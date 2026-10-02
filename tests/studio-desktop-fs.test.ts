// The desktop app's project folder (studio-desktop/src/fs-directory.ts): a
// ProjectDirectory over node:fs that Studio opens and saves in place. These
// tests use real files in a scratch folder and check (1) that every path
// stays inside the folder the user picked, symlinks included, for text and
// art (readBytes) alike, (2) that a save
// replaces only the files whose text changed and leaves no temporary files,
// lock or rollback copies behind, (3) that a file changed on disk since it was
// opened blocks the save, (4) that a save waits for no one: another writer
// holding the project's .rpgkit-edit.lock makes it fail without writing, and
// (5) that a replacement failing half way puts the files already replaced
// back (editor/api/file.ts's atomicWriteProjectFiles).

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { atomicWriteProjectFiles, projectFileLockPath, WriteConflictError } from "../editor/api/file.ts";
import { parseShardedPack, serializeShardedPack } from "../editor/api/pack.ts";
import { EditSession } from "../editor/api/session.ts";
import type { OpenedProject, SaveOutcome, SaveTarget } from "../editor/studio/host.ts";
import { openDirectoryProject, saveDirectoryTarget } from "../editor/studio/project-directory.ts";
import { checkRelative, FsDirectory } from "../studio-desktop/src/fs-directory.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";
import type { Project } from "../src/engine/types.ts";

const ROOT = join(import.meta.dir, "..");
const SUNSTONE = readFileSync(join(ROOT, "examples", "sunstone", "data", "sunstone.json"), "utf8");
const TILE_PNG = new Uint8Array(readFileSync(join(ROOT, "editor", "assets", "tile-town-48.png")));
const TEMP = join(import.meta.dir, `.studio-desktop-fs-${process.pid}`);
const VILLAGE = "maps/village.json";
const SAVED_AT = "2026-01-01T00:00:00.000Z";
/** What a save may leave behind by mistake: staged copies, rollback copies,
 * the project lock and its acquire/reaper siblings. */
const LEFTOVER = /\.tmp$|\.rollback$|\.rpgkit-edit\.lock|\.rpgkit-save-/;
const RUNS_AS_ROOT = process.getuid?.() === 0;

beforeAll(() => mkdirSync(TEMP, { recursive: true }));
afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

let folders = 0;

/** A fresh scratch folder under TEMP. */
function scratch(name: string): string {
  const path = join(TEMP, `${name}-${++folders}`);
  mkdirSync(path, { recursive: true });
  return path;
}

/** Sunstone as a loose sharded folder: project.json plus maps/<id>.json. */
function looseSunstone(name = "sunstone"): string {
  const root = scratch(name);
  const split = splitProjectMaps(JSON.parse(SUNSTONE) as Project);
  writeFileSync(join(root, "project.json"), split.shellText);
  for (const entry of split.entries) {
    mkdirSync(join(root, entry.path, ".."), { recursive: true });
    writeFileSync(join(root, entry.path), entry.text);
  }
  return root;
}

/** Every file and folder under `root`, as POSIX paths relative to it. */
function tree(root: string, prefix = ""): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    return entry.isDirectory() ? [`${path}/`, ...tree(root, path)] : [path];
  }).sort();
}

/** The bytes of every file under `root`. */
function snapshot(root: string): Map<string, string> {
  return new Map(tree(root).filter((path) => !path.endsWith("/")).map((path) => [path, readFileSync(join(root, path), "utf8")]));
}

function mtimes(root: string): Map<string, number> {
  return new Map(tree(root).filter((path) => !path.endsWith("/")).map((path) => [path, statSync(join(root, path)).mtimeMs]));
}

function leftovers(root: string): string[] {
  return tree(root).filter((path) => LEFTOVER.test(path));
}

async function open(dir: FsDirectory): Promise<OpenedProject & { target: SaveTarget }> {
  const opened = await openDirectoryProject(dir);
  if ("error" in opened) throw new Error(opened.error);
  if (opened.target === undefined) throw new Error("a folder opens with a save target");
  // The desktop app's main process tells the directory which file is the
  // shell once the folder is open, so saves lock that file.
  dir.shellPath = (opened.target.ref as { baseline: { shellPath: string } }).baseline.shellPath;
  return opened as OpenedProject & { target: SaveTarget };
}

/** The pack with one ground cell of the village shard changed. The shard is
 * canonical compact JSON with non-ASCII escaped as \uXXXX, so JSON.stringify
 * would rewrite bytes the edit never touched; the cell is edited in the text
 * itself, keeping every other byte as the file has it. */
function paintVillageCell(packText: string): string {
  const pack = parseShardedPack(packText);
  const shard = pack.shards.get(VILLAGE)!;
  const edited = shard.replace(`"ground":["town.0",`, `"ground":["town.37",`);
  expect(edited).not.toBe(shard);
  expect((JSON.parse(edited) as { ground: string[] }).ground[0]).toBe("town.37");
  pack.shards.set(VILLAGE, edited);
  return serializeShardedPack(pack.shellText, pack.shell.mapIndex, pack.shards);
}

/** The pack after a real edit through the edit protocol: the village shard
 * and the shell (whose mapIndex records each shard's hash) both change. */
function paintThroughSession(packText: string): string {
  const session = EditSession.open(packText);
  const response = session.run("paint-cells", { map: "village", layer: "ground", cells: [[1, 1]], value: "town.37" });
  if (!response.ok) throw new Error(response.error.message);
  return session.exportText();
}

function failed(outcome: SaveOutcome): string {
  if (outcome.ok) throw new Error("the save was expected to fail");
  return outcome.message;
}

function written(outcome: SaveOutcome): string[] {
  if (!outcome.ok) throw new Error(outcome.message);
  if (outcome.where !== "directory") throw new Error(`saved to ${outcome.where}`);
  return outcome.written ?? [];
}

// ---- 1. confinement ------------------------------------------------------------

describe("FsDirectory keeps every path inside the folder", () => {
  const refused = ["", "/etc/passwd", "../x", "a/../../x", "a//b", "./a", "a\\b", "C:\\x", "a\0b", "maps/", "maps/./village.json"];

  test("only plain relative POSIX paths pass checkRelative and resolve", () => {
    const root = looseSunstone();
    const dir = new FsDirectory(root);
    for (const path of refused) {
      expect(() => checkRelative(path)).toThrow();
      expect(() => dir.resolve(path)).toThrow();
    }
    expect(checkRelative("project.json")).toEqual(["project.json"]);
    expect(checkRelative("maps/village.json")).toEqual(["maps", "village.json"]);
    const real = realpathSync(root);
    expect(dir.resolve("project.json")).toBe(join(real, "project.json"));
    expect(dir.resolve("maps/village.json")).toBe(join(real, "maps", "village.json"));
    // A file that does not exist yet resolves through its folder.
    expect(dir.resolve("maps/new.json")).toBe(join(real, "maps", "new.json"));
  });

  test("read, size, write, remove and rename refuse unsafe paths before touching the disk", async () => {
    const root = looseSunstone();
    const dir = new FsDirectory(root);
    const before = snapshot(root);
    for (const path of refused) {
      await expect(dir.read(path)).rejects.toThrow();
      await expect(dir.size(path)).rejects.toThrow();
      await expect(dir.write(path, "x")).rejects.toThrow();
      await expect(dir.remove(path)).rejects.toThrow();
      await expect(dir.rename("project.json", path)).rejects.toThrow();
    }
    expect(snapshot(root)).toEqual(before);
  });

  test("symlinks that lead out of the folder are refused; symlinks to files inside it are followed", async () => {
    const outside = scratch("outside");
    writeFileSync(join(outside, "secret.json"), "{\"secret\":true}");
    const root = looseSunstone();
    symlinkSync(join(outside, "secret.json"), join(root, "secret.json"));
    symlinkSync(outside, join(root, "linked"));
    symlinkSync(join(root, "maps", "village.json"), join(root, "alias.json"));
    const dir = new FsDirectory(root);

    for (const path of ["secret.json", "linked/secret.json"]) {
      expect(() => dir.resolve(path)).toThrow(/resolves outside/);
      await expect(dir.read(path)).rejects.toThrow(/resolves outside/);
      await expect(dir.size(path)).rejects.toThrow(/resolves outside/);
      await expect(dir.write(path, "{}")).rejects.toThrow(/resolves outside/);
      await expect(dir.remove(path)).rejects.toThrow(/resolves outside/);
    }
    // A new file under the linked folder would land outside too.
    await expect(dir.write("linked/new.json", "{}")).rejects.toThrow(/resolves outside/);
    expect(readFileSync(join(outside, "secret.json"), "utf8")).toBe("{\"secret\":true}");
    expect(readdirSync(outside)).toEqual(["secret.json"]);

    const village = readFileSync(join(root, VILLAGE), "utf8");
    expect(await dir.read("alias.json")).toBe(village);
    expect(await dir.size("alias.json")).toBe(Buffer.byteLength(village));
    expect(dir.resolve("alias.json")).toBe(join(realpathSync(root), "maps", "village.json"));
    await dir.write("alias.json", village.replace("town.0", "town.1"));
    expect(readFileSync(join(root, VILLAGE), "utf8")).toBe(village.replace("town.0", "town.1"));
  });

  test("readBytes reads a file's exact bytes under the same rules", async () => {
    const outside = scratch("outside");
    writeFileSync(join(outside, "secret.png"), TILE_PNG);
    const root = looseSunstone();
    mkdirSync(join(root, "art", "sheets"), { recursive: true });
    writeFileSync(join(root, "art", "sheets", "town.png"), TILE_PNG);
    symlinkSync(join(outside, "secret.png"), join(root, "art", "sheets", "dun.png"));
    symlinkSync(outside, join(root, "linked"));
    symlinkSync(join(root, "art", "sheets", "town.png"), join(root, "alias.png"));
    const dir = new FsDirectory(root);

    const bytes = await dir.readBytes("art/sheets/town.png");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes).toEqual(TILE_PNG);
    expect(await dir.readBytes("alias.png")).toEqual(TILE_PNG);
    for (const path of refused) await expect(dir.readBytes(path)).rejects.toThrow();
    for (const path of ["art/sheets/dun.png", "linked/secret.png"]) {
      await expect(dir.readBytes(path)).rejects.toThrow(/resolves outside/);
    }
    await expect(dir.readBytes("art/sheets/missing.png")).rejects.toThrow();
    await expect(dir.readBytes("no-such-folder/x.png")).rejects.toThrow();
  });

  test("opening a folder embeds its own art, skips art outside it, and a save never writes art", async () => {
    const outside = scratch("outside");
    writeFileSync(join(outside, "dun.png"), TILE_PNG);
    const root = looseSunstone();
    mkdirSync(join(root, "art", "sheets"), { recursive: true });
    mkdirSync(join(root, "assets", "npc"), { recursive: true });
    writeFileSync(join(root, "art", "sheets", "town.png"), TILE_PNG);
    writeFileSync(join(root, "assets", "npc", "wiz.png"), TILE_PNG);
    symlinkSync(join(outside, "dun.png"), join(root, "art", "sheets", "dun.png"));
    const dir = new FsDirectory(root);
    const opened = await open(dir);
    const pack = parseShardedPack(opened.text);
    expect([...pack.assets.keys()]).toEqual(["art/sheets/town.png", "assets/npc/wiz.png"]);
    expect(opened.notes?.[0]).toBe("Loaded 2 art files from the folder.");
    expect(opened.notes?.[1]).toMatch(/^13 referenced art files are missing: art\/sheets\/dun\.png, /);

    const edited = paintThroughSession(opened.text);
    expect(parseShardedPack(edited).assets).toEqual(pack.assets);
    const before = mtimes(root);
    const outcome = await saveDirectoryTarget(opened.target, edited, SAVED_AT);
    expect(outcome).toEqual({ ok: true, where: "directory", written: [VILLAGE, "project.json"], savedAt: SAVED_AT });
    const after = mtimes(root);
    for (const path of ["art/sheets/town.png", "assets/npc/wiz.png"]) expect(after.get(path)).toBe(before.get(path)!);
    expect(new Uint8Array(readFileSync(join(root, "art", "sheets", "town.png")))).toEqual(TILE_PNG);
    expect(leftovers(root)).toEqual([]);
  });

  // realpathSync also fails for a symlink whose target does not exist, so a
  // dangling link must not be mistaken for a new file inside the folder:
  // write() would follow it and create the file wherever it points.
  test("a dangling symlink pointing outside the folder is refused by write", async () => {
    const outside = scratch("outside");
    const root = looseSunstone();
    symlinkSync(join(outside, "planted.json"), join(root, "planted.json"));
    const dir = new FsDirectory(root);
    let refusedWrite = false;
    try {
      await dir.write("planted.json", "{\"planted\":true}");
    } catch {
      refusedWrite = true;
    }
    expect(existsSync(join(outside, "planted.json"))).toBe(false);
    expect(refusedWrite).toBe(true);
  });

  test("listRoot lists the root's files only, and the name is the folder's name with a slash", async () => {
    const root = looseSunstone("my-game");
    writeFileSync(join(root, "README.txt"), "hi");
    mkdirSync(join(root, "empty-folder"));
    const dir = new FsDirectory(root);
    expect((await dir.listRoot()).sort()).toEqual(["README.txt", "project.json"]);
    expect(dir.name).toBe(`${realpathSync(root).split("/").at(-1)}/`);
    expect(dir.name).toMatch(/^my-game-\d+\/$/);
  });
});

// ---- 2. open and save ----------------------------------------------------------

describe("saving a folder in place through FsDirectory", () => {
  test("a changed shard is the only file written; nothing is left behind and other files keep their mtimes", async () => {
    const root = looseSunstone();
    chmodSync(join(root, VILLAGE), 0o640);
    const dir = new FsDirectory(root);
    const opened = await open(dir);
    expect(opened.label).toBe(dir.name);
    const before = snapshot(root);
    const times = mtimes(root);
    await Bun.sleep(20);

    const edited = paintVillageCell(opened.text);
    expect(written(await saveDirectoryTarget(opened.target, edited, SAVED_AT))).toEqual([VILLAGE]);

    const after = snapshot(root);
    const pack = parseShardedPack(edited);
    expect(after.get(VILLAGE)).toBe(pack.shards.get(VILLAGE)!);
    expect([...after.keys()]).toEqual([...before.keys()]);
    expect([...after.keys()].filter((path) => after.get(path) !== before.get(path))).toEqual([VILLAGE]);
    for (const [path, time] of times) if (path !== VILLAGE) expect(statSync(join(root, path)).mtimeMs).toBe(time);
    expect(leftovers(root)).toEqual([]);
    expect(existsSync(projectFileLockPath(join(root, "project.json")))).toBe(false);
    // The replaced file keeps its permissions.
    expect(statSync(join(root, VILLAGE)).mode & 0o777).toBe(0o640);

    // Saving the same text again writes nothing.
    const again = mtimes(root);
    await Bun.sleep(20);
    expect(written(await saveDirectoryTarget(opened.target, edited, SAVED_AT))).toEqual([]);
    expect(mtimes(root)).toEqual(again);
    expect(snapshot(root)).toEqual(after);

    // Reopening reads the edit back.
    expect((await open(new FsDirectory(root))).text).toBe(edited);
  });

  test("an edit that also changes the shell writes the shard first and the shell last", async () => {
    const root = looseSunstone();
    const dir = new FsDirectory(root);
    const opened = await open(dir);
    const before = snapshot(root);
    const edited = paintThroughSession(opened.text);
    expect(written(await saveDirectoryTarget(opened.target, edited, SAVED_AT))).toEqual([VILLAGE, "project.json"]);
    const after = snapshot(root);
    const pack = parseShardedPack(edited);
    expect(after.get("project.json")).toBe(pack.shellText);
    expect(after.get(VILLAGE)).toBe(pack.shards.get(VILLAGE)!);
    expect([...after.keys()].filter((path) => after.get(path) !== before.get(path)).sort()).toEqual([VILLAGE, "project.json"]);
    expect(leftovers(root)).toEqual([]);
    expect((await open(new FsDirectory(root))).text).toBe(edited);
  });
});

// ---- 3. conflicts --------------------------------------------------------------

describe("a file changed on disk since opening", () => {
  test("blocks the save, writes nothing and keeps the baseline, so putting it back lets the save through", async () => {
    const root = looseSunstone();
    const dir = new FsDirectory(root);
    const opened = await open(dir);
    const original = readFileSync(join(root, VILLAGE), "utf8");
    const edited = paintVillageCell(opened.text);

    writeFileSync(join(root, VILLAGE), `${original} `);
    const before = snapshot(root);
    const message = failed(await saveDirectoryTarget(opened.target, edited, SAVED_AT));
    expect(message).toContain("changed on disk");
    expect(message).toBe(`Not saved to ${dir.name}: ${VILLAGE} changed on disk since it was opened; nothing was written`);
    expect(snapshot(root)).toEqual(before);
    expect(leftovers(root)).toEqual([]);

    writeFileSync(join(root, VILLAGE), original);
    expect(written(await saveDirectoryTarget(opened.target, edited, SAVED_AT))).toEqual([VILLAGE]);
    expect(readFileSync(join(root, VILLAGE), "utf8")).toBe(parseShardedPack(edited).shards.get(VILLAGE)!);
    expect(leftovers(root)).toEqual([]);
  });

  test("commit rechecks every target under the lock, so a change after the check still writes nothing", async () => {
    const root = looseSunstone();
    const dir = new FsDirectory(root);
    await open(dir);
    const shell = readFileSync(join(root, "project.json"), "utf8");
    const village = readFileSync(join(root, VILLAGE), "utf8");
    const before = snapshot(root);
    // The shard is fine; the shell no longer holds what the caller expects.
    await expect(dir.commit([
      { path: VILLAGE, text: village.replace("town.0", "town.1"), expected: village },
      { path: "project.json", text: `${shell} `, expected: `${shell}\n` },
    ])).rejects.toBeInstanceOf(WriteConflictError);
    expect(snapshot(root)).toEqual(before);
    expect(leftovers(root)).toEqual([]);
  });
});

// ---- 4. the project lock -------------------------------------------------------

describe("another writer holding the project's lock", () => {
  test("makes the save fail without writing; once released, the save goes through", async () => {
    const root = looseSunstone();
    const dir = new FsDirectory(root);
    const opened = await open(dir);
    const edited = paintVillageCell(opened.text);

    // A live holder as editor/api/lock.ts writes one: a directory holding
    // owner.json with a running pid (this process).
    const lock = projectFileLockPath(join(realpathSync(root), "project.json"));
    mkdirSync(lock);
    const owner = JSON.stringify({ pid: process.pid, token: "another-writer", createdAt: new Date().toISOString() });
    writeFileSync(join(lock, "owner.json"), owner);
    const before = snapshot(root);
    const message = failed(await saveDirectoryTarget(opened.target, edited, SAVED_AT));
    expect(message).toContain("another writer currently owns the project file lock");
    expect(snapshot(root)).toEqual(before);
    // The holder's lock is left alone, and nothing else was staged.
    expect(readFileSync(join(lock, "owner.json"), "utf8")).toBe(owner);
    expect(tree(root).filter((path) => LEFTOVER.test(path))).toEqual(["project.json.rpgkit-edit.lock/", "project.json.rpgkit-edit.lock/owner.json"]);

    rmSync(lock, { recursive: true });
    expect(written(await saveDirectoryTarget(opened.target, edited, SAVED_AT))).toEqual([VILLAGE]);
    expect(leftovers(root)).toEqual([]);
  });
});

// ---- 5. rollback ---------------------------------------------------------------

/** Make renameSync onto `target` fail once, like a target that cannot be
 * replaced; every other rename (staging, rollback) still happens. */
function failRenameOnto(target: string): { restore(): void; calls: () => number } {
  const real = fs.renameSync;
  let calls = 0;
  const spy = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    calls += 1;
    if (String(to) === target && String(from).endsWith(".tmp")) throw new Error(`EPERM: cannot replace ${target}`);
    return real(from, to);
  });
  return { restore: () => spy.mockRestore(), calls: () => calls };
}

describe("a replacement that fails half way", () => {
  test("atomicWriteProjectFiles: a stale second target stops the write before the first is replaced", () => {
    const folder = scratch("atomic-stale");
    writeFileSync(join(folder, "a.json"), "A");
    writeFileSync(join(folder, "b.json"), "B");
    expect(() => atomicWriteProjectFiles([
      { path: join(folder, "a.json"), text: "A2", expectedSource: "A" },
      { path: join(folder, "b.json"), text: "B2", expectedSource: "not B" },
    ])).toThrow(WriteConflictError);
    expect(readFileSync(join(folder, "a.json"), "utf8")).toBe("A");
    expect(readFileSync(join(folder, "b.json"), "utf8")).toBe("B");
    expect(readdirSync(folder).sort()).toEqual(["a.json", "b.json"]);
  });

  // Staging writes a temporary next to each target, so a read-only folder
  // fails at staging, before anything is replaced. (A failure of the rename
  // itself, after staging succeeded, is covered by the next tests.)
  test.skipIf(RUNS_AS_ROOT)("atomicWriteProjectFiles: a second target in a read-only folder leaves the first untouched", () => {
    const folder = scratch("atomic-readonly");
    mkdirSync(join(folder, "locked"));
    writeFileSync(join(folder, "a.json"), "A");
    writeFileSync(join(folder, "locked", "b.json"), "B");
    chmodSync(join(folder, "locked"), 0o555);
    try {
      expect(() => atomicWriteProjectFiles([
        { path: join(folder, "a.json"), text: "A2", expectedSource: "A" },
        { path: join(folder, "locked", "b.json"), text: "B2", expectedSource: "B" },
      ])).toThrow(/EACCES|permission/i);
    } finally {
      chmodSync(join(folder, "locked"), 0o755);
    }
    expect(readFileSync(join(folder, "a.json"), "utf8")).toBe("A");
    expect(readFileSync(join(folder, "locked", "b.json"), "utf8")).toBe("B");
    expect(tree(folder)).toEqual(["a.json", "locked/", "locked/b.json"]);
  });

  test("atomicWriteProjectFiles: when the second rename fails the first target gets its old bytes back", () => {
    const folder = realpathSync(scratch("atomic-rollback"));
    writeFileSync(join(folder, "a.json"), "A");
    writeFileSync(join(folder, "b.json"), "B");
    const failing = failRenameOnto(join(folder, "b.json"));
    try {
      expect(() => atomicWriteProjectFiles([
        { path: join(folder, "a.json"), text: "A2", expectedSource: "A" },
        { path: join(folder, "b.json"), text: "B2", expectedSource: "B" },
      ])).toThrow(/cannot replace/);
      // a's rename, b's failed rename, a's rollback rename.
      expect(failing.calls()).toBe(3);
    } finally {
      failing.restore();
    }
    expect(readFileSync(join(folder, "a.json"), "utf8")).toBe("A");
    expect(readFileSync(join(folder, "b.json"), "utf8")).toBe("B");
    expect(readdirSync(folder).sort()).toEqual(["a.json", "b.json"]);
  });

  test("a folder save whose shell cannot be replaced puts the shard back, and a later save succeeds", async () => {
    const root = looseSunstone();
    const dir = new FsDirectory(root);
    const opened = await open(dir);
    const edited = paintThroughSession(opened.text);
    const before = snapshot(root);
    const failing = failRenameOnto(join(dir.root, "project.json"));
    let message: string;
    try {
      message = failed(await saveDirectoryTarget(opened.target, edited, SAVED_AT));
    } finally {
      failing.restore();
    }
    expect(message).toContain(`could not write ${VILLAGE}, project.json`);
    expect(message).toContain("cannot replace");
    expect(snapshot(root)).toEqual(before);
    expect(leftovers(root)).toEqual([]);

    // The baseline was not advanced: the same save now goes through.
    expect(written(await saveDirectoryTarget(opened.target, edited, SAVED_AT))).toEqual([VILLAGE, "project.json"]);
    expect((await open(new FsDirectory(root))).text).toBe(edited);
    expect(leftovers(root)).toEqual([]);
  });
});
