// editor/api/file.ts — synchronous, atomic file adapter shared by CLI + MCP.

import {
  chmodSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { executeEditOperation } from "./operations.ts";
import type { FileEditResponse } from "./types.ts";
import { FileLockBusyError, withFileLock } from "./lock.ts";

export interface FileEditRequest {
  command: string;
  file: string;
  args?: unknown;
  dryRun?: boolean;
  /** Optional MCP safety boundary. Symlinks are resolved before this check. */
  root?: string;
}

function ioFailure(
  command: string,
  file: string,
  dryRun: boolean,
  code: "READ_FAILED" | "WRITE_FAILED" | "WRITE_CONFLICT" | "PATH_OUTSIDE_ROOT",
  error: unknown,
): FileEditResponse {
  return {
    ok: false,
    command,
    file,
    dryRun,
    written: false,
    error: {
      code,
      message: `${code === "READ_FAILED" ? "could not read" : code === "PATH_OUTSIDE_ROOT" ? "path is outside the configured project root" : code === "WRITE_CONFLICT" ? "file changed before it could be saved" : "could not atomically write"} ${file}: ${error instanceof Error ? error.message : String(error)}`,
      path: file,
    },
  };
}

export class WriteConflictError extends Error {}

export function projectFileLockPath(path: string): string {
  return `${path}.rpgkit-edit.lock`;
}

/** Serialize cooperating direct edits and proposal acceptance across the
 * complete compare-and-replace window. */
export function withProjectFileLock<T>(path: string, run: () => T): T {
  try {
    return withFileLock(projectFileLockPath(path), run);
  } catch (error) {
    if (error instanceof FileLockBusyError) {
      throw new WriteConflictError("another writer currently owns the project file lock");
    }
    throw error;
  }
}

/** Atomically replace one project file only while its source bytes still
 * match the revision the caller read. Shared by direct edits and proposal
 * acceptance so neither path can silently overwrite a newer revision. */
export function atomicWriteProjectFile(path: string, text: string, expectedSource: string): void {
  const mode = statSync(path).mode;
  const temporary = `${path}.rpgkit-edit-${process.pid}-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { encoding: "utf8", flag: "wx", mode });
    chmodSync(temporary, mode);
    if (readFileSync(path, "utf8") !== expectedSource) {
      throw new WriteConflictError("on-disk bytes no longer match the edited revision");
    }
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** Read, execute, and (for effective mutations) atomically replace a file.
 * Dry-run follows the exact validation/diff path but never reaches the write. */
export function runFileEdit(request: FileEditRequest): FileEditResponse {
  const requestedFile = resolve(request.file);
  const dryRun = request.dryRun === true;
  let file: string;
  let source: string;
  try {
    // Resolve the final component before replacement so editing a symlink
    // updates its target rather than silently replacing the link itself.
    file = realpathSync(requestedFile);
    if (request.root !== undefined) {
      const root = realpathSync(resolve(request.root));
      const fromRoot = relative(root, file);
      if (fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromRoot)) {
        return ioFailure(request.command, file, dryRun, "PATH_OUTSIDE_ROOT", new Error(`configured root is ${root}`));
      }
    }
    source = readFileSync(file, "utf8");
  } catch (error) {
    return ioFailure(request.command, requestedFile, dryRun, "READ_FAILED", error);
  }

  const execution = executeEditOperation(source, request.command, request.args);
  if (!execution.response.ok) {
    return { ...execution.response, file, dryRun, written: false };
  }

  let written = false;
  if (!dryRun && execution.response.changed && execution.output !== undefined) {
    try {
      withProjectFileLock(file, () => atomicWriteProjectFile(file, execution.output!, source));
      written = true;
    } catch (error) {
      return ioFailure(
        request.command,
        file,
        dryRun,
        error instanceof WriteConflictError ? "WRITE_CONFLICT" : "WRITE_FAILED",
        error,
      );
    }
  }
  return { ...execution.response, file, dryRun, written };
}
