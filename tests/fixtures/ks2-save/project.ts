// Scripted two-map project for the save tests and the save/load GameView
// fixture. On "plaza" a director's parallel page loops a scene: a
// fire-and-forget route walks the guard, a waited path search sends the
// courier across a map large enough that the BFS spans several reference
// ticks, the player is walked by a forced route with pauses, and after two
// loops a faded transfer moves to "yard". A patrol, a random wanderer and an
// approaching follower move on their own throughout.

import type { Command, GameEvent, MapDef, Page, Project, TileId } from "../../../src/engine/types.ts";

const TILE: TileId = "tiles.0";

const page = (trigger: Page["trigger"], commands: Command[], extra: Partial<Page> = {}): Page => ({
  trigger,
  sprite: "npc",
  commands,
  ...extra,
});

const event = (id: string, x: number, y: number, pages: Page[]): GameEvent => ({ id, x, y, pages });

function map(id: string, width: number, height: number, events: GameEvent[]): MapDef {
  return {
    id,
    name: id,
    width,
    height,
    sheets: ["tiles"],
    ground: new Array<TileId>(width * height).fill(TILE),
    events,
  };
}

export function scriptedProject(): Project {
  const director = event("director", 0, 0, [
    page("parallel", [
      {
        op: "moveRoute",
        target: { event: "guard" },
        wait: false,
        route: {
          steps: ["moveRight", "moveRight", "moveRight", "faceUp", "wait", "moveDown", "moveDown", "moveLeft", "moveLeft"],
          repeat: false,
          skippable: true,
        },
      },
      { op: "wait", seconds: 20 / 60 },
      {
        op: "moveRoute",
        target: { event: "courier" },
        wait: true,
        route: { steps: [{ pathTo: { x: 20, y: 14 } }, "faceLeft"], repeat: false, skippable: true },
      },
      {
        op: "moveRoute",
        target: "player",
        wait: false,
        route: { steps: ["moveRight", "wait", "wait", "wait", "moveDown", "wait", "moveLeft"], repeat: false, skippable: true },
      },
      { op: "wait", seconds: 50 / 60 },
      {
        op: "moveRoute",
        target: { event: "courier" },
        wait: true,
        route: { steps: [{ pathTo: { x: 3, y: 4 } }], repeat: false, skippable: true },
      },
      { op: "variable", id: "loops", set: { op: "add", value: 1 } },
      {
        op: "if",
        if: { kind: "variable", id: "loops", op: ">=", value: 2 },
        then: [{ op: "transfer", map: "yard", x: 4, y: 4, dir: "down", fade: 40 / 60 }],
      },
    ], { sprite: null }),
  ]);
  const plaza = map("plaza", 64, 40, [
    director,
    event("guard", 6, 6, [page("action", [], { blocks: true })]),
    event("courier", 3, 4, [page("action", [], { blocks: true })]),
    event("patrol", 12, 3, [page("action", [], {
      blocks: true,
      moveRoute: { steps: ["moveRight", "moveRight", "moveLeft", "moveLeft"], repeat: true, skippable: true },
    })]),
    event("wanderer", 20, 10, [page("action", [], { moveType: "random", blocks: true })]),
    event("follower", 9, 12, [page("action", [], { moveType: "approach", blocks: true })]),
  ]);
  const yard = map("yard", 16, 12, [
    event("keeper", 8, 6, [page("action", [], {
      blocks: true,
      moveRoute: { steps: ["moveUp", "moveDown"], repeat: true, skippable: true },
    })]),
    event("stray", 3, 8, [page("action", [], { moveType: "random", blocks: true })]),
  ]);
  return {
    format: "rpgkit-project/v1",
    title: "KS2",
    tileSize: 16,
    start: { map: "plaza", x: 4, y: 8, dir: "down" },
    sheets: [{ id: "tiles", pak: "chunks", cols: 1, rows: 1, defaultPassage: "pass" }],
    items: [],
    maps: [plaza, yard],
  };
}
