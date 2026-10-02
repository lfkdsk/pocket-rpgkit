// tools/preview/protocol.ts — the rpgkit-preview/v1 message protocol.
//
// Pure TypeScript (no DOM): the same parsing, validation and dispatch runs
// in bun unit tests (tests/preview-protocol.test.ts) and in the browser host
// (tools/preview/preview.tsx). The wire is postMessage JSON; the reference
// frontend is tools/web/preview-demo.html and the reference documentation is
// docs/protocols.md, section "Preview protocol".

import type { Dir } from "../../src/engine/types.ts";
import { utf8BytesWithin, utf8UnitBytes } from "../../src/engine/utf8.ts";

export const PREVIEW_PROTOCOL = "rpgkit-preview/v1";
export const PREVIEW_VERSION = 1;

/** Bounds every host enforces before doing expensive work. A load over any
 *  bound is refused with `too-large`; see docs/protocols.md (Preview
 *  protocol, Limits). */
export const PREVIEW_LIMITS = {
  /** Whole wire message, counted structurally as an approximation of its
   *  JSON encoding (string UTF-8 bytes, 8 per number, 4 per boolean/null,
   *  plus container overhead). Checked before the message is parsed. */
  maxMessageBytes: 4 * 1024 * 1024,
  /** Chapters per `load`. */
  maxChapters: 64,
  /** One chapter snapshot (save code string or snapshot object), in bytes. */
  maxSnapshotBytes: 1024 * 1024,
  /** One chapter tape, in u16 frames. */
  maxChapterTapeLength: 36_000,
  /** A `requestId`, in UTF-8 bytes. */
  maxRequestIdBytes: 128,
} as const;

export type PreviewErrorCode =
  | "bad-message"
  | "bad-version"
  | "not-loaded"
  | "bad-document"
  | "unknown-map"
  | "bad-start"
  | "unknown-chapter"
  | "bad-input"
  | "too-large"
  | "internal";

export class PreviewError extends Error {
  constructor(
    readonly code: PreviewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PreviewError";
  }
}

// ---- results ----------------------------------------------------------------

export interface PreviewMapSummary {
  id: string;
  name: string;
  width: number;
  height: number;
}

export interface PreviewLoadResult {
  title: string;
  maps: PreviewMapSummary[];
  start: { map: string; x: number; y: number; dir: string };
}

export type PreviewStartTarget =
  | { kind: "tile"; map: string; x: number; y: number; dir?: Dir }
  | { kind: "chapter"; chapter: string };

export interface PreviewStartResult {
  map: string;
  x: number;
  y: number;
  dir: string;
}

export interface PreviewMessage {
  kind: "text" | "choices" | "shop";
  /** Whole dialogue text (lines joined with "\n"), the choice prompt and
   *  options one per line, or "" for a shop. */
  text: string;
}

export interface PreviewStateResult {
  status: "running";
  map: string;
  x: number;
  y: number;
  px: number;
  py: number;
  dir: string;
  moving: boolean;
  // The next four fields are optional additions within v1: the preview host
  // always sends them, but a frontend must still accept a reply without them.
  /** Session frame counter; it advances once per simulated frame. */
  frame?: number;
  /** Event pages running now: the main one (if any) plus parallels. */
  running?: number;
  /** Key ("map/event") of the event page running in the main slot. */
  event?: string | null;
  /** The open message box: dialogue text, a choice prompt, or a shop. */
  message?: PreviewMessage | null;
  switches: Record<string, boolean>;
  variables: Record<string, number | string>;
  gold: number;
  items: Record<string, number>;
}

/** The host side of the protocol. The preview app implements it; tests use
 *  a fake. Every method either returns its result or throws PreviewError. */
export interface PreviewBackend {
  /** Validate and mount a project document (JSON text or an object). */
  load(document: unknown, chapters?: unknown): PreviewLoadResult;
  /** Warp to a tile, or restore a chapter supplied with `load`. */
  start(target: PreviewStartTarget): PreviewStartResult;
  /** Read the running session's summary. */
  state(): PreviewStateResult;
  /** Hold a u16 button mask for `frames` host frames, then release. */
  input(buttons: number, frames: number): void;
  /** Unmount the current project and return to the idle screen. */
  stop(): void;
}

// ---- replies ----------------------------------------------------------------

export interface PreviewReply {
  protocol: typeof PREVIEW_PROTOCOL;
  type: "reply";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

/** What the host does with one received message:
 *  - a reply to post back to the sender;
 *  - "drop": the origin is not allowed, so no reply is sent;
 *  - null: handled, but no reply (fire-and-forget input/stop). */
export type PreviewDispatch = PreviewReply | "drop" | null;

// ---- origin allowlist --------------------------------------------------------

/** Origins the host accepts messages from. The page's own origin is always
 *  allowed (same-origin embeds); `?preview-origin=<origin>` query parameters
 *  (repeatable, comma-separated) add more. The opaque "null" origin (data:
 *  and file: pages) is never allowed: the player needs a real web origin. */
export function previewAllowlist(selfOrigin: string, search: string): Set<string> {
  const allow = new Set<string>();
  if (selfOrigin && selfOrigin !== "null") allow.add(selfOrigin);
  const query = new URLSearchParams(search);
  for (const raw of query.getAll("preview-origin")) {
    for (const piece of raw.split(",")) {
      const origin = piece.trim();
      if (origin && origin !== "null") allow.add(origin);
    }
  }
  return allow;
}

export function isAllowedOrigin(allow: ReadonlySet<string>, origin: string): boolean {
  return origin !== "null" && origin !== "" && allow.has(origin);
}

// ---- parsing -----------------------------------------------------------------

const DIRS: readonly Dir[] = ["down", "left", "up", "right"];
const MAX_INPUT_FRAMES = 600;

/** The most code units of a request value an error message quotes back. */
export const PREVIEW_ECHO_LIMIT = 64;

/** A short, bounded rendering of a request value for an error message: a
 *  string is quoted and cut to PREVIEW_ECHO_LIMIT code units (never through
 *  a surrogate pair) with a "(truncated)" marker; a number, boolean or null
 *  prints as itself; anything else is named by kind. The cost is bounded by
 *  the limit, whatever the size of `value`. */
export function echoPreviewValue(value: unknown): string {
  if (typeof value === "string") {
    if (value.length <= PREVIEW_ECHO_LIMIT) return JSON.stringify(value);
    let end = PREVIEW_ECHO_LIMIT;
    const last = value.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
    return `${JSON.stringify(value.slice(0, end))}... (truncated, ${value.length} chars)`;
  }
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

function asObject(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new PreviewError("bad-message", "message is not a JSON object");
  }
  return data as Record<string, unknown>;
}

// ---- byte budget --------------------------------------------------------------

/** Add the UTF-8 byte length of `s` one code unit at a time, so a budget
 *  callback can stop the walk partway through a long string. */
function walkStringBytes(s: string, add: (n: number) => void): void {
  for (let i = 0; i < s.length; i++) add(utf8UnitBytes(s, i));
}

/** Structural JSON size: string UTF-8 bytes, 8 per number, 4 per
 *  boolean/null, and container overhead (2 per bracket pair, 2 per array
 *  element, 4 per object entry plus its key's bytes). This approximates the
 *  JSON encoding without building it, so an over-budget message costs work
 *  proportional to the budget, not to the message. */
export function previewMessageBytes(value: unknown): number {
  let total = 0;
  walkPreviewBytes(value, (n) => {
    total += n;
  });
  return total;
}

/** Like previewMessageBytes, but throws `too-large` as soon as the running
 *  total passes `limit` — never walking the whole value when it is over. */
function assertWithinByteBudget(value: unknown, limit: number, label: string): void {
  let total = 0;
  walkPreviewBytes(value, (n) => {
    total += n;
    if (total > limit) throw new PreviewError("too-large", `${label} exceeds the ${limit}-byte budget`);
  });
}

/** Walk the structural JSON size of `value` piece by piece, calling `add`
 *  for each contribution. Strings are walked one code unit at a time, so a
 *  long string is scanned incrementally and the walk can be stopped from
 *  inside `add` (for example, the moment a byte budget is exceeded). */
export function walkPreviewBytes(value: unknown, add: (n: number) => void): void {
  if (value === null) {
    add(4);
    return;
  }
  switch (typeof value) {
    case "string":
      walkStringBytes(value, add);
      return;
    case "number":
      add(8);
      return;
    case "boolean":
      add(4);
      return;
    case "object":
      if (Array.isArray(value)) {
        add(2); // brackets
        for (const element of value) {
          add(2); // comma + element slot
          walkPreviewBytes(element, add);
        }
      } else {
        add(2); // braces
        for (const [key, element] of Object.entries(value as Record<string, unknown>)) {
          add(4); // "key":
          walkStringBytes(key, add);
          walkPreviewBytes(element, add);
        }
      }
      return;
    default:
      add(8); // undefined/function/symbol never survive the wire
  }
}

/** A present `requestId` must be a non-empty bounded string. Anything else
 *  refuses the message rather than demoting it to a notification, so a
 *  malformed caller can never smuggle work through the fire-and-forget
 *  path. */
function parseRequestId(msg: Record<string, unknown>): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(msg, "requestId")) return undefined;
  const id = msg.requestId;
  if (typeof id !== "string") throw new PreviewError("bad-message", "requestId must be a string");
  if (id.length === 0) throw new PreviewError("bad-message", "requestId must be a non-empty string");
  if (!utf8BytesWithin(id, PREVIEW_LIMITS.maxRequestIdBytes)) {
    throw new PreviewError("bad-message", `requestId must be at most ${PREVIEW_LIMITS.maxRequestIdBytes} bytes`);
  }
  return id;
}

/** Correlation key for an error reply: only a valid bounded string can be
 *  echoed back; a malformed id leaves the message silent (it never ran). */
function correlationId(data: unknown): string | undefined {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(record, "requestId")) {
      const id = record.requestId;
      if (typeof id === "string" && id.length > 0 && utf8BytesWithin(id, PREVIEW_LIMITS.maxRequestIdBytes)) return id;
    }
  }
  return undefined;
}

function requireId(type: string, requestId: string | undefined): string {
  if (!requestId) throw new PreviewError("bad-message", `${type} needs a requestId`);
  return requestId;
}

/** Bounds for the optional chapter list, checked before the backend walks
 *  it. Shape errors stay where they are (the backend's chapterList), but
 *  count and size bounds belong to the wire. */
function checkChapterLimits(chapters: unknown): void {
  if (!Array.isArray(chapters)) return;
  if (chapters.length > PREVIEW_LIMITS.maxChapters) {
    throw new PreviewError("too-large", `a load accepts at most ${PREVIEW_LIMITS.maxChapters} chapters`);
  }
  chapters.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const chapter = entry as Record<string, unknown>;
    if (typeof chapter.snapshot === "string") {
      if (!utf8BytesWithin(chapter.snapshot, PREVIEW_LIMITS.maxSnapshotBytes)) {
        throw new PreviewError("too-large", `chapters[${index}].snapshot exceeds the ${PREVIEW_LIMITS.maxSnapshotBytes}-byte budget`);
      }
    } else if (chapter.snapshot && typeof chapter.snapshot === "object") {
      assertWithinByteBudget(chapter.snapshot, PREVIEW_LIMITS.maxSnapshotBytes, `chapters[${index}].snapshot`);
    }
    if (Array.isArray(chapter.tape) && chapter.tape.length > PREVIEW_LIMITS.maxChapterTapeLength) {
      throw new PreviewError("too-large", `chapters[${index}].tape exceeds the ${PREVIEW_LIMITS.maxChapterTapeLength}-frame budget`);
    }
  });
}

function parseStart(msg: Record<string, unknown>): PreviewStartTarget {
  if (typeof msg.chapter === "string") {
    if (msg.chapter.length === 0) throw new PreviewError("bad-message", "start chapter is empty");
    return { kind: "chapter", chapter: msg.chapter };
  }
  if (typeof msg.map !== "string" || msg.map.length === 0) {
    throw new PreviewError("bad-message", "start needs a map id and x/y, or a chapter id");
  }
  if (!Number.isInteger(msg.x) || (msg.x as number) < 0) {
    throw new PreviewError("bad-message", "start x must be a non-negative integer");
  }
  if (!Number.isInteger(msg.y) || (msg.y as number) < 0) {
    throw new PreviewError("bad-message", "start y must be a non-negative integer");
  }
  let dir: Dir | undefined;
  if (msg.dir !== undefined) {
    if (typeof msg.dir !== "string" || !(DIRS as readonly string[]).includes(msg.dir)) {
      throw new PreviewError("bad-message", `start dir must be one of ${DIRS.join(", ")}`);
    }
    dir = msg.dir as Dir;
  }
  return { kind: "tile", map: msg.map, x: msg.x as number, y: msg.y as number, dir };
}

export interface PreviewRequest {
  type: "load" | "start" | "state" | "input" | "stop";
  requestId?: string;
  document?: unknown;
  chapters?: unknown;
  start?: PreviewStartTarget;
  buttons?: number;
  frames?: number;
}

/** Validate one wire message. Throws PreviewError on any shape problem. */
export function parsePreviewMessage(data: unknown): PreviewRequest {
  const msg = asObject(data);
  // The budget is checked before any field parsing or backend work, so an
  // allowed origin cannot force stringify/validation/traversal proportional
  // to an oversized message.
  assertWithinByteBudget(msg, PREVIEW_LIMITS.maxMessageBytes, "message");
  if (msg.protocol !== PREVIEW_PROTOCOL) {
    throw new PreviewError(
      "bad-version",
      `unsupported protocol ${echoPreviewValue(msg.protocol)}; expected "${PREVIEW_PROTOCOL}"`,
    );
  }
  if (typeof msg.type !== "string") throw new PreviewError("bad-message", "type is missing");
  const requestId = parseRequestId(msg);
  switch (msg.type) {
    case "load":
      if (msg.document === undefined) throw new PreviewError("bad-message", "load needs a document");
      checkChapterLimits(msg.chapters);
      return { type: "load", requestId: requireId("load", requestId), document: msg.document, chapters: msg.chapters };
    case "start":
      return { type: "start", requestId: requireId("start", requestId), start: parseStart(msg) };
    case "state":
      return { type: "state", requestId: requireId("state", requestId) };
    case "input": {
      if (!Number.isInteger(msg.buttons) || (msg.buttons as number) < 0 || (msg.buttons as number) > 0xffff) {
        throw new PreviewError("bad-input", "input buttons must be a u16 mask (0..65535)");
      }
      const frames = msg.frames ?? 1;
      if (!Number.isInteger(frames) || (frames as number) < 1 || (frames as number) > MAX_INPUT_FRAMES) {
        throw new PreviewError("bad-input", `input frames must be an integer from 1 through ${MAX_INPUT_FRAMES}`);
      }
      return { type: "input", requestId, buttons: msg.buttons as number, frames: frames as number };
    }
    case "stop":
      return { type: "stop", requestId };
    default:
      throw new PreviewError("bad-message", `unknown type ${echoPreviewValue(msg.type)}`);
  }
}

// ---- dispatch ----------------------------------------------------------------

function runBackend(backend: PreviewBackend, request: PreviewRequest): unknown {
  switch (request.type) {
    case "load":
      return backend.load(request.document, request.chapters);
    case "start":
      return backend.start(request.start!);
    case "state":
      return backend.state();
    case "input":
      backend.input(request.buttons!, request.frames!);
      return undefined;
    case "stop":
      backend.stop();
      return undefined;
  }
}

/** The single exit every reply leaves through. A candidate reply —
 *  success, parse error or backend error alike — is measured against the
 *  whole-message budget; one over it is replaced by a constant `too-large`
 *  error that carries only the (already bounded) requestId. */
function boundedReply(candidate: PreviewReply): PreviewReply {
  try {
    assertWithinByteBudget(candidate, PREVIEW_LIMITS.maxMessageBytes, "reply");
    return candidate;
  } catch (error) {
    // Measuring can only fail on budget, unless a result object misbehaves
    // (a throwing getter); either way the replacement is short and constant.
    const bounded =
      error instanceof PreviewError && error.code === "too-large"
        ? error
        : new PreviewError("internal", "reply could not be measured");
    return errorReply(candidate.requestId, bounded);
  }
}

function errorReply(requestId: string, error: unknown): PreviewReply {
  const pe =
    error instanceof PreviewError
      ? error
      : new PreviewError("internal", error instanceof Error ? error.message : String(error));
  return { protocol: PREVIEW_PROTOCOL, type: "reply", requestId, ok: false, error: { code: pe.code, message: pe.message } };
}

/** Validate, authorize and run one message against the backend. The caller
 *  posts a returned reply to `event.source` with `event.origin`; "drop" and
 *  null produce no reply. */
export function dispatchPreviewMessage(
  data: unknown,
  origin: string,
  allow: ReadonlySet<string>,
  backend: PreviewBackend,
): PreviewDispatch {
  if (!isAllowedOrigin(allow, origin)) return "drop";
  let request: PreviewRequest;
  try {
    request = parsePreviewMessage(data);
  } catch (error) {
    // A parse failure can still name a requestId; answer it so the frontend
    // does not have to time out to learn the message was malformed. A
    // malformed or absent id leaves the message silent (it never ran).
    const id = correlationId(data);
    if (!id) return null;
    return boundedReply(errorReply(id, error));
  }
  if (request.requestId === undefined) {
    // A notification has no reply channel; run it inside the same boundary
    // so a backend error stays contained and never reaches the browser's
    // event loop. Silent failure is the documented notification contract.
    try {
      runBackend(backend, request);
    } catch {
      // intentionally silent
    }
    return null;
  }
  let reply: PreviewReply;
  try {
    const result = runBackend(backend, request);
    reply =
      result === undefined
        ? { protocol: PREVIEW_PROTOCOL, type: "reply", requestId: request.requestId, ok: true }
        : { protocol: PREVIEW_PROTOCOL, type: "reply", requestId: request.requestId, ok: true, result };
  } catch (error) {
    reply = errorReply(request.requestId, error);
  }
  // Replies obey the same whole-message budget as requests: a backend result
  // or error message that would exceed it (for example a huge dialogue text
  // in a `state` reply) becomes a bounded `too-large` error instead.
  return boundedReply(reply);
}
