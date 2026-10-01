import { describe, expect, test } from "bun:test";
import { AttractController } from "../src/engine/attract.ts";
import { canonicalJson, createSessionSnapshot, fnv1aText } from "../src/engine/save.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import type { Command, GameEvent, JsonValue, MapDef, Project } from "../src/engine/types.ts";
import { toyBattleRules, toyState } from "./fixtures/toy-battle.ts";

const CIRCLE = 0x2000;
const CROSS = 0x4000;
const RIGHT = 0x0020;
const L = 0x0100;

function battleEvent(setup: JsonValue): GameEvent {
  const battle: Command = {
    op: "battle",
    setup,
    onWin: [{ op: "switch", id: "branch.win", value: true }],
    onLose: [{ op: "switch", id: "branch.lose", value: true }],
    onEscape: [{ op: "switch", id: "branch.escape", value: true }],
  };
  return {
    id: "battle",
    x: 1,
    y: 1,
    pages: [
      {
        trigger: "autorun",
        commands: [battle, { op: "switch", id: "after", value: true }],
      },
      {
        condition: { switch: "after" },
        trigger: "action",
        commands: [],
      },
    ],
  };
}

function map(id: string, events: GameEvent[] = []): MapDef {
  return {
    id,
    name: id,
    width: 8,
    height: 8,
    sheets: ["plain"],
    ground: new Array(64).fill("plain.0"),
    events,
  };
}

function project(setup: JsonValue, extraEvents: GameEvent[] = [], extraMaps: MapDef[] = []): Project {
  return projectWithEvents([battleEvent(setup), ...extraEvents], extraMaps);
}

function projectWithEvents(events: GameEvent[], extraMaps: MapDef[] = []): Project {
  return {
    format: "rpgkit-project/v1",
    title: "toy battle",
    tileSize: 16,
    start: { map: "a", x: 2, y: 2, dir: "down" },
    sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [],
    maps: [map("a", events), ...extraMaps],
  };
}

function parallelBattleEvent(id: string, setup: JsonValue): GameEvent {
  const done = `done.${id}`;
  return {
    id,
    x: 5,
    y: 5,
    pages: [
      {
        trigger: "parallel",
        commands: [
          {
            op: "battle",
            setup,
            onWin: [{ op: "switch", id: `won.${id}`, value: true }],
          },
          { op: "switch", id: done, value: true },
        ],
      },
      { condition: { switch: done }, trigger: "action", commands: [] },
    ],
  };
}

function step(session: Session, state: SessionState, buttons = 0): SessionState {
  return stepSession(session, state, {
    buttons,
    confirmEdge: !!(buttons & CIRCLE),
    cancelEdge: !!(buttons & CROSS),
  });
}

function settle(session: Session, state: SessionState): SessionState {
  let next = state;
  for (let i = 0; i < 120 && (next.scene || !next.sw.switches.after); i++) next = step(session, next);
  return next;
}

describe("KB2 battle processing", () => {
  test("toy damage is independent of host randomness", () => {
    const started = toyBattleRules.start(null, { enemyHp: 99 }, 0x1234_5678, {
      ext: null,
      switches: {},
      variables: {},
      items: {},
      gold: 0,
      playerName: "Player",
    });
    expect(started).not.toBeNull();
    const originalRandom = Math.random;
    let hostDraws = 0;
    Math.random = () => {
      hostDraws++;
      return hostDraws % 2 === 0 ? 0.999 : 0;
    };
    try {
      const input = { buttons: CIRCLE, confirmEdge: true };
      const first = toyBattleRules.step(started!.state, input, 1);
      const second = toyBattleRules.step(started!.state, input, 1);
      expect(second).toEqual(first);
      expect(hostDraws).toBe(0);
    } finally {
      Math.random = originalRandom;
    }
  });

  test("battle frames branch entirely from SessionState without hidden mutable state", () => {
    const p = project({ enemyHp: 99 });
    const session = createSession(p, 60, { battle: toyBattleRules });
    const entered = step(session, startSession(p, session));
    const retained = structuredClone(entered);

    const first = step(session, entered, CIRCLE);
    const second = step(session, entered, CIRCLE);
    expect(second).toEqual(first);
    expect(entered).toEqual(retained);
  });

  test("a project with Battle Processing requires registered rules; start null resumes immediately", () => {
    const p = project({ skip: true });
    expect(() => createSession(p)).toThrow("no BattleRules were registered");
    const session = createSession(p, 60, { battle: toyBattleRules });
    const initial = startSession(p, session);
    const started = step(session, initial);
    expect(started.scene).toBeNull();
    expect(started.sw.rng).not.toBe(initial.sw.rng);
    const resumed = step(session, started);
    expect(resumed.sw.switches.after).toBe(true);
  });

  test("two parallel battle requests in one tick run FIFO and both fibers resume", () => {
    // Deliberately author reverse JSON order: interpreter arbitration uses
    // stable event keys, not source-array insertion order.
    const p = projectWithEvents([
      parallelBattleEvent("z-second", { enemyHp: 1 }),
      parallelBattleEvent("a-first", { enemyHp: 1 }),
    ]);
    const session = createSession(p, 60, { battle: toyBattleRules });
    let state = step(session, startSession(p, session));
    expect(state.scene?.fiber).toBe("a/a-first");
    expect(state.interp.pendingBattles.map((request) => request.fiber)).toEqual(["a/z-second"]);

    for (let frame = 0; frame < 80 && state.scene; frame++) {
      state = step(session, state, state.scene && toyState(state.scene.state).phase === "choice" ? CIRCLE : 0);
    }
    expect(state.scene).toBeNull();
    expect(state.interp.pendingBattles.map((request) => request.fiber)).toEqual(["a/z-second"]);
    expect(() => createSessionSnapshot(session, state, 0)).toThrow(/no modal or scene open/);

    state = step(session, state);
    expect(state.scene?.fiber).toBe("a/z-second");
    for (let frame = 0; frame < 80 && state.scene; frame++) {
      state = step(session, state, state.scene && toyState(state.scene.state).phase === "choice" ? CIRCLE : 0);
    }
    for (let frame = 0; frame < 5 && (!state.sw.switches["done.a-first"] || !state.sw.switches["done.z-second"]); frame++) {
      state = step(session, state);
    }

    expect(state.scene).toBeNull();
    expect(state.interp.pendingBattles).toEqual([]);
    expect(state.sw.switches["won.a-first"]).toBe(true);
    expect(state.sw.switches["won.z-second"]).toBe(true);
    expect(state.sw.switches["done.a-first"]).toBe(true);
    expect(state.sw.switches["done.z-second"]).toBe(true);
    expect(Object.values(state.interp.parallels).some((fiber) => fiber.mode === "external")).toBe(false);
  });

  test("queued battle completion never mutates any retained session state", () => {
    const p = projectWithEvents([
      parallelBattleEvent("z-second", { enemyHp: 1 }),
      parallelBattleEvent("a-first", { enemyHp: 1 }),
    ]);
    const session = createSession(p, 60, { battle: toyBattleRules });
    const retained: Array<{ state: SessionState; json: string }> = [];
    let state = startSession(p, session);

    for (let frame = 0; frame < 240; frame++) {
      retained.push({ state, json: JSON.stringify(state) });
      const attack = state.scene !== null && toyState(state.scene.state).phase === "choice";
      state = step(session, state, attack ? CIRCLE : 0);
      if (
        state.scene === null && state.interp.pendingBattles.length === 0 &&
        state.sw.switches["done.a-first"] && state.sw.switches["done.z-second"]
      ) break;
    }

    expect(state.sw.switches["toy.result.win"]).toBe(true);
    expect(state.ext).toEqual({ toyStarts: 2, toyResults: ["win", "win"] });
    expect(state.interp.pendingBattles).toEqual([]);
    for (const previous of retained) expect(JSON.stringify(previous.state)).toBe(previous.json);
  });

  test("a main request precedes same-tick parallels, whose keys sort ascending", () => {
    const p = project({ enemyHp: 1 }, [
      parallelBattleEvent("z-last", { enemyHp: 1 }),
      parallelBattleEvent("a-next", { enemyHp: 1 }),
    ]);
    const session = createSession(p, 60, { battle: toyBattleRules });
    const state = step(session, startSession(p, session));

    expect(state.scene?.fiber).toBe("a/battle");
    expect(state.interp.pendingBattles.map((request) => request.fiber)).toEqual([
      "a/a-next",
      "a/z-last",
    ]);
  });

  test("a parallel-only active battle is never a save point", () => {
    const p = projectWithEvents([parallelBattleEvent("only", { enemyHp: 99 })]);
    const session = createSession(p, 60, { battle: toyBattleRules });
    let state = step(session, startSession(p, session));
    for (let frame = 0; frame < 4; frame++) state = step(session, state);

    expect(state.scene?.fiber).toBe("a/only");
    expect(state.interp.main).toBeNull();
    expect(state.interp.pendingBattles).toEqual([]);
    expect(() => createSessionSnapshot(session, state, 0)).toThrow(/no modal or scene open/);
  });

  for (const scenario of [
    { name: "win", setup: { enemyHp: 1 }, button: CIRCLE, branch: "branch.win" },
    { name: "lose", setup: { playerHp: 1, enemyHp: 99 }, button: CIRCLE, branch: "branch.lose" },
    { name: "escape", setup: {}, button: CROSS, branch: "branch.escape" },
  ] as const) {
    test(`${scenario.name} applies ext/variables/switches and takes only its result branch`, () => {
      const p = project(scenario.setup as JsonValue);
      const session = createSession(p, 60, { battle: toyBattleRules });
      let state = step(session, startSession(p, session));
      expect(state.scene?.kind).toBe("battle");
      expect(state.ext).toEqual({ toyStarts: 1 });
      expect(() => createSessionSnapshot(session, state, 0)).toThrow(/no modal or scene open/);
      state = step(session, state, scenario.button);
      state = settle(session, state);

      expect(state.scene).toBeNull();
      expect(state.sw.variables["toy.result"]).toBe(scenario.name);
      expect(state.ext).toEqual({ toyStarts: 1, toyResults: [scenario.name] });
      expect(state.sw.switches[`toy.result.${scenario.name}`]).toBe(true);
      expect(state.sw.switches[scenario.branch]).toBe(true);
      for (const other of ["branch.win", "branch.lose", "branch.escape"]) {
        if (other !== scenario.branch) expect(state.sw.switches[other]).toBeUndefined();
      }
    });
  }

  test("a completion transfer runs after the lose branch", () => {
    const p = project(
      { playerHp: 1, enemyHp: 99, transfer: { map: "b", x: 4, y: 5, dir: "left" } },
      [],
      [map("b")],
    );
    const session = createSession(p, 60, { battle: toyBattleRules });
    let state = step(session, startSession(p, session));
    state = step(session, state, CIRCLE);
    state = settle(session, state);
    expect(state.mapId).toBe("b");
    expect([state.move.tx, state.move.ty, state.move.facing]).toEqual([4, 5, 1]);
    expect(state.sw.switches["branch.lose"]).toBe(true);
    expect(state.sw.variables["toy.result"]).toBe("lose");
  });

  test("battle input is isolated and the map world freezes by default", () => {
    const parallel: GameEvent = {
      id: "clock",
      x: 5,
      y: 5,
      pages: [{
        trigger: "parallel",
        commands: [
          { op: "variable", id: "parallel.ticks", set: { op: "add", value: 1 } },
          { op: "wait", seconds: 1 / 60 },
        ],
      }],
    };
    const npc: GameEvent = {
      id: "walker",
      x: 3,
      y: 3,
      pages: [{
        trigger: "action",
        blocks: true,
        moveRoute: { repeat: true, skippable: true, steps: ["moveRight", "moveLeft"] },
        commands: [],
      }],
    };
    const p = project({}, [parallel, npc]);
    const session = createSession(p, 60, { battle: toyBattleRules });
    let state = step(session, startSession(p, session));
    const player = { tx: state.move.tx, ty: state.move.ty };
    const npcBefore = state.chars.chars.walker;
    const parallelBefore = state.sw.variables["parallel.ticks"];
    const parallelFiberBefore = structuredClone(state.interp.parallels["a/clock"]);
    for (let i = 0; i < 5; i++) state = step(session, state, RIGHT);

    expect([state.move.tx, state.move.ty]).toEqual([player.tx, player.ty]);
    expect(toyState(state.scene!.state).lastButtons).toBe(RIGHT);
    expect(state.sw.variables["parallel.ticks"]).toBe(parallelBefore);
    expect(state.interp.parallels["a/clock"]).toEqual(parallelFiberBefore);
    expect(state.interp.main?.mode).toBe("external");
    expect(state.chars.chars.walker).toEqual(npcBefore);
  });

  test("a parallel 30-tick wait excludes battle freeze time at every supported Hz", () => {
    const timer: GameEvent = {
      id: "timer",
      x: 5,
      y: 5,
      pages: [
        {
          trigger: "parallel",
          commands: [
            { op: "wait", seconds: 30 / 60 },
            { op: "switch", id: "wait.done", value: true },
          ],
        },
        { condition: { switch: "wait.done" }, trigger: "action", commands: [] },
      ],
    };
    const samples = ([60, 30, 20, 4] as const).map((hz) => {
      const p = project({ enemyHp: 1 }, [timer]);
      const session = createSession(p, hz, { battle: toyBattleRules });
      let state = step(session, startSession(p, session));
      expect(state.scene, `battle entered at ${hz} Hz`).not.toBeNull();
      const battleEntryTick = state.interp.frame;
      let freezeTicks = 0;

      for (let frame = 0; frame < 120 && state.scene; frame++) {
        const before = state.interp.frame;
        const attack = toyState(state.scene.state).phase === "choice" ? CIRCLE : 0;
        state = step(session, state, attack);
        freezeTicks += state.interp.frame - before;
      }
      expect(state.scene, `battle completed at ${hz} Hz`).toBeNull();

      for (let frame = 0; frame < 120 && !state.sw.switches["wait.done"]; frame++) {
        state = step(session, state);
      }
      expect(state.sw.switches["wait.done"], `wait completed at ${hz} Hz`).toBe(true);
      return {
        hz,
        battleEntryTick,
        freezeTicks,
        fireTick: state.interp.frame,
        elapsedWaitTicks: state.interp.frame - freezeTicks - battleEntryTick,
      };
    });

    // Entry and scene length are host-frame quantized. Once both are
    // removed, the independent map timer advances exactly its authored 30
    // reference ticks at every supported simulation rate.
    expect(samples.map(({ hz, elapsedWaitTicks }) => [hz, elapsedWaitTicks])).toEqual([
      [60, 30],
      [30, 30],
      [20, 30],
      [4, 30],
    ]);
  });

  test("scene.worldContinues preserves background world ticks when explicitly enabled", () => {
    const parallel: GameEvent = {
      id: "clock",
      x: 5,
      y: 5,
      pages: [{
        trigger: "parallel",
        commands: [
          { op: "variable", id: "parallel.ticks", set: { op: "add", value: 1 } },
          { op: "wait", seconds: 1 / 60 },
        ],
      }],
    };
    const npc: GameEvent = {
      id: "walker",
      x: 3,
      y: 3,
      pages: [{
        trigger: "action",
        blocks: true,
        moveRoute: { repeat: true, skippable: true, steps: ["moveRight", "moveLeft"] },
        commands: [],
      }],
    };
    const p = project({}, [parallel, npc]);
    const session = createSession(p, 60, {
      battle: toyBattleRules,
      scene: { worldContinues: true },
    });
    let state = step(session, startSession(p, session));
    const npcBefore = state.chars.chars.walker;
    for (let i = 0; i < 5; i++) state = step(session, state);

    expect(Number(state.sw.variables["parallel.ticks"] ?? 0)).toBeGreaterThan(0);
    expect(state.chars.chars.walker).not.toEqual(npcBefore);
  });

  test("a parallel battle requested during a main battle queues without throwing", () => {
    const delayed = parallelBattleEvent("later", { enemyHp: 1 });
    delayed.pages[0]!.commands.unshift({ op: "wait", seconds: 2 / 60 });
    const p = project({ enemyHp: 1 }, [delayed]);
    const session = createSession(p, 60, {
      battle: toyBattleRules,
      scene: { worldContinues: true },
    });
    let state = step(session, startSession(p, session));
    expect(state.scene?.fiber).toBe("a/battle");

    state = step(session, state);
    state = step(session, state);
    expect(state.scene?.fiber).toBe("a/battle");
    expect(state.interp.pendingBattles.map((request) => request.fiber)).toEqual(["a/later"]);

    const order: string[] = [state.scene!.fiber];
    let previous = state.scene!.fiber;
    for (let frame = 0; frame < 160; frame++) {
      state = step(session, state, state.scene && toyState(state.scene.state).phase === "choice" ? CIRCLE : 0);
      const fiber = state.scene?.fiber ?? "";
      if (fiber && fiber !== previous) order.push(fiber);
      previous = fiber;
      if (state.scene === null && state.interp.pendingBattles.length === 0 && state.sw.switches["done.later"]) break;
    }

    expect(order).toEqual(["a/battle", "a/later"]);
    expect(state.sw.switches.after).toBe(true);
    expect(state.sw.switches["done.later"]).toBe(true);
  });

  test("two runs and 60/30/20/4 Hz have the same semantic state", () => {
    const run = (hz: 60 | 30 | 20 | 4): SessionState => {
      const p = project({ enemyHp: 1 });
      const session = createSession(p, hz, { battle: toyBattleRules });
      let state = startSession(p, session);
      const frames = hz * 2;
      for (let frame = 0; frame < frames; frame++) {
        state = step(session, state, frame === hz / 2 ? CIRCLE : 0);
      }
      return state;
    };
    const semantic = (state: SessionState) => JSON.stringify({ ...state, frame: 0 });
    const reference = semantic(run(60));
    expect(semantic(run(60))).toBe(reference);
    for (const hz of [30, 20, 4] as const) expect(semantic(run(hz))).toBe(reference);
  });

  test("queued battles have stable hashes across two runs and 60/30/20/4 Hz", () => {
    const run = (hz: 60 | 30 | 20 | 4): string => {
      const p = projectWithEvents([
        parallelBattleEvent("z-second", { enemyHp: 1 }),
        parallelBattleEvent("a-first", { enemyHp: 1 }),
      ]);
      const session = createSession(p, hz, { battle: toyBattleRules });
      let state = startSession(p, session);
      for (let frame = 0; frame < hz * 3; frame++) {
        const attack = state.scene !== null && toyState(state.scene.state).phase === "choice";
        state = step(session, state, attack ? CIRCLE : 0);
      }
      expect(state.scene).toBeNull();
      expect(state.interp.pendingBattles).toEqual([]);
      const semantic = { ...state, frame: 0 };
      return fnv1aText(canonicalJson(semantic));
    };

    const reference = run(60);
    expect(run(60)).toBe(reference);
    for (const hz of [30, 20, 4] as const) expect(run(hz)).toBe(reference);
  });

  test("attract rewind restores the queued gap and post-queue state byte-for-byte", () => {
    const p = projectWithEvents([
      parallelBattleEvent("z-second", { enemyHp: 1 }),
      parallelBattleEvent("a-first", { enemyHp: 1 }),
    ]);
    const options = {
      hz: 60,
      attractEnabled: false,
      rewindSeconds: 1 / 60,
      battle: toyBattleRules,
    } as const;
    const baseline = new AttractController(p, [], options);
    const rewound = new AttractController(p, [], options);
    baseline.startPlay();
    rewound.startPlay();
    const both = (buttons: number): void => {
      baseline.step(buttons);
      rewound.step(buttons);
    };

    both(0);
    both(CIRCLE);
    while (baseline.state.scene) both(0);
    const queuedGap = structuredClone(baseline.state);
    expect(queuedGap.interp.pendingBattles.map((request) => request.fiber)).toEqual(["a/z-second"]);

    both(0);
    const secondEntry = structuredClone(baseline.state);
    expect(secondEntry.scene?.fiber).toBe("a/z-second");
    rewound.step(L);
    expect(rewound.state).toEqual(queuedGap);
    rewound.step(0);
    expect(rewound.state).toEqual(secondEntry);

    both(CIRCLE);
    while (baseline.state.scene) both(0);
    const beforeBranches = structuredClone(baseline.state);
    both(0);
    const completed = structuredClone(baseline.state);
    expect(completed.sw.switches["done.a-first"]).toBe(true);
    expect(completed.sw.switches["done.z-second"]).toBe(true);

    rewound.step(L);
    expect(rewound.state).toEqual(beforeBranches);
    rewound.step(0);
    expect(rewound.state).toEqual(completed);
  });

  test("rewind can cross both battle boundaries and replay to byte-identical victory", () => {
    const p = project({ enemyHp: 1 });
    // Delay entry long enough that a short rewind from early battle lands on
    // the map, before the Battle Processing instruction.
    p.maps[0]!.events![0]!.pages[0]!.commands.unshift({ op: "wait", seconds: 3 / 60 });
    const options = {
      hz: 60,
      attractEnabled: false,
      rewindSeconds: 4 / 60,
      battle: toyBattleRules,
    } as const;
    const early = new AttractController(p, [], options);
    early.startPlay();
    while (!early.state.scene) early.step(0);
    const entryClock = early.worldAnimationTick();
    early.step(0);
    expect(early.worldAnimationTick()).toBe(entryClock);
    early.step(L);
    expect(early.state.scene).toBeNull();
    expect(early.worldAnimationTick()).toBeLessThan(entryClock);

    const baseline = new AttractController(p, [], options);
    const rewound = new AttractController(p, [], options);
    baseline.startPlay();
    rewound.startPlay();
    const tape: number[] = [];
    while (!baseline.state.scene) {
      tape.push(0);
      baseline.step(0);
      rewound.step(0);
    }
    const frozenClock = baseline.worldAnimationTick();
    tape.push(CIRCLE);
    baseline.step(CIRCLE);
    rewound.step(CIRCLE);
    tape.push(0); // release the confirm edge
    baseline.step(0);
    rewound.step(0);
    while (baseline.state.scene) {
      tape.push(0);
      baseline.step(0);
      rewound.step(0);
    }
    expect(baseline.worldAnimationTick()).toBe(frozenClock);
    expect(rewound.worldAnimationTick()).toBe(frozenClock);
    tape.push(0, 0);
    baseline.step(0);
    baseline.step(0);
    rewound.step(0);
    rewound.step(0);

    rewound.step(L);
    expect(rewound.state.scene?.kind).toBe("battle");
    for (const buttons of tape.slice(-4)) rewound.step(buttons);
    expect(rewound.state).toEqual(baseline.state);
    expect(rewound.worldAnimationTick()).toBe(baseline.worldAnimationTick());
  });
});
