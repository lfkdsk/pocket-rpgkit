// tools/editor-files.ts — filesystem companion for sharded editor projects.
//
// The PocketJS desktop host is the PKNT client when launched with
// `--svc-connect`. This module supplies the listening side without adding a
// project-specific adapter to PocketJS: it sends the ProjectShell at connect,
// reads map shards on request, and commits targeted multi-file saves.

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  MAP_SCHEMA_HASH,
  assertShellManifestFresh,
  sha256Text,
  validateMapDef,
  validateMapIndex,
} from "../src/engine/map-repository.ts";
import { validateSchema } from "../src/engine/schema-validate.ts";
import type { MapIndexEntry, ProjectShell } from "../src/engine/types.ts";
import PROJECT_SCHEMA from "../src/data/schema.json";
import {
  runDesktopHost,
  type DesktopBuild,
} from "./lib/desktop.ts";
import { createSvcWireAuthToken } from "./lib/svc-wire-auth.ts";

const SHA256_HEX = /^[0-9a-f]{64}$/;

// PocketJS contracts/spec/spec.ts, SVC WIRE (PKNT). Kept local so the
// companion does not import or modify host internals.
const PKNT_MAGIC = 0x544e4b50;
const PKNT_VERSION = 1;
const PKNT_HEADER_BYTES = 8;
const PKNT_MAX_PAYLOAD = 256 * 1024;
const PKNT_PING = 0x01;
const PKNT_PONG = 0x02;
const PKNT_CTRL = 0x10;
const CTRL_MAX_BYTES = 8192;
const CHUNK_CODE_UNITS = 1024;
const CHUNK_MAX_COUNT = 8192;
const LOGICAL_MAX_CODE_UNITS = 8 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

export interface ProjectMessage {
  t: "project";
  shell: string;
  request?: number;
}

export interface MapReadMessage {
  t: "map-read";
  request: number;
  entry: string;
}

export interface MapDataMessage {
  t: "map-data";
  request: number;
  entry: string;
  text: string;
}

export interface MapErrorMessage {
  t: "map-error";
  request: number;
  entry: string;
  error: string;
}

export interface ProjectSaveShard {
  entry: string;
  text: string;
  expectedSha256: string;
}

export interface ProjectSaveMessage {
  t: "project-save";
  request: number;
  baseManifestHash: string;
  shell: string;
  shards: ProjectSaveShard[];
}

export interface ProjectSavedMessage {
  t: "project-saved";
  request: number;
  ok: boolean;
  error?: string;
}

export type EditorFilesRequest = MapReadMessage | ProjectSaveMessage | JsonRecord;
export type EditorFilesReply = MapDataMessage | MapErrorMessage | ProjectSavedMessage;

export type EditorFilesErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_PROJECT"
  | "PATH_OUTSIDE_ROOT"
  | "ENTRY_NOT_FOUND"
  | "READ_FAILED"
  | "READ_CONFLICT"
  | "WRITE_CONFLICT"
  | "WRITE_FAILED";

export class EditorFilesError extends Error {
  constructor(
    readonly code: EditorFilesErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EditorFilesError";
  }
}

/** Test/diagnostic hook. Throwing before a commit rename exercises rollback;
 * production callers normally omit it. */
export interface EditorFilesHooks {
  beforeRename?(
    path: string,
    kind: "shard" | "shell",
    phase: "commit" | "rollback",
  ): void;
}

export interface EditorFilesOptions {
  /** Every shell and shard path must resolve beneath this directory. The
   * shell's real parent directory is the default. */
  root?: string;
  hooks?: EditorFilesHooks;
}

interface ParsedShell {
  value: ProjectShell;
  entries: Map<string, MapIndexEntry>;
}

interface SaveTarget {
  kind: "shard" | "shell";
  path: string;
  expected: string;
  replacement: string;
}

interface StagedTarget extends SaveTarget {
  replacementTemp: string;
  rollbackTemp: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requestNumber(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function errorText(error: unknown, fallback: EditorFilesErrorCode): string {
  const known = error instanceof EditorFilesError
    ? error
    : new EditorFilesError(fallback, error instanceof Error ? error.message : String(error));
  return `${known.code}: ${known.message}`;
}

function inside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(fromRoot));
}

function parseShell(source: string, label: string): ParsedShell {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new EditorFilesError(
      "INVALID_PROJECT",
      `${label} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const errors = validateSchema(PROJECT_SCHEMA, parsed);
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new EditorFilesError("INVALID_PROJECT", `${label} ${first.path}: ${first.msg}`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.mapIndex) || "maps" in parsed) {
    throw new EditorFilesError("INVALID_PROJECT", `${label} must be a ProjectShell`);
  }
  const shell = parsed as unknown as ProjectShell;
  if (shell.mapSchemaHash !== undefined && shell.mapSchemaHash !== MAP_SCHEMA_HASH) {
    throw new EditorFilesError("INVALID_PROJECT", `${label} mapSchemaHash does not match this RPG Kit build`);
  }
  if (typeof shell.mapManifestHash !== "string") {
    throw new EditorFilesError("INVALID_PROJECT", `${label} must declare mapManifestHash`);
  }
  try {
    validateMapIndex(shell.mapIndex);
    assertShellManifestFresh(shell);
  } catch (error) {
    throw new EditorFilesError(
      "INVALID_PROJECT",
      `${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    value: shell,
    entries: new Map(shell.mapIndex.map((entry) => [entry.entry, entry])),
  };
}

function sameMeta(a: MapIndexEntry, b: MapIndexEntry): boolean {
  return a.id === b.id && a.width === b.width && a.height === b.height &&
    a.entry === b.entry && a.sha256 === b.sha256;
}

function temporaryPath(path: string, purpose: "next" | "rollback"): string {
  return `${path}.rpgkit-editor-${purpose}-${process.pid}-${randomUUID()}.tmp`;
}

function writeTemporary(path: string, text: string, mode: number): void {
  writeFileSync(path, text, { encoding: "utf8", flag: "wx", mode });
  chmodSync(path, mode);
}

/** Root-confined, synchronous core. It is deliberately independent of the
 * socket listener so file and transaction behavior can be tested directly. */
export class EditorFiles {
  readonly root: string;
  readonly shellFile: string;
  readonly shellDirectory: string;

  private shellSource: string;
  private shell: ProjectShell;
  private entries: Map<string, MapIndexEntry>;
  private readonly hooks: EditorFilesHooks;

  constructor(shellFile: string, options: EditorFilesOptions = {}) {
    let resolvedShell: string;
    let resolvedRoot: string;
    try {
      resolvedShell = realpathSync(resolve(shellFile));
      resolvedRoot = options.root === undefined
        ? realpathSync(dirname(resolvedShell))
        : realpathSync(resolve(options.root));
    } catch (error) {
      throw new EditorFilesError(
        "READ_FAILED",
        `could not resolve project shell/root: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!inside(resolvedRoot, resolvedShell)) {
      throw new EditorFilesError(
        "PATH_OUTSIDE_ROOT",
        `project shell ${resolvedShell} is outside configured root ${resolvedRoot}`,
      );
    }
    this.root = resolvedRoot;
    this.shellFile = resolvedShell;
    this.shellDirectory = dirname(resolvedShell);
    this.hooks = options.hooks ?? {};
    try {
      this.shellSource = readFileSync(resolvedShell, "utf8");
    } catch (error) {
      throw new EditorFilesError(
        "READ_FAILED",
        `could not read project shell ${resolvedShell}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const opened = parseShell(this.shellSource, "project shell");
    this.shell = opened.value;
    this.entries = opened.entries;
    this.validateCatalogPaths(this.entries);
  }

  /** The shell contains the complete map catalog; no shard is read here. */
  project(request?: number): ProjectMessage {
    return {
      t: "project",
      shell: this.shellSource,
      ...(request === undefined ? {} : { request }),
    };
  }

  /** Dispatch one decoded guest control message. Input/mouse lines never
   * reach the companion; unknown editor messages are ignored. */
  handle(message: unknown): EditorFilesReply | null {
    if (!isRecord(message)) return null;
    if (message.t === "map-read") return this.readMap(message);
    if (message.t === "project-save") return this.saveProject(message);
    return null;
  }

  private readMap(message: JsonRecord): MapDataMessage | MapErrorMessage {
    const request = requestNumber(message.request);
    const entry = typeof message.entry === "string" ? message.entry : "";
    try {
      if (request !== message.request || entry.length === 0) {
        throw new EditorFilesError("INVALID_REQUEST", "map-read needs a non-negative integer request and entry");
      }
      const meta = this.entries.get(entry);
      if (!meta) throw new EditorFilesError("ENTRY_NOT_FOUND", `shell does not index ${JSON.stringify(entry)}`);
      const path = this.resolveEntry(entry);
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (error) {
        throw new EditorFilesError(
          "READ_FAILED",
          `could not read ${entry}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const actual = sha256Text(text);
      if (actual !== meta.sha256) {
        throw new EditorFilesError(
          "READ_CONFLICT",
          `${entry} checksum is ${actual}, shell expects ${meta.sha256}`,
        );
      }
      return { t: "map-data", request, entry, text };
    } catch (error) {
      return { t: "map-error", request, entry, error: errorText(error, "READ_FAILED") };
    }
  }

  private saveProject(message: JsonRecord): ProjectSavedMessage {
    const request = requestNumber(message.request);
    try {
      const save = this.parseSave(message);
      this.commitSave(save);
      return { t: "project-saved", request, ok: true };
    } catch (error) {
      return {
        t: "project-saved",
        request,
        ok: false,
        error: errorText(error, "WRITE_FAILED"),
      };
    }
  }

  private parseSave(message: JsonRecord): ProjectSaveMessage {
    if (requestNumber(message.request) !== message.request ||
      typeof message.baseManifestHash !== "string" ||
      typeof message.shell !== "string" || !Array.isArray(message.shards)) {
      throw new EditorFilesError(
        "INVALID_REQUEST",
        "project-save needs request, baseManifestHash, shell, and a shards array",
      );
    }
    if (!SHA256_HEX.test(message.baseManifestHash)) {
      throw new EditorFilesError("INVALID_REQUEST", "baseManifestHash must be a lowercase SHA-256 digest");
    }
    const shards: ProjectSaveShard[] = message.shards.map((value, index) => {
      if (!isRecord(value) || typeof value.entry !== "string" ||
        typeof value.text !== "string" || typeof value.expectedSha256 !== "string" ||
        !SHA256_HEX.test(value.expectedSha256)) {
        throw new EditorFilesError(
          "INVALID_REQUEST",
          `project-save shards[${index}] needs entry, text, and expectedSha256`,
        );
      }
      return {
        entry: value.entry,
        text: value.text,
        expectedSha256: value.expectedSha256,
      };
    });
    return {
      t: "project-save",
      request: message.request,
      baseManifestHash: message.baseManifestHash,
      shell: message.shell,
      shards,
    };
  }

  private commitSave(save: ProjectSaveMessage): void {
    if (save.baseManifestHash !== this.shell.mapManifestHash) {
      throw new EditorFilesError(
        "WRITE_CONFLICT",
        `base manifest ${save.baseManifestHash} does not match opened manifest ${this.shell.mapManifestHash}`,
      );
    }
    const currentShell = this.readCurrent(this.shellFile, "project shell");
    if (currentShell !== this.shellSource) {
      throw new EditorFilesError("WRITE_CONFLICT", "project shell changed after it was opened");
    }

    const next = parseShell(save.shell, "replacement shell");
    this.validateCatalogPaths(next.entries);
    const currentKeys = [...this.entries.keys()].sort();
    const nextKeys = [...next.entries.keys()].sort();
    if (currentKeys.length !== nextKeys.length || currentKeys.some((entry, i) => entry !== nextKeys[i])) {
      throw new EditorFilesError(
        "INVALID_PROJECT",
        "replacement shell must keep the opened mapIndex entry set stable",
      );
    }

    const supplied = new Map<string, ProjectSaveShard>();
    for (const shard of save.shards) {
      if (supplied.has(shard.entry)) {
        throw new EditorFilesError("INVALID_REQUEST", `duplicate shard ${JSON.stringify(shard.entry)}`);
      }
      supplied.set(shard.entry, shard);
    }
    for (const entry of currentKeys) {
      const before = this.entries.get(entry)!;
      const after = next.entries.get(entry)!;
      if (!sameMeta(before, after) && !supplied.has(entry)) {
        throw new EditorFilesError(
          "INVALID_PROJECT",
          `replacement shell changes ${JSON.stringify(entry)} without a shard payload`,
        );
      }
    }

    const prepared = new Map<string, { shard: ProjectSaveShard; path: string; current: string }>();
    for (const [entry, shard] of supplied) {
      const before = this.entries.get(entry);
      const after = next.entries.get(entry);
      if (!before || !after) {
        throw new EditorFilesError("ENTRY_NOT_FOUND", `shell does not index ${JSON.stringify(entry)}`);
      }
      if (shard.expectedSha256 !== before.sha256) {
        throw new EditorFilesError(
          "WRITE_CONFLICT",
          `${entry} expected checksum does not match the opened shell`,
        );
      }
      const path = this.resolveEntry(entry);
      const current = this.readCurrent(path, entry);
      const actual = sha256Text(current);
      if (actual !== shard.expectedSha256) {
        throw new EditorFilesError(
          "WRITE_CONFLICT",
          `${entry} checksum is ${actual}, expected ${shard.expectedSha256}`,
        );
      }
      const replacementHash = sha256Text(shard.text);
      if (replacementHash !== after.sha256) {
        throw new EditorFilesError(
          "INVALID_PROJECT",
          `${entry} replacement checksum is ${replacementHash}, replacement shell declares ${after.sha256}`,
        );
      }
      let map: unknown;
      try {
        map = JSON.parse(shard.text);
        validateMapDef(map);
      } catch (error) {
        throw new EditorFilesError(
          "INVALID_PROJECT",
          `${entry} replacement is invalid: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const typed = map as { id: string; width: number; height: number };
      if (typed.id !== after.id || typed.width !== after.width || typed.height !== after.height) {
        throw new EditorFilesError(
          "INVALID_PROJECT",
          `${entry} replacement metadata does not match replacement shell`,
        );
      }
      prepared.set(entry, { shard, path, current });
    }

    // The index order is the deterministic shard commit order. The shell is
    // always last, so it never advertises a shard that has not been replaced.
    const targets: SaveTarget[] = [];
    for (const meta of next.value.mapIndex) {
      const item = prepared.get(meta.entry);
      if (item && item.current !== item.shard.text) {
        targets.push({
          kind: "shard",
          path: item.path,
          expected: item.current,
          replacement: item.shard.text,
        });
      }
    }
    if (save.shell !== currentShell) {
      targets.push({
        kind: "shell",
        path: this.shellFile,
        expected: currentShell,
        replacement: save.shell,
      });
    }
    this.replaceTransaction(targets);

    // A successful acknowledgement advances the optimistic baseline for the
    // next edit/save in the same editor session.
    this.shellSource = save.shell;
    this.shell = next.value;
    this.entries = next.entries;
  }

  private replaceTransaction(targets: readonly SaveTarget[]): void {
    const staged: StagedTarget[] = [];
    try {
      for (const target of targets) {
        const mode = statSync(target.path).mode;
        const replacementTemp = temporaryPath(target.path, "next");
        const rollbackTemp = temporaryPath(target.path, "rollback");
        try {
          writeTemporary(replacementTemp, target.replacement, mode);
          writeTemporary(rollbackTemp, target.expected, mode);
        } catch (error) {
          rmSync(replacementTemp, { force: true });
          rmSync(rollbackTemp, { force: true });
          throw error;
        }
        staged.push({ ...target, replacementTemp, rollbackTemp });
      }
    } catch (error) {
      for (const item of staged) {
        rmSync(item.replacementTemp, { force: true });
        rmSync(item.rollbackTemp, { force: true });
      }
      throw new EditorFilesError(
        "WRITE_FAILED",
        `could not stage project save: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const committed: StagedTarget[] = [];
    let failure: unknown;
    try {
      for (const item of staged) {
        // Recheck exact source bytes immediately before each atomic replace.
        if (this.readCurrent(item.path, item.kind === "shell" ? "project shell" : item.path) !== item.expected) {
          throw new EditorFilesError("WRITE_CONFLICT", `${item.path} changed while the save was staged`);
        }
        this.hooks.beforeRename?.(item.path, item.kind, "commit");
        renameSync(item.replacementTemp, item.path);
        committed.push(item);
      }
    } catch (error) {
      failure = error;
    }

    if (failure !== undefined) {
      const rollbackErrors: string[] = [];
      for (const item of committed.reverse()) {
        try {
          this.hooks.beforeRename?.(item.path, item.kind, "rollback");
          renameSync(item.rollbackTemp, item.path);
        } catch (error) {
          rollbackErrors.push(`${item.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      for (const item of staged) {
        rmSync(item.replacementTemp, { force: true });
        rmSync(item.rollbackTemp, { force: true });
      }
      if (rollbackErrors.length > 0) {
        throw new EditorFilesError(
          "WRITE_FAILED",
          `${errorText(failure, "WRITE_FAILED")}; rollback failed: ${rollbackErrors.join("; ")}`,
        );
      }
      if (failure instanceof EditorFilesError) throw failure;
      throw new EditorFilesError(
        "WRITE_FAILED",
        `could not commit project save: ${failure instanceof Error ? failure.message : String(failure)}`,
      );
    }

    for (const item of staged) {
      rmSync(item.rollbackTemp, { force: true });
    }
  }

  private validateCatalogPaths(entries: ReadonlyMap<string, MapIndexEntry>): void {
    for (const entry of entries.keys()) this.lexicalEntryPath(entry);
  }

  private lexicalEntryPath(entry: string): string {
    if (entry.length === 0 || entry.includes("\0")) {
      throw new EditorFilesError("PATH_OUTSIDE_ROOT", `invalid shard entry ${JSON.stringify(entry)}`);
    }
    const path = resolve(this.shellDirectory, entry);
    if (!inside(this.root, path) || path === this.shellFile) {
      throw new EditorFilesError(
        "PATH_OUTSIDE_ROOT",
        `shard entry ${JSON.stringify(entry)} escapes the configured root or aliases the shell`,
      );
    }
    return path;
  }

  private resolveEntry(entry: string): string {
    const lexical = this.lexicalEntryPath(entry);
    let path: string;
    try {
      path = realpathSync(lexical);
    } catch (error) {
      throw new EditorFilesError(
        "READ_FAILED",
        `could not resolve ${entry}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!inside(this.root, path) || path === this.shellFile) {
      throw new EditorFilesError(
        "PATH_OUTSIDE_ROOT",
        `shard entry ${JSON.stringify(entry)} resolves outside the configured root or aliases the shell`,
      );
    }
    return path;
  }

  private readCurrent(path: string, label: string): string {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      throw new EditorFilesError(
        "READ_FAILED",
        `could not read ${label}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function encodeFrame(kind: number, payload: Uint8Array): Buffer {
  if (payload.byteLength > PKNT_MAX_PAYLOAD) {
    throw new EditorFilesError("INVALID_REQUEST", `PKNT payload is ${payload.byteLength} bytes (max ${PKNT_MAX_PAYLOAD})`);
  }
  const frame = Buffer.allocUnsafe(PKNT_HEADER_BYTES + payload.byteLength);
  frame[0] = kind;
  frame[1] = 0;
  frame.writeUInt16LE(0, 2);
  frame.writeUInt32LE(payload.byteLength, 4);
  Buffer.from(payload).copy(frame, PKNT_HEADER_BYTES);
  return frame;
}

function controlTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  if (payload.byteLength > CTRL_MAX_BYTES) {
    throw new EditorFilesError(
      "INVALID_REQUEST",
      `PKNT ctrl payload is ${payload.byteLength} bytes (max ${CTRL_MAX_BYTES})`,
    );
  }
  return encodeFrame(PKNT_CTRL, payload);
}

class PkntPeer {
  private input: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private accepted = false;
  private outgoingTransfer = 1;
  private incomingTransfer: {
    transfer: number;
    chunks: number;
    next: number;
    codeUnits: number;
    parts: string[];
  } | undefined;

  constructor(
    private readonly socket: Socket,
    private readonly files: EditorFiles,
    private readonly app: string,
  ) {}

  push(chunk: string | Buffer): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.input = this.input.length === 0 ? bytes : Buffer.concat([this.input, bytes]);
    if (!this.accepted && !this.handshake()) return;
    while (this.input.length >= PKNT_HEADER_BYTES) {
      const kind = this.input[0]!;
      const length = this.input.readUInt32LE(4);
      if (length > PKNT_MAX_PAYLOAD) {
        this.socket.destroy(new Error("PKNT payload exceeds limit"));
        return;
      }
      const total = PKNT_HEADER_BYTES + length;
      if (this.input.length < total) return;
      const payload = this.input.subarray(PKNT_HEADER_BYTES, total);
      this.input = this.input.subarray(total);
      if (kind === PKNT_PING) {
        this.socket.write(encodeFrame(PKNT_PONG, payload));
      } else if (kind === PKNT_CTRL) {
        this.control(payload);
      }
    }
  }

  private handshake(): boolean {
    if (this.input.length < 7) return false;
    const length = this.input[6]!;
    if (length === 0 || length > 64) {
      this.socket.destroy(new Error("invalid PKNT app length"));
      return false;
    }
    const total = 7 + length;
    if (this.input.length < total) return false;
    const magic = this.input.readUInt32LE(0);
    const version = this.input[4]!;
    const app = this.input.subarray(7, total).toString("utf8");
    this.input = this.input.subarray(total);
    if (magic !== PKNT_MAGIC || version !== PKNT_VERSION || app !== this.app) {
      this.socket.destroy(new Error("PKNT handshake rejected"));
      return false;
    }
    const ack = Buffer.alloc(8);
    ack.writeUInt32LE(PKNT_MAGIC, 0);
    ack[4] = PKNT_VERSION;
    this.socket.write(ack);
    this.send(this.files.project());
    this.accepted = true;
    return true;
  }

  private control(payload: Buffer): void {
    if (payload.byteLength > CTRL_MAX_BYTES) {
      this.incomingTransfer = undefined;
      return;
    }
    try {
      const envelope = JSON.parse(payload.toString("utf8")) as unknown;
      const message = this.receive(envelope);
      if (message === undefined) return;
      const reply = this.files.handle(message);
      if (reply !== null) this.send(reply);
    } catch {
      // Invalid JSON or a malformed transfer discards the partial logical
      // message. A subsequent chunk-start or ordinary message starts cleanly.
      this.incomingTransfer = undefined;
    }
  }

  /** Return one complete logical message, or undefined while consuming or
   * rejecting chunk envelopes. TCP ordering means only one transfer is
   * needed per peer. */
  private receive(envelope: unknown): unknown | undefined {
    if (!isRecord(envelope)) {
      this.incomingTransfer = undefined;
      return undefined;
    }
    if (envelope.t === "chunk-start") {
      this.incomingTransfer = undefined;
      if (!Number.isSafeInteger(envelope.transfer) || (envelope.transfer as number) < 0 ||
        !Number.isSafeInteger(envelope.chunks) || (envelope.chunks as number) < 1 ||
        (envelope.chunks as number) > CHUNK_MAX_COUNT) {
        return undefined;
      }
      this.incomingTransfer = {
        transfer: envelope.transfer as number,
        chunks: envelope.chunks as number,
        next: 0,
        codeUnits: 0,
        parts: [],
      };
      return undefined;
    }
    if (envelope.t === "chunk") {
      const state = this.incomingTransfer;
      if (!state || envelope.transfer !== state.transfer || envelope.index !== state.next ||
        typeof envelope.text !== "string" || envelope.text.length > CHUNK_CODE_UNITS) {
        this.incomingTransfer = undefined;
        return undefined;
      }
      state.codeUnits += envelope.text.length;
      if (state.codeUnits > LOGICAL_MAX_CODE_UNITS) {
        this.incomingTransfer = undefined;
        return undefined;
      }
      state.parts.push(envelope.text);
      state.next += 1;
      if (state.next < state.chunks) return undefined;
      this.incomingTransfer = undefined;
      const text = state.parts.join("");
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return undefined;
      }
    }
    if (this.incomingTransfer !== undefined) {
      // Logical messages cannot interleave with a transfer. Drop both the
      // partial transfer and this unexpected message.
      this.incomingTransfer = undefined;
      return undefined;
    }
    return envelope;
  }

  private send(message: unknown): void {
    const text = JSON.stringify(message);
    const direct = Buffer.byteLength(text, "utf8");
    if (direct <= CTRL_MAX_BYTES) {
      this.socket.write(controlTextFrame(text));
      return;
    }
    if (text.length > LOGICAL_MAX_CODE_UNITS) {
      throw new EditorFilesError(
        "INVALID_REQUEST",
        `logical JSON message is ${text.length} code units (max ${LOGICAL_MAX_CODE_UNITS})`,
      );
    }
    const chunks = Math.ceil(text.length / CHUNK_CODE_UNITS);
    if (chunks > CHUNK_MAX_COUNT) {
      throw new EditorFilesError(
        "INVALID_REQUEST",
        `logical JSON message needs ${chunks} chunks (max ${CHUNK_MAX_COUNT})`,
      );
    }
    const transfer = this.outgoingTransfer;
    this.outgoingTransfer = transfer >= Number.MAX_SAFE_INTEGER ? 1 : transfer + 1;
    this.socket.write(controlTextFrame(JSON.stringify({ t: "chunk-start", transfer, chunks })));
    for (let index = 0; index < chunks; index++) {
      const part = text.slice(index * CHUNK_CODE_UNITS, (index + 1) * CHUNK_CODE_UNITS);
      this.socket.write(controlTextFrame(JSON.stringify({
        t: "chunk",
        transfer,
        index,
        text: part,
      })));
    }
  }
}

export interface EditorFilesServerOptions extends EditorFilesOptions {
  host?: string;
  port?: number;
}

export interface EditorFilesServer {
  readonly files: EditorFiles;
  readonly host: string;
  readonly port: number;
  readonly address: string;
  /** Per-launch PKNT hello identity passed only to the desktop host. */
  readonly authToken: string;
  close(): Promise<void>;
}

/** Listen for the existing desktop host's `--svc-connect` PKNT client. */
export async function startEditorFilesServer(
  shellFile: string,
  options: EditorFilesServerOptions = {},
): Promise<EditorFilesServer> {
  const files = new EditorFiles(shellFile, options);
  const host = options.host ?? "127.0.0.1";
  const authToken = createSvcWireAuthToken();
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    const peer = new PkntPeer(socket, files, authToken);
    socket.on("data", (chunk) => {
      try {
        peer.push(chunk);
      } catch (error) {
        socket.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  await new Promise<void>((accept, reject) => {
    const failed = (error: Error): void => reject(error);
    server.once("error", failed);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", failed);
      accept();
    });
  });
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    server.close();
    throw new Error("editor files companion did not bind a TCP address");
  }
  return {
    files,
    host,
    port: bound.port,
    address: `${host}:${bound.port}`,
    authToken,
    async close() {
      for (const socket of sockets) socket.destroy();
      if (!server.listening) return;
      await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept()));
    },
  };
}

export interface RunDesktopEditorFilesOptions extends EditorFilesOptions {
  host?: string;
}

/** Launch helper for tools/editor.ts. Inline documents should continue to use
 * `runDesktopHost(build, ["--file", file, ...flags])`; only a ProjectShell
 * should take this companion path. */
export async function runDesktopEditorFiles(
  build: DesktopBuild,
  shellFile: string,
  flags: readonly string[],
  options: RunDesktopEditorFilesOptions = {},
): Promise<void> {
  const server = await startEditorFilesServer(shellFile, {
    ...options,
  });
  try {
    console.log(`editor: sharded companion ${server.address}`);
    await runDesktopHost(build, ["--svc-connect", server.address, ...flags, "--app", server.authToken]);
  } finally {
    await server.close();
  }
}
