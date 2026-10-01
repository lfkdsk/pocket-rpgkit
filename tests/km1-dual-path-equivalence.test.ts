// KM1 fix 1 — dual-path differential test.
//
// The perf fix split movement into a legacy fast path (used when the compiled
// world has no movement-control capability and no runtime override exists) and
// the controlled path. For inputs that trigger NO control, both paths must
// produce byte-identical canonical state on every frame.
//
// Each scenario boots the same project twice: one session runs the legacy
// path, the other is white-box forced onto the controlled path (the compiled
// world's gate flag flipped, nothing else). A second boot variant arms the
// controlled path the authored way (a page default equal to the default
// grade). Player movement, NPC routes, random/approach motion, collision and
// blocks, and cross-map transfers are all covered frame by frame.

import { describe, expect, test } from "bun:test";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import type {
  Command,
  GameEvent,
  MapDef,
  Page,
  Project,
  TileId,
} from "../src/engine/types.ts";

const TILE: TileId = "tiles.0";
const BTN = { UP: 0x0010, RIGHT: 0x0020, DOWN: 0x0040, LEFT: 0x0080 } as const;

const page = (trigger: Page["trigger"], commands: Command[], extra: Partial<Page> = {}): Page => ({
  trigger,
  sprite: null,
  commands,
  ...extra,
});

const event = (id: string, x: number, y: number, pages: Page[]): GameEvent => ({ id, x, y, pages });

function map(
  id: string,
  events: GameEvent[] = [],
  passage?: Array<[number, "pass" | "block"]>,
  width = 10,
  height = 8,
): MapDef {
  return {
    id,
    name: id,
    width,
    height,
    sheets: ["tiles"],
    ground: new Array<TileId>(width * height).fill(TILE),
    events,
    ...(passage ? { passage } : {}),
  };
}

function project(
  maps: MapDef[],
  start: Project["start"] = { map: "a", x: 2, y: 2, dir: "down" },
): Project {
  return {
    format: "rpgkit-project/v1",
    title: "KM1-DIFF",
    tileSize: 16,
    start,
    sheets: [{ id: "tiles", pak: "chunks", cols: 1, rows: 1, defaultPassage: "pass" }],
    items: [],
    maps,
  };
}

function boot(p: Project, hz = 60): { session: Session; state: SessionState } {
  const session = createSession(p, hz);
  return { session, state: startSession(p, session) };
}

interface BootPair {
  legacy: { session: Session; state: SessionState };
  controlled: { session: Session; state: SessionState };
}

/** Boot the same project twice; force the controlled path on the second
 *  session by flipping the compiled world's gate flag (white-box: nothing
 *  else differs, so any state divergence is a path-equivalence bug). */
function dualBoot(p: Project, hz = 60): BootPair {
  const legacy = boot(p, hz);
  const controlled = boot(p, hz);
  for (const world of controlled.session.worlds.values()) {
    world.needsMovementControlPath = true;
  }
  return { legacy, controlled };
}

type StepInput = { buttons?: number; confirmEdge?: boolean };

function runScript(pair: BootPair, script: StepInput[]): void {
  let l = pair.legacy.state;
  let c = pair.controlled.state;
  for (let i = 0; i < script.length; i++) {
    const input = { buttons: 0, ...script[i]! };
    l = stepSession(pair.legacy.session, l, input);
    c = stepSession(pair.controlled.session, c, input);
    expect(JSON.stringify(c), `frame ${i}`).toBe(JSON.stringify(l));
  }
}

const hold = (buttons: number, frames: number): StepInput[] =>
  Array.from({ length: frames }, () => ({ buttons }));

const idle = (frames: number): StepInput[] => hold(0, frames);

test("player movement: walk, turn, bump the map edge, idle", () => {
  const pair = dualBoot(project([map("a", [])]));
  runScript(pair, [
    ...hold(BTN.RIGHT, 90),
    ...idle(30),
    ...hold(BTN.UP, 90),
    ...hold(BTN.LEFT, 90),
    ...hold(BTN.DOWN, 90),
    ...idle(30),
    // Walk off the right edge (x=9): bump, face right, no move.
    ...hold(BTN.RIGHT, 240),
    ...idle(30),
    ...hold(BTN.LEFT, 120),
  ]);
});

test("player movement matches when the controlled path is armed by an authored neutral default", () => {
  // moveSpeed 5 is the default grade: settings resolve to defaults, but the
  // compile-time capability bit arms the controlled path from tick 0.
  const armed = project([map("a", [event("marker", 0, 0, [
    page("action", [], { moveSpeed: 5 }),
  ])])]);
  const plain = project([map("a", [event("marker", 0, 0, [page("action", [])])])]);
  const pair: BootPair = { legacy: boot(plain), controlled: boot(armed) };
  expect(armed.maps[0]!.events![0]!.pages[0]!.moveSpeed).toBe(5);
  runScript(pair, [
    ...hold(BTN.DOWN, 60),
    ...idle(30),
    ...hold(BTN.RIGHT, 120),
    ...hold(BTN.UP, 120),
    ...idle(60),
  ]);
});

test("NPC patrol route: turns, waits, repeat, and blocked skippable release", () => {
  const patrol = event("patrol", 6, 1, [page("parallel", [], {
    moveRoute: {
      steps: ["moveRight", "moveDown", "faceLeft", "wait", "moveUp", "faceRight"],
      repeat: true,
      skippable: false,
    },
  })]);
  // A one-shot skippable route that runs into a blocking static NPC: the
  // route must release identically on both paths.
  const blocker = event("blocker", 9, 5, [page("parallel", [], { blocks: true })]);
  const skipper = event("skipper", 7, 5, [page("parallel", [], {
    moveRoute: { steps: ["moveRight", "moveRight", "moveRight"], repeat: false, skippable: true },
  })]);
  const pair = dualBoot(project([map("a", [patrol, blocker, skipper])]));
  runScript(pair, [
    ...idle(600),
    ...hold(BTN.RIGHT, 120),
    ...idle(600),
  ]);
});

test("NPC random motion consumes the session RNG identically", () => {
  const wanderer = event("wanderer", 4, 4, [page("parallel", [], { moveType: "random" })]);
  const pair = dualBoot(project([map("a", [wanderer])]));
  runScript(pair, [
    ...idle(900),
    ...hold(BTN.LEFT, 120),
    ...idle(900),
  ]);
});

test("NPC approach motion steps toward the player identically", () => {
  const chaser = event("chaser", 4, 4, [page("parallel", [], { moveType: "approach" })]);
  const pair = dualBoot(project([map("a", [chaser])]));
  runScript(pair, [
    // Player walks to within approach sight, loiters, leaves.
    ...hold(BTN.RIGHT, 60),
    ...idle(600),
    ...hold(BTN.DOWN, 60),
    ...idle(600),
    ...hold(BTN.LEFT, 240),
    ...idle(600),
  ]);
});

test("blocks: the player bumps a blocking NPC and NPCs block each other", () => {
  const wall = event("wall", 4, 2, [page("parallel", [], { blocks: true })]);
  const other = event("other", 4, 3, [page("parallel", [], { moveType: "random" })]);
  const pair = dualBoot(project([map("a", [wall, other])]));
  runScript(pair, [
    // Player at (2,2) walks right into the wall at (4,2).
    ...hold(BTN.RIGHT, 300),
    ...idle(120),
    ...hold(BTN.DOWN, 120),
    ...idle(600),
  ]);
});

test("blocks: the player cannot enter a moving NPC's destination cell", () => {
  // The patrol NPC shuttles (4,4) <-> (5,4). The player walks down from
  // (5,2): its second step targets (5,4) while the NPC is still moving into
  // it, so the moving-destination overlay cell must block on both paths.
  const mover = event("mover", 4, 4, [page("parallel", [], {
    blocks: true,
    moveRoute: { steps: ["moveRight", "moveLeft"], repeat: true, skippable: false },
  })]);
  const pair = dualBoot(project([map("a", [mover])], { map: "a", x: 5, y: 2, dir: "down" }));
  runScript(pair, [
    ...hold(BTN.DOWN, 240),
    ...idle(120),
    ...hold(BTN.UP, 240),
    ...idle(120),
    ...hold(BTN.DOWN, 240),
    ...idle(300),
  ]);
});

test("cross-map transfer keeps both paths in lockstep", () => {
  const controller = event("porter", 2, 3, [page("action", [
    { op: "transfer", map: "b", x: 3, y: 3, dir: "down" },
  ])]);
  const maps = [
    map("a", [controller]),
    map("b", [
      event("wanderer", 6, 6, [page("parallel", [], { moveType: "random" })]),
      event("patrol", 1, 1, [page("parallel", [], {
        moveRoute: { steps: ["moveRight", "moveDown"], repeat: true, skippable: false },
      })]),
    ]),
  ];
  const pair = dualBoot(project(maps));
  runScript(pair, [
    ...idle(30),
    { confirmEdge: true },
    ...idle(60),
    ...hold(BTN.RIGHT, 120),
    ...idle(600),
    ...hold(BTN.UP, 120),
    ...idle(300),
  ]);
});
