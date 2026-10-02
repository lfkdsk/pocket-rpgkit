import { describe, expect, test } from "bun:test";
import { AttractController } from "../src/engine/attract.ts";
import { createJsonMapRepository, MapNotReadyError } from "../src/engine/map-repository.ts";
import { loadSession, saveSession } from "../src/engine/save-restore.ts";
import { canonicalJson } from "../src/engine/save.ts";
import {
  acquireSessionMap,
  createSession,
  prepareSessionMap,
  releaseSessionMapLayers,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import { createWorldHandoffResolver } from "../src/engine/world-handoff.ts";
import type { Command, GameEvent, Project } from "../src/engine/types.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";
import {
  autorunTransfer,
  handoffProject,
  HANDOFF_LAYOUT,
  markedTransfer,
  playerTouchTransfer,
  PORTAL_ONLY_EAST,
  SAFE_EAST,
  SAFE_WEST,
} from "./fixtures/seamless-handoff/fixture-data.ts";

function runtime(project: Project, hz = 60): { session: Session; state: SessionState } {
  const session = createSession(project, hz, {
    handoff: createWorldHandoffResolver(HANDOFF_LAYOUT),
  });
  return { session, state: startSession(project, session) };
}

function step(session: Session, state: SessionState, frames = 1): SessionState {
  let next = state;
  for (let frame = 0; frame < frames; frame++) {
    next = stepSession(session, next, { buttons: 0 });
  }
  return next;
}

function walkToPortal(session: Session, state: SessionState, buttons: number): SessionState {
  let next = state;
  for (let tick = 0; tick < 8; tick++) {
    next = stepSession(session, next, { buttons });
  }
  return next;
}

function autorun(commands: Command[], id = "script"): GameEvent {
  return { id, x: 0, y: 0, pages: [{ trigger: "autorun", commands }] };
}

function normalizeHostFrame(state: SessionState): SessionState {
  return { ...state, frame: 0 };
}

describe("seamless-v1 opening handoff", () => {
  test("crosses a proven opening in one eight-reference-tick step and enters atomically", () => {
    const project = handoffProject({
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: playerTouchTransfer(
        "safe-east",
        3,
        1,
        markedTransfer("east", 0, 1, "right", SAFE_EAST),
      ),
    });
    const { session } = runtime(project);
    let state = startSession(project, session);

    state = walkToPortal(session, state, 0x0020);
    expect(state.mapId).toBe("west");
    expect(state.handoff).toMatchObject({
      sourceMapId: "west",
      targetMapId: "east",
      sourceX: 3,
      sourceY: 1,
      targetX: 0,
      targetY: 1,
      direction: 3,
      phase: 0,
      totalTicks: 8,
    });
    expect(state.move).toMatchObject({ tx: 3, ty: 1, px: 48, py: 16, moving: true, phase: 0 });

    for (let phase = 1; phase < 8; phase++) {
      state = step(session, state);
      expect(state.mapId, `phase ${phase} owner`).toBe("west");
      expect(state.handoff?.phase, `phase ${phase}`).toBe(phase);
      expect(state.move.px, `phase ${phase} world progress`).toBe(48 + phase * 2);
      expect(state.move.py).toBe(16);
    }

    state = step(session, state);
    expect(state.mapId).toBe("east");
    expect(Object.prototype.hasOwnProperty.call(state, "handoff")).toBe(false);
    expect(state.move).toMatchObject({
      tx: 0,
      ty: 1,
      px: 0,
      py: 16,
      facing: 3,
      moving: false,
      phase: 0,
    });
    // west origin 0 + crossing endpoint 64px equals east origin 64px + local 0.
    expect(4 * 16 + state.move.px).toBe(64);
    expect(state.interp.frame).toBe(0);
    expect(Object.keys(state.chars.chars)).toHaveLength(0);
  });

  test("supports the independently proven reverse opening", () => {
    const project = handoffProject({
      start: { map: "east", x: 1, y: 1, dir: "left" },
      sourceEvent: playerTouchTransfer(
        "safe-west",
        0,
        1,
        markedTransfer("west", 3, 1, "left", SAFE_WEST),
      ),
    });
    const { session } = runtime(project);
    let state = walkToPortal(session, startSession(project, session), 0x0080);
    expect(state.handoff?.direction).toBe(1);
    state = step(session, state, 8);
    expect(state.mapId).toBe("west");
    expect([state.move.tx, state.move.ty, state.move.facing]).toEqual([3, 1, 1]);
    expect(state.move.px).toBe(48);
  });

  const fallbackCases = [
    ["project mode omitted", undefined, "west", 2, 1, "right", 3, 1, 0x0020, markedTransfer("east", 0, 1, "right", SAFE_EAST)],
    ["command marker omitted", "seamless-v1", "west", 2, 1, "right", 3, 1, 0x0020, { op: "transfer", map: "east", x: 0, y: 1, dir: "right" }],
    ["portal-only opening", "seamless-v1", "west", 2, 2, "right", 3, 2, 0x0020, markedTransfer("east", 0, 2, "right", PORTAL_ONLY_EAST)],
    ["wrong portal provenance", "seamless-v1", "west", 2, 1, "right", 3, 1, 0x0020, markedTransfer("east", 0, 1, "right", "missing")],
    ["wrong landing", "seamless-v1", "west", 2, 1, "right", 3, 1, 0x0020, markedTransfer("east", 0, 2, "right", SAFE_EAST)],
    ["wrong direction", "seamless-v1", "west", 2, 1, "right", 3, 1, 0x0020, markedTransfer("east", 0, 1, "left", SAFE_EAST)],
    ["direction-only seam", "seamless-v1", "east", 1, 2, "down", 1, 3, 0x0040, markedTransfer("south", 1, 0, "down", "east:south")],
    ["gap", "seamless-v1", "west", 1, 2, "down", 1, 3, 0x0040, markedTransfer("south", 0, 0, "down", "west:south:gap")],
    ["unplaced indoor story transfer", "seamless-v1", "west", 2, 1, "right", 3, 1, 0x0020, { op: "transfer", map: "indoor", x: 2, y: 2, dir: "up" }],
  ] satisfies readonly (readonly [
    string,
    Project["worldTraversal"] | undefined,
    string,
    number,
    number,
    "up" | "down" | "left" | "right",
    number,
    number,
    number,
    Extract<Command, { op: "transfer" }> & { map: string; x: number; y: number },
  ])[];

  test.each(fallbackCases)("falls back to legacy for %s", (
    _name, traversal, sourceMap, startX, startY, startDir, eventX, eventY, buttons, command,
  ) => {
    const project = handoffProject({
      start: { map: sourceMap, x: startX, y: startY, dir: startDir },
      traversal,
      sourceEvent: playerTouchTransfer("fallback", eventX, eventY, command),
    });
    if (traversal === undefined) delete project.worldTraversal;
    const { session } = runtime(project);
    const state = walkToPortal(session, startSession(project, session), buttons);
    expect(Object.prototype.hasOwnProperty.call(state, "handoff")).toBe(false);
    expect(state.mapId).toBe(command.map);
    expect([state.move.tx, state.move.ty]).toEqual([command.x, command.y]);
  });

  test("requires open authored target passage before starting the crossing", () => {
    const project = handoffProject({
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: playerTouchTransfer(
        "blocked-target",
        3,
        1,
        markedTransfer("east", 0, 1, "right", SAFE_EAST),
      ),
    });
    project.maps.find((map) => map.id === "east")!.passage = [[4, "block"]];
    const { session } = runtime(project);
    const state = walkToPortal(session, startSession(project, session), 0x0020);
    expect(state.mapId).toBe("east");
    expect(Object.hasOwn(state, "handoff")).toBe(false);
  });

  test("requires a resolver bound to the project's topology identity", () => {
    const makeProject = () => handoffProject({
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: playerTouchTransfer(
        "identity",
        3,
        1,
        markedTransfer("east", 0, 1, "right", SAFE_EAST),
      ),
    });
    const noResolverProject = makeProject();
    const noResolverSession = createSession(noResolverProject);
    expect(walkToPortal(noResolverSession, startSession(noResolverProject, noResolverSession), 0x0020).mapId)
      .toBe("east");

    const noLayoutProject = makeProject();
    delete noLayoutProject.worldLayout;
    const noLayoutSession = createSession(noLayoutProject, 60, {
      handoff: createWorldHandoffResolver(HANDOFF_LAYOUT),
    });
    expect(walkToPortal(noLayoutSession, startSession(noLayoutProject, noLayoutSession), 0x0020).mapId)
      .toBe("east");

    const wrongTopologyProject = makeProject();
    wrongTopologyProject.worldLayout = {
      ...HANDOFF_LAYOUT,
      topologyHash: "e".repeat(64),
    };
    const wrongTopologySession = createSession(wrongTopologyProject, 60, {
      handoff: createWorldHandoffResolver(HANDOFF_LAYOUT),
    });
    expect(walkToPortal(wrongTopologySession, startSession(wrongTopologyProject, wrongTopologySession), 0x0020).mapId)
      .toBe("east");
  });

  test("pauses an async cold target and retries the same logical portal tick", async () => {
    const project = handoffProject({
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: playerTouchTransfer(
        "async-safe",
        3,
        1,
        markedTransfer("east", 0, 1, "right", SAFE_EAST),
      ),
    });
    const split = splitProjectMaps(project);
    const files = new Map(split.entries.map((entry) => [entry.path, entry.text]));
    const westEntry = split.shell.mapIndex.find((entry) => entry.id === "west")!.entry;
    const ready = new Set([westEntry]);
    const repository = createJsonMapRepository(split.shell.mapIndex, {
      read: (entry) => ready.has(entry) ? files.get(entry) : undefined,
      prepare: async (entry) => { ready.add(entry); },
    });
    const session = createSession(split.shell, 60, {
      maps: repository,
      handoff: createWorldHandoffResolver(HANDOFF_LAYOUT),
    });
    let state = startSession(split.shell, session);
    for (let tick = 0; tick < 7; tick++) {
      state = stepSession(session, state, { buttons: 0x0020 });
    }
    const before = canonicalJson(state);
    expect(() => stepSession(session, state, { buttons: 0x0020 })).toThrow(MapNotReadyError);
    expect(canonicalJson(state)).toBe(before);
    expect([...session.maps.keys()]).toEqual(["west"]);

    await prepareSessionMap(session, "east");
    state = stepSession(session, state, { buttons: 0x0020 });
    expect(state.handoff?.phase).toBe(0);
    expect(state.interp.frame).toBe(8);
    state = step(session, state, 8);
    expect(state.mapId).toBe("east");
    expect([...session.maps.keys()].sort()).toEqual(["east", "west"]);
  });

  test("does not flatten the connected-world parsed keep-set on commit", () => {
    const project = handoffProject({
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: playerTouchTransfer(
        "cache-safe",
        3,
        1,
        markedTransfer("east", 0, 1, "right", SAFE_EAST),
      ),
    });
    const split = splitProjectMaps(project);
    const files = new Map(split.entries.map((entry) => [entry.meta.id, entry.bytes]));
    const repository = createJsonMapRepository(split.shell.mapIndex, {
      read: (entry) => {
        const meta = split.shell.mapIndex.find((candidate) => candidate.entry === entry);
        return meta ? files.get(meta.id) : undefined;
      },
    });
    const session = createSession(split.shell, 60, {
      maps: repository,
      handoff: createWorldHandoffResolver(HANDOFF_LAYOUT),
    });
    let state = startSession(split.shell, session);
    acquireSessionMap(session, "east");
    acquireSessionMap(session, "north");
    // W3 keeps a visible-only map parsed while dropping its compiled layers.
    releaseSessionMapLayers(session, ["east", "north", "west"], ["east", "west"], "west");
    expect([...session.maps.keys()].sort()).toEqual(["east", "north", "west"]);
    expect(session.worlds.has("north")).toBe(false);
    expect(session.tables.has("north")).toBe(false);

    state = walkToPortal(session, state, 0x0020);
    expect(state.handoff?.phase).toBe(0);
    state = step(session, state, 8);
    expect(state.mapId).toBe("east");
    // Restoring the old flat release at the atomic commit deletes north and
    // makes this fail; only the cache driver knows the real working set.
    expect(session.maps.has("north")).toBe(true);
    expect(session.worlds.has("north")).toBe(false);
    expect(session.tables.has("north")).toBe(false);
  });

  test("does not reinterpret marked autorun, action, parallel, or nested-common transfers", () => {
    const command = () => markedTransfer("east", 0, 1, "right", SAFE_EAST);
    const cases: { name: string; event: GameEvent; input: { buttons: number; confirmEdge?: boolean } }[] = [
      { name: "autorun", event: autorunTransfer(command()), input: { buttons: 0 } },
      {
        name: "action",
        event: { id: "action", x: 3, y: 1, pages: [{ trigger: "action", commands: [command()] }] },
        input: { buttons: 0, confirmEdge: true },
      },
      {
        name: "parallel",
        event: { id: "parallel", x: 0, y: 0, pages: [{ trigger: "parallel", commands: [command()] }] },
        input: { buttons: 0 },
      },
    ];
    for (const entry of cases) {
      const project = handoffProject({ sourceEvent: entry.event });
      const { session, state } = runtime(project);
      const transferred = stepSession(session, state, entry.input);
      expect(transferred.mapId, entry.name).toBe("east");
      expect(Object.hasOwn(transferred, "handoff"), entry.name).toBe(false);
    }

    const nested = handoffProject({
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: {
        id: "nested",
        x: 3,
        y: 1,
        pages: [{ trigger: "playerTouch", commands: [{ op: "common", id: "portal-common" }] }],
      },
    });
    nested.commonEvents = [{ id: "portal-common", trigger: "none", commands: [command()] }];
    const nestedRuntime = runtime(nested);
    const nestedState = walkToPortal(nestedRuntime.session, nestedRuntime.state, 0x0020);
    expect(nestedState.mapId).toBe("east");
    expect(Object.hasOwn(nestedState, "handoff")).toBe(false);
  });

  test("keeps source runtime as the sole owner and starts target pages one tick after entry", () => {
    const sourceParallel = autorun([
      { op: "variable", id: "source.ticks", set: { op: "add", value: 1 } },
    ], "source-parallel");
    sourceParallel.pages[0]!.trigger = "parallel";
    const targetAutorun = autorun([
      { op: "switch", id: "target.autorun", value: true },
      { op: "wait", seconds: 10 },
    ], "target-autorun");
    const targetParallel = autorun([
      { op: "switch", id: "target.parallel", value: true },
      { op: "wait", seconds: 10 },
    ], "target-parallel");
    targetParallel.pages[0]!.trigger = "parallel";
    targetParallel.pages[0]!.sprite = "npc";
    const project = handoffProject({
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: playerTouchTransfer(
        "safe-east",
        3,
        1,
        markedTransfer("east", 0, 1, "right", SAFE_EAST),
      ),
      mapEvents: {
        west: [sourceParallel],
        east: [targetAutorun, targetParallel],
      },
    });
    project.sprites = {
      npc: { kind: "image", src: "npc.png" },
    };
    const { session } = runtime(project);
    let state = walkToPortal(session, startSession(project, session), 0x0020);
    const sourceTicks = Number(state.sw.variables["source.ticks"]);
    expect(sourceTicks).toBe(8);
    expect(state.sw.switches["target.autorun"]).toBeUndefined();
    expect(state.sw.switches["target.parallel"]).toBeUndefined();
    for (let phase = 1; phase < 8; phase++) {
      state = step(session, state);
      expect(state.sw.variables["source.ticks"], `source phase ${phase}`).toBe(sourceTicks! + phase);
      expect(state.sw.switches["target.autorun"], `target autorun phase ${phase}`).toBeUndefined();
      expect(state.sw.switches["target.parallel"], `target parallel phase ${phase}`).toBeUndefined();
      expect(Object.keys(state.chars.chars)).toContain("source-parallel");
      expect(Object.keys(state.chars.chars)).not.toContain("target-parallel");
    }
    state = step(session, state);
    expect(state.mapId).toBe("east");
    expect(state.interp.frame).toBe(0);
    expect(Object.keys(state.chars.chars)).toEqual([]);
    expect(state.sw.switches["target.autorun"]).toBeUndefined();
    expect(state.sw.switches["target.parallel"]).toBeUndefined();
    expect(state.sw.variables["source.ticks"]).toBe(sourceTicks! + 8);

    state = step(session, state);
    expect(state.interp.frame).toBe(1);
    expect(state.sw.switches["target.autorun"]).toBe(true);
    expect(state.sw.switches["target.parallel"]).toBe(true);
    expect(Object.keys(state.chars.chars).sort()).toEqual(["target-autorun", "target-parallel"]);
  });

  test("reuses legacy map-entry cleanup and preserves only transfer-safe screen/audio state", () => {
    const setup: Command[] = [
      { op: "variable", id: "local.visit", set: { op: "set", value: 9 } },
      { op: "switch", id: "local.flag", value: true },
      { op: "switch", id: "global.flag", value: true },
      { op: "playBgm", id: "route", volume: 73 },
      { op: "screenTint", layer: "night", color: { r: 5, g: 10, b: 30, a: 120 }, duration: 0 },
      { op: "screenFlash", color: { r: 255, g: 255, b: 255, a: 255 }, intensity: 255, duration: 5 },
      { op: "camera", target: { x: 1, y: 1 }, duration: 5 },
      {
        op: "moveRoute",
        target: "player",
        wait: false,
        route: { steps: ["moveUp"], repeat: false, skippable: false },
      },
    ];
    const make = (seamless: boolean): Project => handoffProject({
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: {
        id: "entry-semantics",
        x: 3,
        y: 1,
        pages: [{
          trigger: "playerTouch",
          commands: [
            ...setup,
            seamless
              ? markedTransfer("east", 0, 1, "right", SAFE_EAST)
              : { op: "transfer", map: "east", x: 0, y: 1, dir: "right" },
          ],
        }],
      },
    });

    const legacyProject = make(false);
    const legacyRuntime = runtime(legacyProject);
    const legacy = walkToPortal(legacyRuntime.session, legacyRuntime.state, 0x0020);
    const seamlessProject = make(true);
    const seamlessRuntime = runtime(seamlessProject);
    let seamless = walkToPortal(seamlessRuntime.session, seamlessRuntime.state, 0x0020);
    expect(seamless.playerRoute).not.toBeNull();
    seamless = step(seamlessRuntime.session, seamless, 8);

    for (const state of [legacy, seamless]) {
      expect(state.mapId).toBe("east");
      expect(state.move).toMatchObject({ tx: 0, ty: 1, facing: 3, moving: false, phase: 0 });
      expect(state.sw.variables["local.visit"]).toBeUndefined();
      expect(state.sw.switches["local.flag"]).toBeUndefined();
      expect(state.sw.switches["global.flag"]).toBe(true);
      expect(state.playerRoute).toBeNull();
      expect(Object.keys(state.chars.chars)).toEqual([]);
      expect(state.interp.main).toBeNull();
      expect(state.interp.frame).toBe(0);
      expect(state.interp.screen).toMatchObject({ tints: { night: { left: 0 } } });
      expect(state.interp.screen?.flash).toBeUndefined();
      expect(state.interp.screen?.camera).toBeUndefined();
      expect(state.interp.audio?.bgm?.id).toBe("route");
    }
    expect(legacy.interp.audio?.bgm?.positionTicks).toBe(0);
    expect(seamless.interp.audio?.bgm?.positionTicks).toBe(8);
  });

  test("folds the same virtual traversal at 20, 30 and 60 Hz", () => {
    const project = handoffProject({
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: playerTouchTransfer("rates", 3, 1, markedTransfer("east", 0, 1, "right", SAFE_EAST)),
    });
    const states = ([20, 30, 60] as const).map((hz) => {
      const { session, state } = runtime(project, hz);
      const ticksPerFrame = 60 / hz;
      const movementFrames = Math.ceil(8 / ticksPerFrame);
      let next = state;
      for (let frame = 0; frame < hz; frame++) {
        next = stepSession(session, next, { buttons: frame < movementFrames ? 0x0020 : 0 });
      }
      return normalizeHostFrame(next);
    });
    expect(canonicalJson(states[1])).toBe(canonicalJson(states[0]));
    expect(canonicalJson(states[2])).toBe(canonicalJson(states[0]));
    expect(states[0]!.mapId).toBe("east");
    expect(states[0]!.interp.frame).toBe(44);
  });

  test("rejects every in-flight save, keeps the v1 shape, and resumes before and after the handoff", () => {
    const project = handoffProject({
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: playerTouchTransfer("save", 3, 1, markedTransfer("east", 0, 1, "right", SAFE_EAST)),
    });
    const original = runtime(project);
    const before = saveSession(original.session, original.state, 0);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(Object.keys(before.snapshot).sort()).toEqual(["ext", "held", "interp", "map", "mapRuntime", "player"]);
    expect(canonicalJson(before.snapshot)).not.toContain("handoff");

    let state = walkToPortal(original.session, original.state, 0x0020);
    for (let phase = 0; phase < 8; phase++) {
      expect(state.handoff?.phase).toBe(phase);
      const saving = saveSession(original.session, state, 0);
      expect(saving.ok, `phase ${phase}`).toBe(false);
      if (!saving.ok) expect(saving.error.code).toBe("not-safe-point");
      state = step(original.session, state);
    }
    expect(state.mapId).toBe("east");
    expect(saveSession(original.session, state, 0).ok).toBe(true);

    const resumedRuntime = runtime(project);
    const loaded = loadSession(resumedRuntime.session, before.snapshot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(Object.hasOwn(loaded.state, "handoff")).toBe(false);
    let resumed = walkToPortal(resumedRuntime.session, loaded.state, 0x0020);
    resumed = step(resumedRuntime.session, resumed, 8);
    expect(canonicalJson(resumed)).toBe(canonicalJson(state));
  });

  test("rewinds through a mid-handoff keyframe and refolds byte-identically", () => {
    const project = handoffProject({
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: playerTouchTransfer("rewind", 3, 1, markedTransfer("east", 0, 1, "right", SAFE_EAST)),
    });
    const tape = [...new Array<number>(8).fill(0x0020), ...new Array<number>(32).fill(0)];
    const options = {
      hz: 60,
      tapeHz: 60,
      idleFrames: 60_000,
      endHoldFrames: 60_000,
      rewindSeconds: 3 / 60,
      keyframeIntervalFrames: 1,
      worldTraversal: "seamless-v1" as const,
      handoff: createWorldHandoffResolver(HANDOFF_LAYOUT),
    };
    const keyed = new AttractController(project, tape, options);
    const fromZero = new AttractController(project, tape, { ...options, keyframeMaxBytes: 0 });
    keyed.startAttract();
    fromZero.startAttract();
    for (let frame = 0; frame < 15; frame++) {
      keyed.step(0);
      fromZero.step(0);
    }
    expect(keyed.state.handoff?.phase).toBe(7);
    keyed.step(0x0100);
    fromZero.step(0x0100);
    expect(keyed.length).toBe(12);
    expect(keyed.state.handoff?.phase).toBe(4);
    expect(canonicalJson(keyed.state)).toBe(canonicalJson(fromZero.state));
    for (let frame = 0; frame < 4; frame++) {
      keyed.step(0);
      fromZero.step(0);
      expect(canonicalJson(keyed.state), `refold suffix ${frame}`).toBe(canonicalJson(fromZero.state));
    }
    expect(keyed.state.mapId).toBe("east");
    expect(keyed.keyframeStats().lastRefoldStart).toBe(12);
  });

  test("a non-empty tape without traversal identity remains on the legacy timeline", () => {
    const project = handoffProject({
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: playerTouchTransfer("tape", 3, 1, markedTransfer("east", 0, 1, "right", SAFE_EAST)),
    });
    const resolver = createWorldHandoffResolver(HANDOFF_LAYOUT);
    const tape = new Array<number>(8).fill(0x0020);
    const legacy = new AttractController(project, tape, {
      hz: 60,
      idleFrames: 60_000,
      handoff: resolver,
    });
    legacy.startAttract();
    for (let frame = 0; frame < 8; frame++) legacy.step(0);
    expect(legacy.state.mapId).toBe("east");
    expect(Object.hasOwn(legacy.state, "handoff")).toBe(false);

    const seamless = new AttractController(project, tape, {
      hz: 60,
      idleFrames: 60_000,
      worldTraversal: "seamless-v1",
      handoff: resolver,
    });
    seamless.startAttract();
    for (let frame = 0; frame < 8; frame++) seamless.step(0);
    expect(seamless.state.mapId).toBe("west");
    expect(seamless.state.handoff?.phase).toBe(0);
  });
});
