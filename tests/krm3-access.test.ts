// tests/krm3-access.test.ts — Change Menu Access / Change Save Access
// (RPG Maker 135/134) and their effect on the openMenu/openSave host actions.
//
// Both flags live in SwitchState, default ENABLED (MV parity) and store only
// an explicit disable. The reducer always emits the host action; the UI
// drops a menu/save request whose flag is disabled, so a disabled entry is
// never delivered. gameOver/title are never gated.

import { describe, expect, test } from "bun:test";
import {
  compile,
  createInterpState,
  createSwitchState,
  createWorld,
  stepInterp,
  type InterpInput,
  type InterpState,
} from "../src/engine/interpreter.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import { canonicalJson } from "../src/engine/save.ts";
import { loadSession, restoreSessionEnvelope, saveSession } from "../src/engine/save-restore.ts";
import { encodeEnvelope, encodeSaveCode } from "../src/engine/save.ts";
import { dispatchGameViewHostActions, type GameViewHostCallbacks } from "../src/ui/game-host-actions.ts";
import type { GameViewSessionHost } from "../src/ui/demo-contract.ts";
import type { Command, GameEvent, MapDef, Project } from "../src/engine/types.ts";

const MAP_ID = "v";

function map(events: GameEvent[], w = 12, h = 12): MapDef {
  return {
    id: MAP_ID,
    name: "access",
    width: w,
    height: h,
    sheets: ["plain"],
    ground: Array(w * h).fill("plain.0"),
    events,
  };
}

function input(partial: Partial<InterpInput> = {}): InterpInput {
  const cell = { x: 1, y: 1 };
  return {
    confirmEdge: false,
    cancelEdge: false,
    upEdge: false,
    downEdge: false,
    playerCell: cell,
    prevCell: cell,
    facing: 0,
    ...partial,
  };
}

function idle(w: ReturnType<typeof createWorld>, s0: InterpState, n = 1): InterpState {
  let s = s0;
  for (let i = 0; i < n; i++) s = stepInterp(w, s, input());
  return s;
}

/** An autorun event that runs `commands` once (flips self switch A to a
 *  blank action page). */
function once(id: string, commands: Command[], x = 8, y = 8): GameEvent {
  const flip: Command = { op: "selfSwitch", key: "A", value: true };
  return {
    id,
    x,
    y,
    pages: [
      { trigger: "autorun", commands: [flip, ...commands] },
      { trigger: "action", commands: [], condition: { selfSwitch: "A" } },
    ],
  };
}

function world(events: GameEvent[]) {
  return createWorld(map(events));
}

function project(events: GameEvent[]): Project {
  return {
    format: "rpgkit-project/v1",
    title: "access",
    tileSize: 16,
    start: { map: MAP_ID, x: 1, y: 1, dir: "down" },
    sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [],
    maps: [map(events)],
  };
}

function session(p: Project): Session {
  return createSession(p);
}

// --- switch state -----------------------------------------------------------

describe("menu/save access flags", () => {
  test("default to enabled (absent) and store only an explicit disable", () => {
    const sw = createSwitchState();
    expect(sw.menuAccess).toBeUndefined();
    expect(sw.saveAccess).toBeUndefined();
    const disabled = createSwitchState({ menuAccess: false, saveAccess: false });
    expect(disabled.menuAccess).toBe(false);
    expect(disabled.saveAccess).toBe(false);
    // A stored true is dropped back to absent (enabled).
    const enabled = createSwitchState({ menuAccess: true, saveAccess: true });
    expect(enabled.menuAccess).toBeUndefined();
    expect(enabled.saveAccess).toBeUndefined();
  });

  test("the commands set and clear the flags", () => {
    const w = world([once("e", [
      { op: "menuAccess", enabled: false },
      { op: "saveAccess", enabled: false },
      { op: "switch", id: "off", value: true },
    ])]);
    let s = idle(w, createInterpState(), 4);
    expect(s.sw.menuAccess).toBe(false);
    expect(s.sw.saveAccess).toBe(false);
    expect(s.sw.switches["off"]).toBe(true);

    const w2 = world([once("e2", [
      { op: "menuAccess", enabled: true },
      { op: "saveAccess", enabled: true },
      { op: "switch", id: "on", value: true },
    ])]);
    s = idle(w2, s, 4);
    expect(s.sw.menuAccess).toBeUndefined();
    expect(s.sw.saveAccess).toBeUndefined();
    expect(s.sw.switches["on"]).toBe(true);
  });
});

// --- host action dispatch ---------------------------------------------------

function mockHost(sw: Partial<SessionState["sw"]>): GameViewSessionHost {
  const state = { sw: { ...createSwitchState(), ...sw } } as unknown as SessionState;
  return { getState: () => state } as GameViewSessionHost;
}

describe("dispatchGameViewHostActions honors the access flags", () => {
  test("a disabled menu/save request is dropped; gameOver/title still deliver", () => {
    const delivered: string[] = [];
    const callbacks: GameViewHostCallbacks = {
      menu: () => delivered.push("menu"),
      save: () => delivered.push("save"),
      gameOver: () => delivered.push("gameOver"),
      title: () => delivered.push("title"),
    };
    const host = mockHost({ menuAccess: false, saveAccess: false });
    dispatchGameViewHostActions(["menu", "save", "gameOver", "title"], callbacks, host);
    expect(delivered).toEqual(["gameOver", "title"]);
  });

  test("enabled flags (the default) deliver every request", () => {
    const delivered: string[] = [];
    const callbacks: GameViewHostCallbacks = {
      menu: () => delivered.push("menu"),
      save: () => delivered.push("save"),
    };
    dispatchGameViewHostActions(["menu", "save", "menu"], callbacks, mockHost({}));
    expect(delivered).toEqual(["menu", "save", "menu"]);
  });

  test("only the disabled flag is gated", () => {
    const delivered: string[] = [];
    const callbacks: GameViewHostCallbacks = {
      menu: () => delivered.push("menu"),
      save: () => delivered.push("save"),
    };
    dispatchGameViewHostActions(["menu", "save"], callbacks, mockHost({ saveAccess: false }));
    expect(delivered).toEqual(["menu"]);
  });
});

// --- save/restore and rewind ------------------------------------------------

describe("menu/save access across saves and rewind", () => {
  test("a disable survives save/restore; an enabled state stays enabled", () => {
    const p = project([once("e", [
      { op: "menuAccess", enabled: false },
      { op: "saveAccess", enabled: false },
    ])]);
    const sess = session(p);
    let state = startSession(p, sess);
    for (let i = 0; i < 8; i++) state = stepSession(sess, state, { buttons: 0 });
    expect(state.interp.sw.menuAccess).toBe(false);
    expect(state.interp.sw.saveAccess).toBe(false);

    const saved = saveSession(sess, state, 0);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const restored = restoreSessionEnvelope(session(p), encodeEnvelope(saved.snapshot));
    expect(restored.interp.sw.menuAccess).toBe(false);
    expect(restored.interp.sw.saveAccess).toBe(false);
    const loaded = loadSession(session(p), encodeSaveCode(saved.snapshot));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.state.interp.sw.menuAccess).toBe(false);
      expect(loaded.state.interp.sw.saveAccess).toBe(false);
    }
  });

  test("the flags replay identically from a mid-run keyframe", () => {
    const p = project([once("e", [
      { op: "menuAccess", enabled: false },
      { op: "switch", id: "off", value: true },
    ])]);
    const sess = session(p);
    const tape = Array(12).fill(0);
    const ref: SessionState[] = [startSession(p, sess)];
    for (const buttons of tape) ref.push(stepSession(sess, ref.at(-1)!, { buttons }));
    const key = (s: SessionState) =>
      canonicalJson({ m: s.interp.sw.menuAccess, sv: s.interp.sw.saveAccess, sw: s.interp.sw.switches });
    for (const at of [2, 5, 9]) {
      const keyframe = ref[at]!;
      const before = key(keyframe);
      const replay: SessionState[] = [keyframe];
      for (let i = at; i < tape.length; i++) {
        replay.push(stepSession(session(p), replay.at(-1)!, { buttons: tape[i] }));
      }
      expect(key(keyframe)).toBe(before);
      for (let k = 0; k < replay.length; k++) {
        expect(key(replay[k]!)).toBe(key(ref[at + k]!));
      }
    }
  });
});
