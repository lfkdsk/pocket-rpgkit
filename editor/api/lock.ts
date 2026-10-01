// Node-only advisory lock used by project-file and proposal-sidecar writers.
// A lock is a non-empty directory so acquisition and stale-owner reaping can
// both use atomic directory renames without a check/unlink race.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

const OWNER_FILE = "owner.json";
const UNKNOWN_OWNER_GRACE_MS = 30_000;

interface LockOwner {
  pid: number;
  token: string;
  createdAt: string;
}

interface LockSnapshot {
  owner: LockOwner | null;
  token: string;
  stale: boolean;
}

export class FileLockBusyError extends Error {
  readonly code = "FILE_LOCK_BUSY";

  constructor(readonly path: string) {
    super(`file lock is busy: ${path}`);
  }
}

function ownerPath(path: string): string {
  return lstatSync(path).isDirectory() ? join(path, OWNER_FILE) : path;
}

function validOwner(value: unknown): value is LockOwner {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as Partial<LockOwner>;
  return typeof owner.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0 &&
    typeof owner.token === "string" && /^[A-Za-z0-9-]{1,128}$/.test(owner.token) &&
    typeof owner.createdAt === "string";
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function snapshot(path: string): LockSnapshot {
  const target = ownerPath(path);
  let raw = "";
  try {
    raw = readFileSync(target, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (validOwner(parsed)) {
      return { owner: parsed, token: parsed.token, stale: !processAlive(parsed.pid) };
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const legacy = parsed as { pid?: unknown };
      if (typeof legacy.pid === "number" && Number.isInteger(legacy.pid) && legacy.pid > 0) {
        const token = `legacy-${createHash("sha256").update(raw).digest("hex").slice(0, 24)}`;
        return { owner: null, token, stale: !processAlive(legacy.pid) };
      }
    }
  } catch {
    // A creator from an older version may have left a malformed regular-file
    // lock. Give an unknown owner a grace period before considering it stale.
  }
  const age = Date.now() - statSync(path).mtimeMs;
  const token = `unknown-${createHash("sha256").update(raw).digest("hex").slice(0, 24)}`;
  return { owner: null, token, stale: age >= UNKNOWN_OWNER_GRACE_MS };
}

function tryCreate(path: string, owner: LockOwner): boolean {
  const temporary = join(dirname(path), `.${basename(path)}.acquire-${owner.token}`);
  try {
    mkdirSync(temporary, { mode: 0o700 });
    writeFileSync(join(temporary, OWNER_FILE), JSON.stringify(owner), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTEMPTY" || code === "ENOTDIR" || code === "EISDIR") return false;
    throw error;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Move exactly one stale token to a permanent, non-empty reaper tombstone.
 * Keeping that token-named destination prevents a delayed contender that saw
 * the old owner from ever renaming away a newly acquired lock. */
function reap(path: string, seen: LockSnapshot): boolean {
  const reaped = join(dirname(path), `.${basename(path)}.reaped-${seen.token}`);
  if (existsSync(reaped)) return false;
  try {
    renameSync(path, reaped);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY" || code === "ENOTDIR" || code === "EISDIR") return false;
    throw error;
  }
  // The atomic rename is the claim. Verify that it captured the stale token
  // observed above; a mismatch is retained as a tombstone and fails closed.
  const moved = snapshot(reaped);
  return moved.token === seen.token && moved.stale;
}

function release(path: string, token: string): void {
  if (!existsSync(path)) return;
  let current: LockSnapshot;
  try {
    current = snapshot(path);
  } catch {
    return;
  }
  if (current.token === token) rmSync(path, { recursive: true, force: true });
}

/** Run synchronously while owning `path`. Live owners fail fast. Dead owners
 * are reclaimed by token through an atomic reaper tombstone. */
export function withFileLock<T>(path: string, run: () => T): T {
  mkdirSync(dirname(path), { recursive: true });
  const owner: LockOwner = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    if (tryCreate(path, owner)) {
      try {
        return run();
      } finally {
        release(path, owner.token);
      }
    }
    let seen: LockSnapshot;
    try {
      seen = snapshot(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!seen.stale) throw new FileLockBusyError(path);
    if (!reap(path, seen) && existsSync(path)) {
      // Another reaper may have won and already installed a fresh live lock.
      continue;
    }
  }
  throw new FileLockBusyError(path);
}
