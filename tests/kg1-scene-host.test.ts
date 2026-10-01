// tests/kg1-scene-host.test.ts — the generic game-scene host.
//
// A toy SceneRules (counter + wallet writeback) exercises the full
// lifecycle: park → queue → open → operate → commit → resume, plus
// cancel, skip, saves, rewind, multi-hz, registration and freeze policy.

import { describe, expect, test } from "bun:test";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { AttractController } from "../src/engine/attract.ts";
import type { SceneRules } from "../src/engine/scene.ts";
import {
  createInterpState,
  isWorldIdle,
  stepInterp,
  type InterpInput,
} from "../src/engine/interpreter.ts";
import {
  acquireSessionMap,
  createSession,
  isSessionWorldIdle,
  prepareSessionMapStep,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import { createJsonMapRepository } from "../src/engine/map-repository.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";
import { canSave, createSessionSnapshot, decodeSaveCode, encodeEnvelope, encodeSaveCode } from "../src/engine/save.ts";
import { restoreSessionEnvelope } from "../src/engine/save-restore.ts";
import { createSwitchState } from "../src/engine/interpreter.ts";
import type { Command, GameEvent, JsonValue, MapDef, Project } from "../src/engine/types.ts";

const MAP_ID = "scene-map";
const SCENE_ID = "toy.counter";

function map(events: GameEvent[] = []): MapDef {
  return {
    id: MAP_ID,
    name: "Scene host fixture",
    width: 8,
    height: 8,
    sheets: ["plain"],
    ground: new Array(64).fill("plain.0"),
    events,
  };
}

function project(events: GameEvent[] = [], gold = 0): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Scene host fixture",
    tileSize: 16,
    start: { map: MAP_ID, x: 2, y: 2, dir: "down" },
    sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [],
    maps: [map(events)],
    ...(gold > 0 ? { initialGold: gold } : {}),
  };
}

function page(
  trigger: GameEvent["pages"][number]["trigger"],
  commands: Command[],
  condition?: GameEvent["pages"][number]["condition"],
): GameEvent["pages"][number] {
  return { trigger, commands, ...(condition ? { condition } : {}) };
}

function event(id: string, pages: GameEvent["pages"]): GameEvent {
  return { id, x: 6, y: 6, pages };
}

const idleInput = (): InterpInput => ({
  confirmEdge: false,
  cancelEdge: false,
  upEdge: false,
  downEdge: false,
  playerCell: { x: 2, y: 2 },
  prevCell: { x: 2, y: 2 },
  facing: 0,
});

function sceneProject(opts: {
  onDone?: Command[];
  onCancel?: Command[];
  args?: Record<string, unknown>;
  gold?: number;
  extraEvents?: GameEvent[];
} = {}): Project {
  return project(
    [
      event("scene-open", [
        page("autorun", [
          {
            op: "scene",
            id: SCENE_ID,
            ...(opts.args ? { args: opts.args as unknown as JsonValue } : {}),
            ...(opts.onDone ? { onDone: opts.onDone } : {}),
            ...(opts.onCancel ? { onCancel: opts.onCancel } : {}),
          },
          { op: "switch", id: "scene.finished", value: true },
        ]),
        page("action", [], { switch: "scene.finished" }),
      ]),
      ...(opts.extraEvents ?? []),
    ],
    opts.gold ?? 0,
  );
}

interface ToyState {
  count: number;
  gold0: number;
  variable: string | null;
  ticks: number;
  phase: "edit" | "done";
  cancelled: boolean;
  keepExt: boolean;
  ext: JsonValue;
}

function record(value: JsonValue): Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}

/** Toy SceneRules: up/down change a counter (left/right jump by 10), OK
 *  commits gold0+count and an optional variable write, Cancel cancels.
 *  `skip: true` makes start() decline. `keepExt: true` omits ext from the
 *  completion, exercising the retain-current-ext path. */
const toySceneRules: SceneRules = {
  start(ext, rawArgs, _seed, ctx) {
    const args = record(rawArgs);
    if (args.skip === true) return null;
    const nextExt: JsonValue = {
      ...record(ext),
      toySceneStarts: Number(record(ext).toySceneStarts ?? 0) + 1,
    };
    return {
      ext: nextExt,
      state: {
        count: typeof args.start === "number" ? args.start : 0,
        gold0: ctx.gold,
        variable: typeof args.variable === "string" ? args.variable : null,
        ticks: 0,
        phase: "edit",
        cancelled: false,
        keepExt: args.keepExt === true,
        ext: nextExt,
      } as unknown as JsonValue,
    };
  },

  step(rawState, input, ticks) {
    const state = rawState as unknown as ToyState;
    state.ticks += ticks;
    if (state.phase !== "edit") return rawState;
    if (input.cancelEdge === true) {
      state.phase = "done";
      state.cancelled = true;
      return rawState;
    }
    if (input.upEdge) state.count++;
    if (input.downEdge) state.count--;
    if (input.leftEdge) state.count -= 10;
    if (input.rightEdge) state.count += 10;
    if (input.confirmEdge) state.phase = "done";
    return rawState;
  },

  done(rawState) {
    const state = rawState as unknown as ToyState;
    if (state.phase !== "done") return null;
    if (state.cancelled) return { cancelled: true, ext: state.ext };
    return {
      ...(state.keepExt ? {} : { ext: state.ext }),
      gold: state.gold0 + state.count,
      ...(state.variable ? { writes: { [state.variable]: state.count } } : {}),
      switches: { "toy.scene.done": true },
    };
  },
};

function toySession(p: Project, hz: 60 | 30 | 20 | 4 = 60, opts: { scenes?: boolean; worldContinues?: boolean } = {}): Session {
  return createSession(p, hz, {
    ...(opts.scenes === false ? {} : { scenes: { [SCENE_ID]: toySceneRules } }),
    ...(opts.worldContinues ? { scene: { worldContinues: true } } : {}),
  });
}

const SWITCH_SCENE_ID = "toy.switchWriter";

/** SceneRules whose completion writes a fixed switch set (args.switches), so
 *  a main-scene completion can invalidate a parallel page between folds. */
const switchWritingSceneRules: SceneRules = {
  start(ext, rawArgs) {
    return {
      ext,
      state: { phase: "edit", switches: record(rawArgs).switches ?? {} } as unknown as JsonValue,
    };
  },
  step(rawState, input) {
    const s = rawState as { phase: string };
    if (input.confirmEdge) s.phase = "done";
    return rawState;
  },
  done(rawState) {
    const s = rawState as { phase: string; switches: Record<string, boolean> };
    if (s.phase !== "done") return null;
    return { switches: s.switches };
  },
};

function b2Session(p: Project): Session {
  return createSession(p, 60, {
    scenes: { [SCENE_ID]: toySceneRules, [SWITCH_SCENE_ID]: switchWritingSceneRules },
  });
}

function step(
  session: Session,
  state: SessionState,
  edges: { confirm?: boolean; cancel?: boolean; up?: boolean; down?: boolean; left?: boolean; right?: boolean } = {},
): SessionState {
  return stepSession(session, state, {
    buttons: 0,
    confirmEdge: edges.confirm === true,
    cancelEdge: edges.cancel === true,
    upEdge: edges.up === true,
    downEdge: edges.down === true,
    leftEdge: edges.left === true,
    rightEdge: edges.right === true,
  });
}

/** Drive frames until the scene opens (or give up). */
function openScene(session: Session, state: SessionState): SessionState {
  let next = state;
  for (let frame = 0; frame < 10 && next.scene === null; frame++) next = step(session, next);
  return next;
}

/** Drive frames until the scene slot frees, then a few more so the resumed
 *  fiber's result branch and trailing commands fold. */
function closeScene(session: Session, state: SessionState): SessionState {
  let next = state;
  for (let frame = 0; frame < 600 && next.scene !== null; frame++) next = step(session, next);
  for (let frame = 0; frame < 10; frame++) next = step(session, next);
  return next;
}

describe("KG1 generic scene host", () => {
  test("opens: parks the fiber, queues the request, opens on the next tick", () => {
    const p = sceneProject();
    const session = toySession(p);
    let state = startSession(p, session);
    expect(state.scene).toBeNull();
    state = step(session, state);
    expect(state.scene, "scene opens on the tick the autorun fires").not.toBeNull();
    expect(state.scene!.kind).toBe("scene");
    if (state.scene?.kind === "scene") expect(state.scene.id).toBe(SCENE_ID);
    expect(state.interp.main?.mode).toBe("external");
    expect(state.interp.pendingScenes ?? []).toHaveLength(0);
    expect(isSessionWorldIdle(state)).toBe(false);
  });

  test("a queued scene request blocks worldIdle before the scene opens", () => {
    // Interpreter-level: without the session draining the queue, the parked
    // request alone must read as busy (same rule as pendingBattles).
    const p = sceneProject();
    const session = toySession(p);
    const world = session.worlds.get(MAP_ID)!;
    let interp = createInterpState();
    interp = stepInterp(world, interp, idleInput());
    expect(interp.pendingScenes).toHaveLength(1);
    expect(isWorldIdle(interp)).toBe(false);
  });

  test("a queued scene from a parallel fiber blocks worldIdle, even after the fiber cancels", () => {
    // A parallel (not main) fiber parks on a scene: main is null, so only
    // the pendingScenes check makes the world busy. When the page
    // deactivates, cancelStaleParallels drops the fiber but the request
    // stays queued until the session discards it — still busy.
    const p = project([
      event("scene-parallel", [
        page("parallel", [{ op: "scene", id: SCENE_ID }], { switch: "go" }),
      ]),
    ]);
    const session = toySession(p);
    const world = session.worlds.get(MAP_ID)!;
    let interp = createInterpState();
    interp.sw.switches["go"] = true;
    interp = stepInterp(world, interp, idleInput());
    expect(interp.pendingScenes).toHaveLength(1);
    expect(isWorldIdle(interp)).toBe(false);

    interp.sw.switches["go"] = false;
    interp = stepInterp(world, interp, idleInput());
    expect(interp.pendingScenes).toHaveLength(1);
    expect(Object.keys(interp.parallels)).toHaveLength(0);
    expect(isWorldIdle(interp)).toBe(false);
  });

  test("a queued parallel scene does not start after a completion invalidates its page", () => {
    // B2: the main scene's completion writes go=false between folds. The
    // parallel page (condition go) is stale, but cancelStaleParallels only
    // runs inside the next fold — after the session's start-of-tick queue
    // consumption. The stale request must be pruned before it can grab the
    // scene slot.
    const p = project([
      event("par", [
        page("parallel", [{ op: "scene", id: SCENE_ID }], { switch: "go" }),
      ]),
      event("main", [
        page("autorun", [
          { op: "scene", id: SWITCH_SCENE_ID, args: { switches: { go: false } } as unknown as JsonValue },
          { op: "switch", id: "main.done", value: true },
        ]),
        page("action", [], { switch: "main.done" }),
      ]),
    ]);
    const session = b2Session(p);
    let state = startSession(p, session, createSwitchState({ switches: { go: true } }));
    state = openScene(session, state);
    if (state.scene?.kind !== "scene") throw new Error("main scene did not open");
    expect(state.scene.id).toBe(SWITCH_SCENE_ID); // main-first queue ordering
    expect(state.interp.pendingScenes ?? []).toHaveLength(1);
    state = step(session, state, { confirm: true }); // completion writes go=false
    state = step(session, state); // the stale request would be consumed here
    state = step(session, state); // let the resumed main fiber fold
    expect(state.scene, "stale parallel scene did not start").toBeNull();
    expect(state.sw.switches["go"]).toBe(false);
    expect(state.sw.switches["main.done"]).toBe(true);
    expect(Object.keys(state.interp.parallels), "stale parallel fiber cancelled").toHaveLength(0);
  });

  test("a queued parallel scene does not start after its event switches pages", () => {
    // B2 (same-key page switch): the completion flips the event from page 1
    // (condition go) to page 2 (condition go2). The parked fiber belongs to
    // page 1; its queued request must be pruned even though a page is still
    // active.
    const p = project([
      event("par", [
        page("parallel", [{ op: "scene", id: SCENE_ID }], { switch: "go" }),
        page("parallel", [], { switch: "go2" }),
      ]),
      event("main", [
        page("autorun", [
          { op: "scene", id: SWITCH_SCENE_ID, args: { switches: { go: false, go2: true } } as unknown as JsonValue },
          { op: "switch", id: "main.done", value: true },
        ]),
        page("action", [], { switch: "main.done" }),
      ]),
    ]);
    const session = b2Session(p);
    let state = startSession(p, session, createSwitchState({ switches: { go: true, go2: false } }));
    state = openScene(session, state);
    if (state.scene?.kind !== "scene") throw new Error("main scene did not open");
    expect(state.scene.id).toBe(SWITCH_SCENE_ID);
    expect(state.interp.pendingScenes ?? []).toHaveLength(1);
    state = step(session, state, { confirm: true }); // completion flips the page
    state = step(session, state); // the stale request would be consumed here
    state = step(session, state); // let the resumed main fiber fold
    expect(state.scene, "stale parallel scene did not start").toBeNull();
    expect(state.sw.switches["main.done"]).toBe(true);
    expect(Object.keys(state.interp.parallels), "page-1 fiber cancelled").toHaveLength(0);
  });

  test("operates: input edges and reference ticks reach the reducer, state retained", () => {
    const p = sceneProject({ args: { start: 5 } });
    const session = toySession(p);
    let state = openScene(session, startSession(p, session));
    const sceneState = () => state.scene?.state as unknown as ToyState;
    expect(sceneState().count).toBe(5);
    state = step(session, state, { up: true });
    expect(sceneState().count).toBe(6);
    state = step(session, state, { left: true });
    expect(sceneState().count).toBe(-4);
    state = step(session, state, { right: true });
    state = step(session, state, { down: true });
    expect(sceneState().count).toBe(5);
    // ticks accumulate per reference tick (1 per 60 Hz frame).
    expect(sceneState().ticks).toBeGreaterThan(0);
  });

  test("writeback: completion commits gold, variables, switches, ext and runs onDone", () => {
    const p = sceneProject({
      args: { start: 5, variable: "toy.var" },
      gold: 100,
      onDone: [{ op: "switch", id: "done.branch", value: true }],
    });
    const session = toySession(p);
    let state = openScene(session, startSession(p, session));
    state = step(session, state, { up: true });
    state = step(session, state, { confirm: true });
    state = closeScene(session, state);
    expect(state.scene).toBeNull();
    expect(state.sw.gold).toBe(106);
    expect(state.sw.variables["toy.var"]).toBe(6);
    expect(state.sw.switches["toy.scene.done"]).toBe(true);
    expect(state.sw.switches["done.branch"]).toBe(true);
    expect(state.sw.switches["scene.finished"]).toBe(true);
    expect(record(state.ext).toySceneStarts).toBe(1);
    expect(state.interp.main?.mode ?? "run").not.toBe("external");
  });

  test("writeback: items and transfer commit", () => {
    // Gap: the writeback test only covered ext/variables/switches/gold.
    const itemsRule: SceneRules = {
      start(ext) { return { ext, state: { phase: "edit" } as unknown as JsonValue }; },
      step(s, input) { if (input.confirmEdge) (s as Record<string, unknown>).phase = "done"; return s; },
      done(s) {
        return (s as Record<string, unknown>).phase === "done"
          ? { items: { potion: 3 }, gold: 50 }
          : null;
      },
    };
    const p = sceneProject({ args: { start: 0 } });
    const session = createSession(p, 60, { scenes: { [SCENE_ID]: itemsRule } });
    let state = openScene(session, startSession(p, session));
    state = step(session, state, { confirm: true });
    state = closeScene(session, state);
    expect(state.sw.items["potion"]).toBe(3);
    expect(state.sw.gold).toBe(50);

    // transfer writeback moves the player to another map.
    const transferRule: SceneRules = {
      start(ext) { return { ext, state: { phase: "edit" } as unknown as JsonValue }; },
      step(s, input) { if (input.confirmEdge) (s as Record<string, unknown>).phase = "done"; return s; },
      done(s) {
        return (s as Record<string, unknown>).phase === "done"
          ? { transfer: { map: "other-map", x: 3, y: 4, dir: "up" } }
          : null;
      },
    };
    const twoMap: Project = {
      format: "rpgkit-project/v1",
      title: "transfer fixture",
      tileSize: 16,
      start: { map: MAP_ID, x: 2, y: 2, dir: "down" },
      sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
      items: [],
      maps: [
        map([event("go", [page("autorun", [{ op: "scene", id: SCENE_ID }])])]),
        { id: "other-map", name: "Other", width: 8, height: 8, sheets: ["plain"], ground: new Array(64).fill("plain.0"), events: [] },
      ],
    };
    const tSession = createSession(twoMap, 60, { scenes: { [SCENE_ID]: transferRule } });
    let tState = openScene(tSession, startSession(twoMap, tSession));
    tState = step(tSession, tState, { confirm: true });
    tState = closeScene(tSession, tState);
    expect(tState.mapId).toBe("other-map");
    expect(tState.move.tx).toBe(3);
    expect(tState.move.ty).toBe(4);
  });

  test("writeback: an illegal completion commits nothing (all-or-nothing)", () => {
    // Gap: a malformed completion field must throw before ANY field commits.
    // writes is validated before switches; an invalid writes value must leave
    // the switch bank untouched.
    const badWrites: SceneRules = {
      start(ext) { return { ext, state: { phase: "edit" } as unknown as JsonValue }; },
      step(s, input) { if (input.confirmEdge) (s as Record<string, unknown>).phase = "done"; return s; },
      done(s) {
        return (s as Record<string, unknown>).phase === "done"
          ? { writes: { good: "yes", bad: { nested: true } as unknown as string }, switches: { "should.not.commit": true } }
          : null;
      },
    };
    let p = sceneProject({ args: { start: 0 } });
    let session = createSession(p, 60, { scenes: { [SCENE_ID]: badWrites } });
    let state = openScene(session, startSession(p, session));
    expect(() => step(session, state, { confirm: true })).toThrow(/must be a string or finite number/);
    // The throw happened inside advanceGameScene; the scene is still open and
    // nothing committed. Drive a clean frame and confirm the banks are intact.
    expect(state.sw.switches["should.not.commit"]).toBeUndefined();
    expect(state.sw.variables["good"]).toBeUndefined();

    // A later field (items) invalid after an earlier valid one (writes) is
    // also all-or-nothing.
    const badItems: SceneRules = {
      start(ext) { return { ext, state: { phase: "edit" } as unknown as JsonValue }; },
      step(s, input) { if (input.confirmEdge) (s as Record<string, unknown>).phase = "done"; return s; },
      done(s) {
        return (s as Record<string, unknown>).phase === "done"
          ? { writes: { "also.good": "yes" }, items: { potion: "many" as unknown as number } }
          : null;
      },
    };
    p = sceneProject({ args: { start: 0 } });
    session = createSession(p, 60, { scenes: { [SCENE_ID]: badItems } });
    state = openScene(session, startSession(p, session));
    expect(() => step(session, state, { confirm: true })).toThrow(/must be a finite number/);
    expect(state.sw.variables["also.good"]).toBeUndefined();
  });

  test("cancel: commits nothing and runs onCancel", () => {
    const p = sceneProject({
      args: { start: 5, variable: "toy.var" },
      gold: 100,
      onCancel: [{ op: "switch", id: "cancel.branch", value: true }],
    });
    const session = toySession(p);
    let state = openScene(session, startSession(p, session));
    state = step(session, state, { up: true });
    state = step(session, state, { cancel: true });
    state = closeScene(session, state);
    expect(state.scene).toBeNull();
    expect(state.sw.gold).toBe(100);
    expect(state.sw.variables["toy.var"]).toBeUndefined();
    expect(state.sw.switches["toy.scene.done"]).toBeUndefined();
    expect(state.sw.switches["cancel.branch"]).toBe(true);
    expect(state.sw.switches["scene.finished"]).toBe(true);
  });

  test("a completion without ext retains the current extension state", () => {
    const p = sceneProject({ args: { keepExt: true } });
    const session = toySession(p);
    let state = openScene(session, startSession(p, session));
    state = step(session, state, { confirm: true });
    state = closeScene(session, state);
    expect(record(state.ext).toySceneStarts).toBe(1);
  });

  test("skip: start() returning null resumes the fiber without a scene", () => {
    const p = sceneProject({ args: { skip: true } });
    const session = toySession(p);
    let state = startSession(p, session);
    state = step(session, state);
    expect(state.scene).toBeNull();
    expect(state.interp.pendingScenes ?? []).toHaveLength(0);
    // The command after the skipped scene runs on the next fold.
    state = step(session, state);
    expect(state.sw.switches["scene.finished"]).toBe(true);
  });

  test("save: rejected while open, round-trips the writes after completion", () => {
    const p = sceneProject({ args: { start: 5, variable: "toy.var" }, gold: 100 });
    const session = toySession(p);
    let state = openScene(session, startSession(p, session));
    expect(canSave(state.move, state.interp, state.scene)).toBe(false);
    expect(() => createSessionSnapshot(session, state, 0)).toThrow();
    state = step(session, state, { up: true });
    state = step(session, state, { confirm: true });
    state = closeScene(session, state);
    expect(canSave(state.move, state.interp, state.scene)).toBe(true);
    const snapshot = createSessionSnapshot(session, state, 0);
    const decoded = decodeSaveCode(encodeSaveCode(snapshot));
    expect(decoded).toEqual(snapshot);
    expect(decoded.interp.sw.gold).toBe(106);
    expect(decoded.interp.sw.variables["toy.var"]).toBe(6);
  });

  test("restore: a save mid-worldline resumes byte-identically to an unsaved run", () => {
    // Gap: the save test only checked encode/decode equality. Here a real
    // restore continues the worldline and must match a run that never saved.
    const tape = [
      { up: true }, // into the scene
      { confirm: true }, // complete it (gold +1)
    ];
    const tail = [{ right: true }, {}, { right: true }, {}];
    const run = (restoreCode: string | null): SessionState => {
      const p = sceneProject({ args: { start: 0 }, gold: 100 });
      const session = toySession(p);
      let state = startSession(p, session);
      for (const frame of tape) state = step(session, state, frame);
      state = closeScene(session, state);
      if (restoreCode !== null) {
        state = restoreSessionEnvelope(session, restoreCode);
      }
      for (const frame of tail) state = step(session, state, frame);
      return state;
    };
    // Baseline: no save/restore.
    const baseline = run(null);
    // Save at the same mid-point, restore, then continue.
    const p = sceneProject({ args: { start: 0 }, gold: 100 });
    const session = toySession(p);
    let state = startSession(p, session);
    for (const frame of tape) state = step(session, state, frame);
    state = closeScene(session, state);
    const code = encodeEnvelope(createSessionSnapshot(session, state, 0));
    const restored = run(code);
    // The worldline (switches, gold, variables, map, player) is identical.
    expect(restored.sw.switches).toEqual(baseline.sw.switches);
    expect(restored.sw.gold).toBe(baseline.sw.gold);
    expect(restored.sw.variables).toEqual(baseline.sw.variables);
    expect(restored.mapId).toBe(baseline.mapId);
    expect(restored.move.tx).toBe(baseline.move.tx);
    expect(restored.move.ty).toBe(baseline.move.ty);
    expect(restored.scene).toBeNull();
  });

  test("restore: an older save without pendingScenes loads fine", () => {
    // Gap: legacy saves predate the pendingScenes field; restore must treat
    // its absence as an empty queue.
    const p = sceneProject({ args: { start: 0 }, gold: 100 });
    const session = toySession(p);
    let state = openScene(session, startSession(p, session));
    state = step(session, state, { confirm: true });
    state = closeScene(session, state);
    const snapshot = createSessionSnapshot(session, state, 0);
    delete (snapshot.interp as unknown as Record<string, unknown>).pendingScenes;
    const code = encodeEnvelope(snapshot);
    const restored = restoreSessionEnvelope(session, code);
    expect(restored.scene).toBeNull();
    expect(Object.hasOwn(restored.interp, "pendingScenes")).toBe(false);
    expect(isSessionWorldIdle(restored)).toBe(true);
  });

  test("rewind across a scene lifecycle refolds byte-identically", () => {
    const p = sceneProject({ args: { start: 0 }, gold: 50 });
    const controller = new AttractController(p, [], {
      hz: 60,
      attractEnabled: false,
      rewindSeconds: 4 / 60,
      scenes: { [SCENE_ID]: toySceneRules },
    });
    controller.startPlay();
    const states: SessionState[] = [structuredClone(controller.state)];
    for (let frame = 0; frame < 2; frame++) {
      controller.step(0);
      states.push(structuredClone(controller.state));
    }
    expect(controller.state.scene, "scene open").not.toBeNull();
    controller.step(BTN.UP); // up edge
    states.push(structuredClone(controller.state));
    controller.step(BTN.CIRCLE); // confirm edge
    states.push(structuredClone(controller.state));
    const final = structuredClone(controller.state);
    expect(final.scene).toBeNull();
    expect(final.sw.gold).toBe(51);
    const length = controller.length;
    controller.step(BTN.LTRIGGER); // L: transport only, no world frame folded.
    expect(controller.length).toBe(length - 4);
    expect(controller.state).toEqual(states[length - 4]);
    // Re-issue the same masks: the rewound timeline refolds to the same
    // final state byte-for-byte.
    for (const mask of [0, 0, BTN.UP, BTN.CIRCLE]) controller.step(mask);
    expect(controller.state).toEqual(final);
  });

  test("rewind selects a scene-boundary keyframe as its restore point", () => {
    // Gap: the rewind test never checked keyframe stats or proved a scene
    // boundary keyframe is selected as the refold restore point. With a
    // large keyframe interval, only scene open/close boundaries capture
    // keyframes; a rewind must resume from one of them, not from frame 0.
    const p = sceneProject({ args: { start: 0 }, gold: 50 });
    const controller = new AttractController(p, [], {
      hz: 60,
      attractEnabled: false,
      rewindSeconds: 2 / 60,
      keyframeIntervalFrames: 100_000,
      scenes: { [SCENE_ID]: toySceneRules },
    });
    controller.startPlay();
    for (let frame = 0; frame < 2; frame++) controller.step(0);
    expect(controller.state.scene, "scene open").not.toBeNull();
    controller.step(BTN.UP);
    controller.step(BTN.CIRCLE); // confirm: the scene closes on this fold
    expect(controller.state.scene).toBeNull();
    const boundaries = controller.keyframeStats().entries.filter((e) => e.sceneBoundary);
    expect(boundaries.length).toBeGreaterThanOrEqual(2); // open + close
    const openBoundary = boundaries[0]!;
    // Rewind two frames: the refold restore point is the scene-open
    // boundary keyframe (lastRefoldStart is its timeline frame, not 0),
    // and only the frames after it are refolded.
    controller.step(BTN.LTRIGGER);
    const stats = controller.keyframeStats();
    expect(stats.lastRefoldStart).toBe(openBoundary.timelineFrame);
    expect(stats.lastRefoldFrames).toBeGreaterThan(0);
  });

  test("60/30/20/4 Hz reach the same committed result", () => {
    const tape = [
      {} as const,
      { up: true } as const,
      { up: true } as const,
      { confirm: true } as const,
    ];
    const outcomes = ([60, 30, 20, 4] as const).map((hz) => {
      const p = sceneProject({ args: { start: 0, variable: "toy.var" }, gold: 100 });
      const session = toySession(p, hz);
      let state = startSession(p, session);
      for (const edges of tape) state = step(session, state, edges);
      state = closeScene(session, state);
      return {
        scene: state.scene,
        gold: state.sw.gold,
        variable: state.sw.variables["toy.var"],
        done: state.sw.switches["toy.scene.done"],
        finished: state.sw.switches["scene.finished"],
      };
    });
    for (const outcome of outcomes) {
      expect(outcome).toEqual({
        scene: null,
        gold: 102,
        variable: 2,
        done: true,
        finished: true,
      });
    }
  });

  test("zero-cost: a scene-free project keeps pendingScenes absent on the hot path", () => {
    // B5: the scene queue is runtime-only and sparse. A project that never
    // registers or queues a scene must not grow a pendingScenes key (or an
    // empty-array allocation) per reference tick.
    const p = project([
      event("plain", [
        page("autorun", [{ op: "switch", id: "plain.done", value: true }]),
        page("action", [], { switch: "plain.done" }),
      ]),
    ]);
    const session = toySession(p);
    let state = startSession(p, session);
    expect(Object.hasOwn(state.interp, "pendingScenes")).toBe(false);
    for (let i = 0; i < 30; i++) state = step(session, state);
    expect(Object.hasOwn(state.interp, "pendingScenes")).toBe(false);
    // The interpreter-level fold shares the same sparse guarantee.
    let interp = createInterpState();
    const world = session.worlds.get(MAP_ID)!;
    for (let i = 0; i < 30; i++) interp = stepInterp(world, interp, idleInput());
    expect(Object.hasOwn(interp, "pendingScenes")).toBe(false);
  });

  test("registration: createSession throws for unregistered or invalid scene ids", () => {
    const p = sceneProject();
    expect(() => toySession(p, 60, { scenes: false })).toThrow(/unregistered scene ids/);
    const bad = project([
      event("bad", [page("autorun", [{ op: "scene", id: "no-namespace" }])]),
    ]);
    expect(() => createSession(bad, 60, { scenes: { "no-namespace": toySceneRules } }))
      .toThrow(/invalid namespaced scene id/);
  });

  test("registration: scene ids nested in scene branches are registered", () => {
    // B4: the scene-id walker must recurse into scene.onDone/onCancel, the
    // same way it already recurses into battle result branches.
    const nested = project([
      event("nested", [
        page("autorun", [
          { op: "scene", id: SCENE_ID, onDone: [{ op: "scene", id: "toy.inner" }] },
        ]),
      ]),
    ]);
    expect(() => createSession(nested, 60, { scenes: { [SCENE_ID]: toySceneRules } }))
      .toThrow(/unregistered scene ids: toy\.inner/);
    const nestedCancel = project([
      event("nested-cancel", [
        page("autorun", [
          { op: "scene", id: SCENE_ID, onCancel: [{ op: "scene", id: "toy.inner" }] },
        ]),
      ]),
    ]);
    expect(() => createSession(nestedCancel, 60, { scenes: { [SCENE_ID]: toySceneRules } }))
      .toThrow(/unregistered scene ids: toy\.inner/);
  });

  test("registration: battle and ext commands nested in scene branches are registered", () => {
    // B4: the battle and extension walkers must also enter scene branches.
    const battleInBranch = project([
      event("battle-in-scene", [
        page("autorun", [
          { op: "scene", id: SCENE_ID, onDone: [{ op: "battle", setup: {} }] },
        ]),
      ]),
    ]);
    expect(() => createSession(battleInBranch, 60, { scenes: { [SCENE_ID]: toySceneRules } }))
      .toThrow(/uses battle commands/);
    const extInBranch = project([
      event("ext-in-scene", [
        page("autorun", [
          { op: "scene", id: SCENE_ID, onCancel: [{ op: "ext", call: "ns.missing", args: {} }] },
        ]),
      ]),
    ]);
    expect(() => createSession(extInBranch, 60, { scenes: { [SCENE_ID]: toySceneRules } }))
      .toThrow(/unregistered extension calls: command ns\.missing/);
  });

  test("registration: ProjectShell map acquisition fails fast on an unregistered scene id", () => {
    // B4: the sharded load path (acquireSessionMap / prepareSessionMapStep)
    // must assert scene registration at map-load time, not when the event
    // executes.
    const p = project([
      event("shell-scene", [page("autorun", [{ op: "scene", id: SCENE_ID }])]),
    ]);
    const split = splitProjectMaps(p);
    const files = new Map(split.entries.map((entry) => [entry.path, entry.text]));
    const repository = createJsonMapRepository(split.shell.mapIndex, {
      read: (entry) => files.get(entry),
    });
    expect(() => createSession(split.shell, 60, { maps: repository }))
      .toThrow(/unregistered scene ids/);
    // The same map with the scene registered loads cleanly.
    expect(() => createSession(split.shell, 60, {
      maps: repository,
      scenes: { [SCENE_ID]: toySceneRules },
    })).not.toThrow();
  });

  test("registration: prepareSessionMapStep fails fast on an unregistered scene id in the acquired map", () => {
    // B4: the per-tick sharded load path (a transfer's map acquire) must
    // assert scene registration when the map payload arrives, not when the
    // scene command later executes.
    const mapB: MapDef = {
      ...map(),
      id: "map-b",
      events: [event("b-scene", [page("autorun", [{ op: "scene", id: SCENE_ID }])])],
    };
    const twoMap: Project = {
      ...project(),
      maps: [map(), mapB],
    };
    const split = splitProjectMaps(twoMap);
    const files = new Map(split.entries.map((entry) => [entry.path, entry.text]));
    const newRepository = () => createJsonMapRepository(split.shell.mapIndex, {
      read: (entry) => files.get(entry),
    });
    // acquireStep stages on the first call and hands over the map on the
    // second, where the registration assertion runs.
    const session = createSession(split.shell, 60, { maps: newRepository() });
    expect(prepareSessionMapStep(session, "map-b")).toBe(false);
    expect(() => prepareSessionMapStep(session, "map-b")).toThrow(/unregistered scene ids/);
    // Registering the scene lets the same acquire complete (fresh
    // repository: a session releases non-resident maps from a shared one).
    const registered = createSession(split.shell, 60, {
      maps: newRepository(),
      scenes: { [SCENE_ID]: toySceneRules },
    });
    expect(prepareSessionMapStep(registered, "map-b")).toBe(false); // stage
    expect(prepareSessionMapStep(registered, "map-b")).toBe(false); // acquire + assert
    expect(prepareSessionMapStep(registered, "map-b")).toBe(true); // compile
    // The prepared map publishes through acquireSessionMap at the transfer
    // boundary, with the scene registration already validated.
    expect(acquireSessionMap(registered, "map-b").id).toBe("map-b");
    expect(registered.maps.has("map-b")).toBe(true);
  });

  test("freeze: the world pauses behind a scene by default and resumes after; worldContinues opts out", () => {
    const parallelWait = event("scene-parallel", [
      page("parallel", [
        { op: "wait", seconds: 1 },
        { op: "switch", id: "parallel.done", value: true },
      ]),
    ]);
    for (const worldContinues of [false, true]) {
      const p = sceneProject({ extraEvents: [parallelWait] });
      const session = toySession(p, 60, { worldContinues });
      let state = openScene(session, startSession(p, session));
      // The scene stays open for ~2 virtual seconds.
      for (let frame = 0; frame < 120; frame++) state = step(session, state);
      if (worldContinues) {
        expect(state.sw.switches["parallel.done"], `worldContinues=${worldContinues}`).toBe(true);
      } else {
        expect(state.sw.switches["parallel.done"], `worldContinues=${worldContinues}`).toBeUndefined();
      }
      state = step(session, state, { confirm: true });
      state = closeScene(session, state);
      // The frozen wait resumes for its remaining 60 ticks after the scene
      // closes (pausedTicks shifted its origin), so give it a second.
      for (let frame = 0; frame < 90 && state.sw.switches["parallel.done"] !== true; frame++) {
        state = step(session, state);
      }
      expect(state.sw.switches["parallel.done"]).toBe(true);
    }
  });
});
