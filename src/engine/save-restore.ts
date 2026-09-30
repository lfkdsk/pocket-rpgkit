// src/engine/save-restore.ts — map-aware restore gate (R1202-3).
//
// save-validate.ts is deliberately map-agnostic (the engine core has no
// World): it proves a decoded snapshot is internally consistent. This module
// proves it fits the map THIS build actually runs, before any live mover or
// interpreter is replaced:
//
//   1. the snapshot map id is the live map id
//   2. the saved player tile lies inside the map and is standable under the
//      live passage table (a checksum-valid save with tx=1_000_000 otherwise
//      restores the mover off-map, where every direction is blocked and the
//      session soft-locks)
//   3. every serialized fiber names an event the live map owns, parks on a
//      page that exists, and that page's trigger matches the fiber's
//      parallel flag
//
// Pure TS: the host hands in the live MapDef + cooked PassageTable. A
// refusal returns a reason string; the caller throws SaveError("shape") and
// keeps the running session untouched.

import { MAX_FIBER_STACK_DEPTH } from "./interpreter.ts";
import type { MapDef } from "./types.ts";
import { isStandable, withTilePropertyOverrides, type PassageTable } from "./passability.ts";
import type { SaveSnapshot } from "./save.ts";
import { SaveError, decodeEnvelopeText } from "./save.ts";
import { cloneInterp, createSwitchState } from "./interpreter.ts";
import { createChars } from "./chars.ts";
import { decodeExtension } from "./extensions.ts";
import {
  acquireSessionMap,
  releaseSessionMapsExcept,
  type Session,
  type SessionState,
} from "./session.ts";

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Returns null when the snapshot is safe to restore onto this map,
 *  otherwise a human-readable reason. */
export function restoreProblem(
  snap: SaveSnapshot,
  map: MapDef,
  table: PassageTable,
): string | null {
  if (snap.map !== map.id) {
    return `save is for map ${snap.map}, not ${map.id}`;
  }

  // Player tile bounds + standability. The pixel origin (px == 16*tx etc.)
  // and the tile-boundary safe point are already guaranteed by
  // save-validate.ts; here we only need the live map's geometry.
  const { tx, ty } = snap.player;
  if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) {
    return `player tile (${tx},${ty}) is outside ${map.id} (${map.width}x${map.height})`;
  }
  let effectiveTable: PassageTable;
  try {
    effectiveTable = withTilePropertyOverrides(table, snap.interp.tileProperties);
  } catch (error) {
    return `runtime tile properties are invalid: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!isStandable(effectiveTable, tx, ty)) {
    return `player tile (${tx},${ty}) is not standable on ${map.id}`;
  }

  // Fiber provenance: each live fiber must belong to an event this map
  // defines, on an existing page, with a trigger consistent with the
  // fiber's parallel flag. A fiber for a deleted/reordered event would
  // otherwise run commands the live map never authored.
  const events = new Map((map.events ?? []).map((e) => [e.id, e]));
  const fibers: [string, Record<string, unknown>][] = [];
  const interp = snap.interp as unknown as Record<string, unknown>;
  if (interp.main !== null && interp.main !== undefined) {
    if (!isRecord(interp.main)) return "interp.main: fiber must be an object";
    fibers.push(["interp.main", interp.main]);
  }
  if (isRecord(interp.parallels)) {
    for (const [k, f] of Object.entries(interp.parallels)) {
      if (!isRecord(f)) return `interp.parallels.${k}: fiber must be an object`;
      fibers.push([`interp.parallels.${k}`, f]);
    }
  }
  for (const [path, fiber] of fibers) {
    const key = typeof fiber.key === "string" ? fiber.key : "";
    const slash = key.indexOf("/");
    const eventId = slash >= 0 ? key.slice(slash + 1) : "";
    const ev = events.get(eventId);
    if (!ev) return `${path}: fiber event "${eventId}" does not exist on ${map.id}`;
    const pageIndex = fiber.pageIndex;
    if (typeof pageIndex !== "number" || !Number.isInteger(pageIndex) ||
      pageIndex < 0 || pageIndex >= ev.pages.length) {
      return `${path}: page ${String(pageIndex)} does not exist for event "${eventId}"`;
    }
    const page = ev.pages[pageIndex]!;
    const wantParallel = fiber.parallel === true;
    if (page.trigger === "parallel" !== wantParallel) {
      return `${path}: fiber parallel flag does not match page trigger "${page.trigger}"`;
    }
    const stack = fiber.stack;
    if (!Array.isArray(stack) || stack.length > MAX_FIBER_STACK_DEPTH) {
      return `${path}: stack exceeds ${MAX_FIBER_STACK_DEPTH} frames`;
    }
  }
  return null;
}

/** Restore a decoded snapshot, acquiring an evicted destination map before
 * validation. The repository and compile cache remain derived Session data;
 * the returned reducer state contains only the saved map id and state. */
export function restoreSessionSnapshot(
  session: Session,
  snap: SaveSnapshot,
): SessionState {
  const map = acquireSessionMap(session, snap.map);
  const table = session.tables.get(snap.map)!;
  const problem = restoreProblem(snap, map, table);
  if (problem) throw new SaveError("shape", `save cannot be restored: ${problem}`);
  const interp = cloneInterp(snap.interp);
  // B1 (fix 3): the restore boundary normalizes through
  // the same constructor a fresh session uses, so this entry point shares
  // clampFiniteVar with every other numeric-bank write/construction site
  // even though save-validate.ts already requires a decoded envelope's
  // gold/items/shopStock/variables to be safe integers.
  interp.sw = createSwitchState(interp.sw);
  let ext;
  try {
    ext = decodeExtension(session.extensions, snap.ext);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SaveError("shape", `save extension state is invalid: ${reason}`);
  }
  const state: SessionState = {
    frame: Math.floor(interp.frame / session.ticksPerFrame),
    mapId: snap.map,
    sw: interp.sw,
    move: { ...snap.player },
    chars: createChars(),
    interp,
    fade: null,
    playerRoute: null,
    ext,
    scene: null,
  };
  releaseSessionMapsExcept(session, [snap.map]);
  return state;
}

/** Decode with this session's content identity, then rebuild the target map
 * cache and reducer state. A manifest/schema mismatch is rejected before any
 * map bytes are acquired. */
export function restoreSessionEnvelope(session: Session, text: string): SessionState {
  return restoreSessionSnapshot(session, decodeEnvelopeText(text, session.content));
}
