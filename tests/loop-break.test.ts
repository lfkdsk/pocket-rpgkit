// tests/loop-break.test.ts — the `loop` / `break` event commands.
//
// loop runs its body repeatedly; break leaves the innermost loop of the same
// program, even from a nested `if` or from a branch program (choices option
// or cancel, battle/scene result) that runs as its own stack frame. A called
// common event is a separate program. A break with no enclosing loop ends
// the program root (MV Break Loop parity).
//
// A loop never trips the runaway budget by itself: at a back-edge the fiber
// yields to the next tick after LOOP_YIELD_STEPS steps, staying in "run"
// mode. Those fibers must keep working with the scheduler, the idle-scan
// caches, saves and rewind replays.

import { describe, expect, test } from "bun:test";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import {
  LOOP_YIELD_STEPS,
  RUNAWAY_STEP_LIMIT,
  compile,
  createInterpState,
  createWorld,
  stepInterp,
  type InterpInput,
  type InterpState,
  type Instr,
  type Prog,
} from "../src/engine/interpreter.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import { canonicalJson, encodeEnvelope, encodeSaveCode, type SaveSnapshot } from "../src/engine/save.ts";
import { loadSession, restoreSessionEnvelope, saveSession } from "../src/engine/save-restore.ts";
import { validateSnapshot } from "../src/engine/save-validate.ts";
import type { SceneRules } from "../src/engine/scene.ts";
import type { Command, CommonEvent, GameEvent, MapDef, Page, Project } from "../src/engine/types.ts";

const MAP_ID = "v";

function map(events: GameEvent[], w = 12, h = 12): MapDef {
  return {
    id: MAP_ID,
    name: "loop",
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

/** An event whose `trigger` page runs `commands` once: the page flips self
 *  switch A, which activates an empty action page. A main fiber keeps
 *  running after its page changes, so it flips A first (a page-ending break
 *  must not make it restart); a parallel fiber is canceled by a page
 *  change, so it flips A last. */
function once(id: string, commands: Command[], trigger: Page["trigger"] = "autorun", x = 8, y = 8): GameEvent {
  const flip: Command = { op: "selfSwitch", key: "A", value: true };
  return {
    id,
    x,
    y,
    pages: [
      { trigger, commands: trigger === "parallel" ? [...commands, flip] : [flip, ...commands] },
      { trigger: "action", commands: [], condition: { selfSwitch: "A" } },
    ],
  };
}

/** A parallel page that never finishes on its own (a loop page). */
function parallel(id: string, commands: Command[], x = 8, y = 8): GameEvent {
  return { id, x, y, pages: [{ trigger: "parallel", commands }] };
}

const add = (id: string, value = 1): Command => ({ op: "variable", id, set: { op: "add", value } });
const set = (id: string, value: number): Command => ({ op: "variable", id, set: { op: "set", value } });
const on = (id: string): Command => ({ op: "switch", id, value: true });
const ifVar = (id: string, op: ">=" | "==", value: number, then: Command[], els?: Command[]): Command => ({
  op: "if",
  if: { kind: "variable", id, op, value },
  then,
  ...(els ? { else: els } : {}),
});
const BREAK: Command = { op: "break" };
const loop = (commands: Command[]): Command => ({ op: "loop", commands });

function world(events: GameEvent[], common: CommonEvent[] = [], hz = 60) {
  return createWorld(map(events), common, hz);
}

const vars = (s: InterpState) => s.sw.variables;

// --- compile ----------------------------------------------------------------

describe("compile", () => {
  test("a loop compiles inline with a back-edge; a same-frame break is a forward jmp", () => {
    const prog = compile([loop([add("n"), ifVar("n", ">=", 3, [BREAK])]), on("done")]);
    expect(prog.map((i) => i.op)).toEqual(["variable", "if", "jmp", "jmp", "repeat", "switch"]);
    expect(prog[2]).toEqual({ op: "jmp", to: 5 }); // the break: past the repeat
    expect(prog[4]).toEqual({ op: "repeat", to: 0 });
  });

  test("an empty loop repeats onto itself", () => {
    expect(compile([loop([])])).toEqual([{ op: "repeat", to: 0 }]);
  });

  test("a break in a branch program pops exactly the branch frames up to its loop", () => {
    const prog = compile([
      add("x"),
      loop([
        {
          op: "choices",
          prompt: "?",
          options: [{
            text: "a",
            commands: [{
              op: "choices",
              prompt: "??",
              options: [{ text: "b", commands: [BREAK] }],
            }],
          }],
          cancel: { commands: [BREAK] },
        },
        { op: "battle", setup: null, onWin: [BREAK], onLose: [loop([BREAK])] },
        { op: "scene", id: "s", onDone: [ifVar("n", "==", 1, [BREAK])] },
      ]),
      on("after"),
    ]);
    const end = prog.findIndex((i) => i.op === "switch");
    expect(prog[end - 1]).toEqual({ op: "repeat", to: 1 });
    const choices = prog[1] as Extract<Instr, { op: "choices" }>;
    const inner = choices.branches[0]![0] as Extract<Instr, { op: "choices" }>;
    expect(inner.branches[0]![0]).toEqual({ op: "break", up: 2, to: end });
    expect(choices.cancel![0]).toEqual({ op: "break", up: 1, to: end });
    const battle = prog[2] as Extract<Instr, { op: "battle" }>;
    expect(battle.onWin![0]).toEqual({ op: "break", up: 1, to: end });
    // A loop inside the branch owns its break: a same-frame forward jmp.
    expect(battle.onLose).toEqual([{ op: "jmp", to: 2 }, { op: "repeat", to: 0 }]);
    const scene = prog[3] as Extract<Instr, { op: "scene" }>;
    expect(scene.onDone![1]).toEqual({ op: "break", up: 1, to: end });
  });

  test("a break with no loop ends the program root from any branch depth", () => {
    const prog = compile([
      BREAK,
      { op: "choices", prompt: "?", options: [{ text: "a", commands: [BREAK] }] },
    ]);
    expect(prog[0]).toEqual({ op: "break", up: 0, to: null });
    expect((prog[1] as Extract<Instr, { op: "choices" }>).branches[0]![0])
      .toEqual({ op: "break", up: 1, to: null });
  });

  test("programs without loop or break compile exactly as before", () => {
    const prog = compile([ifVar("n", "==", 1, [add("n")], [add("m")])]);
    expect(prog.some((i) => i.op === "repeat" || i.op === "break")).toBe(false);
  });
});

// --- runtime semantics --------------------------------------------------------

describe("loop/break semantics", () => {
  test("a counting loop with if/break completes within one tick", () => {
    const w = world([once("e", [set("n", 0), loop([add("n"), ifVar("n", ">=", 50, [BREAK])]), on("done")])]);
    const s = idle(w, createInterpState());
    expect(s.error).toBeUndefined();
    expect(vars(s)["n"]).toBe(50);
    expect(s.sw.switches["done"]).toBe(true);
    expect(s.main).toBeNull();
  });

  test("nested loops: the inner break leaves only the inner loop", () => {
    const w = world([once("e", [
      loop([
        add("outer"),
        loop([add("inner"), ifVar("inner", ">=", 3, [BREAK])]),
        add("afterInner"),
        ifVar("outer", ">=", 4, [BREAK]),
      ]),
      on("done"),
    ])]);
    const s = idle(w, createInterpState());
    expect(vars(s)).toMatchObject({ outer: 4, inner: 6, afterInner: 4 });
    expect(s.sw.switches["done"]).toBe(true);
  });

  test("a break inside a choices option leaves the loop and continues after it", () => {
    const w = world([once("e", [
      loop([
        add("n"),
        {
          op: "choices",
          prompt: "Again?",
          options: [
            { text: "stay", commands: [add("stayed")] },
            { text: "leave", commands: [add("left"), BREAK, add("never")] },
          ],
          cancel: { commands: [add("cancelled"), BREAK] },
        },
        add("afterChoice"),
      ]),
      on("done"),
    ])]);
    let s = idle(w, createInterpState());
    expect(s.modal?.kind).toBe("choices");
    s = stepInterp(w, s, input({ confirmEdge: true })); // "stay": next pass reopens the box
    expect(vars(s)).toMatchObject({ n: 2, stayed: 1, afterChoice: 1 });
    expect(s.modal?.kind).toBe("choices");
    s = stepInterp(w, s, input({ downEdge: true }));
    s = stepInterp(w, s, input({ confirmEdge: true }));
    expect(vars(s)).toMatchObject({ n: 2, stayed: 1, left: 1, afterChoice: 1 });
    expect(vars(s)["never"]).toBeUndefined();
    expect(s.sw.switches["done"]).toBe(true);
    expect(s.main).toBeNull();
  });

  test("a break inside a choices cancel branch leaves the loop", () => {
    const w = world([once("e", [
      loop([{
        op: "choices",
        prompt: "?",
        options: [{ text: "a", commands: [] }],
        cancel: { commands: [BREAK] },
      }]),
      on("done"),
    ])]);
    let s = idle(w, createInterpState());
    s = stepInterp(w, s, input({ cancelEdge: true }));
    expect(s.sw.switches["done"]).toBe(true);
    expect(s.main).toBeNull();
  });

  test("a break with no enclosing loop ends the page, also from a branch", () => {
    const w = world([
      once("plain", [add("a"), BREAK, add("a", 100)]),
      once("branch", [
        { op: "choices", prompt: "?", options: [{ text: "x", commands: [add("b"), BREAK, add("b", 100)] }] },
        add("b", 1000),
      ], "action", 1, 0),
    ]);
    let s = idle(w, createInterpState());
    expect(vars(s)["a"]).toBe(1);
    expect(s.main).toBeNull();
    // Face the action event one tile up and confirm, then pick the option.
    s = stepInterp(w, s, input({ confirmEdge: true, facing: 2 }));
    expect(s.modal?.kind).toBe("choices");
    s = stepInterp(w, s, input({ confirmEdge: true }));
    expect(vars(s)["b"]).toBe(1);
    expect(s.main).toBeNull();
    s = idle(w, s, 5);
    expect(vars(s)).toMatchObject({ a: 1, b: 1 });
  });

  test("a break in a called common event ends only the common event", () => {
    const common: CommonEvent[] = [{
      id: "ce",
      name: "ce",
      trigger: "none",
      commands: [
        add("c"),
        { op: "choices", prompt: "?", options: [{ text: "x", commands: [add("cb"), BREAK, add("cb", 100)] }] },
        add("c", 100),
      ],
    }, {
      id: "plain",
      name: "plain",
      trigger: "none",
      commands: [add("p"), BREAK, add("p", 100)],
    }];
    const w = world([once("e", [
      loop([add("n"), { op: "common", id: "plain" }, { op: "common", id: "ce" }, ifVar("n", ">=", 2, [BREAK])]),
      on("done"),
    ])], common);
    let s = idle(w, createInterpState());
    s = stepInterp(w, s, input({ confirmEdge: true })); // pass 1: pick the option
    expect(vars(s)).toMatchObject({ n: 2, p: 2, c: 2, cb: 1 });
    expect(s.sw.switches["done"]).toBeUndefined();
    s = stepInterp(w, s, input({ confirmEdge: true })); // pass 2
    expect(vars(s)).toMatchObject({ n: 2, p: 2, c: 2, cb: 2 });
    expect(s.sw.switches["done"]).toBe(true);
  });

  test("a common event's own loop and break stay inside the common event", () => {
    const w = world([once("e", [
      loop([add("n"), { op: "common", id: "count" }, ifVar("n", ">=", 3, [BREAK])]),
      on("done"),
    ])], [{
      id: "count",
      name: "count",
      trigger: "none",
      commands: [set("k", 0), loop([add("k"), ifVar("k", ">=", 4, [BREAK])]), add("total", 1)],
    }]);
    const s = idle(w, createInterpState());
    expect(vars(s)).toMatchObject({ n: 3, k: 4, total: 3 });
    expect(s.sw.switches["done"]).toBe(true);
  });

  test("a malformed break (frames past the stack) is a fatal state, not a throw", () => {
    const w = world([parallel("x", [{ op: "wait", seconds: 10 }])]);
    const s0 = idle(w, createInterpState());
    const fiber = s0.parallels[`${MAP_ID}/x`]!;
    fiber.mode = "run";
    const bad: Prog = [{ op: "break", up: 3, to: null }];
    fiber.stack = [{ prog: bad, pc: 0 }];
    expect(stepInterp(w, s0, input()).error?.kind).toBe("runaway");
    const beyond: Prog = [{ op: "break", up: 0, to: 9 }];
    fiber.stack = [{ prog: beyond, pc: 0 }];
    expect(stepInterp(w, s0, input()).error?.kind).toBe("runaway");
  });
});

// --- yield / budget -------------------------------------------------------------

describe("loop budget and yield", () => {
  test("a wait-less infinite loop yields every tick without a runaway error", () => {
    const w = world([parallel("spin", [loop([add("v")])])]);
    let s = createInterpState();
    let last = 0;
    for (let tick = 1; tick <= 20; tick++) {
      s = stepInterp(w, s, input());
      expect(s.error).toBeUndefined();
      const v = vars(s)["v"] as number;
      // Two steps per pass (variable + back-edge): one slice per tick.
      expect(v - last).toBe(LOOP_YIELD_STEPS / 2);
      last = v;
      expect(s.parallels[`${MAP_ID}/spin`]!.mode).toBe("run");
    }
  });

  test("many spinning parallels share the budget, all progress, none trips the backstop", () => {
    const count = Math.ceil(RUNAWAY_STEP_LIMIT / LOOP_YIELD_STEPS) + 3;
    const events = Array.from({ length: count }, (_, i) =>
      parallel(`spin${String(i).padStart(2, "0")}`, [loop([add(`v${i}`)])]));
    events.push(parallel("ticker", [add("t"), { op: "wait", seconds: 0 }]));
    const w = world(events);
    let s = createInterpState();
    let prev: Record<string, unknown> = {};
    for (let tick = 0; tick < 10; tick++) {
      s = stepInterp(w, s, input());
      expect(s.error).toBeUndefined();
      for (let i = 0; i < count; i++) {
        expect(vars(s)[`v${i}`] as number).toBeGreaterThan((prev[`v${i}`] as number | undefined) ?? 0);
      }
      prev = { ...vars(s) };
    }
    expect(vars(s)["t"] as number).toBeGreaterThanOrEqual(5);
  });

  test("a loop inside a common event called from a spinning loop still yields", () => {
    const w = world([parallel("spin", [loop([{ op: "common", id: "inner" }])])], [{
      id: "inner",
      name: "inner",
      trigger: "none",
      commands: [loop([add("i"), ifVar("i", ">=", 1_000_000, [BREAK])])],
    }]);
    let s = createInterpState();
    for (let tick = 0; tick < 5; tick++) {
      s = stepInterp(w, s, input());
      expect(s.error).toBeUndefined();
    }
    expect(vars(s)["i"] as number).toBeGreaterThan(0);
  });
});

// --- session-level: player, hz, save, rewind ------------------------------------

const SCENE_ID = "loop.instant";

/** A scene that completes on its first fold; args.transfer becomes the
 *  completion transfer. */
const instantScene: SceneRules = {
  start(ext, args) {
    return { ext, state: args };
  },
  step(state) {
    return state;
  },
  done(state) {
    const args = state as { transfer?: { map: string; x: number; y: number } } | null;
    return args?.transfer ? { transfer: args.transfer } : {};
  },
};

function project(events: GameEvent[]): Project {
  return {
    format: "rpgkit-project/v1",
    title: "loop",
    tileSize: 16,
    start: { map: MAP_ID, x: 1, y: 1, dir: "down" },
    sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [],
    maps: [map(events)],
  };
}

function session(p: Project, hz: 60 | 30 | 20 | 4 = 60, immutableState = false): Session {
  return createSession(p, hz, { scenes: { [SCENE_ID]: instantScene }, immutableState });
}

function frameKey(state: SessionState): string {
  return canonicalJson({
    map: state.mapId,
    move: state.move,
    chars: state.chars,
    interp: state.interp,
    fade: state.fade,
    playerRoute: state.playerRoute,
    ext: state.ext,
  });
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

const MODES = [false, true] as const;

describe("session: scene result branches", () => {
  for (const immutable of MODES) {
    test(`a break in scene onDone leaves the loop (immutable=${immutable})`, () => {
      const p = project([once("e", [
        loop([add("n"), { op: "scene", id: SCENE_ID, onDone: [add("done"), BREAK, add("never")] }, add("after")]),
        on("exited"),
      ])]);
      const states = run(session(p, 60, immutable), p, Array(6).fill(0));
      const last = states.at(-1)!;
      expect(last.interp.error).toBeUndefined();
      expect(last.interp.sw.variables).toMatchObject({ n: 1, done: 1 });
      expect(last.interp.sw.variables["never"]).toBeUndefined();
      expect(last.interp.sw.variables["after"]).toBeUndefined();
      expect(last.interp.sw.switches["exited"]).toBe(true);
    });
  }

  test("a break out of a scene result branch still performs the completion transfer", () => {
    const p = project([once("e", [
      loop([
        add("n"),
        { op: "scene", id: SCENE_ID, args: { transfer: { map: MAP_ID, x: 6, y: 4 } }, onDone: [BREAK] },
      ]),
      on("exited"),
    ])]);
    const states = run(session(p), p, Array(90).fill(0));
    const last = states.at(-1)!;
    expect(last.interp.error).toBeUndefined();
    expect(last.interp.sw.variables["n"]).toBe(1);
    expect([last.move.tx, last.move.ty]).toEqual([6, 4]);
    // A transfer rebuilds the map interpreter: the rest of the page (after
    // the loop) is dropped, exactly as for a branch that ends normally.
    expect(last.interp.sw.switches["exited"]).toBeUndefined();
  });
});

describe("session: spinning loops keep the world moving", () => {
  for (const immutable of MODES) {
    test(`the player walks and other parallels run beside a wait-less loop (immutable=${immutable})`, () => {
      const p = project([
        parallel("spin", [loop([add("v")])]),
        parallel("tick", [loop([add("t"), { op: "wait", seconds: 0.1 }])], 9, 9),
      ]);
      const states = run(session(p, 60, immutable), p, Array(60).fill(BTN.RIGHT));
      const last = states.at(-1)!;
      expect(last.interp.error).toBeUndefined();
      expect(last.move.tx).toBeGreaterThan(1);
      expect(last.interp.sw.variables["t"]).toBe(10); // one pass per 0.1 s
      const v = last.interp.sw.variables["v"] as number;
      expect(v).toBe(60 * LOOP_YIELD_STEPS / 2);
      expect(last.interp.parallels[`${MAP_ID}/spin`]!.mode).toBe("run");
    });
  }
});

describe("session: a polling loop with wait is rate-independent", () => {
  const p = project([
    // Wakes every 0.25 s until S is on, then records the clock and stops.
    once("poll", [
      loop([{ op: "if", if: { kind: "switch", id: "S" }, then: [BREAK] }, { op: "wait", seconds: 0.25 }]),
      { op: "variable", id: "exitClock", set: { op: "copy", from: "clock" } },
      on("exited"),
    ], "parallel", 9, 9),
    // A 0.05 s clock.
    parallel("clock", [loop([add("clock"), { op: "wait", seconds: 0.05 }])], 10, 10),
    once("setter", [{ op: "wait", seconds: 1.3 }, on("S")], "parallel", 11, 11),
  ]);

  function perSecond(hz: 60 | 30 | 20 | 4, immutable: boolean): unknown[] {
    const states = run(session(p, hz, immutable), p, Array(hz * 3).fill(0));
    const out: unknown[] = [];
    for (let second = 1; second <= 3; second++) {
      const st = states[second * hz]!;
      expect(st.interp.error).toBeUndefined();
      out.push({
        S: st.interp.sw.switches["S"] ?? false,
        exited: st.interp.sw.switches["exited"] ?? false,
        exitClock: st.interp.sw.variables["exitClock"] ?? null,
        clock: st.interp.sw.variables["clock"],
      });
    }
    return out;
  }

  for (const immutable of MODES) {
    test(`exit lands at the same virtual time at 60/30/20/4 Hz (immutable=${immutable})`, () => {
      const ref = perSecond(60, immutable);
      expect(ref[0]).toMatchObject({ S: false, exited: false });
      expect(ref[1]).toMatchObject({ S: true, exited: true });
      for (const hz of [30, 20, 4] as const) expect(perSecond(hz, immutable)).toEqual(ref);
    });
  }

  test("the interpreter alone agrees at World hz 60/30/20/4", () => {
    const events = [
      once("poll", [
        loop([{ op: "if", if: { kind: "switch", id: "S" }, then: [BREAK] }, { op: "wait", seconds: 0.5 }]),
        on("exited"),
      ], "parallel", 9, 9),
      once("setter", [{ op: "wait", seconds: 1.5 }, on("S")], "parallel", 11, 11),
    ];
    const outcome = (hz: number) => {
      const w = world(events, [], hz);
      let s = createInterpState();
      const out: unknown[] = [];
      for (let second = 1; second <= 3; second++) {
        s = idle(w, s, hz);
        out.push([s.sw.switches["S"] ?? false, s.sw.switches["exited"] ?? false]);
      }
      return out;
    };
    const ref = outcome(60);
    expect(ref).toEqual([[false, false], [true, false], [true, true]]);
    for (const hz of [30, 20, 4]) expect(outcome(hz)).toEqual(ref);
  });
});

describe("session: saves and rewind mid-loop", () => {
  const p = project([
    parallel("poller", [loop([add("p"), { op: "wait", seconds: 0.25 }])], 9, 9),
    parallel("spinner", [loop([add("q"), ifVar("q", ">=", 1_000_000_000, [BREAK])])], 10, 10),
    once("late", [{ op: "wait", seconds: 0.5 }, loop([add("r"), ifVar("r", ">=", 7, [BREAK])]), on("lateDone")], "parallel", 11, 11),
  ]);
  const tape = Array.from({ length: 150 }, (_, f) => (Math.floor(f / 20) % 3 === 1 ? BTN.RIGHT : f % 40 === 30 ? BTN.DOWN : 0));

  for (const immutable of MODES) {
    test(`a save with a waiting and a yielded loop fiber resumes identically (immutable=${immutable})`, () => {
      const sess = session(p, 60, immutable);
      const ref = run(sess, p, tape);
      let checked = 0;
      for (const at of [7, 15, 31, 64]) {
        const state = ref[at]!;
        const poller = state.interp.parallels[`${MAP_ID}/poller`]!;
        const spinner = state.interp.parallels[`${MAP_ID}/spinner`]!;
        expect(poller.mode).toBe("wait");
        expect(spinner.mode).toBe("run");
        const saved = saveSession(sess, state, tape[at - 1] ?? 0);
        if (!saved.ok) continue; // player mid-step: not a save point
        checked++;
        const snapshot: SaveSnapshot = saved.snapshot;
        expect(validateSnapshot(snapshot)).toBeNull();
        for (const restoredState of [
          restoreSessionEnvelope(session(p, 60, immutable), encodeEnvelope(snapshot)),
          (() => {
            const fresh = session(p, 60, immutable);
            const loaded = loadSession(fresh, encodeSaveCode(snapshot));
            if (!loaded.ok) throw new Error(loaded.error.message);
            return loaded.state;
          })(),
        ]) {
          const resumed = run(session(p, 60, immutable), p, tape.slice(at), restoredState);
          for (let k = 0; k < resumed.length; k += 10) {
            expect(frameKey(resumed[k]!)).toBe(frameKey(ref[at + k]!));
          }
          expect(frameKey(resumed.at(-1)!)).toBe(frameKey(ref.at(-1)!));
        }
      }
      expect(checked).toBeGreaterThan(0);
      expect(ref.at(-1)!.interp.sw.switches["lateDone"]).toBe(true);
    });

    test(`replaying the tape from a mid-loop keyframe yields identical states (immutable=${immutable})`, () => {
      const sess = session(p, 60, immutable);
      const ref = run(sess, p, tape);
      for (const at of [3, 20, 45]) {
        const keyframe = ref[at]!;
        const before = frameKey(keyframe);
        const replay = run(sess, p, tape.slice(at), keyframe);
        expect(frameKey(keyframe)).toBe(before); // the keyframe was not mutated
        for (let k = 0; k < replay.length; k++) {
          expect(frameKey(replay[k]!)).toBe(frameKey(ref[at + k]!));
        }
      }
    });
  }

  test("save-validate rejects a tampered loop back-edge or break", () => {
    const sess = session(p);
    const states = run(sess, p, Array(10).fill(0));
    const saved = saveSession(sess, states.at(-1)!, 0);
    if (!saved.ok) throw new Error(saved.error.message);
    const key = `${MAP_ID}/spinner`;
    const tamper = (edit: (prog: Instr[]) => void): string | null => {
      const snap = JSON.parse(JSON.stringify(saved.snapshot)) as SaveSnapshot;
      edit(snap.interp.parallels[key]!.stack[0]!.prog as Instr[]);
      return validateSnapshot(snap);
    };
    expect(tamper(() => {})).toBeNull();
    const back = (prog: Instr[]) => prog.findIndex((i) => i.op === "repeat");
    expect(tamper((prog) => { (prog[back(prog)] as { to: number }).to = back(prog) + 1; }))
      .toMatch(/loop start/);
    expect(tamper((prog) => { (prog[back(prog)] as { to: number }).to = -1; })).toMatch(/loop start/);
    expect(tamper((prog) => { (prog[back(prog)] as { to: unknown }).to = "0"; })).toMatch(/loop start/);
    expect(tamper((prog) => { prog.push({ op: "break", up: -1, to: null }); })).toMatch(/up/);
    expect(tamper((prog) => { prog.push({ op: "break", up: 1, to: 1.5 }); })).toMatch(/to/);
    expect(tamper((prog) => { prog.unshift({ op: "break", up: 0, to: 0 }); })).toMatch(/forward/);
  });
});
