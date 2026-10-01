// Saving a folder (loose sharded project) in place: a failed write must not
// leave a half-saved project. saveProjectDirectory stages every file as a
// temporary sibling, replaces shards then the shell, and rolls back on a
// failed replacement. These tests inject faults into MemoryDirectory at each
// step, with and without host rename support, and check that the folder is
// byte-identical to the previous version, no temporary file is left, the
// notice says what happened, and a retry after the fault clears succeeds.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseShardedPack } from "../editor/api/pack.ts";
import { StudioApp } from "../editor/studio/app.ts";
import { ArtRegistry } from "../editor/studio/art.ts";
import { StudioFiles } from "../editor/studio/files.ts";
import { MemoryDirectory, MemoryHost, type DirectoryFault } from "../editor/studio/host-memory.ts";
import { isStagingPath, openProjectDirectory, saveProjectDirectory } from "../editor/studio/project-directory.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";
import type { Project } from "../src/engine/types.ts";

const SUNSTONE = readFileSync(join(import.meta.dir, "..", "examples", "sunstone", "data", "sunstone.json"), "utf8");
/** Shards in mapIndex order, the order a save replaces them. */
const SHARDS = ["maps/cave.json", "maps/forest.json", "maps/village.json"];
const isShard = (path: string): boolean => path.startsWith("maps/") && !isStagingPath(path);

function looseSunstone(rename: boolean): MemoryDirectory {
  const split = splitProjectMaps(JSON.parse(SUNSTONE) as Project);
  const files = new Map<string, string>([["project.json", split.shellText], ["README.txt", "not a project"]]);
  for (const entry of split.entries) files.set(entry.path, entry.text);
  return new MemoryDirectory("sunstone/", files, { rename });
}

/** Open the folder in Studio and edit all three maps, so a save changes
 * three shards and the shell. */
async function editedFolder(rename: boolean) {
  const host = new MemoryHost();
  const app = new StudioApp();
  const files = new StudioFiles(app, new ArtRegistry(), host);
  const dir = looseSunstone(rename);
  const before = new Map(dir.files);
  host.directoryPicks.push(dir);
  await files.openDirectory();
  await Bun.sleep(0);
  for (const [map, value] of [["village", "town.37"], ["forest", "town.37"], ["cave", "dun.30"]]) {
    app.run("paint-cells", { map, layer: "ground", cells: [[1, 1]], value });
  }
  return { host, app, files, dir, before };
}

function expectUnchanged(dir: MemoryDirectory, before: Map<string, string>): void {
  expect([...dir.files.keys()].filter(isStagingPath)).toEqual([]);
  expect(new Map(dir.files)).toEqual(before);
}

function expectSaved(app: StudioApp, dir: MemoryDirectory): void {
  expect([...dir.files.keys()].filter(isStagingPath)).toEqual([]);
  const pack = parseShardedPack(app.session!.exportText());
  expect(dir.files.get("project.json")).toBe(pack.shellText);
  for (const [entry, text] of pack.shards) expect(dir.files.get(entry)).toBe(text);
  expect(app.session!.isDirty()).toBe(false);
}

/** Retry once the fault is gone: the baseline must still be the old one. */
async function expectRetrySucceeds(files: StudioFiles, app: StudioApp, dir: MemoryDirectory): Promise<void> {
  dir.faults = [];
  expect(await files.save()).toBe(true);
  expectSaved(app, dir);
}

for (const rename of [true, false]) {
  const mode = rename ? "with rename" : "without rename";
  /** Fail replacing `path` (the nth time): a rename onto it, or a direct write. */
  const replaceFault = (path: DirectoryFault["path"], nth?: number): DirectoryFault => ({ op: rename ? "rename" : "write", path, nth, message: "disk said no" });

  describe(`Studio folder save ${mode}`, () => {
    test("success: changed shards then the shell are written and no temporary file remains", async () => {
      const { app, files, dir, before } = await editedFolder(rename);
      expect(await files.save()).toBe(true);
      expect(dir.writes).toEqual([...SHARDS, "project.json"]);
      expect(app.notices.at(-1)?.text).toBe("Saved to sunstone/: 4 files written.");
      expectSaved(app, dir);
      expect(dir.files.get("README.txt")).toBe(before.get("README.txt")!);
      expect(dir.files.size).toBe(before.size);
    });

    test("the shell replacement fails: every replaced shard is restored", async () => {
      const { app, files, dir, before } = await editedFolder(rename);
      dir.faults.push(replaceFault("project.json"));
      expect(await files.save()).toBe(false);
      expectUnchanged(dir, before);
      expect(app.notices.at(-1)?.text).toBe(`Not saved to sunstone/: replacing project.json failed (disk said no); restored ${SHARDS.join(", ")}, so the folder still holds the previous version`);
      expect(app.session!.isDirty()).toBe(true);
      await expectRetrySucceeds(files, app, dir);
    });

    for (const nth of [1, 2]) {
      test(`shard replacement ${nth} of 3 fails: the earlier shards are restored, the shell is never touched`, async () => {
        const { app, files, dir, before } = await editedFolder(rename);
        dir.faults.push(replaceFault(isShard, nth));
        expect(await files.save()).toBe(false);
        expectUnchanged(dir, before);
        const restored = SHARDS.slice(0, nth - 1);
        expect(app.notices.at(-1)?.text).toBe(`Not saved to sunstone/: replacing ${SHARDS[nth - 1]} failed (disk said no); ${restored.length === 0 ? "nothing had been replaced" : `restored ${restored.join(", ")}`}, so the folder still holds the previous version`);
        expect(dir.writes).not.toContain("project.json");
        await expectRetrySucceeds(files, app, dir);
      });
    }

    test("a temporary (staging) write fails: nothing is replaced", async () => {
      const { app, files, dir, before } = await editedFolder(rename);
      dir.faults.push({ op: "write", path: isStagingPath, nth: 3, message: "quota exceeded" });
      expect(await files.save()).toBe(false);
      expectUnchanged(dir, before);
      expect(dir.writes).toEqual([]);
      expect(app.notices.at(-1)?.text).toBe("Not saved to sunstone/: could not write a temporary copy of maps/village.json (quota exceeded); nothing was replaced and the folder still holds the previous version");
      await expectRetrySucceeds(files, app, dir);
    });

    test("a rollback write fails: the error names the file that may be inconsistent", async () => {
      const { app, files, dir, before } = await editedFolder(rename);
      dir.faults.push(replaceFault("project.json"));
      // Without rename the first write to forest is its replacement, the second its rollback.
      dir.faults.push({ op: "write", path: "maps/forest.json", nth: rename ? 1 : 2, message: "read-only now" });
      expect(await files.save()).toBe(false);
      expect(app.notices.at(-1)?.text).toBe("Not saved to sunstone/: replacing project.json failed (disk said no), and restoring the previous version also failed, so maps/forest.json may now hold the new version while the other files hold the previous one; save again to finish the save, or reopen the folder");
      // Everything else is the old version; forest holds the new one.
      const pack = parseShardedPack(app.session!.exportText());
      for (const [path, text] of before) {
        expect(dir.files.get(path)).toBe(path === "maps/forest.json" ? pack.shards.get("maps/forest.json")! : text);
      }
      expect([...dir.files.keys()].filter(isStagingPath)).toEqual([]);
      // Saving again finishes the job: forest already holds its new text.
      dir.faults = [];
      dir.writes = [];
      expect(await files.save()).toBe(true);
      expect(dir.writes).toEqual(["maps/cave.json", "maps/village.json", "project.json"]);
      expectSaved(app, dir);
    });

    test("a temporary file that cannot be removed is named in the error", async () => {
      const { app, files, dir, before } = await editedFolder(rename);
      dir.faults.push({ op: "write", path: isStagingPath, nth: 2, message: "quota exceeded" });
      dir.faults.push({ op: "remove", path: (path) => path.startsWith("maps/cave.json.rpgkit-save-") });
      expect(await files.save()).toBe(false);
      const text = app.notices.at(-1)?.text ?? "";
      expect(text).toMatch(/^Not saved to sunstone\/: could not write a temporary copy of maps\/forest\.json \(quota exceeded\); nothing was replaced and the folder still holds the previous version; temporary file maps\/cave\.json\.rpgkit-save-[a-z0-9]+\.tmp could not be removed and can be deleted$/);
      const left = [...dir.files.keys()].filter(isStagingPath);
      expect(left).toHaveLength(1);
      for (const [path, old] of before) expect(dir.files.get(path)).toBe(old);
    });
  });
}

describe("the review's reproduction", () => {
  test("a failed shell write no longer leaves a changed shard behind", async () => {
    const dir = looseSunstone(false);
    const before = new Map(dir.files);
    const opened = await openProjectDirectory(dir);
    const pack = parseShardedPack(opened.packText);
    // A save that changes the forest shard and the shell.
    const host = new MemoryHost();
    const app = new StudioApp();
    const files = new StudioFiles(app, new ArtRegistry(), host);
    host.directoryPicks.push(new MemoryDirectory("copy/", new Map(dir.files)));
    await files.openDirectory();
    await Bun.sleep(0);
    app.run("paint-cells", { map: "forest", layer: "ground", cells: [[1, 1], [2, 1]], value: "town.37" });
    const edited = app.session!.exportText();
    expect(parseShardedPack(edited).shellText).not.toBe(pack.shellText);

    dir.faults.push({ op: "write", path: "project.json", message: "injected shell failure" });
    await expect(saveProjectDirectory(dir, opened.baseline, edited)).rejects.toThrow("replacing project.json failed (injected shell failure); restored maps/forest.json, so the folder still holds the previous version");
    expect(dir.files.get("maps/forest.json")).toBe(before.get("maps/forest.json")!);
    expect(dir.files.get("project.json")).toBe(before.get("project.json")!);
    expectUnchanged(dir, before);
  });
});
