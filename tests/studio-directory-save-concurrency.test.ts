// Overlapping saves into one folder (loose sharded project) run one after
// another. Without that, two saves check against the same baseline and a
// failing one rolls back files the other had just committed, leaving a new
// shell next to old map files. These tests hold the first save at a
// controllable gate inside its commit, start a second save, check the second
// has not touched the folder, then let the first finish. Afterwards the
// shell and every map file come from the same save (all from one version)
// and no temporary file is left.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseShardedPack } from "../editor/api/pack.ts";
import { StudioApp } from "../editor/studio/app.ts";
import { ArtRegistry } from "../editor/studio/art.ts";
import { StudioFiles } from "../editor/studio/files.ts";
import { MemoryDirectory, MemoryHost } from "../editor/studio/host-memory.ts";
import type { SaveOutcome } from "../editor/studio/host.ts";
import { isStagingPath, openProjectDirectory, saveProjectDirectory } from "../editor/studio/project-directory.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";
import type { Project } from "../src/engine/types.ts";

const SUNSTONE = readFileSync(join(import.meta.dir, "..", "examples", "sunstone", "data", "sunstone.json"), "utf8");
const SHARDS = ["maps/cave.json", "maps/forest.json", "maps/village.json"];
const META = { label: "sunstone/", fileName: "sunstone-pack.json" };

function looseSunstone(rename: boolean, name = "sunstone/"): MemoryDirectory {
  const split = splitProjectMaps(JSON.parse(SUNSTONE) as Project);
  const files = new Map<string, string>([["project.json", split.shellText]]);
  for (const entry of split.entries) files.set(entry.path, entry.text);
  return new MemoryDirectory(name, files, { rename });
}

/** Hold the nth `op` on `path` until release(); `reached` resolves when the
 * call arrives at the gate. */
function holdAt(dir: MemoryDirectory, op: "write" | "rename", path: string, nth = 1) {
  let seen = 0;
  let arrive!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { arrive = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  dir.gate = (calledOp, calledPath) => {
    if (calledOp !== op || calledPath !== path) return;
    seen += 1;
    if (seen !== nth) return;
    arrive();
    return released;
  };
  return { reached, release };
}

/** Let every pending promise chain run as far as it can. */
const settle = (): Promise<void> => Bun.sleep(5);

/** The shell and all three map files hold `packText`'s version, and no
 * temporary file is left. */
function expectWholeVersion(dir: MemoryDirectory, packText: string): void {
  expect([...dir.files.keys()].filter(isStagingPath)).toEqual([]);
  const pack = parseShardedPack(packText);
  expect(dir.files.get("project.json")).toBe(pack.shellText);
  for (const entry of SHARDS) expect(dir.files.get(entry)).toBe(pack.shards.get(entry)!);
}

/** Open the folder in Studio; return the folder and two successive versions
 * of the document (A, then B with further edits to every map). */
async function twoVersions(rename: boolean) {
  const host = new MemoryHost();
  const app = new StudioApp();
  const files = new StudioFiles(app, new ArtRegistry(), host);
  const dir = looseSunstone(rename);
  host.directoryPicks.push(dir);
  await files.openDirectory();
  await Bun.sleep(0);
  const opened = app.session!.exportText();
  for (const [map, value] of [["village", "town.37"], ["forest", "town.37"], ["cave", "dun.30"]]) {
    app.run("paint-cells", { map, layer: "ground", cells: [[1, 1]], value });
  }
  const a = app.session!.exportText();
  for (const [map, value] of [["village", "town.37"], ["forest", "town.37"], ["cave", "dun.30"]]) {
    app.run("paint-cells", { map, layer: "ground", cells: [[2, 2]], value });
  }
  const b = app.session!.exportText();
  for (const entry of SHARDS) {
    expect(parseShardedPack(a).shards.get(entry)).not.toBe(parseShardedPack(opened).shards.get(entry));
    expect(parseShardedPack(b).shards.get(entry)).not.toBe(parseShardedPack(a).shards.get(entry));
  }
  return { host, app, files, dir, opened, a, b, target: files.target! };
}

for (const rename of [true, false]) {
  const mode = rename ? "with rename" : "without rename";
  const replaceOp = rename ? "rename" as const : "write" as const;

  describe(`overlapping folder saves ${mode}`, () => {
    test("first succeeds, second fails: the folder holds the first save's version throughout", async () => {
      const { host, dir, a, b, target } = await twoVersions(rename);
      // The second replacement of the shell (the second save's) fails.
      dir.faults.push({ op: replaceOp, path: "project.json", nth: 2, message: "disk said no" });
      const gate = holdAt(dir, replaceOp, SHARDS[0]!);
      const first = host.save(a, META, target);
      await gate.reached;
      const opsAtHold = dir.log.length;
      const second = host.save(b, META, target);
      await settle();
      // The second save waits: it has not even re-read a file yet.
      expect(dir.log.length).toBe(opsAtHold);
      gate.release();
      const [one, two] = await Promise.all([first, second]);
      expect(one).toMatchObject({ ok: true, written: [...SHARDS, "project.json"] });
      expect(two).toEqual({
        ok: false,
        message: `Not saved to sunstone/: replacing project.json failed (disk said no); restored ${SHARDS.join(", ")}, so the folder still holds the previous version`,
      } satisfies SaveOutcome);
      // "Previous version" is the first save's, not the folder as opened.
      expectWholeVersion(dir, a);
      // The target's baseline is the first save's: retrying B now succeeds.
      dir.gate = null;
      dir.faults = [];
      expect(await host.save(b, META, target)).toMatchObject({ ok: true, written: [...SHARDS, "project.json"] });
      expectWholeVersion(dir, b);
    });

    test("first fails, second succeeds: the second checks against the baseline the failure left", async () => {
      const { host, dir, opened, a, b, target } = await twoVersions(rename);
      dir.faults.push({ op: replaceOp, path: "project.json", nth: 1, message: "disk said no" });
      const gate = holdAt(dir, replaceOp, SHARDS[1]!);
      const first = host.save(a, META, target);
      await gate.reached;
      const opsAtHold = dir.log.length;
      const second = host.save(b, META, target);
      await settle();
      expect(dir.log.length).toBe(opsAtHold);
      // Mid-commit the first save has replaced one map file and nothing else.
      expect(dir.files.get(SHARDS[0]!)).toBe(parseShardedPack(a).shards.get(SHARDS[0]!)!);
      expect(dir.files.get("project.json")).toBe(parseShardedPack(opened).shellText);
      gate.release();
      const [one, two] = await Promise.all([first, second]);
      expect(one.ok).toBe(false);
      expect(two).toMatchObject({ ok: true, written: [...SHARDS, "project.json"] });
      expectWholeVersion(dir, b);
    });

    test("the review's interleaving: two identical saves from one baseline, the later shell replacement failing", async () => {
      const dir = looseSunstone(rename);
      const before = await openProjectDirectory(dir);
      const { a } = await twoVersions(rename);
      dir.faults.push({ op: replaceOp, path: "project.json", nth: 2 });
      const gate = holdAt(dir, replaceOp, SHARDS[0]!);
      const results = Promise.allSettled([
        saveProjectDirectory(dir, before.baseline, a),
        saveProjectDirectory(dir, before.baseline, a),
      ]);
      await gate.reached;
      const opsAtHold = dir.log.length;
      await settle();
      expect(dir.log.length).toBe(opsAtHold);
      gate.release();
      const [one, two] = await results;
      expect(one).toMatchObject({ status: "fulfilled", value: { written: [...SHARDS, "project.json"] } });
      // The second finds every file already holds its text and writes nothing,
      // so the injected failure is never reached.
      expect(two).toMatchObject({ status: "fulfilled", value: { written: [] } });
      expectWholeVersion(dir, a);
    });

    test("a second direct save from the same stale baseline is refused, not interleaved", async () => {
      const dir = looseSunstone(rename);
      const before = await openProjectDirectory(dir);
      const { a, b } = await twoVersions(rename);
      const gate = holdAt(dir, replaceOp, "project.json");
      const results = Promise.allSettled([
        saveProjectDirectory(dir, before.baseline, a),
        saveProjectDirectory(dir, before.baseline, b),
      ]);
      await gate.reached;
      const opsAtHold = dir.log.length;
      await settle();
      expect(dir.log.length).toBe(opsAtHold);
      gate.release();
      const [one, two] = await results;
      expect(one.status).toBe("fulfilled");
      expect(two).toMatchObject({ status: "rejected", reason: { message: "maps/cave.json changed on disk since it was opened; nothing was written" } });
      expectWholeVersion(dir, a);
    });
  });

  describe(`Studio Save pressed twice ${mode}`, () => {
    test("the second save waits, then saves the document as it is when it runs; Saving… shows meanwhile", async () => {
      const { app, files, dir } = await twoVersions(rename);
      const events: string[] = [];
      app.on((reason) => { if (reason === "saving" || reason === "saved") events.push(`${reason}:${files.saving}`); });
      // twoVersions left both edit rounds in the session; undo the second.
      for (let i = 0; i < 3; i += 1) app.undo();
      const gate = holdAt(dir, replaceOp, SHARDS[0]!);
      const first = files.save();
      expect(files.saving).toBe(1);
      await gate.reached;
      const savedFirst = parseShardedPack(app.session!.exportText());
      const opsAtHold = dir.log.length;
      const second = files.save();
      expect(files.saving).toBe(2);
      await settle();
      expect(dir.log.length).toBe(opsAtHold);
      // Edits made after Save was pressed, while the first save still runs,
      // are in the second save too.
      for (let i = 0; i < 3; i += 1) app.redo();
      gate.release();
      expect(await Promise.all([first, second])).toEqual([true, true]);
      expect(files.saving).toBe(0);
      expectWholeVersion(dir, app.session!.exportText());
      expect(parseShardedPack(app.session!.exportText()).shellText).not.toBe(savedFirst.shellText);
      expect(app.session!.isDirty()).toBe(false);
      expect(events).toEqual(["saving:1", "saved:2", "saved:1", "saving:0"]);
    });

    test("the second save fails: the folder keeps the first save's version and the edits stay unsaved", async () => {
      const { app, files, dir } = await twoVersions(rename);
      for (let i = 0; i < 3; i += 1) app.undo();
      const firstText = app.session!.exportText();
      dir.faults.push({ op: replaceOp, path: "project.json", nth: 2, message: "disk said no" });
      const gate = holdAt(dir, replaceOp, SHARDS[0]!);
      const first = files.save();
      await gate.reached;
      for (let i = 0; i < 3; i += 1) app.redo();
      const second = files.save();
      await settle();
      gate.release();
      expect(await Promise.all([first, second])).toEqual([true, false]);
      expectWholeVersion(dir, firstText);
      expect(app.session!.isDirty()).toBe(true);
      expect(app.notices.at(-1)?.text).toBe(`Not saved to sunstone/: replacing project.json failed (disk said no); restored ${SHARDS.join(", ")}, so the folder still holds the previous version`);
      dir.gate = null;
      dir.faults = [];
      expect(await files.save()).toBe(true);
      expectWholeVersion(dir, app.session!.exportText());
      expect(app.session!.isDirty()).toBe(false);
    });
  });
  describe(`Saving one folder while another is opened ${mode}`, () => {
    /** alpha/ open in Studio with an edit to every map, beta/ waiting to be
     * picked, and alpha's save held inside its commit. */
    async function savingAlphaThenOpenBeta() {
      const host = new MemoryHost();
      const app = new StudioApp();
      const files = new StudioFiles(app, new ArtRegistry(), host);
      const alpha = looseSunstone(rename, "alpha/");
      const beta = looseSunstone(rename, "beta/");
      const betaBefore = new Map(beta.files);
      host.directoryPicks.push(alpha);
      await files.openDirectory();
      await Bun.sleep(0);
      for (const [map, value] of [["village", "town.37"], ["forest", "town.37"], ["cave", "dun.30"]]) {
        app.run("paint-cells", { map, layer: "ground", cells: [[1, 1]], value });
      }
      const alphaSession = app.session!;
      const alphaText = alphaSession.exportText();
      const events: string[] = [];
      app.on((reason) => { if (reason === "saving" || reason === "saved") events.push(`${reason}:${files.target?.name}`); });
      const gate = holdAt(alpha, replaceOp, SHARDS[0]!);
      const save = files.save();
      await gate.reached;
      expect(files.savingTo).toBe("alpha/");
      host.directoryPicks.push(beta);
      await files.openDirectory();
      await Bun.sleep(0);
      expect(host.questions).toHaveLength(1);
      expect(files.target?.name).toBe("beta/");
      expect(app.session).not.toBe(alphaSession);
      // The running save is still alpha's, and says so.
      expect(files.savingTo).toBe("alpha/");
      return { host, app, files, alpha, beta, betaBefore, alphaText, events, gate, save };
    }

    test("alpha's save finishes as alpha's: beta is not marked saved and the notice names alpha/", async () => {
      const { app, files, alpha, beta, betaBefore, alphaText, events, gate, save } = await savingAlphaThenOpenBeta();
      gate.release();
      expect(await save).toBe(true);
      expect(files.saving).toBe(0);
      expect(files.savingTo).toBeNull();
      // On disk: alpha holds the saved version, beta is untouched.
      expectWholeVersion(alpha, alphaText);
      expect(beta.files).toEqual(betaBefore);
      expect(beta.log.filter((line) => !line.startsWith("read "))).toEqual([]);
      // In Studio: beta is open and its saved state is its own (never saved).
      expect(files.target?.name).toBe("beta/");
      expect(files.lastSavedAt).toBeNull();
      expect(files.lastSavedWhere).toBeNull();
      expect(app.notices.at(-1)).toMatchObject({ level: "ok", text: "Saved to alpha/: 4 files written." });
      expect(events).toEqual(["saving:alpha/", "saving:beta/"]);
    });

    test("an edit to beta made during alpha's save stays unsaved", async () => {
      const { app, files, beta, betaBefore, gate, save } = await savingAlphaThenOpenBeta();
      app.run("paint-cells", { map: "village", layer: "ground", cells: [[3, 3]], value: "town.37" });
      expect(app.session!.isDirty()).toBe(true);
      gate.release();
      expect(await save).toBe(true);
      expect(app.session!.isDirty()).toBe(true);
      expect(files.lastSavedAt).toBeNull();
      expect(beta.files).toEqual(betaBefore);
    });

    test("a second Save queued for alpha still saves alpha, not the newly open beta", async () => {
      const host = new MemoryHost();
      const app = new StudioApp();
      const files = new StudioFiles(app, new ArtRegistry(), host);
      const alpha = looseSunstone(rename, "alpha/");
      const beta = looseSunstone(rename, "beta/");
      const betaBefore = new Map(beta.files);
      host.directoryPicks.push(alpha);
      await files.openDirectory();
      await Bun.sleep(0);
      app.run("paint-cells", { map: "village", layer: "ground", cells: [[1, 1]], value: "town.37" });
      const gate = holdAt(alpha, replaceOp, SHARDS[2]!);
      const first = files.save();
      await gate.reached;
      app.run("paint-cells", { map: "cave", layer: "ground", cells: [[1, 1]], value: "dun.30" });
      const alphaText = app.session!.exportText();
      const second = files.save();
      host.directoryPicks.push(beta);
      await files.openDirectory();
      await Bun.sleep(0);
      expect(files.target?.name).toBe("beta/");
      gate.release();
      expect(await Promise.all([first, second])).toEqual([true, true]);
      expectWholeVersion(alpha, alphaText);
      expect(beta.files).toEqual(betaBefore);
      expect(beta.log.filter((line) => !line.startsWith("read "))).toEqual([]);
      expect(files.lastSavedAt).toBeNull();
      expect(app.notices.filter((notice) => notice.level === "ok").map((notice) => notice.text)).toEqual([
        "Saved to alpha/: 2 files written.",
        "Saved to alpha/: 2 files written.",
      ]);
    });
  });
}
