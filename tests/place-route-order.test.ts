// tests/place-route-order.test.ts — same-tick `place` + `moveRoute` order
//
// A `place` and the routes a fiber publishes after it on the same reference
// tick must apply in command order: the placement cancels only routes that
// were running (or queued) before it, never the ones queued after it.

import { describe, expect, test } from "bun:test";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import type { Command, GameEvent, MapDef, MoveRoute, Page, Project, TileId } from "../src/engine/types.ts";

const GRASS: TileId = "town.0";

function project(events: GameEvent[]): Project {
  const w = 12;
  const h = 12;
  const map: MapDef = {
    id: "a", name: "a", width: w, height: h, sheets: ["town"],
    ground: new Array(w * h).fill(GRASS), events,
  };
  return {
    format: "rpgkit-project/v1", title: "t", tileSize: 16,
    start: { map: "a", x: 2, y: 2, dir: "up" },
    sheets: [{ id: "town", cols: 12, rows: 11, defaultPassage: "pass" }],
    items: [],
    maps: [map],
  };
}
function pg(trigger: Page["trigger"], commands: Command[], extra: Partial<Page> = {}): Page {
  return { trigger, sprite: null, commands, ...extra };
}
/** An autorun that runs `commands` once, then sets `done`. */
function once(commands: Command[]): GameEvent {
  return {
    id: "director", x: 0, y: 0,
    pages: [pg("autorun", [...commands, { op: "switch", id: "done", value: true }], {
      condition: { all: [{ kind: "switch", id: "done", value: false }] },
    })],
  };
}
function run(p: Project, n: number, hz?: number): { sess: Session; s: SessionState } {
  const sess = createSession(p, hz);
  let s = startSession(p, sess);
  for (let k = 0; k < n; k++) s = stepSession(sess, s, { buttons: 0 });
  return { sess, s };
}
const cell = (s: SessionState, id: string) => [s.chars.chars[id]?.tx, s.chars.chars[id]?.ty];

const NPC: GameEvent = { id: "npc", x: 8, y: 8, pages: [pg("action", [])] };
const right2: MoveRoute = { steps: ["moveRight", "moveRight"], repeat: false, skippable: false };

describe("same-tick place then moveRoute", () => {
  test("an NPC route queued after its placement walks from the placed cell", () => {
    const p = project([NPC, once([
      { op: "place", target: { event: "npc" }, x: 3, y: 5 },
      { op: "moveRoute", target: { event: "npc" }, wait: true, route: right2 },
    ])]);
    const { s } = run(p, 60);
    expect(cell(s, "npc")).toEqual([5, 5]);
    expect(s.sw.switches["done"]).toBe(true);
  });

  test("a waited NPC route keeps its waiter parked until the walk ends", () => {
    const p = project([NPC, once([
      { op: "place", target: { event: "npc" }, x: 3, y: 5 },
      { op: "moveRoute", target: { event: "npc" }, wait: true, route: right2 },
    ])]);
    const { s } = run(p, 4);
    expect(s.sw.switches["done"] ?? false).toBe(false);
  });

  test("a face route queued after an NPC placement turns the placed character", () => {
    const p = project([NPC, once([
      { op: "place", target: { event: "npc" }, x: 3, y: 5, dir: "up" },
      { op: "moveRoute", target: { event: "npc" }, wait: false,
        route: { steps: ["faceLeft"], repeat: false, skippable: true } },
    ])]);
    const { s } = run(p, 10);
    expect(cell(s, "npc")).toEqual([3, 5]);
    expect(s.chars.chars["npc"]?.facing).toBe(1);
  });

  test("a player face queued after a player placement is kept", () => {
    const p = project([once([
      { op: "place", target: "player", x: 6, y: 6, dir: "down" },
      { op: "moveRoute", target: "player", wait: false,
        route: { steps: ["faceLeft"], repeat: false, skippable: true } },
    ])]);
    const { s } = run(p, 10);
    expect([s.move.tx, s.move.ty]).toEqual([6, 6]);
    expect(s.move.facing).toBe(1);
  });

  test("a waited player route queued after a player placement walks from the placed cell", () => {
    const p = project([once([
      { op: "place", target: "player", x: 6, y: 6, dir: "down" },
      { op: "moveRoute", target: "player", wait: true, route: right2 },
    ])]);
    const { s } = run(p, 60);
    expect([s.move.tx, s.move.ty]).toEqual([8, 6]);
    expect(s.sw.switches["done"]).toBe(true);
  });

  test("a route queued before the placement is still canceled by it", () => {
    const p = project([NPC, once([
      { op: "moveRoute", target: { event: "npc" }, wait: false, route: right2 },
      { op: "place", target: { event: "npc" }, x: 3, y: 5 },
    ])]);
    const { s } = run(p, 60);
    expect(cell(s, "npc")).toEqual([3, 5]);
  });

  test("a spawn-then-place-then-route NPC (page switched this tick) still walks", () => {
    // The imported-NPC shape: an always-live empty page 0 and the visible
    // page 1 gated on a variable the same fiber sets before placing it.
    const npc: GameEvent = {
      id: "npc", x: 8, y: 8,
      pages: [
        pg("action", []),
        pg("action", [], { condition: { variable: { id: "here", op: "==", value: 1 } } }),
      ],
    };
    const p = project([npc, once([
      { op: "variable", id: "here", set: { op: "set", value: 1 } },
      { op: "place", target: { event: "npc" }, x: 3, y: 5 },
      { op: "moveRoute", target: { event: "npc" }, wait: true, route: right2 },
    ])]);
    const { s } = run(p, 60);
    expect(s.chars.chars["npc"]?.pageIndex).toBe(1);
    expect(cell(s, "npc")).toEqual([5, 5]);
    expect(s.sw.switches["done"]).toBe(true);
  });

  test("an event whose only page turns on this tick spawns placed and walks", () => {
    const npc: GameEvent = {
      id: "npc", x: 8, y: 8,
      pages: [pg("action", [], { condition: { variable: { id: "here", op: "==", value: 1 } } })],
    };
    const p = project([npc, once([
      { op: "variable", id: "here", set: { op: "set", value: 1 } },
      { op: "place", target: { event: "npc" }, x: 3, y: 5 },
      { op: "moveRoute", target: { event: "npc" }, wait: true, route: right2 },
    ])]);
    expect(run(p, 2).s.sw.switches["done"] ?? false).toBe(false);
    const { s } = run(p, 60);
    expect(cell(s, "npc")).toEqual([5, 5]);
    expect(s.sw.switches["done"]).toBe(true);
  });

  test("a route published before its target's page flips is still reset by the flip", () => {
    const pages = [
      pg("action", []),
      pg("action", [], { condition: { variable: { id: "here", op: ">=", value: 1 } } }),
      pg("action", [], { condition: { variable: { id: "here", op: ">=", value: 2 } } }),
    ];
    const before = project([{ id: "npc", x: 8, y: 8, pages }, once([
      { op: "moveRoute", target: { event: "npc" }, wait: false, route: right2 },
      { op: "variable", id: "here", set: { op: "set", value: 1 } },
    ])]);
    expect(cell(run(before, 60).s, "npc")).toEqual([8, 8]);
    // Published for page 1, but the same fold moves on to page 2.
    const between = project([{ id: "npc", x: 8, y: 8, pages }, once([
      { op: "variable", id: "here", set: { op: "set", value: 1 } },
      { op: "moveRoute", target: { event: "npc" }, wait: false, route: right2 },
      { op: "variable", id: "here", set: { op: "set", value: 2 } },
    ])]);
    const s = run(between, 60).s;
    expect(s.chars.chars["npc"]?.pageIndex).toBe(2);
    expect(cell(s, "npc")).toEqual([8, 8]);
  });

  test("place, route, place, route on one tick keeps only the last leg", () => {
    const p = project([NPC, once([
      { op: "place", target: { event: "npc" }, x: 3, y: 5 },
      { op: "moveRoute", target: { event: "npc" }, wait: false, route: right2 },
      { op: "place", target: { event: "npc" }, x: 3, y: 8 },
      { op: "moveRoute", target: { event: "npc" }, wait: false,
        route: { steps: ["moveUp"], repeat: false, skippable: false } },
    ])]);
    const { s } = run(p, 60);
    expect(cell(s, "npc")).toEqual([3, 7]);
  });
});

describe("same-tick place then moveRoute across host rates and replays", () => {
  const scene = (): Project => {
    const npc: GameEvent = {
      id: "npc", x: 8, y: 8,
      pages: [
        pg("action", []),
        pg("action", [], { condition: { variable: { id: "here", op: "==", value: 1 } } }),
      ],
    };
    return project([npc, once([
      { op: "variable", id: "here", set: { op: "set", value: 1 } },
      { op: "place", target: { event: "npc" }, x: 3, y: 5, dir: "up" },
      { op: "moveRoute", target: { event: "npc" }, wait: true, route: right2 },
      { op: "moveRoute", target: { event: "npc" }, wait: false,
        route: { steps: ["faceDown"], repeat: false, skippable: true } },
      { op: "place", target: "player", x: 6, y: 9, dir: "left" },
      { op: "moveRoute", target: "player", wait: true,
        route: { steps: ["moveUp", "faceRight"], repeat: false, skippable: false } },
    ])]);
  };
  const probe = (s: SessionState) => {
    const ch = s.chars.chars["npc"]!;
    return {
      npc: [ch.tx, ch.ty, ch.px, ch.py, ch.facing, ch.pageIndex],
      player: [s.move.tx, s.move.ty, s.move.px, s.move.py, s.move.facing],
      done: s.sw.switches["done"] ?? false,
    };
  };

  test("60, 30 and 20 Hz agree at every shared reference tick", () => {
    const trace = (hz: number) => {
      const per = 60 / hz;
      const sess = createSession(scene(), hz);
      let s = startSession(scene(), sess);
      const out: unknown[] = [];
      for (let tick = per; tick <= 120; tick += per) {
        s = stepSession(sess, s, { buttons: 0 });
        if (tick % 6 === 0) out.push(probe(s));
      }
      return out;
    };
    const at60 = trace(60);
    expect(trace(30)).toEqual(at60);
    expect(trace(20)).toEqual(at60);
    const last = at60.at(-1) as ReturnType<typeof probe>;
    expect(last.npc.slice(0, 2)).toEqual([5, 5]);
    expect(last.npc[4]).toBe(0);
    expect(last.player.slice(0, 2)).toEqual([6, 8]);
    expect(last.player[4]).toBe(3);
    expect(last.done).toBe(true);
  });

  test("replaying from the tick before the placement reproduces the run", () => {
    const sess = createSession(scene());
    let s = startSession(scene(), sess);
    const snap = s;
    for (let k = 0; k < 60; k++) s = stepSession(sess, s, { buttons: 0 });
    const first = probe(s);
    let again = snap;
    for (let k = 0; k < 60; k++) again = stepSession(sess, again, { buttons: 0 });
    expect(probe(again)).toEqual(first);
    expect(first.done).toBe(true);
  });
});
