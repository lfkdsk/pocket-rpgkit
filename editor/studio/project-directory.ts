// editor/studio/project-directory.ts — open and save a sharded project kept
// as loose files: a ProjectShell (usually project.json) plus one file per map
// at the shell's mapIndex entries, relative to the shell.
//
// Studio edits a sharded project as a pack (editor/api/pack.ts). This module
// turns a directory into that pack and writes a saved pack back as files:
// only the shards whose text changed, then the shell. Before writing it
// re-reads every file it will replace and refuses if any changed on disk
// since it was read. Saving stages every new file as a temporary sibling
// first and rolls back on a failed replacement (see saveProjectDirectory).
// The directory itself is an interface, so the browser host (File System
// Access handles), a desktop host (node:fs) and tests (a Map) share this code.

import { assertPackEntry, parseShardedPack, serializeShardedPack } from "../api/pack.ts";
import {
  packFileProblem,
  projectFileProblem,
  shardCountProblem,
  shardProblem,
  utf8Bytes,
} from "../api/limits.ts";
import { loadValidatedProjectShell, sourceDeclaresProjectShell } from "../api/sharded.ts";
import type { OpenedProject, SaveOutcome, SaveTarget } from "./host.ts";

/** POSIX-relative paths inside one project directory. */
export interface ProjectDirectory {
  readonly name: string;
  /** File names (not directories) directly inside the root. */
  listRoot(): Promise<string[]>;
  read(path: string): Promise<string>;
  /** A file's size in bytes, read before the file itself so oversized
   * input is refused without loading it. */
  size(path: string): Promise<number>;
  /** Replace `path`, or create it if it does not exist yet (staging writes
   * new temporary files next to their targets). */
  write(path: string, text: string): Promise<void>;
  /** Delete the file at `path`. */
  remove(path: string): Promise<void>;
  /** Move the file `from` onto `to`, replacing `to`. Hosts that can rename
   * (ideally atomically) provide it; without it a save writes each target
   * directly from the text it already staged once. */
  rename?(from: string, to: string): Promise<void>;
}

/** What a directory save compares against: the bytes last read or written. */
export interface DirectoryBaseline {
  shellPath: string;
  shellText: string;
  shards: Map<string, string>;
}

export interface OpenedDirectory {
  /** A sharded pack holding the shell and every shard, for EditSession. */
  packText: string;
  baseline: DirectoryBaseline;
  shardCount: number;
}

/** The shell names Studio looks for, in order. */
export const SHELL_NAMES = ["project.json", "game.json"] as const;

/** Join a shard entry onto the shell's own directory. */
export function shardPath(shellPath: string, entry: string): string {
  assertPackEntry(entry);
  const slash = shellPath.lastIndexOf("/");
  return slash < 0 ? entry : `${shellPath.slice(0, slash + 1)}${entry}`;
}

/** Find the ProjectShell at the root, reading exactly one file: the first
 * of SHELL_NAMES that exists, else the only top-level JSON file. Any other
 * top-level JSON may be a map shard of that shell, so it is never read here;
 * shards are read only after openProjectDirectory has checked their sizes. */
export async function findShell(dir: ProjectDirectory): Promise<{ path: string; text: string; bytes: number }> {
  const names = (await dir.listRoot()).filter((name) => name.toLowerCase().endsWith(".json")).sort();
  const path = SHELL_NAMES.find((name) => names.includes(name)) ?? (names.length === 1 ? names[0]! : undefined);
  if (path === undefined) {
    throw new Error(names.length === 0
      ? `${dir.name} has no JSON file at its top level, so it has no project shell. Use Open file for single-file projects and packs.`
      : `${dir.name} has ${names.length} JSON files at its top level (${names.join(", ")}) and none is named ${SHELL_NAMES.join(" or ")}, so Studio cannot tell which is the project shell; name the shell project.json.`);
  }
  const bytes = await dir.size(path);
  const tooBig = projectFileProblem(bytes, path);
  if (tooBig !== null) throw new Error(`${dir.name}: ${tooBig}`);
  const text = await dir.read(path);
  if (!sourceDeclaresProjectShell(text)) {
    throw new Error(`${dir.name}: ${path} is not a project shell (a JSON file with a mapIndex). Use Open file for single-file projects and packs.`);
  }
  return { path, text, bytes };
}

/** Read a directory as a pack, in two steps. First findShell reads the
 * shell and nothing else. Then limits (editor/api/limits.ts) are checked
 * from file sizes before any shard is read: the shard count, each shard's
 * size and the shell plus all shards against the pack limit. Only then are
 * the shards read.
 *
 * A folder's 64 MiB limit is the size of the pack Studio edits, the shell
 * and shard texts as JSON strings in one file (EditSession refuses a larger
 * pack). That pack is always a little bigger than the files themselves (keys,
 * indentation, escaped quotes and newlines), so the files' total is a lower
 * bound checked before reading, and the pack's own size after it. A folder
 * this accepts always opens. */
export async function openProjectDirectory(dir: ProjectDirectory): Promise<OpenedDirectory> {
  const { path: shellPath, text: shellText, bytes: shellBytes } = await findShell(dir);
  const shell = loadValidatedProjectShell(shellText);
  const tooMany = shardCountProblem(shell.mapIndex.length);
  if (tooMany !== null) throw new Error(`${dir.name}: ${tooMany}`);
  const paths = shell.mapIndex.map((meta) => shardPath(shellPath, meta.entry));
  let total = shellBytes;
  for (const path of paths) {
    let bytes: number;
    try {
      bytes = await dir.size(path);
    } catch (error) {
      throw new Error(`${dir.name}: cannot read shard ${path} (${message(error)})`);
    }
    const tooBig = shardProblem(path, bytes);
    if (tooBig !== null) throw new Error(`${dir.name}: ${tooBig}`);
    total += bytes;
  }
  const what = `the project (${shellPath} and ${paths.length} map file${paths.length === 1 ? "" : "s"})`;
  const overBudget = packFileProblem(total, what);
  if (overBudget !== null) throw new Error(`${dir.name}: ${overBudget}`);
  const shards = new Map<string, string>();
  for (const [index, meta] of shell.mapIndex.entries()) {
    const path = paths[index]!;
    try {
      shards.set(meta.entry, await dir.read(path));
    } catch (error) {
      throw new Error(`${dir.name}: cannot read shard ${path} (${message(error)})`);
    }
  }
  const packText = serializeShardedPack(shellText, shell.mapIndex, shards);
  const packed = packFileProblem(utf8Bytes(packText), `${what} as one sharded pack`);
  if (packed !== null) throw new Error(`${dir.name}: ${packed}`);
  return {
    packText,
    baseline: { shellPath, shellText, shards },
    shardCount: shards.size,
  };
}

/** Marks the temporary siblings a save stages: `<target>.rpgkit-save-<id>.tmp`. */
export const STAGING_MARKER = ".rpgkit-save-";

/** Whether `path` names a temporary file staged by saveProjectDirectory. */
export function isStagingPath(path: string): boolean {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  return name.includes(STAGING_MARKER) && name.endsWith(".tmp");
}

interface PlannedWrite {
  path: string;
  text: string;
  /** The bytes on disk before this save: the baseline. */
  expected: string;
  /** The staged temporary sibling, while it exists. */
  temp?: string;
}

/** A temporary sibling name for `path` that is not already a file. */
async function freeStagingPath(dir: ProjectDirectory, path: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = `${path}${STAGING_MARKER}${Math.random().toString(36).slice(2, 10)}.tmp`;
    try {
      await dir.read(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error(`cannot find a free temporary name next to ${path}`);
}

/** Remove every staged file still present; returns the ones that stayed. */
async function removeTemps(dir: ProjectDirectory, writes: readonly PlannedWrite[]): Promise<string[]> {
  const left: string[] = [];
  for (const write of writes) {
    if (write.temp === undefined) continue;
    try {
      await dir.remove(write.temp);
    } catch {
      // A temporary that cannot be read either is already gone (for
      // example a staging write that failed before creating it).
      const gone = await dir.read(write.temp).then(() => false, () => true);
      if (!gone) {
        left.push(write.temp);
        continue;
      }
    }
    write.temp = undefined;
  }
  return left;
}

function leftoverNote(left: readonly string[]): string {
  return left.length === 0 ? "" : `; temporary file${left.length === 1 ? "" : "s"} ${left.join(", ")} could not be removed and can be deleted`;
}

/** Write a saved pack back into its directory. Returns the paths written,
 * shards first and the shell last, and the new baseline.
 *
 * 1. Check: re-read every file to replace; any that differs from the
 *    baseline (and is not already the new text) stops the save before
 *    anything is written.
 * 2. Stage: write each new text to a temporary sibling and read it back.
 *    A failure here removes the temporaries; nothing was replaced.
 * 3. Commit: replace the targets one by one, shards first and the shell
 *    (which indexes the shards) last, by renaming the temporary onto the
 *    target, or by writing the target directly when the host cannot rename.
 *    If a replacement fails, the targets already replaced get their previous
 *    text written back, and the error says whether that worked.
 * 4. Remove the temporaries.
 *
 * This is NOT crash-atomic: a browser offers no multi-file atomic rename, so
 * a crash, power loss or closed tab between two replacements can still leave
 * new shards next to an old shell. What it guarantees is narrower: a write
 * that fails (permission, quota, a vanished file) no longer leaves a
 * half-saved project, and the caller's baseline is only replaced on success.
 *
 * Saves into the same directory run one at a time (withDirectoryLock): two
 * overlapping saves would otherwise check against the same baseline, and a
 * failing one could roll back files the other had just committed. */
export function saveProjectDirectory(dir: ProjectDirectory, baseline: DirectoryBaseline, packText: string): Promise<SavedDirectory> {
  return withDirectoryLock(dir, () => saveLocked(dir, baseline, packText));
}

export interface SavedDirectory {
  written: string[];
  baseline: DirectoryBaseline;
}

const directoryLocks = new WeakMap<ProjectDirectory, Promise<unknown>>();

/** Run `task` once every earlier task on `dir` has settled, so a whole
 * check-stage-commit-cleanup cycle never overlaps another one. */
export function withDirectoryLock<T>(dir: ProjectDirectory, task: () => Promise<T>): Promise<T> {
  const run = (directoryLocks.get(dir) ?? Promise.resolve()).then(task);
  const settled = run.then(() => undefined, () => undefined);
  directoryLocks.set(dir, settled);
  // Drop the entry once the queue drains so an idle directory holds nothing.
  void settled.then(() => {
    if (directoryLocks.get(dir) === settled) directoryLocks.delete(dir);
  });
  return run;
}

async function saveLocked(dir: ProjectDirectory, baseline: DirectoryBaseline, packText: string): Promise<SavedDirectory> {
  const pack = parseShardedPack(packText);
  const before = new Set(baseline.shards.keys());
  const after = new Set(pack.shards.keys());
  if (before.size !== after.size || [...after].some((entry) => !before.has(entry))) {
    throw new Error("this save adds, removes or renames shard files, which saving in place does not support yet; download the pack instead");
  }
  const changed = [...pack.shards].filter(([entry, text]) => baseline.shards.get(entry) !== text);
  const shellChanged = pack.shellText !== baseline.shellText;
  const planned: PlannedWrite[] = changed.map(([entry, text]) => ({
    path: shardPath(baseline.shellPath, entry),
    text,
    expected: baseline.shards.get(entry)!,
  }));
  if (shellChanged) planned.push({ path: baseline.shellPath, text: pack.shellText, expected: baseline.shellText });

  // 1. Check. A file that already holds the new text (say, left behind by an
  // earlier save whose rollback failed) needs no write.
  const writes: PlannedWrite[] = [];
  for (const write of planned) {
    let current: string;
    try {
      current = await dir.read(write.path);
    } catch (error) {
      throw new Error(`cannot re-read ${write.path} before saving (${message(error)})`);
    }
    if (current === write.text) continue;
    if (current !== write.expected) throw new Error(`${write.path} changed on disk since it was opened; nothing was written`);
    writes.push(write);
  }

  // 2. Stage.
  for (const write of writes) {
    let temp: string | undefined;
    try {
      temp = await freeStagingPath(dir, write.path);
      await dir.write(temp, write.text);
      write.temp = temp;
      if ((await dir.read(temp)) !== write.text) throw new Error("the temporary copy read back different bytes");
    } catch (error) {
      // A failed write may still have created the file.
      write.temp ??= temp;
      const left = await removeTemps(dir, writes);
      throw new Error(`could not write a temporary copy of ${write.path} (${message(error)}); nothing was replaced and the folder still holds the previous version${leftoverNote(left)}`);
    }
  }

  // 3. Commit, shell last.
  const committed: PlannedWrite[] = [];
  for (const write of writes) {
    try {
      // After a rename the temporary is normally gone; removeTemps still
      // checks, since a host may fall back to copying.
      if (dir.rename) {
        await dir.rename(write.temp!, write.path);
      } else {
        await dir.write(write.path, write.text);
      }
      committed.push(write);
    } catch (error) {
      throw new Error(await rollBack(dir, writes, committed, write, error));
    }
  }

  // 4. Clean up. Every target holds its new text, so a temporary that will
  // not go away is only clutter; the save itself succeeded.
  await removeTemps(dir, writes);
  return {
    written: writes.map((write) => write.path),
    baseline: { shellPath: baseline.shellPath, shellText: pack.shellText, shards: new Map(pack.shards) },
  };
}

/** Put back the previous text of every target this save touched and explain
 * the outcome. Returns the error message for the failed save. */
async function rollBack(dir: ProjectDirectory, writes: readonly PlannedWrite[], committed: readonly PlannedWrite[], failed: PlannedWrite, cause: unknown): Promise<string> {
  const failure = `replacing ${failed.path} failed (${message(cause)})`;
  // The failed target is restored too if the failed replacement left it changed.
  const touched: PlannedWrite[] = [...committed];
  try {
    if ((await dir.read(failed.path)) !== failed.expected) touched.push(failed);
  } catch {
    touched.push(failed);
  }
  const inconsistent: string[] = [];
  for (const write of [...touched].reverse()) {
    try {
      await dir.write(write.path, write.expected);
    } catch {
      inconsistent.push(write.path);
    }
  }
  const left = await removeTemps(dir, writes);
  if (inconsistent.length > 0) {
    inconsistent.reverse();
    return `${failure}, and restoring the previous version also failed, so ${inconsistent.join(", ")} may now hold the new version while the other files hold the previous one; save again to finish the save, or reopen the folder${leftoverNote(left)}`;
  }
  const restored = touched.map((write) => write.path);
  return `${failure}; ${restored.length === 0 ? "nothing had been replaced" : `restored ${restored.join(", ")}`}, so the folder still holds the previous version${leftoverNote(left)}`;
}

// ---- host glue: the same steps for every host -------------------------------------

interface DirectoryRef {
  dir: ProjectDirectory;
  baseline: DirectoryBaseline;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Open `dir` as a document whose Save writes back into it. */
export async function openDirectoryProject(dir: ProjectDirectory): Promise<OpenedProject | { error: string }> {
  try {
    const opened = await openProjectDirectory(dir);
    const ref: DirectoryRef = { dir, baseline: opened.baseline };
    return {
      text: opened.packText,
      label: dir.name,
      fileName: `${dir.name.replace(/\/$/, "")}-pack.json`,
      target: { kind: "directory", name: dir.name, ref },
    };
  } catch (error) {
    return { error: `Could not open ${dir.name}: ${message(error)}` };
  }
}

/** Save into a target made by openDirectoryProject. Overlapping calls run
 * one after another. */
export async function saveDirectoryTarget(target: SaveTarget, text: string, savedAt: string): Promise<SaveOutcome> {
  const ref = target.ref as DirectoryRef;
  try {
    // The baseline is read and replaced inside the lock: a save queued
    // behind another compares against what that one wrote (or, if it
    // failed, the baseline it left in place).
    const result = await withDirectoryLock(ref.dir, async () => {
      const saved = await saveLocked(ref.dir, ref.baseline, text);
      ref.baseline = saved.baseline;
      return saved;
    });
    return { ok: true, where: "directory", written: result.written, savedAt };
  } catch (error) {
    return { ok: false, message: `Not saved to ${target.name}: ${message(error)}` };
  }
}
