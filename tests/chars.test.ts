// tests/rpgkit-chars.test.ts — P1④ character motion reducer
// (engine/chars.ts): patrol routes, random/approach autonomy, collision
// against the player and other characters, forced routes with waiters, and
// page-switch teardown. Pure reducer tests: no host, no clock.

import { describe, expect, test } from "bun:test";
import {
  createChars,
  installRoute,
  stepChars,
  syncPages,
  charBlocksPlayer,
  APPROACH_SIGHT,
  type CharsState,
} from "../src/engine/chars.ts";
import { createSwitchState } from "../src/engine/interpreter.ts";
import { buildPassage } from "../src/engine/passability.ts";
import type { Facing, GameEvent, MapDef, MoveRoute, Sheet } from "../src/engine/types.ts";

const CFG = { tile: 16, speed: 2 };
const STEP = 8;
const SHEET: Sheet = { id: "s", cols: 1, rows: 1, defaultPassage: "pass" };

function makeMap(events: GameEvent[], w = 12, h = 12): MapDef {
  return {
    id: "m",
    name: "m",
    width: w,
    height: h,
    sheets: ["s"],
    ground: new Array(w * h).fill("s.0"),
    events,
  };
}

function ev(id: string, x: number, y: number, extra: Partial<GameEvent["pages"][number]> = {}): GameEvent {
  return {
    id,
    x,
    y,
    pages: [{ trigger: "action", sprite: "a", blocks: true, commands: [], ...extra }],
  };
}

const route = (steps: MoveRoute["steps"], repeat = false): MoveRoute => ({
  steps,
  repeat,
  skippable: false,
});

function run(
  map: MapDef,
  chars0: CharsState,
  frames: number,
  player = { tx: 0, ty: 0, destX: 0, destY: 0 },
  locked = new Set<string>(),
): CharsState {
  const table = buildPassage(map, new Map([["s", SHEET]]));
  let chars = chars0;
  for (let i = 0; i < frames; i++) {
    const motion: Record<string, string> = {};
    for (const e of map.events ?? []) {
      const e0 = e;
      motion[e0.id] = e0.pages[0]!.moveType ?? "static";
    }
    chars = stepChars(chars, table, player, CFG, locked, motion as never).state;
  }
  return chars;
}

function synced(map: MapDef): CharsState {
  const r = syncPages(createChars(), map, createSwitchState(), CFG, new Set());
  return r.state;
}

describe("P1④ chars — patrol routes", () => {
  test("a static character never leaves its authored cell", () => {
    const map = makeMap([ev("npc", 5, 5)]);
    const end = run(map, synced(map), 100, { tx: 1, ty: 1, destX: 1, destY: 1 });
    expect([end.chars["npc"]!.tx, end.chars["npc"]!.ty]).toEqual([5, 5]);
  });

  test("a patrol walks two right, waits, faces up, returns, and loops", () => {
    const map = makeMap([
      ev("guard", 2, 2, {
        moveType: undefined,
        moveRoute: route(
          ["moveRight", "moveRight", "wait", "faceUp", "wait", "moveLeft", "moveLeft", "faceDown"],
          true,
        ),
      }),
    ]);
    let chars = synced(map);
    // One beat per command; moves take STEP frames, waits STEP frames,
    // faces one frame. Sample the first right step.
    chars = run(map, chars, STEP, { tx: 0, ty: 0, destX: 0, destY: 0 });
    expect([chars.chars["guard"]!.tx, chars.chars["guard"]!.ty]).toEqual([3, 2]);
    // second right step finishes at frame 16
    chars = run(map, chars, STEP, { tx: 0, ty: 0, destX: 0, destY: 0 });
    expect([chars.chars["guard"]!.tx, chars.chars["guard"]!.ty]).toEqual([4, 2]);
    // wait (8) + faceUp (1) + wait (8): guard at (4,2) facing up
    chars = run(map, chars, STEP + 1 + STEP, { tx: 0, ty: 0, destX: 0, destY: 0 });
    expect([chars.chars["guard"]!.tx, chars.chars["guard"]!.ty]).toEqual([4, 2]);
    expect(chars.chars["guard"]!.facing).toBe(2);
    // two lefts bring it home
    chars = run(map, chars, STEP * 2, { tx: 0, ty: 0, destX: 0, destY: 0 });
    expect([chars.chars["guard"]!.tx, chars.chars["guard"]!.ty]).toEqual([2, 2]);
  });

  test("a patrol is byte-identical across two runs", () => {
    const map = makeMap([
      ev("guard", 3, 3, { moveRoute: route(["moveRight", "wait", "moveDown", "wait"], true) }),
    ]);
    const a = run(map, synced(map), 200);
    const b = run(map, synced(map), 200);
    expect(b.chars).toEqual(a.chars);
  });
});

describe("P1④ chars — autonomous motion", () => {
  test("a random wanderer is driven by the seeded RNG and replays identically", () => {
    const map = makeMap([ev("boy", 6, 6, { moveType: "random" })], 20, 20);
    const a = run(map, synced(map), 400, { tx: 0, ty: 0, destX: 0, destY: 0 });
    const b = run(map, synced(map), 400, { tx: 0, ty: 0, destX: 0, destY: 0 });
    expect(b.chars).toEqual(a.chars);
    // 400 frames at ~one move per 16 frames: it left the start cell.
    expect([a.chars["boy"]!.tx, a.chars["boy"]!.ty]).not.toEqual([6, 6]);
    // Never left the map bounds.
    const c = a.chars["boy"]!;
    expect(c.tx).toBeGreaterThanOrEqual(0);
    expect(c.tx).toBeLessThan(20);
    expect(c.ty).toBeGreaterThanOrEqual(0);
    expect(c.ty).toBeLessThan(20);
  });

  test("an approach character walks toward the player inside sight and faces it when blocked", () => {
    // A vertical corridor with the NPC south of the player.
    const w = 3;
    const h = 12;
    const map: MapDef = {
      id: "m",
      name: "m",
      width: w,
      height: h,
      sheets: ["s"],
      ground: new Array(w * h).fill("s.0"),
      // walls on the side columns so approach can't detour wide
      passage: [],
      events: [ev("slime", 1, 10, { moveType: "approach" })],
    };
    for (let y = 0; y < h; y++) {
      map.passage!.push([y * w + 0, "block"], [y * w + 2, "block"]);
    }
    // player five tiles north, within APPROACH_SIGHT
    expect(Math.abs(1 - 1) + Math.abs(10 - 5)).toBeLessThanOrEqual(APPROACH_SIGHT);
    let chars = synced(map);
    chars = run(map, chars, STEP * 4, { tx: 1, ty: 5, destX: 1, destY: 5 });
    // four steps north: (1,10)->(1,6), one short of the player at (1,5)
    expect([chars.chars["slime"]!.tx, chars.chars["slime"]!.ty]).toEqual([1, 6]);
    // it must never enter the player's tile
    chars = run(map, chars, STEP * 4, { tx: 1, ty: 5, destX: 1, destY: 5 });
    expect([chars.chars["slime"]!.tx, chars.chars["slime"]!.ty]).toEqual([1, 6]);
    expect(chars.chars["slime"]!.facing).toBe(2); // faces up toward player
  });

  test("approach does not move when the player is beyond sight", () => {
    const map = makeMap([ev("slime", 1, 1, { moveType: "approach" })], 20, 20);
    const end = run(map, synced(map), 100, { tx: 11, ty: 11, destX: 11, destY: 11 });
    expect([end.chars["slime"]!.tx, end.chars["slime"]!.ty]).toEqual([1, 1]);
  });
});

describe("P1④ chars — collision and exclusion", () => {
  test("a blocking character keeps the player out of its cell and step target", () => {
    const map = makeMap([ev("npc", 5, 5)]);
    const chars = synced(map);
    expect(charBlocksPlayer(chars.chars["npc"]!, 5, 5)).toBe(true);
    expect(charBlocksPlayer(chars.chars["npc"]!, 5, 6)).toBe(false);
    // a below-character (sprite null, blocks false) still has a char (a
    // route may move it) but it is invisible and never blocks the player.
    const map2 = makeMap([ev("sign", 5, 5, { blocks: false, sprite: null })]);
    const chars2 = synced(map2);
    expect(chars2.chars["sign"]!.visible).toBe(false);
    expect(charBlocksPlayer(chars2.chars["sign"]!, 5, 5)).toBe(false);
  });

  test("two characters can never occupy the same cell", () => {
    // Two NPCs on row 5: a walker at (3,5) moving right into a static at (5,5);
    // it must stop at (4,5).
    const map = makeMap([
      ev("a", 3, 5, { moveRoute: route(["moveRight"], false) }),
      ev("b", 5, 5),
    ]);
    let chars = synced(map);
    // first step lands (4,5); the next right into (5,5) is occupied and
    // (repeat:false) the one-step route ends. Run long enough to retry.
    chars = run(map, chars, STEP * 6, { tx: 0, ty: 0, destX: 0, destY: 0 });
    expect([chars.chars["a"]!.tx, chars.chars["a"]!.ty]).toEqual([4, 5]);
    expect([chars.chars["b"]!.tx, chars.chars["b"]!.ty]).toEqual([5, 5]);
  });

  test("a character walks over a blocks:false event; a blocks:true body still stops it", () => {
    // Row 5: a patrol heading right from (2,5) crosses a sprite-less marker
    // (blocks:false, the player walks over it too) at (3,5) and stops
    // against the blocking NPC at (6,5).
    const map = makeMap([
      ev("walker", 2, 5, { moveRoute: route(["moveRight"], true) }),
      ev("marker", 3, 5, { blocks: false, sprite: null }),
      ev("wall", 6, 5),
    ]);
    const end = run(map, synced(map), STEP * 8, { tx: 0, ty: 0, destX: 0, destY: 0 });
    expect([end.chars["walker"]!.tx, end.chars["walker"]!.ty]).toEqual([5, 5]);
    expect([end.chars["marker"]!.tx, end.chars["marker"]!.ty]).toEqual([3, 5]);
    expect([end.chars["wall"]!.tx, end.chars["wall"]!.ty]).toEqual([6, 5]);
  });

  test("a waited non-skippable route through a blocks:false event lands and releases its waiter", () => {
    // A cutscene walks an NPC north over a sprite-less transfer marker. A
    // non-skippable route blocked by the marker would retry forever and
    // hold its waiting fiber (and any input lock) for good.
    const map = makeMap([
      ev("kyle", 4, 4),
      ev("portal", 4, 3, { trigger: "playerTouch", blocks: false, sprite: null }),
    ]);
    const table = buildPassage(map, new Map([["s", SHEET]]));
    let chars = installRoute(synced(map), "kyle", route(["moveUp", "moveUp"]), "m/scene", CFG).state;
    let finished: string[] = [];
    for (let i = 0; i < STEP * 3; i++) {
      const r = stepChars(chars, table, { tx: 0, ty: 0, destX: 0, destY: 0 }, CFG, new Set(), {} as never);
      chars = r.state;
      finished = finished.concat(r.finishedWaiters);
    }
    expect([chars.chars["kyle"]!.tx, chars.chars["kyle"]!.ty]).toEqual([4, 2]);
    expect(finished).toEqual(["m/scene"]);
  });

  test("a pathTo search crosses a blocks:false event in a one-tile corridor", () => {
    // Row 1 is the only open row; the marker at (3,1) sits in it.
    const blocked: [number, "block"][] = [];
    for (let x = 0; x < 7; x++) blocked.push([x, "block"], [14 + x, "block"]);
    const map: MapDef = {
      ...makeMap([
        ev("walker", 0, 1),
        ev("marker", 3, 1, { blocks: false, sprite: null }),
      ], 7, 3),
      passage: blocked,
    };
    const table = buildPassage(map, new Map([["s", SHEET]]));
    const walk: MoveRoute = { steps: [{ pathTo: { x: 6, y: 1, retries: 0 } }], repeat: false, skippable: false };
    let chars = installRoute(synced(map), "walker", walk, "m/scene", CFG).state;
    let finished: string[] = [];
    for (let i = 0; i < STEP * 8; i++) {
      const r = stepChars(chars, table, { tx: 0, ty: 0, destX: 0, destY: 0 }, CFG, new Set(), {} as never);
      chars = r.state;
      finished = finished.concat(r.finishedWaiters);
    }
    expect([chars.chars["walker"]!.tx, chars.chars["walker"]!.ty]).toEqual([6, 1]);
    expect(finished).toEqual(["m/scene"]);
  });

  test("a blocks:true body in the same corridor still stops the search", () => {
    const blocked: [number, "block"][] = [];
    for (let x = 0; x < 7; x++) blocked.push([x, "block"], [14 + x, "block"]);
    const map: MapDef = {
      ...makeMap([ev("walker", 0, 1), ev("guard", 3, 1)], 7, 3),
      passage: blocked,
    };
    const table = buildPassage(map, new Map([["s", SHEET]]));
    const walk: MoveRoute = { steps: [{ pathTo: { x: 6, y: 1, retries: 0 } }], repeat: false, skippable: false };
    let chars = installRoute(synced(map), "walker", walk, "m/scene", CFG).state;
    let finished: string[] = [];
    for (let i = 0; i < STEP * 8; i++) {
      const r = stepChars(chars, table, { tx: 0, ty: 0, destX: 0, destY: 0 }, CFG, new Set(), {} as never);
      chars = r.state;
      finished = finished.concat(r.finishedWaiters);
    }
    // No path while the guard stands in the corridor: the retry budget
    // (0) runs out and the route ends where it started.
    expect([chars.chars["walker"]!.tx, chars.chars["walker"]!.ty]).toEqual([0, 1]);
    expect(finished).toEqual(["m/scene"]);
  });
});

describe("P1④ chars — forced routes and waiters", () => {
  test("a waited forced route reports the waiter when the last step lands", () => {
    const map = makeMap([ev("porter", 4, 4)]);
    const table = buildPassage(map, new Map([["s", SHEET]]));
    let chars = synced(map);
    const installed = installRoute(
      chars,
      "porter",
      route(["moveUp", "moveUp"]),
      "m/porter",
      CFG,
    );
    chars = installed.state;
    const motion = { porter: "static" } as never;
    let finished: string[] = [];
    for (let i = 0; i < STEP * 2; i++) {
      const r = stepChars(chars, table, { tx: 0, ty: 0, destX: 0, destY: 0 }, CFG, new Set(), motion);
      chars = r.state;
      finished = finished.concat(r.finishedWaiters);
    }
    expect([chars.chars["porter"]!.tx, chars.chars["porter"]!.ty]).toEqual([4, 2]);
    expect(finished).toContain("m/porter");
    expect(chars.chars["porter"]!.route).toBeNull();
  });

  test("a skippable route blocked immediately releases the waiter", () => {
    // moveUp from the top-left corner (0,0) leaves the map, so canEnter
    // blocks and the skippable route gives up on the first frame.
    const map = makeMap([ev("porter", 0, 0)]);
    const table = buildPassage(map, new Map([["s", SHEET]]));
    let chars = synced(map);
    const blocked: MoveRoute = { steps: ["moveUp"], repeat: false, skippable: true };
    chars = installRoute(chars, "porter", blocked, "m/porter", CFG).state;
    const r = stepChars(chars, table, { tx: 9, ty: 9, destX: 9, destY: 9 }, CFG, new Set(), {
      porter: "static",
    } as never);
    expect(r.finishedWaiters).toContain("m/porter");
    expect(r.state.chars["porter"]!.route).toBeNull();
  });

  test("a page switch aborts the forced route and reports the waiter", () => {
    const map = makeMap([ev("porter", 4, 4)]);
    // install a running route, then sync against a switch state where the
    // event still exists (page index changed by adding a gated page 0).
    let chars = synced(map);
    chars = installRoute(chars, "porter", route(["moveUp", "moveUp"]), "m/porter", CFG).state;
    const switched: GameEvent = {
      ...map.events![0]!,
      pages: [
        { trigger: "action", sprite: "a", blocks: true, commands: [], condition: { switch: "x" } },
        { trigger: "action", sprite: "a", blocks: true, commands: [] },
      ],
    };
    const map2 = makeMap([switched]);
    const sw = createSwitchState({ switches: { x: true } });
    const r = syncPages(chars, map2, sw, CFG, new Set());
    expect(r.result.abortedWaiters).toContain("m/porter");
    expect(r.state.chars["porter"]!.route).toBeNull();
  });

  test("a locked character freezes for its interaction but its forced route continues", () => {
    // Autonomous random NPC locked for a dialog: no motion.
    const map = makeMap([ev("boy", 6, 6, { moveType: "random" })], 20, 20);
    const locked = run(
      map,
      synced(map),
      200,
      { tx: 0, ty: 0, destX: 0, destY: 0 },
      new Set(["boy"]),
    );
    expect([locked.chars["boy"]!.tx, locked.chars["boy"]!.ty]).toEqual([6, 6]);
  });
});

describe("P1④-fix — a route step checks the cell in the step direction (R5)", () => {
  const dirSheet: Sheet = {
    id: "s", cols: 12, rows: 11, defaultPassage: "pass",
    dirBlock: { "1": ["right"] },
  };
  const groundAt = (w: number, h: number, cell: number): MapDef["ground"] =>
    Array.from({ length: w * h }, (_, i) => (i === cell ? "s.1" : "s.0"));

  test("moveRight out of a cell that forbids the right exit is refused", () => {
    const map: MapDef = {
      id: "m", name: "m", width: 9, height: 9, sheets: ["s"],
      // The blocking tile is under the character's OWN (source) cell.
      ground: groundAt(9, 9, 3 * 9 + 3),
      events: [ev("mover", 3, 3, { moveRoute: route(["moveRight"], true) })],
    };
    const table = buildPassage(map, new Map([["s", dirSheet]]));
    const synced0 = syncPages(createChars(), map, createSwitchState(), CFG, new Set()).state;
    // The character starts facing DOWN; the lookup must use the STEP
    // direction (right) for the source cell's exit mask, not the old facing.
    expect(synced0.chars["mover"]!.facing).toBe(0);
    const end = (() => {
      let chars = synced0;
      for (let i = 0; i < STEP; i++) {
        chars = stepChars(chars, table, { tx: 0, ty: 0, destX: 0, destY: 0 }, CFG, new Set(), { mover: "static" }).state;
      }
      return chars;
    })();
    expect([end.chars["mover"]!.tx, end.chars["mover"]!.ty]).toEqual([3, 3]);
    expect(end.chars["mover"]!.facing).toBe(3); // turned to face the refused direction
  });

  test("the right-blocked cell is enterable from the left through a cell that allows the exit", () => {
    const map: MapDef = {
      id: "m", name: "m", width: 9, height: 9, sheets: ["s"],
      ground: groundAt(9, 9, 3 * 9 + 4), // (4,3): s.1 forbids only its own right exit
      events: [ev("mover", 3, 3, { moveRoute: route(["moveRight", "moveUp"], false) })],
    };
    const table = buildPassage(map, new Map([["s", dirSheet]]));
    let chars = syncPages(createChars(), map, createSwitchState(), CFG, new Set()).state;
    // First moveRight: source (3,3)=s.0 allows right, target (4,3)=s.1 is
    // enterable (its right-exit mask governs LEAVING it, not entering it).
    for (let i = 0; i < STEP * 2; i++) {
      chars = stepChars(chars, table, { tx: 0, ty: 0, destX: 0, destY: 0 }, CFG, new Set(), { mover: "static" }).state;
    }
    expect([chars.chars["mover"]!.tx, chars.chars["mover"]!.ty]).toEqual([4, 2]);
  });

  test("moveRight into a cell that seals its OWN left edge is refused (destination reverse edge)", () => {
    const entrySheet: Sheet = {
      id: "s", cols: 12, rows: 11, defaultPassage: "pass",
      dirBlock: { "1": ["left"] },
    };
    const map: MapDef = {
      id: "m", name: "m", width: 9, height: 9, sheets: ["s"],
      ground: groundAt(9, 9, 3 * 9 + 4),
      events: [ev("mover", 3, 3, { moveRoute: route(["moveRight", "moveUp"], false) })],
    };
    const table = buildPassage(map, new Map([["s", entrySheet]]));
    let chars = syncPages(createChars(), map, createSwitchState(), CFG, new Set()).state;
    for (let tick = 0; tick < STEP * 2; tick++) {
      chars = stepChars(chars, table, { tx: 0, ty: 0, destX: 0, destY: 0 }, CFG, new Set(), { mover: "static" }).state;
    }
    expect([chars.chars.mover!.tx, chars.chars.mover!.ty]).toEqual([3, 3]);
    expect(chars.chars.mover!.facing).toBe(3);
  });

  test("moveUp out of an up-blocked source cell is refused even when pre-facing right", () => {
    const sheet: Sheet = { id: "s", cols: 12, rows: 11, defaultPassage: "pass", dirBlock: { "1": ["up"] } };
    const map: MapDef = {
      id: "m", name: "m", width: 9, height: 9, sheets: ["s"],
      ground: groundAt(9, 9, 3 * 9 + 3), // source (3,3)=s.1 forbids the up exit
      events: [ev("mover", 3, 3, { moveRoute: route(["moveUp"], true) })],
    };
    const table = buildPassage(map, new Map([["s", sheet]]));
    let chars = syncPages(createChars(), map, createSwitchState(), CFG, new Set()).state;
    // Assign through a Facing-typed parameter so the property is not
    // narrowed to the literal type 3 (which made .toBe(2) a TS2769).
    const preface = (facing: Facing): void => {
      chars.chars["mover"]!.facing = facing;
    };
    preface(3); // pre-turn orientation: right
    for (let i = 0; i < STEP; i++) {
      chars = stepChars(chars, table, { tx: 0, ty: 0, destX: 0, destY: 0 }, CFG, new Set(), { mover: "static" }).state;
    }
    expect([chars.chars["mover"]!.tx, chars.chars["mover"]!.ty]).toEqual([3, 3]);
    expect(chars.chars["mover"]!.facing).toBe(2);
  });
});

describe("P1④-fix — a forced route restores the page patrol afterward (R3)", () => {
  test("the patrol is reinstalled when a waited forced route lands", () => {
    const map = makeMap([
      ev("guard", 3, 3, { moveRoute: route(["moveRight", "wait", "moveLeft", "wait"], true) }),
    ]);
    const table = buildPassage(map, new Map([["s", SHEET]]));
    let chars = synced(map);
    // Action installs a one-step forced route down to (3,4).
    chars = installRoute(chars, "guard", route(["moveDown"]), "m/guard", CFG).state;
    const motion = { guard: "static" } as never;
    let finished: string[] = [];
    for (let i = 0; i < STEP; i++) {
      const r = stepChars(chars, table, { tx: 0, ty: 0, destX: 0, destY: 0 }, CFG, new Set(), motion);
      chars = r.state;
      finished = finished.concat(r.finishedWaiters);
    }
    expect(finished).toContain("m/guard");
    const g = chars.chars["guard"]!;
    expect([g.tx, g.ty]).toEqual([3, 4]);
    expect(g.route?.patrol).toBe(true); // patrol is back, not a null route
    expect(g.route?.pc).toBe(0); // restored from the first command
  });

  test("the restored patrol runs from the character's current cell", () => {
    const map = makeMap([
      ev("guard", 3, 3, { moveRoute: route(["moveRight", "wait", "moveLeft", "wait"], true) }),
    ]);
    const table = buildPassage(map, new Map([["s", SHEET]]));
    let chars = synced(map);
    // Advance the patrol one command (first moveRight lands at (4,3),
    // pc becomes 1), then force a moveDown.
    const motion = { guard: "static" } as never;
    for (let i = 0; i < STEP; i++) {
      chars = stepChars(chars, table, { tx: 0, ty: 0, destX: 0, destY: 0 }, CFG, new Set(), motion).state;
    }
    expect([chars.chars["guard"]!.tx, chars.chars["guard"]!.ty]).toEqual([4, 3]);
    expect(chars.chars["guard"]!.route?.pc).toBe(1);
    chars = installRoute(chars, "guard", route(["moveDown"]), null, CFG).state;
    for (let i = 0; i < STEP; i++) {
      chars = stepChars(chars, table, { tx: 0, ty: 0, destX: 0, destY: 0 }, CFG, new Set(), motion).state;
    }
    // Forced route landed at (4,4); the restored patrol restarts at pc 0,
    // so its next moveRight takes the guard to (5,4) one step later.
    expect(chars.chars["guard"]!.route?.patrol).toBe(true);
    expect(chars.chars["guard"]!.route?.pc).toBe(0);
    for (let i = 0; i < STEP; i++) {
      chars = stepChars(chars, table, { tx: 0, ty: 0, destX: 0, destY: 0 }, CFG, new Set(), motion).state;
    }
    expect([chars.chars["guard"]!.tx, chars.chars["guard"]!.ty]).toEqual([5, 4]);
  });
});

describe("I1-fix2 — char motion folds fixed reference ticks", () => {
  const PLAYER_FAR = { tx: 0, ty: 0, destX: 0, destY: 0 };

  function tick(map: MapDef, chars: CharsState): CharsState {
    const table = buildPassage(map, new Map([["s", SHEET]]));
    const motion = Object.fromEntries(
      (map.events ?? []).map((event) => [event.id, event.pages[0]!.moveType ?? "static"]),
    );
    return stepChars(chars, table, PLAYER_FAR, CFG, new Set(), motion as never).state;
  }

  test("sixty reference ticks reach the expected patrol phase", () => {
    const map = makeMap([ev("patrol", 10, 4, { moveRoute: route([
      ...Array(8).fill("moveRight"),
      ...Array(8).fill("moveLeft"),
      "wait", "faceUp", "faceDown",
    ], true) })], 40, 12);
    let chars = synced(map);
    for (let i = 0; i < 60; i++) chars = tick(map, chars);
    expect(chars.chars.patrol).toMatchObject({
      tx: 17, px: 280, facing: 3, phase: 4, moving: true,
      route: { pc: 8, waitLeft: 0 },
    });
  });

  test("a fresh character advances on every reference tick of its creation frame", () => {
    // The current session architecture syncs pages inside each fixed-rate
    // tick. This supersedes task 1376's host-frame `started` set: a 4 Hz
    // creation frame consumes the same fifteen ticks as fifteen 60 Hz frames.
    const map = makeMap([ev("npc", 3, 3, { moveRoute: route(["moveRight", "moveRight"], true) })]);
    let chars = synced(map);
    for (let referenceTick = 0; referenceTick < 15; referenceTick++) chars = tick(map, chars);
    expect(chars.chars.npc).toMatchObject({
      tx: 4, px: 78, facing: 3, phase: 7, moving: true,
      route: { pc: 0, waitLeft: 0 },
    });
  });

  test("a newly synced character moves on its first fixed reference tick", () => {
    const map = makeMap([ev("npc", 3, 3, { moveRoute: route(["moveRight"], true) })]);
    const moved = tick(map, synced(map)).chars.npc!;
    expect(moved.phase).toBe(1);
    expect(moved.px).toBe(50);
  });

  test("autonomous random NPCs advance to a pinned seeded state", () => {
    const map = makeMap([ev("boy", 6, 6, { moveType: "random" })]);
    let chars = synced(map);
    for (let tickIndex = 0; tickIndex < 60; tickIndex++) chars = tick(map, chars);
    expect(chars.rng).toBe(1300342532);
    expect(chars.chars.boy).toMatchObject({
      tx: 7, ty: 8, px: 112, py: 128, facing: 0, phase: 0,
      moving: false, thinkIn: 13, route: null,
    });
  });
});

describe("character reducer purity", () => {
  test("a page-switch patrol template is detached by default", () => {
    const npc: GameEvent = {
      id: "npc",
      x: 3,
      y: 3,
      pages: [
        {
          trigger: "action",
          sprite: "a",
          blocks: true,
          moveRoute: route(["moveLeft"], true),
          commands: [],
        },
        {
          condition: { switch: "second-page" },
          trigger: "action",
          sprite: "a",
          blocks: true,
          moveRoute: route(["moveRight", "wait"], true),
          commands: [],
        },
      ],
    };
    const map = makeMap([npc]);
    const first = synced(map);
    const switched = syncPages(
      first,
      map,
      createSwitchState({ switches: { "second-page": true } }),
      CFG,
      new Set(),
    ).state;
    const current = switched.chars.npc!;

    expect(current.pageIndex).toBe(1);
    expect(current.route).not.toBe(current.patrol);
    current.route!.pc = 1;
    expect(current.patrol!.pc).toBe(0);
  });

  test("advancing an active route never mutates retained input states", () => {
    const map = makeMap([ev("npc", 3, 3, {
      moveRoute: route(["moveRight", "wait", "moveLeft"], true),
    })]);
    const table = buildPassage(map, new Map([["s", SHEET]]));
    const motion = { npc: "static" } as const;
    const playerFar = { tx: 0, ty: 0, destX: 0, destY: 0 };
    const retained: Array<{ state: CharsState; json: string }> = [];
    let chars = synced(map);

    for (let tickIndex = 0; tickIndex < 40; tickIndex++) {
      retained.push({ state: chars, json: JSON.stringify(chars) });
      chars = stepChars(chars, table, playerFar, CFG, new Set(), motion).state;
      for (const previous of retained.slice(-4)) {
        expect(JSON.stringify(previous.state)).toBe(previous.json);
      }
    }
  });
});
