// tests/krm3-location.test.ts — Get Location Info (RPG Maker 285) and the
// region condition, with the map's optional region-id and terrain-tag layers.

import { describe, expect, test } from "bun:test";
import {
  createInterpState,
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
import type { Command, GameEvent, MapDef, Project } from "../src/engine/types.ts";

const MAP_ID = "v";
const W = 12;
const H = 12;

function map(events: GameEvent[], extra: Partial<MapDef> = {}): MapDef {
  return {
    id: MAP_ID,
    name: "location",
    width: W,
    height: H,
    sheets: ["plain"],
    ground: Array(W * H).fill("plain.0"),
    ...(extra.upper ? { upper: extra.upper } : {}),
    ...(extra.regions ? { regions: extra.regions } : {}),
    ...(extra.terrain ? { terrain: extra.terrain } : {}),
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

/** An autorun event that runs `commands` once (flips self switch A). */
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

function world(events: GameEvent[], extra: Partial<MapDef> = {}) {
  return createWorld(map(events, extra));
}

function project(events: GameEvent[], extra: Partial<MapDef> = {}): Project {
  return {
    format: "rpgkit-project/v1",
    title: "location",
    tileSize: 16,
    start: { map: MAP_ID, x: 1, y: 1, dir: "down" },
    sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [],
    maps: [map(events, extra)],
  };
}

function session(p: Project): Session {
  return createSession(p);
}

const idx = (x: number, y: number) => y * W + x;
const loc = (variable: string, x: number | { variable: string }, y: number | { variable: string },
  kind: "terrain" | "event" | "tile" | "region", layer?: 0 | 1): Command =>
  ({ op: "locationInfo", variable, x, y, kind, ...(layer !== undefined ? { layer } : {}) });

// --- locationInfo -----------------------------------------------------------

describe("locationInfo", () => {
  test("reads the region id at a literal cell (0 when unmarked)", () => {
    const w = world([once("e", [
      loc("r1", 3, 4, "region"),
      loc("r2", 0, 0, "region"),
      { op: "switch", id: "done", value: true },
    ])], { regions: [[idx(3, 4), 7]] });
    const s = idle(w, createInterpState(), 6);
    expect(s.sw.variables["r1"]).toBe(7);
    expect(s.sw.variables["r2"]).toBe(0);
    expect(s.sw.switches["done"]).toBe(true);
  });

  test("reads the terrain tag at a literal cell", () => {
    const w = world([once("e", [
      loc("t1", 5, 6, "terrain"),
      loc("t2", 0, 0, "terrain"),
    ])], { terrain: [[idx(5, 6), 3]] });
    const s = idle(w, createInterpState(), 4);
    expect(s.sw.variables["t1"]).toBe(3);
    expect(s.sw.variables["t2"]).toBe(0);
  });

  test("reads the lowest event id on a cell", () => {
    const w = world([
      once("e", [loc("ev", 9, 9, "event"), { op: "switch", id: "done", value: true }], 2, 2),
      { id: "ev007", x: 9, y: 9, pages: [{ trigger: "action", commands: [] }] },
      { id: "ev003", x: 9, y: 9, pages: [{ trigger: "action", commands: [] }] },
    ]);
    const s = idle(w, createInterpState(), 4);
    expect(s.sw.variables["ev"]).toBe(3); // lowest numeric id
    expect(s.sw.switches["done"]).toBe(true);
  });

  test("reads 0 for an empty cell's event", () => {
    const w = world([once("e", [loc("ev", 0, 0, "event")])]);
    const s = idle(w, createInterpState(), 3);
    expect(s.sw.variables["ev"]).toBe(0);
  });

  test("reads the ground and upper tile's sheet index", () => {
    const w = world([once("e", [
      loc("g", 1, 1, "tile"),
      loc("u", 1, 1, "tile", 1),
    ])], { upper: [[idx(1, 1), "plain.42"]] });
    const s = idle(w, createInterpState(), 3);
    expect(s.sw.variables["g"]).toBe(0); // plain.0
    expect(s.sw.variables["u"]).toBe(42); // plain.42
  });

  test("reads coordinates from variables", () => {
    const w = world([once("e", [
      { op: "variable", id: "vx", set: { op: "set", value: 3 } },
      { op: "variable", id: "vy", set: { op: "set", value: 4 } },
      loc("r", { variable: "vx" }, { variable: "vy" }, "region"),
    ])], { regions: [[idx(3, 4), 9]] });
    const s = idle(w, createInterpState(), 5);
    expect(s.sw.variables["r"]).toBe(9);
  });

  test("writes 0 for an out-of-bounds cell", () => {
    const w = world([once("e", [
      loc("oob", 100, 100, "region"),
      loc("neg", -1, 0, "terrain"),
    ])]);
    const s = idle(w, createInterpState(), 3);
    expect(s.sw.variables["oob"]).toBe(0);
    expect(s.sw.variables["neg"]).toBe(0);
  });

  test("a map without regions/terrain reads 0 at no cost", () => {
    const w = world([once("e", [loc("r", 1, 1, "region"), loc("t", 1, 1, "terrain")])]);
    const s = idle(w, createInterpState(), 3);
    expect(s.sw.variables["r"]).toBe(0);
    expect(s.sw.variables["t"]).toBe(0);
    expect(w.regionCells).toBeUndefined();
    expect(w.terrainCells).toBeUndefined();
  });
});

// --- region condition -------------------------------------------------------

describe("region condition", () => {
  test("an if branch on a region condition follows the cell's region", () => {
    const w = world([once("e", [
      {
        op: "if",
        if: { kind: "region", x: 3, y: 4, id: 7 },
        then: [{ op: "switch", id: "match", value: true }],
        else: [{ op: "switch", id: "nomatch", value: true }],
      },
      {
        op: "if",
        if: { kind: "region", x: 0, y: 0, id: 0 },
        then: [{ op: "switch", id: "unmarked", value: true }],
      },
    ])], { regions: [[idx(3, 4), 7]] });
    const s = idle(w, createInterpState(), 4);
    expect(s.sw.switches["match"]).toBe(true);
    expect(s.sw.switches["nomatch"]).toBeUndefined();
    expect(s.sw.switches["unmarked"]).toBe(true); // id 0 matches an unmarked cell
  });

  test("a page condition with a region clause gates the page", () => {
    const w = world([
      {
        id: "ev001",
        x: 3,
        y: 4,
        pages: [
          { trigger: "action", commands: [], condition: { all: [{ kind: "region", x: 3, y: 4, id: 7 }] } },
          { trigger: "action", commands: [{ op: "switch", id: "page2", value: true }] },
        ],
      },
    ], { regions: [[idx(3, 4), 7]] });
    // The region matches, so page 1 (empty) is active; page 2 never runs.
    const s = idle(w, createInterpState(), 2);
    expect(s.sw.switches["page2"]).toBeUndefined();
    expect(w.needsRegionContext).toBe(true);
  });
});

// --- determinism: hz, save, rewind -----------------------------------------

describe("locationInfo determinism", () => {
  test("reads the same values at 60/30/20/4 Hz", () => {
    const p = project([once("e", [
      loc("r", 3, 4, "region"),
      loc("t", 5, 6, "terrain"),
      loc("ev", 9, 9, "event"),
      { op: "switch", id: "done", value: true },
    ], 9, 9)], {
      regions: [[idx(3, 4), 7]],
      terrain: [[idx(5, 6), 3]],
    });
    for (const hz of [60, 30, 20, 4] as const) {
      const sess = createSession(p, hz);
      let state = startSession(p, sess);
      for (let i = 0; i < hz; i++) state = stepSession(sess, state, { buttons: 0 });
      expect(state.interp.sw.variables["r"]).toBe(7);
      expect(state.interp.sw.variables["t"]).toBe(3);
      expect(state.interp.sw.switches["done"]).toBe(true);
    }
  });

  test("a locationInfo result survives save/restore", () => {
    const p = project([once("e", [loc("r", 3, 4, "region"), { op: "switch", id: "done", value: true }])],
      { regions: [[idx(3, 4), 7]] });
    const sess = session(p);
    let state = startSession(p, sess);
    for (let i = 0; i < 6; i++) state = stepSession(sess, state, { buttons: 0 });
    expect(state.interp.sw.variables["r"]).toBe(7);
    const saved = saveSession(sess, state, 0);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const restored = restoreSessionEnvelope(session(p), encodeEnvelope(saved.snapshot));
    expect(restored.interp.sw.variables["r"]).toBe(7);
    const loaded = loadSession(session(p), encodeSaveCode(saved.snapshot));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.state.interp.sw.variables["r"]).toBe(7);
  });

  test("replays identically from a mid-run keyframe", () => {
    const p = project([once("e", [
      loc("r", 3, 4, "region"),
      { op: "switch", id: "done", value: true },
    ])], { regions: [[idx(3, 4), 7]] });
    const sess = session(p);
    const tape = Array(12).fill(0);
    const ref: SessionState[] = [startSession(p, sess)];
    for (const buttons of tape) ref.push(stepSession(sess, ref.at(-1)!, { buttons }));
    const key = (s: SessionState) =>
      canonicalJson({ v: s.interp.sw.variables, sw: s.interp.sw.switches });
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
