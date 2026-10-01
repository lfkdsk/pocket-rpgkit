// tests/k4-fix3-finite-state.test.ts — K4 fix 3, B1:
// every construction/restore entry point, plus ext/battle write points,
// share the interpreter's finite-safe-integer normalizer, not only the
// authored command writes fix 2 already covered.
//
// Four regressions:
//   1. createSwitchState (the public constructor) clamps a hand-built
//      1e308/-1e308 seed in all four numeric banks.
//   2. A checksum-valid envelope whose numeric bank carries 1e308 is
//      refused by save-validate.ts's safe-integer requirement, as a typed
//      SaveError, before restoreSessionSnapshot ever runs.
//   3. An ext command's `result.writes` clamps a 1e308 write and the
//      result still saves/reloads.
//   4. A BattleCompletion.writes clamps a 1e308 write and the result
//      still saves/reloads.

import { describe, expect, test } from "bun:test";
import { createInterpState, createSwitchState } from "../src/engine/interpreter.ts";
import {
  canonicalJson,
  createSessionSnapshot,
  createSnapshot,
  decodeEnvelopeText,
  encodeEnvelope,
  fnv1aText,
  SaveError,
} from "../src/engine/save.ts";
import { restoreSessionEnvelope } from "../src/engine/save-restore.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import { initialMovement } from "../src/engine/movement.ts";
import type { BattleCompletion, BattleRules } from "../src/engine/battle.ts";
import type { GameEvent, MapDef, Project } from "../src/engine/types.ts";

const MAX = Number.MAX_SAFE_INTEGER;
const TILE = "plain.0";

function map(id: string, events: GameEvent[] = []): MapDef {
  return {
    id, name: id, width: 6, height: 6, sheets: ["plain"],
    ground: new Array(36).fill(TILE), events,
  };
}

function step(session: Session, state: SessionState): SessionState {
  return stepSession(session, state, { buttons: 0 });
}

/** Fold until the fiber settles (no active fiber, no modal, no scene), so
 *  the resulting state passes canSave and a snapshot can be taken. */
function settle(session: Session, state: SessionState): SessionState {
  let next = state;
  for (let i = 0; i < 10; i++) {
    next = step(session, next);
    if (!next.scene && !next.interp.main && !next.interp.modal) break;
  }
  return next;
}

describe("K4 fix 3 — construction shares the finite-safe-integer clamp", () => {
  test("createSwitchState clamps a hand-built 1e308/-1e308 seed in all four banks", () => {
    const sw = createSwitchState({
      gold: 1e308,
      items: { potion: 1e308, cursed: -1e308 },
      variables: { score: 1e308, name: "kept" },
      shopStock: { "shop:key": 1e308 },
    });
    expect(sw.gold).toBe(MAX);
    expect(sw.items.potion).toBe(MAX);
    expect(sw.items.cursed).toBe(-MAX);
    expect(sw.variables.score).toBe(MAX);
    expect(sw.variables.name).toBe("kept"); // strings pass through untouched
    expect(sw.shopStock["shop:key"]).toBe(MAX);
    expect(Number.isSafeInteger(sw.gold)).toBe(true);
    expect(Number.isSafeInteger(sw.items.potion)).toBe(true);
    expect(Number.isSafeInteger(sw.items.cursed)).toBe(true);
    expect(Number.isSafeInteger(sw.variables.score as number)).toBe(true);
    expect(Number.isSafeInteger(sw.shopStock["shop:key"]!)).toBe(true);
  });

  test("shopStock never goes negative even when seeded with a huge negative value", () => {
    const sw = createSwitchState({ shopStock: { "shop:key": -1e308 } });
    expect(sw.shopStock["shop:key"]).toBe(0);
  });
});

describe("K4 fix 3 — restore refuses a checksum-valid envelope with an out-of-range bank", () => {
  test("gold: 1e308 is refused as a typed SaveError, not silently restored", () => {
    const player = initialMovement(2, 2, 0, { tile: 16, speed: 2 });
    const snap = createSnapshot("a", player, {
      frame: 0, sw: createSwitchState(), main: null, parallels: {}, modal: null,
      erased: {}, touched: {}, inputLocked: false, placements: {}, anims: [], cues: [],
      pendingTransfer: null, pendingMoveRoutes: [], pendingBattles: [], pendingPlacements: [],
      abortedRoutes: [],
    }, 0);
    const envelope = JSON.parse(encodeEnvelope(snap)) as { state: unknown; checksum: string };
    const tampered = envelope.state as { interp: { sw: { gold: number } } };
    tampered.interp.sw.gold = 1e308;
    // Recompute the checksum over the tampered state: this is the "correct
    // checksum but an illegal bank" envelope the review asked for, not a
    // truncated/edited-byte case (which would fail with code "checksum").
    envelope.checksum = fnv1aText(canonicalJson(envelope.state));
    const text = JSON.stringify(envelope);
    let error: unknown;
    try {
      decodeEnvelopeText(text);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SaveError);
    expect((error as SaveError).code).toBe("shape");
    expect((error as SaveError).message).toMatch(/gold/);
  });
});

describe("K4 fix 3 — ext command writes clamp through the shared normalizer", () => {
  function project(commands: GameEvent["pages"][number]["commands"]): Project {
    return {
      format: "rpgkit-project/v1", title: "ext-clamp", tileSize: 16,
      start: { map: "a", x: 2, y: 2, dir: "down" },
      sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
      items: [],
      maps: [map("a", [{
        id: "e", x: 2, y: 2,
        pages: [{ trigger: "autorun", commands }],
      }])],
    };
  }

  test("result.writes clamps 1e308 and the clamped value survives a save round trip", () => {
    const p = project([
      { op: "ext", call: "demo.reward", args: null },
      { op: "switch", id: "after", value: true },
    ]);
    const session = createSession(p, 60, {
      extensions: {
        initial: null,
        commands: {
          "demo.reward": () => ({ writes: { "ext.reward": 1e308 } }),
        },
      },
    });
    let state = startSession(p, session);
    state = settle(session, state);
    expect(state.sw.variables["ext.reward"]).toBe(MAX);
    expect(Number.isSafeInteger(state.sw.variables["ext.reward"] as number)).toBe(true);

    const snapshot = createSessionSnapshot(session, state, 0);
    const bytes = encodeEnvelope(snapshot);
    const restored = restoreSessionEnvelope(session, bytes);
    expect(restored.interp.sw.variables["ext.reward"]).toBe(MAX);
  });
});

describe("K4 fix 3 — battle completion writes clamp through the shared normalizer", () => {
  // Minimal BattleRules that completes on the very first advance: `start`
  // seeds `done:true`, `step` is a no-op, `done` fires immediately with a
  // huge numeric write. Exercises BattleCompletion.writes specifically,
  // independent of the toy-battle fixture's HP/turn mechanics.
  const instantWinRules: BattleRules = {
    start: (ext) => ({ ext, state: true }),
    step: (state) => state,
    done: (state): BattleCompletion | null =>
      state === true
        ? { ext: null, result: "win", writes: { "battle.reward": 1e308 } }
        : null,
  };

  function project(): Project {
    return {
      format: "rpgkit-project/v1", title: "battle-clamp", tileSize: 16,
      start: { map: "a", x: 2, y: 2, dir: "down" },
      sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
      items: [],
      maps: [map("a", [{
        id: "battle", x: 2, y: 2,
        pages: [{
          trigger: "autorun",
          commands: [
            { op: "battle", setup: null, onWin: [{ op: "switch", id: "won", value: true }] },
            { op: "switch", id: "after", value: true },
          ],
        }],
      }])],
    };
  }

  test("BattleCompletion.writes clamps 1e308 and the clamped value survives a save round trip", () => {
    const p = project();
    const session = createSession(p, 60, { battle: instantWinRules });
    let state = startSession(p, session);
    state = settle(session, state);
    expect(state.sw.switches.won).toBe(true);
    expect(state.sw.variables["battle.reward"]).toBe(MAX);
    expect(Number.isSafeInteger(state.sw.variables["battle.reward"] as number)).toBe(true);

    const snapshot = createSessionSnapshot(session, state, 0);
    const bytes = encodeEnvelope(snapshot);
    const restored = restoreSessionEnvelope(session, bytes);
    expect(restored.interp.sw.variables["battle.reward"]).toBe(MAX);
  });
});

describe("the save boundary normalizes numeric banks", () => {
  test("a live state mutated to 1e308 saves into an envelope that decodes", () => {
    const player = initialMovement(2, 2, 0, { tile: 16, speed: 2 });
    const interp = createInterpState();
    interp.sw.gold = 1e308;
    interp.sw.items.potion = 1e308;
    interp.sw.variables.score = -1e308;
    interp.sw.shopStock["mart:potion"] = 1e308;
    const snap = createSnapshot("a", player, interp, 0);
    expect(snap.interp.sw.gold).toBe(MAX);
    expect(snap.interp.sw.items.potion).toBe(MAX);
    expect(snap.interp.sw.variables.score).toBe(-MAX);
    expect(snap.interp.sw.shopStock["mart:potion"]).toBe(MAX);
    const decoded = decodeEnvelopeText(encodeEnvelope(snap));
    expect(decoded.interp.sw.gold).toBe(MAX);
    expect(decoded.interp.sw.items.potion).toBe(MAX);
    // The live state itself is untouched: only the saved copy is normalized.
    expect(interp.sw.gold).toBe(1e308);
  });
});
