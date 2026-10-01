// src/engine/save.ts — P1⑤ save/load snapshot.
//
// One reducer snapshot covers the whole resumable session:
//   map      — current map id (P1④ transfers change it)
//   player   — the mover's tile/pixel position, facing, step phase
//   held     — the BTN mask on the save frame, restored as the host's
//              previous-mask so pressed edges line up after a load
//   interp   — the FULL interpreter state (engine/interpreter.ts): frame
//              clock, switches/variables/self-switches/items/gold, the
//              mulberry32 RNG cursor, blocking and parallel fibers (with
//              their compiled stacks), modal, erased/touch latches
//
// Nothing here is host-derived: a save point is a SAFE POINT — mover at a
// tile boundary, no blocking fiber except a resumable waited screen effect,
// no modal, no parked external request —
// so the restored state folds the same future tape into the same states
// and the same pixels (docs/SIMULATION.md). The envelope carries a format
// id, a version number and an FNV-1a checksum over canonicalized JSON;
// truncation, a pasted typo, or a future-version file is refused with a
// typed code instead of loading garbage.
//
// The web/other-targets fallback is the save CODE: the same envelope
// encoded as URL-safe base64 (no padding), copied in/out by hand. Its
// alphabet is A-Z a-z 0-9 - _, every key of which the framework OSK
// types. Pure TS, no host imports, QuickJS-safe (no TextEncoder/btoa).

import type { MovementState } from "./movement.ts";
import type { InterpState } from "./interpreter.ts";
import { cloneInterp, createSwitchState, isBusy } from "./interpreter.ts";
import { deepClone, keyedRecord } from "./clone.ts";
import { assertJsonValue, encodeExtension } from "./extensions.ts";
import { envelopeConsistent, validateSnapshot } from "./save-validate.ts";
import type { MapContentIdentity } from "./map-repository.ts";
import type { JsonValue } from "./types.ts";
import type { Session, SessionState } from "./session.ts";

export const SAVE_FORMAT = "rpgkit-save/v1" as const;
export const SAVE_VERSION = 1 as const;

/** Slot 1..3 (save/slot-N.json on an fs host). */
export const SLOT_MIN = 1;
export const SLOT_MAX = 3;

// --- snapshot ---------------------------------------------------------------

export interface SaveSnapshot {
  /** Current map id. */
  map: string;
  /** Mover state at a tile boundary. */
  player: MovementState;
  /** BTN mask held on the save frame (host previous-mask seed). */
  held: number;
  /** Full interpreter state, cues drained and no request parked. */
  interp: InterpState;
  /** Game-owned state in its encoded JSON form. Older v1 saves hydrate null. */
  ext: JsonValue;
}

/** A save is only valid at a safe point: the mover rests on a tile and no
 *  modal / queued external request / scene owns the session. A main fiber
 *  parked on `screenWait` is safe because both its clock and presentation
 *  descriptor are reducer state; every other blocking mode remains barred.
 *  Parallel fibers serialize in their running state. */
export function canSave(player: MovementState, interp: InterpState, scene: unknown = null): boolean {
  return (
    !player.moving &&
    player.phase === 0 &&
    (!isBusy(interp) || interp.main?.mode === "screenWait") &&
    interp.error === undefined &&
    interp.modal === null &&
    interp.pendingTransfer === null &&
    interp.pendingMoveRoutes.length === 0 &&
    interp.pendingPlacements.length === 0 &&
    interp.abortedRoutes.length === 0 &&
    interp.pendingBattles.length === 0 &&
    (interp.pendingScenes?.length ?? 0) === 0 &&
    scene === null
  );
}

/** Deep-copy a snapshot without host built-ins. The desktop QuickJS realm
 *  has no structuredClone (F1/task-1173); movement state is a flat record
 *  and interpreter state goes through its own hand-written cloner. */
export function cloneSnapshot(snap: SaveSnapshot): SaveSnapshot {
  return {
    map: snap.map,
    player: { ...snap.player },
    held: snap.held >>> 0,
    interp: cloneInterp(snap.interp),
    ext: deepClone((snap as SaveSnapshot & { ext?: JsonValue }).ext ?? null),
  };
}

export function createSnapshot(
  map: string,
  player: MovementState,
  interp: InterpState,
  held: number,
  ext: JsonValue = null,
  scene: unknown = null,
): SaveSnapshot {
  if (!canSave(player, interp, scene)) {
    throw new Error("save: snapshot is only valid at a tile boundary with no modal or scene open and no external work pending");
  }
  assertJsonValue(ext, "save extension state");
  return normalizeInterp(cloneSnapshot({ map, player, held, interp, ext }));
}

/** Session-aware save entry point. It applies the registered extension
 * codec and rejects active scenes before constructing the checksum payload. */
export function createSessionSnapshot(
  session: Session,
  state: SessionState,
  held: number,
): SaveSnapshot {
  return createSnapshot(
    state.mapId,
    state.move,
    state.interp,
    held,
    encodeExtension(session.extensions, state.ext),
    state.scene,
  );
}

/** Drop between-frame transient fields. The battle queue is persistent at
 * runtime, but can only be empty at the safe point checked above. */
function normalizeInterp(snap: SaveSnapshot): SaveSnapshot {
  // The per-frame cloneInterp copies the numeric banks verbatim (so an
  // ill-typed content value still reaches its fatal check). The save
  // boundary re-normalizes them through createSwitchState, so a state that
  // passes canSave always encodes into an envelope the decoder accepts.
  snap.interp.sw = createSwitchState(snap.interp.sw);
  snap.interp.cues = [];
  snap.interp.pendingTransfer = null;
  snap.interp.pendingMoveRoutes = [];
  snap.interp.pendingBattles = [];
  // The scene queue is runtime-only: it must be empty at a save point, so
  // the field is dropped from the snapshot rather than serialized.
  delete (snap.interp as Partial<InterpState>).pendingScenes;
  snap.interp.pendingPlacements = [];
  snap.interp.abortedRoutes = [];
  return snap;
}

// --- envelope ---------------------------------------------------------------

export interface SaveEnvelope {
  format: typeof SAVE_FORMAT;
  version: number;
  /** Frame clock of the snapshot (interp.frame), for the slot summary. */
  frame: number;
  /** FNV-1a 32-bit (8 hex chars) over canonical JSON of `state`. */
  checksum: string;
  /** Sharded-project build identity. Envelope metadata, not reducer state. */
  content?: MapContentIdentity;
  state: SaveSnapshot;
}

export type SaveErrorCode =
  | "bad-json"
  | "format"
  | "version"
  | "checksum"
  | "content"
  | "shape";

export class SaveError extends Error {
  constructor(
    readonly code: SaveErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SaveError";
  }
}

// --- FNV-1a 32 over UTF-8 (same constants as hosts/sim/sim.ts fnv1a) -------

export function fnv1aBytes(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function fnv1aText(s: string): string {
  return fnv1aBytes(utf8Encode(s));
}

export function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.codePointAt(i)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else {
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f),
      );
      i++; // surrogate pair
    }
  }
  return new Uint8Array(out);
}

/** Canonical JSON: object keys sorted recursively (codepoint order), so the
 *  checksum does not depend on record insertion order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(stringifyCanonical(value));
}

function stringifyCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stringifyCanonical);
  if (value !== null && typeof value === "object") {
    const out = keyedRecord<unknown>();
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = stringifyCanonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function encodeEnvelope(
  snapshot: SaveSnapshot,
  content?: MapContentIdentity | null,
): string {
  const state = cloneSnapshot(snapshot);
  const envelope: SaveEnvelope = {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    frame: state.interp.frame,
    checksum: fnv1aText(canonicalJson(state)),
    ...(content ? { content: { ...content } } : {}),
    state,
  };
  return JSON.stringify(envelope);
}

// --- base64url save code ----------------------------------------------------

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64URL_INV: Record<string, number> = {};
for (let i = 0; i < B64URL.length; i++) B64URL_INV[B64URL[i]!] = i;

/** URL-safe base64 without padding; whitespace tolerant on the way back. */
export function encodeSaveCode(
  snapshot: SaveSnapshot,
  content?: MapContentIdentity | null,
): string {
  const bytes = utf8Encode(encodeEnvelope(snapshot, content));
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64URL[b0 >> 2]!;
    out += B64URL[((b0 & 3) << 4) | (b1 >> 4)]!;
    if (i + 1 < bytes.length) out += B64URL[((b1 & 15) << 2) | (b2 >> 6)]!;
    if (i + 2 < bytes.length) out += B64URL[b2 & 63]!;
  }
  return out;
}

export function decodeSaveCode(
  code: string,
  expectedContent?: MapContentIdentity | null,
): SaveSnapshot {
  const clean = code.replace(/\s+/g, "");
  if (clean.length === 0) throw new SaveError("bad-json", "save code is empty");
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64URL_INV[clean[i]!];
    const c1 = B64URL_INV[clean[i + 1]!];
    const c2 = i + 2 < clean.length ? B64URL_INV[clean[i + 2]!] : 0;
    const c3 = i + 3 < clean.length ? B64URL_INV[clean[i + 3]!] : 0;
    if (c0 === undefined || c1 === undefined ||
      (i + 2 < clean.length && B64URL_INV[clean[i + 2]!] === undefined) ||
      (i + 3 < clean.length && B64URL_INV[clean[i + 3]!] === undefined)) {
      throw new SaveError("bad-json", "save code contains characters outside the save alphabet");
    }
    const n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    bytes.push((n >> 16) & 255);
    if (i + 2 < clean.length) bytes.push((n >> 8) & 255);
    if (i + 3 < clean.length) bytes.push(n & 255);
  }
  const text = utf8Decode(new Uint8Array(bytes));
  if (text === null) throw new SaveError("bad-json", "save code is not valid UTF-8");
  return decodeEnvelopeText(text, expectedContent);
}

/** Strict UTF-8 decode: validate lead/continuation bytes, overlong forms,
 *  surrogates and code points past U+10FFFF, so an alphabet-valid save code
 *  raises a typed SaveError instead of String.fromCodePoint's RangeError
 *  (F6/task-1173). Returns null on any malformed sequence. */
function utf8Decode(bytes: Uint8Array): string | null {
  let out = "";
  let i = 0;
  const cont = (at: number): number | null =>
    at < bytes.length ? (bytes[at]! & 0xc0) === 0x80 ? bytes[at]! & 0x3f : null : null;
  while (i < bytes.length) {
    const b0 = bytes[i]!;
    let cp: number;
    let len: number;
    let min: number;
    if (b0 < 0x80) {
      out += String.fromCodePoint(b0);
      i += 1;
      continue;
    } else if (b0 >= 0xc2 && b0 < 0xe0) {
      len = 2; min = 0x80;
      const c1 = cont(i + 1);
      if (c1 === null) return null;
      cp = ((b0 & 0x1f) << 6) | c1;
    } else if (b0 >= 0xe0 && b0 < 0xf0) {
      len = 3; min = 0x800;
      const c1 = cont(i + 1);
      const c2 = cont(i + 2);
      if (c1 === null || c2 === null) return null;
      cp = ((b0 & 0x0f) << 12) | (c1 << 6) | c2;
    } else if (b0 >= 0xf0 && b0 < 0xf5) {
      len = 4; min = 0x10000;
      const c1 = cont(i + 1);
      const c2 = cont(i + 2);
      const c3 = cont(i + 3);
      if (c1 === null || c2 === null || c3 === null) return null;
      cp = ((b0 & 0x07) << 18) | (c1 << 12) | (c2 << 6) | c3;
    } else {
      return null; // 0x80..0xc1 (continuation/overlong-2), 0xf5+ (out of range)
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    out += String.fromCodePoint(cp);
    i += len;
  }
  return out;
}

// --- decode + validate ------------------------------------------------------

export function decodeEnvelopeText(
  text: string,
  expectedContent?: MapContentIdentity | null,
): SaveSnapshot {
  let envelope: SaveEnvelope;
  try {
    envelope = JSON.parse(text) as SaveEnvelope;
  } catch {
    throw new SaveError("bad-json", "save data is not JSON");
  }
  if (envelope === null || typeof envelope !== "object") {
    throw new SaveError("shape", "save data has no envelope");
  }
  if (envelope.format !== SAVE_FORMAT) {
    throw new SaveError("format", `not a ${SAVE_FORMAT} save`);
  }
  if (envelope.version !== SAVE_VERSION) {
    throw new SaveError(
      "version",
      `save version ${String(envelope.version)} is not loadable by version ${SAVE_VERSION}`,
    );
  }
  if (envelope.content !== undefined && (
    envelope.content === null || typeof envelope.content !== "object" ||
    typeof envelope.content.manifest !== "string" ||
    typeof envelope.content.schema !== "string"
  )) {
    throw new SaveError("shape", "save content identity is malformed");
  }
  if (expectedContent) {
    if (!envelope.content) {
      throw new SaveError("content", "save has no content identity for this sharded project");
    }
    if (envelope.content.manifest !== expectedContent.manifest) {
      throw new SaveError("content", "save map manifest hash does not match this content build");
    }
    if (envelope.content.schema !== expectedContent.schema) {
      throw new SaveError("content", "save map schema hash does not match this runtime");
    }
  }
  const snapshot = envelope.state;
  if (!isSnapshotShape(snapshot)) {
    throw new SaveError("shape", "save state is missing fields");
  }
  const expected = fnv1aText(canonicalJson(snapshot));
  if (typeof envelope.checksum !== "string" || envelope.checksum !== expected) {
    throw new SaveError("checksum", "save checksum mismatch (truncated or edited)");
  }
  // The event-model additions extended the existing v1 snapshot rather
  // than changing its envelope version. Hydrate only fields absent from an
  // older checksum-valid v1 save; an explicitly malformed value remains in
  // place for the deep validator to reject below.
  hydrateLegacyV1(snapshot);
  // Checksum proved the bytes are intact, not that they form a legal
  // session: fully validate structure, ranges and save-time invariants
  // before anything can restore from this snapshot (F4/task-1173).
  const reason = validateSnapshot(snapshot);
  if (reason !== null) throw new SaveError("shape", `save state is invalid: ${reason}`);
  if (!envelopeConsistent(envelope as unknown as Record<string, unknown>, snapshot as unknown as Record<string, unknown>)) {
    throw new SaveError("shape", "save envelope frame does not match the state clock");
  }
  // JSON.parse returns ordinary objects. Re-clone before exposing the state
  // so legacy v1 saves keep the same wire bytes while every external-id
  // dictionary regains the runtime's null prototype.
  return cloneSnapshot(snapshot);
}

function hydrateLegacyV1(snapshot: SaveSnapshot): void {
  const interp = snapshot.interp as InterpState & {
    inputLocked?: boolean;
    placements?: InterpState["placements"];
    pendingPlacements?: InterpState["pendingPlacements"];
    pendingBattles?: InterpState["pendingBattles"];
    pendingBattle?: InterpState["pendingBattles"][number] | null;
  };
  if (interp.inputLocked === undefined) interp.inputLocked = false;
  if (interp.placements === undefined) interp.placements = keyedRecord();
  if (interp.pendingPlacements === undefined) interp.pendingPlacements = [];
  if (interp.pendingBattles === undefined) {
    interp.pendingBattles = interp.pendingBattle === undefined || interp.pendingBattle === null
      ? []
      : [interp.pendingBattle];
  }
  if ((snapshot as SaveSnapshot & { ext?: JsonValue }).ext === undefined) snapshot.ext = null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Cheap presence/type pre-check so checksum parsing never indexes
 *  undefined; the deep validator (save-validate.ts) decides validity. */
function isSnapshotShape(v: unknown): v is SaveSnapshot {
  if (!isRecord(v)) return false;
  if (typeof v.map !== "string") return false;
  if (typeof v.held !== "number") return false;
  const player = v.player;
  if (!isRecord(player)) return false;
  for (const k of ["tx", "ty", "px", "py", "facing", "phase", "moving", "walking", "stepDir"]) {
    if (!(k in player)) return false;
  }
  const interp = v.interp;
  if (!isRecord(interp) || typeof interp.frame !== "number" || !isRecord(interp.sw)) return false;
  return true;
}

// --- slot helpers ------------------------------------------------------------

export function slotPath(slot: number): string {
  if (!Number.isInteger(slot) || slot < SLOT_MIN || slot > SLOT_MAX) {
    throw new Error(`save: slot ${String(slot)} out of range ${SLOT_MIN}..${SLOT_MAX}`);
  }
  return `save/slot-${slot}.json`;
}

export interface SlotSummary {
  slot: number;
  map: string;
  frame: number;
}

/** Parse a slot file for the menu summary. Unlike a bare JSON peek this
 *  runs the SAME full validation as a load (format/version/checksum/
 *  structural/frame consistency), so a bad file lists as an error instead
 *  of a healthy selectable slot (F5/task-1173). */
export function summarizeEnvelope(
  slot: number,
  text: string,
  expectedContent?: MapContentIdentity | null,
): SlotSummary & { checksum: string } {
  const snapshot = decodeEnvelopeText(text, expectedContent);
  const envelope = JSON.parse(text) as SaveEnvelope;
  return {
    slot,
    map: snapshot.map,
    frame: snapshot.interp.frame,
    checksum: envelope.checksum,
  };
}

/** A host-port-shaped store: the fs adapter (ui/save-fs.ts) implements it
 *  over @pocketjs/framework/fs; tests implement it over a Map. */
export interface SaveStore {
  exists(slot: number): boolean;
  read(slot: number): string | null;
  write(slot: number, envelope: string): void;
  remove?(slot: number): void;
}

export function saveToStore(
  store: SaveStore,
  slot: number,
  snapshot: SaveSnapshot,
  content?: MapContentIdentity | null,
): void {
  store.write(slot, encodeEnvelope(snapshot, content));
}

export function loadFromStore(
  store: SaveStore,
  slot: number,
  expectedContent?: MapContentIdentity | null,
): SaveSnapshot {
  const text = store.read(slot);
  if (text === null) throw new SaveError("bad-json", `slot ${slot} is empty`);
  return decodeEnvelopeText(text, expectedContent);
}
