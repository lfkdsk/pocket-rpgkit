// tools/rpgkit-check/src/dynamic/reach-witness.ts — replayable input witnesses.
//
// A reach witness is a button-mask tape recorded at CHECK_HZ (60): one u16
// PSP BTN mask per reference tick. The search records masks in CONSTANT
// 6-TICK BLOCKS — every block holds one mask, pressed edges land on the
// first tick of a block. A witness is replayed and verified at 60 Hz only
// (a fresh session, one stepSession call per tick): the tool makes no
// claim about other host frame rates.
//
// CIRCLE confirms and CROSS cancels (the engine's attract/tape convention,
// src/engine/attract.ts reduce()); edges are the pressed bits against the
// previous mask. The tape is plain data: an AI agent (or a human) can fold
// it through any fresh session and land on the same map.

import { canonicalJson, fnv1aText, sessionStateFingerprint } from "../../../../src/engine/save.ts";
import {
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../../../../src/engine/session.ts";
import type { Project } from "../../../../src/engine/types.ts";
import type { SwitchState } from "../../../../src/engine/interpreter.ts";

// PSP BTN mask bits (contracts/spec/spec.ts BTN), mirrored so this module
// keeps zero framework imports.
export const BTN_UP = 0x0010;
export const BTN_RIGHT = 0x0020;
export const BTN_DOWN = 0x0040;
export const BTN_LEFT = 0x0080;
export const BTN_CIRCLE = 0x2000;
export const BTN_CROSS = 0x4000;

/** Bits that act as pressed edges (not held levels) in a witness tape. */
export const EDGE_BITS = BTN_CIRCLE | BTN_CROSS | BTN_UP | BTN_DOWN;

export interface ReachWitness {
  /** Recording rate: the tape is one mask per 60 Hz reference tick. */
  hz: 60;
  /** One u16 button mask per tick, constant over 6-tick blocks (the six
   *  masks of a block are equal; pressed edges land on a block start). */
  masks: number[];
}

/** The full reducer state, normalized for hashing: `cues` are per-fold
 *  host-drained side outputs (src/engine/interpreter.ts clears them at the
 *  start of every fold), so two states equal in every reducer respect can
 *  differ only in cues. Everything else — banks, fibers, parallels, modal,
 *  scene, ext — is compared byte for byte. */
function normalizeForHash(s: SessionState): unknown {
  return { ...s, interp: { ...s.interp, cues: [] } };
}

/** FNV-1a over the canonical JSON of the full normalized state. Two states
 *  with the same hash folded the same future (the reducer is deterministic). */
export function stateHash(s: SessionState): string {
  return fnv1aText(canonicalJson(normalizeForHash(s)));
}

/** The dedup key for the search: the engine's own canonical state identity
 *  (sessionStateFingerprint — the save-snapshot payload of map, player, the
 *  full interpreter state and ext, with between-fold transients dropped and
 *  pure progress zeroed: the absolute frame clock, audio playback positions,
 *  and the mover's sub-tile interpolation kept at tile+facing; every
 *  absolute time anchor — a fiber's `since`, an animation's `start` — is
 *  rebased onto the zeroed clock, so same elapsed time merges and different
 *  elapsed time splits). Persistent audio intent, fibers, parallels,
 *  latches, placements and every other field that can change a page
 *  condition or a command's future are in the key automatically — a
 *  bgmPlaying gate after a playBgm is never merged into the pre-music state.
 *  Two states equal on this key fold the same reducer future; merging them
 *  can only leave a map unfound (a lead, not a proof), never fabricate a
 *  witness. The held button mask is input state, tracked per node as
 *  endMask, and is not part of the key. */
export function stateKey(s: SessionState): string {
  return sessionStateFingerprint(s);
}

export interface ReplayResult {
  /** State after the final tick. */
  state: SessionState;
  /** mapId after each tick, starting with the start map (length =
   *  masks.length + 1). */
  maps: string[];
  /** stateHash of the final state. */
  finalHash: string;
}

function foldMask(
  session: Session,
  state: SessionState,
  mask: number,
  prev: number,
): SessionState {
  const pressed = (mask & ~prev) >>> 0;
  return stepSession(session, state, {
    buttons: mask,
    confirmEdge: !!(pressed & BTN_CIRCLE),
    cancelEdge: !!(pressed & BTN_CROSS),
    upEdge: !!(pressed & BTN_UP),
    downEdge: !!(pressed & BTN_DOWN),
  });
}

/** Replay a witness tick by tick at 60 Hz through a FRESH session (the
 *  caller creates it with the same battle/extension options the search
 *  used). Returns the per-tick map trail and the final state hash. */
export function replayWitness(
  session: Session,
  project: Project,
  witness: ReachWitness,
  sw0?: SwitchState,
): ReplayResult {
  let state = startSession(project, session, sw0);
  const maps: string[] = [state.mapId];
  let prev = 0;
  for (const mask of witness.masks) {
    state = foldMask(session, state, mask >>> 0, prev);
    maps.push(state.mapId);
    prev = mask >>> 0;
  }
  return { state, maps, finalHash: stateHash(state) };
}

/** Verify a witness against an expected final map and state hash. Returns
 *  the replay result when the replay really lands on `targetMap` with the
 *  expected state, or an explanation when it does not. */
export function verifyWitness(
  session: Session,
  project: Project,
  witness: ReachWitness,
  targetMap: string,
  expectedHash: string,
  sw0?: SwitchState,
): { ok: true; replay: ReplayResult } | { ok: false; reason: string; replay: ReplayResult } {
  const replay = replayWitness(session, project, witness, sw0);
  if (replay.state.mapId !== targetMap) {
    return {
      ok: false,
      reason: `replay ends on ${JSON.stringify(replay.state.mapId)}, expected ${JSON.stringify(targetMap)}`,
      replay,
    };
  }
  if (replay.finalHash !== expectedHash) {
    return {
      ok: false,
      reason: `replay state hash ${replay.finalHash} does not match the recorded state ${expectedHash}`,
      replay,
    };
  }
  return { ok: true, replay };
}
