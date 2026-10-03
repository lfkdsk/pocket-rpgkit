// tests/labels.test.ts — the `label` / `jumpLabel` event commands (RPG Maker
// 118/119).
//
// A label names a position in a page or common event; a jumpLabel continues
// at the FIRST label with that name anywhere in the same list, at any nesting
// depth. Jumping out of a block abandons it; jumping into one enters that
// branch unconditionally (its choice/battle/scene is not replayed). A name
// with no label does nothing, like MV. A backward jump that never reaches a
// label again is stopped by the per-frame step budget that bounds loops.

import { describe, expect, test } from "bun:test";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import {
  RUNAWAY_STEP_LIMIT,
  compile,
  createInterpState,
  createWorld,
  stepInterp,
  type InterpInput,
  type InterpState,
  type Instr,
} from "../src/engine/interpreter.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import { canonicalJson, encodeEnvelope, encodeSaveCode } from "../src/engine/save.ts";
import { loadSession, restoreSessionEnvelope, saveSession } from "../src/engine/save-restore.ts";
import type { Command, CommonEvent, GameEvent, MapDef, Project } from "../src/engine/types.ts";

const MAP_ID = "v";

function map(events: GameEvent[], w = 12, h = 12): MapDef {
  return {
    id: MAP_ID,
    name: "labels",
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

const add = (id: string, value = 1): Command => ({ op: "variable", id, set: { op: "add", value } });
const set = (id: string, value: number): Command => ({ op: "variable", id, set: { op: "set", value } });
const on = (id: string): Command => ({ op: "switch", id, value: true });
const label = (name: string): Command => ({ op: "label", name });
const jump = (name: string): Command => ({ op: "jumpLabel", name });
const ifVar = (id: string, op: ">=" | "==", value: number, then: Command[], els?: Command[]): Command => ({
  op: "if",
  if: { kind: "variable", id, op, value },
  then,
  ...(els ? { else: els } : {}),
});

function world(events: GameEvent[], common: CommonEvent[] = [], hz = 60) {
  return createWorld(map(events), common, hz);
}

const vars = (s: InterpState) => s.sw.variables;

function project(events: GameEvent[], common: CommonEvent[] = []): Project {
  return {
    format: "rpgkit-project/v1",
    title: "labels",
    tileSize: 16,
    start: { map: MAP_ID, x: 1, y: 1, dir: "down" },
    sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [],
    commonEvents: common,
    maps: [map(events)],
  };
}

function session(p: Project, hz: 60 | 30 | 20 | 4 = 60): Session {
  return createSession(p, hz);
}

function run(sess: Session, p: Project, masks: readonly number[], from?: SessionState): SessionState[] {
  let state = from ?? startSession(p, sess);
  const out = [state];
  for (const buttons of masks) {
    state = stepSession(sess, state, { buttons });
    out.push(state);
  }
  return out;
}

// --- compile ----------------------------------------------------------------

describe("compile: labels", () => {
  test("a label and jump compile to position markers in the same program", () => {
    const prog = compile([label("a"), add("n"), jump("a")]);
    expect(prog.map((i) => i.op)).toEqual(["label", "variable", "jumpLabel"]);
    expect(prog[0]).toEqual({ op: "label", name: "a" });
    expect(prog[2]).toEqual({ op: "jumpLabel", name: "a" });
  });

  test("a label inside a branch compiles into that branch program", () => {
    const prog = compile([
      { op: "choices", prompt: "?", options: [{ text: "go", commands: [label("inside"), add("n")] }] },
      jump("inside"),
    ]);
    const choices = prog[0] as Extract<Instr, { op: "choices" }>;
    expect(choices.branches[0]![0]).toEqual({ op: "label", name: "inside" });
    expect(prog[1]).toEqual({ op: "jumpLabel", name: "inside" });
  });
});

// --- same-program jumps -----------------------------------------------------

describe("jumpLabel within one program", () => {
  test("a forward jump skips the commands between", () => {
    const w = world([once("e", [jump("skip"), add("never"), label("skip"), add("ran"), on("done")])]);
    const s = idle(w, createInterpState(), 4);
    expect(vars(s)["never"]).toBeUndefined();
    expect(vars(s)["ran"]).toBe(1);
    expect(s.sw.switches["done"]).toBe(true);
  });

  test("a backward jump with a conditional exit loops until the exit", () => {
    const w = world([once("e", [
      label("top"),
      add("n"),
      ifVar("n", ">=", 3, [jump("out")]),
      jump("top"),
      label("out"),
      on("done"),
    ])]);
    const s = idle(w, createInterpState(), 10);
    expect(vars(s)["n"]).toBe(3);
    expect(s.sw.switches["done"]).toBe(true);
    expect(s.error).toBeUndefined();
  });

  test("a backward jump with no exit is stopped by the step budget", () => {
    const w = world([once("e", [label("spin"), jump("spin")])]);
    const s = idle(w, createInterpState(), 1);
    expect(s.error).toBeDefined();
    expect(s.error!.kind).toBe("runaway");
  });

  test("the budget is shared: a goto loop in one fiber is bounded per tick", () => {
    // Two fibers: the autorun spins on a goto; a parallel still gets its
    // slice of the same RUNAWAY_STEP_LIMIT budget before the error.
    const w = world([
      once("spin", [label("x"), jump("x")], 2, 2),
      { id: "tick", x: 9, y: 9, pages: [{ trigger: "parallel", commands: [add("t")] }] },
    ]);
    const s = idle(w, createInterpState(), 1);
    expect(s.error).toBeDefined();
    // The parallel ran at least one instruction before the budget ran out.
    expect(vars(s)["t"]).toBeGreaterThanOrEqual(1);
  });

  test("a jump to a name with no label does nothing (MV parity)", () => {
    const w = world([once("e", [jump("nope"), add("ran"), on("done")])]);
    const s = idle(w, createInterpState(), 4);
    expect(vars(s)["ran"]).toBe(1);
    expect(s.sw.switches["done"]).toBe(true);
    expect(s.error).toBeUndefined();
  });

  test("the first label with a name wins (MV scans top-down)", () => {
    const w = world([once("e", [
      jump("dup"),
      add("never"),
      label("dup"),
      add("first"),
      label("dup"),
      add("second"),
      on("done"),
    ])]);
    const s = idle(w, createInterpState(), 6);
    expect(vars(s)["never"]).toBeUndefined();
    expect(vars(s)["first"]).toBe(1);
    expect(vars(s)["second"]).toBe(1);
    expect(s.sw.switches["done"]).toBe(true);
  });
});

// --- jumps across if branches ----------------------------------------------

describe("jumpLabel across if branches", () => {
  test("a jump from before the if lands on a label inside the (not-taken) branch", () => {
    // The if is false (s001 off), so the branch is never entered normally;
    // the jump enters it unconditionally, then falls out past the if.
    const w = world([once("e", [
      jump("inside"),
      add("after"),
      { op: "if", if: { kind: "switch", id: "s001", value: true }, then: [label("inside"), add("branch")] },
      on("done"),
    ])]);
    const s = idle(w, createInterpState(), 6);
    expect(vars(s)["branch"]).toBe(1);
    expect(vars(s)["after"]).toBeUndefined(); // the jump skipped it
    expect(s.sw.switches["done"]).toBe(true);
  });

  test("a jump from inside a taken branch lands on a label after the branch", () => {
    const w = world([once("e", [
      on("s001"),
      { op: "if", if: { kind: "switch", id: "s001", value: true }, then: [add("a"), jump("out"), add("never")] },
      label("out"),
      add("after"),
      on("done"),
    ])]);
    const s = idle(w, createInterpState(), 6);
    expect(vars(s)["a"]).toBe(1);
    expect(vars(s)["never"]).toBeUndefined();
    expect(vars(s)["after"]).toBe(1);
    expect(s.sw.switches["done"]).toBe(true);
  });

  test("a jump from the then-branch to a label in the else-branch enters it", () => {
    const w = world([once("e", [
      on("s001"),
      {
        op: "if",
        if: { kind: "switch", id: "s001", value: true },
        then: [jump("else")],
        else: [label("else"), add("els")],
      },
      on("done"),
    ])]);
    const s = idle(w, createInterpState(), 6);
    expect(vars(s)["els"]).toBe(1);
    expect(s.sw.switches["done"]).toBe(true);
  });
});

// --- jumps across choices branches ------------------------------------------

describe("jumpLabel across choices branches", () => {
  test("a jump from the cancel branch enters an option body", () => {
    const w = world([once("e", [
      {
        op: "choices",
        prompt: "?",
        options: [{ text: "a", commands: [label("opt"), add("a"), jump("done")] }],
        cancel: { commands: [jump("opt")] },
      },
      label("done"),
      on("done"),
    ])]);
    let s = createInterpState();
    s = stepInterp(w, s, input()); // open the modal
    expect(s.modal?.kind).toBe("choices");
    s = stepInterp(w, s, input({ cancelEdge: true })); // cancel -> jumps into option a
    s = idle(w, s, 6);
    expect(vars(s)["a"]).toBe(1);
    expect(s.sw.switches["done"]).toBe(true);
  });

  test("a jump from one option to a label in another option runs the rest of the target", () => {
    const w = world([once("e", [
      {
        op: "choices",
        prompt: "?",
        options: [
          { text: "a", commands: [add("a"), jump("b")] },
          { text: "b", commands: [label("b"), add("b")] },
        ],
      },
      on("done"),
    ])]);
    // Pick option a (confirmEdge). The jump then enters option b's body.
    let s = createInterpState();
    s = stepInterp(w, s, input()); // open the modal
    expect(s.modal?.kind).toBe("choices");
    s = stepInterp(w, s, input({ confirmEdge: true })); // pick a -> jumps into b
    s = idle(w, s, 4);
    expect(vars(s)["a"]).toBe(1);
    expect(vars(s)["b"]).toBe(1);
    expect(s.sw.switches["done"]).toBe(true);
  });

  test("a jump out of an option to a label after the choices completes the box", () => {
    const w = world([once("e", [
      {
        op: "choices",
        prompt: "?",
        options: [{ text: "a", commands: [jump("after")] }],
        cancel: { commands: [add("cancelled")] },
      },
      label("after"),
      add("ran"),
      on("done"),
    ])]);
    let s = createInterpState();
    s = stepInterp(w, s, input());
    s = stepInterp(w, s, input({ confirmEdge: true }));
    s = idle(w, s, 4);
    expect(vars(s)["ran"]).toBe(1);
    expect(vars(s)["cancelled"]).toBeUndefined();
    expect(s.sw.switches["done"]).toBe(true);
  });
});

// --- common events are their own label scope --------------------------------

describe("jumpLabel scoping with common events", () => {
  test("a jump inside a common event resolves within the common event", () => {
    const ce: CommonEvent = {
      id: "ce1",
      trigger: "none",
      commands: [jump("there"), add("never"), label("there"), add("ce")],
    };
    const w = world([once("e", [{ op: "common", id: "ce1" }, on("done")])], [ce]);
    const s = idle(w, createInterpState(), 6);
    expect(vars(s)["never"]).toBeUndefined();
    expect(vars(s)["ce"]).toBe(1);
    expect(s.sw.switches["done"]).toBe(true);
  });

  test("a jump in a common event does NOT see the caller's labels (MV child interpreter)", () => {
    const ce: CommonEvent = {
      id: "ce1",
      trigger: "none",
      commands: [jump("caller"), add("ce")],
    };
    const w = world([once("e", [
      { op: "common", id: "ce1" },
      label("caller"),
      add("page"),
      on("done"),
    ])], [ce]);
    const s = idle(w, createInterpState(), 6);
    // The jump found no label in the common event, so "ce" ran; the page
    // label is only reached in normal flow after the common event returns.
    expect(vars(s)["ce"]).toBe(1);
    expect(vars(s)["page"]).toBe(1);
    expect(s.sw.switches["done"]).toBe(true);
  });

  test("a jump in a common-event branch resolves within the common event", () => {
    const ce: CommonEvent = {
      id: "ce1",
      trigger: "none",
      commands: [
        { op: "choices", prompt: "?", options: [{ text: "a", commands: [jump("ce-label")] }] },
        add("never"),
        label("ce-label"),
        add("ce"),
      ],
    };
    const w = world([once("e", [{ op: "common", id: "ce1" }, on("done")])], [ce]);
    let s = createInterpState();
    s = stepInterp(w, s, input());
    s = stepInterp(w, s, input({ confirmEdge: true }));
    s = idle(w, s, 4);
    expect(vars(s)["never"]).toBeUndefined();
    expect(vars(s)["ce"]).toBe(1);
    expect(s.sw.switches["done"]).toBe(true);
  });
});

// --- interaction with loop / break / wait ----------------------------------

describe("jumpLabel with loop, break and wait", () => {
  test("a jump out of a loop to a label after it", () => {
    const w = world([once("e", [
      { op: "loop", commands: [add("n"), jump("out")] },
      add("never"),
      label("out"),
      add("after"),
      on("done"),
    ])]);
    const s = idle(w, createInterpState(), 8);
    expect(vars(s)["n"]).toBe(1);
    expect(vars(s)["never"]).toBeUndefined();
    expect(vars(s)["after"]).toBe(1);
    expect(s.sw.switches["done"]).toBe(true);
  });

  test("a jump into a loop body from before the loop runs it once", () => {
    const w = world([once("e", [
      jump("body"),
      add("never"),
      { op: "loop", commands: [label("body"), add("n"), { op: "break" }] },
      add("after"),
      on("done"),
    ])]);
    const s = idle(w, createInterpState(), 8);
    expect(vars(s)["never"]).toBeUndefined();
    expect(vars(s)["n"]).toBe(1);
    expect(vars(s)["after"]).toBe(1);
    expect(s.sw.switches["done"]).toBe(true);
  });

  test("a jump over a wait does not park the fiber", () => {
    const w = world([once("e", [jump("past"), { op: "wait", seconds: 5 }, label("past"), on("done")])]);
    const s = idle(w, createInterpState(), 2);
    expect(s.main?.mode).not.toBe("wait");
    expect(s.sw.switches["done"]).toBe(true);
  });

  test("a jump landing on a wait parks the fiber until it elapses", () => {
    const w = world([once("e", [jump("w"), add("never"), label("w"), { op: "wait", seconds: 0.1 }, on("done")])]);
    let s = idle(w, createInterpState(), 1);
    expect(s.main?.mode).toBe("wait");
    expect(s.sw.switches["done"]).toBeUndefined();
    s = idle(w, s, 60); // 0.1 s at 60 Hz
    expect(s.sw.switches["done"]).toBe(true);
  });
});

// --- multi-Hz, save, rewind --------------------------------------------------

describe("jumpLabel determinism", () => {
  test("a goto loop with a wait counts the same iterations at 60/30/20/4 Hz", () => {
    const p = project([once("e", [
      label("top"),
      add("n"),
      ifVar("n", ">=", 10, [jump("out")]),
      { op: "wait", seconds: 0.05 },
      jump("top"),
      label("out"),
      on("done"),
    ])]);
    for (const hz of [60, 30, 20, 4] as const) {
      const states = run(session(p, hz), p, Array(hz * 3).fill(0));
      const last = states.at(-1)!;
      expect(last.interp.error).toBeUndefined();
      expect(last.interp.sw.variables["n"]).toBe(10);
      expect(last.interp.sw.switches["done"]).toBe(true);
    }
  });

  test("a parked fiber with labels in its stack saves and restores", () => {
    // A common event parks on a waited screen fade; the unit marker is
    // saved with the frame (older saves without it are reconstructed at
    // restore), and the restored fiber still runs to completion.
    const ce: CommonEvent = {
      id: "ce1",
      trigger: "none",
      commands: [
        { op: "screenFade", direction: "out", duration: 0.5, wait: true },
        jump("after"),
        label("after"),
      ],
    };
    const p = project([once("e", [{ op: "common", id: "ce1" }, on("done")])], [ce]);
    const sess = session(p);
    let state = startSession(p, sess);
    for (let i = 0; i < 5; i++) state = stepSession(sess, state, { buttons: 0 });
    // The fiber is parked in screenWait inside the common event.
    expect(state.interp.main?.mode).toBe("screenWait");
    const saved = saveSession(sess, state, 0);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const snapshot = saved.snapshot;
    const restored = restoreSessionEnvelope(session(p), encodeEnvelope(snapshot));
    expect(restored.interp.main?.mode).toBe("screenWait");
    // The save-code path restores too.
    const loaded = loadSession(session(p), encodeSaveCode(snapshot));
    expect(loaded.ok).toBe(true);
    // Run to completion: the jumpLabel resolves and the page finishes.
    let done = restored;
    for (let i = 0; i < 60; i++) done = stepSession(sess, done, { buttons: 0 });
    expect(done.interp.error).toBeUndefined();
  });

  test("a label/jump sequence replays identically from a mid-run keyframe", () => {
    const p = project([once("e", [
      jump("b"),
      add("never"),
      label("b"),
      add("n"),
      ifVar("n", ">=", 3, [jump("out")]),
      jump("b"),
      label("out"),
      on("done"),
    ])]);
    const sess = session(p);
    const tape = Array(20).fill(0);
    const ref = run(sess, p, tape);
    const frameKey = (s: SessionState) =>
      canonicalJson({ v: s.interp.sw.variables, sw: s.interp.sw.switches, err: s.interp.error });
    for (const at of [2, 5, 9]) {
      const keyframe = ref[at]!;
      const before = frameKey(keyframe);
      const replay = run(session(p), p, tape.slice(at), keyframe);
      expect(frameKey(keyframe)).toBe(before); // the keyframe was not mutated
      for (let k = 0; k < replay.length; k++) {
        expect(frameKey(replay[k]!)).toBe(frameKey(ref[at + k]!));
      }
    }
    const last = ref.at(-1)!;
    expect(last.interp.sw.variables["n"]).toBe(3);
    expect(last.interp.sw.variables["never"]).toBeUndefined();
    expect(last.interp.sw.switches["done"]).toBe(true);
  });
});
