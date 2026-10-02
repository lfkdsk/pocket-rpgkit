// studio-desktop/src/fs-directory.ts — a ProjectDirectory
// (editor/studio/project-directory.ts) over node:fs, confined to one root the
// user picked. Runs in the Electron main process.
//
// Paths from Studio are POSIX and relative to the root. Absolute paths, `..`,
// backslashes and empty segments are refused before touching the disk, and
// the resolved path (symlinks followed) must still sit inside the root's real
// path. Saving goes through editor/api/file.ts: every changed file staged,
// rechecked and published in order under the shell's .rpgkit-edit.lock, the
// lock rpgkit-edit's CLI and MCP server take, so a Studio save never
// interleaves with an agent's or a script's direct edit.

import { lstatSync, realpathSync } from "node:fs";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { atomicWriteProjectFiles, withProjectFileLock } from "../../editor/api/file.ts";
import type { ProjectDirectory } from "../../editor/studio/project-directory.ts";

/** Refuse anything but a plain relative POSIX path. */
export function checkRelative(path: string): string[] {
  if (typeof path !== "string" || path.length === 0 || path.length > 1024) throw new Error("bad path");
  if (path.includes("\\") || path.includes("\0") || path.startsWith("/") || isAbsolute(path)) {
    throw new Error(`${JSON.stringify(path)} is not a relative path inside the project folder`);
  }
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${JSON.stringify(path)} is not a relative path inside the project folder`);
  }
  return parts;
}

function inside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

export class FsDirectory implements ProjectDirectory {
  readonly name: string;
  /** The root's real path; every file Studio touches resolves inside it. */
  readonly root: string;
  /** The shell's relative path, set once the folder is opened; saves lock it. */
  shellPath = "project.json";

  constructor(root: string) {
    this.root = realpathSync(root);
    this.name = `${basename(this.root)}/`;
  }

  /** The absolute path for `path`, checked against the root. A file that
   * exists is resolved through symlinks; a new one through its folder. A
   * name that exists but cannot be resolved (a dangling symlink) is refused:
   * writing to it would follow the link wherever it points. */
  resolve(path: string): string {
    const parts = checkRelative(path);
    const joined = join(this.root, ...parts);
    let real: string;
    try {
      real = realpathSync(joined);
    } catch {
      let exists = true;
      try {
        lstatSync(joined);
      } catch {
        exists = false;
      }
      if (exists) throw new Error(`${path} is a link Studio cannot follow inside ${this.name}`);
      real = join(realpathSync(join(this.root, ...parts.slice(0, -1))), parts.at(-1)!);
    }
    if (!inside(this.root, real)) throw new Error(`${path} resolves outside ${this.name}`);
    return real;
  }

  async listRoot(): Promise<string[]> {
    return (await readdir(this.root, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name);
  }

  async read(path: string): Promise<string> {
    return readFile(this.resolve(path), "utf8");
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const data = await readFile(this.resolve(path));
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  async size(path: string): Promise<number> {
    return (await stat(this.resolve(path))).size;
  }

  async write(path: string, text: string): Promise<void> {
    await writeFile(this.resolve(path), text, "utf8");
  }

  async remove(path: string): Promise<void> {
    await rm(this.resolve(path));
  }

  async rename(from: string, to: string): Promise<void> {
    await rename(this.resolve(from), this.resolve(to));
  }

  async commit(writes: readonly { path: string; text: string; expected: string }[]): Promise<void> {
    const replacements = writes.map((write) => ({ path: this.resolve(write.path), text: write.text, expectedSource: write.expected }));
    withProjectFileLock(this.resolve(this.shellPath), () => atomicWriteProjectFiles(replacements));
  }
}
