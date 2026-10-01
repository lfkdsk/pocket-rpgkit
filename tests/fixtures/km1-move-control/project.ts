// Built KM1 fixture: every coloured actor is driven by the real session
// reducer. Two red blocking cells prove that through applies equally to the
// player and a route-controlled event; the magenta actor proves runtime
// wander remains deterministic.

import type { Command, GameEvent, MapDef, Page, Project, TileId } from "../../../src/engine/types.ts";

const TILE = "plain.0" as TileId;
const WIDTH = 30;
const HEIGHT = 17;

const page = (trigger: Page["trigger"], commands: Command[], extra: Partial<Page> = {}): Page => ({
  trigger,
  sprite: null,
  commands,
  ...extra,
});

const event = (id: string, x: number, y: number, pages: Page[]): GameEvent => ({ id, x, y, pages });

export function buildKm1Project(): Project {
  const driver = event("driver", 0, 0, [
    page("autorun", [
      { op: "moveControl", target: "player", control: { kind: "speed", value: 6 } },
      { op: "moveControl", target: "player", control: { kind: "through", value: true } },
      { op: "moveControl", target: "player", control: { kind: "directionFix", value: true } },
      { op: "moveControl", target: { event: "wanderer" }, control: { kind: "speed", value: 6 } },
      {
        op: "moveControl",
        target: { event: "wanderer" },
        control: { kind: "wander", bounds: { x: 7, y: 3, width: 3, height: 3 }, frequency: 5 },
      },
      {
        op: "moveRoute",
        target: { event: "runner" },
        wait: false,
        route: {
          steps: [
            { control: { kind: "speed", value: 6 } },
            { control: { kind: "through", value: true } },
            { control: { kind: "facingMode", value: "locked" } },
            "moveRight",
          ],
          repeat: false,
          skippable: false,
        },
      },
      { op: "selfSwitch", key: "A", value: true },
    ]),
    page("parallel", [], { condition: { selfSwitch: "A" } }),
  ]);

  const events = [
    driver,
    event("player-blocker", 3, 2, [page("action", [], { blocks: true })]),
    event("runner", 2, 6, [page("action", [], { dir: "down" })]),
    event("runner-blocker", 3, 6, [page("action", [], { blocks: true })]),
    event("wanderer", 8, 4, [page("action", [], { dir: "down" })]),
  ];
  const map: MapDef = {
    id: "field",
    name: "Runtime movement controls",
    width: WIDTH,
    height: HEIGHT,
    sheets: ["plain"],
    ground: new Array<TileId>(WIDTH * HEIGHT).fill(TILE),
    passage: [
      [2 * WIDTH + 3, "block"],
      [6 * WIDTH + 3, "block"],
    ],
    events,
  };
  return {
    format: "rpgkit-project/v1",
    title: "KM1 runtime movement controls",
    tileSize: 16,
    start: { map: "field", x: 2, y: 2, dir: "down" },
    sheets: [{ id: "plain", pak: "chunks", cols: 1, rows: 1, defaultPassage: "pass" }],
    items: [],
    maps: [map],
  };
}
