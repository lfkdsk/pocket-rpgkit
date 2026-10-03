// tests/fixtures/text-tokens/fixture-data.ts — the trivial map and the
// autorun event for the {x:} text-token fixture (tests/text-tokens-ui-sim.test.ts).
// The map is never walked: the autorun page opens a text box whose {x:}
// tokens the session resolver answers from the game's ext state, then an
// extChoice whose prompt carries one too.

import type { Command, GameEvent, MapDef, Project } from "../../../src/engine/types.ts";

export const MAP_ID = "text-tokens-field";
export const MAP_SIZE = { width: 4, height: 4 } as const;

/** The keys the fixture's resolver answers; declaring it is the {x:} opt-in. */
export const TEXT_TOKEN_KEYS = ["leader", "partySize", "rev"] as const;

export const PARTY = [
  { name: "Aardling", level: 5 },
  { name: "Rockitten", level: 4 },
];

export function textTokenEvent(): GameEvent {
  return {
    id: "text-tokens",
    x: 1,
    y: 1,
    pages: [
      {
        trigger: "autorun",
        commands: [
          { op: "variable", id: "rev", set: { op: "set", value: 0 } },
          { op: "text", lines: ["Leader: {x:leader} ({x:partySize} mon)."] },
          {
            op: "extChoice",
            call: "demo.party",
            args: {},
            prompt: "Pick for {x:rev}",
            cancel: true,
          },
        ] as Command[],
      },
    ],
  };
}

export const MAP: MapDef = {
  id: MAP_ID,
  name: MAP_ID,
  width: MAP_SIZE.width,
  height: MAP_SIZE.height,
  sheets: ["plain"],
  ground: new Array(MAP_SIZE.width * MAP_SIZE.height).fill("plain.0"),
  events: [textTokenEvent()],
};

export function fixtureProject(): Project {
  return {
    format: "rpgkit-project/v1",
    title: "text tokens fixture",
    tileSize: 16,
    start: { map: MAP_ID, x: 1, y: 1, dir: "down" },
    playerName: "Red",
    system: { textTokens: [...TEXT_TOKEN_KEYS] },
    sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [],
    maps: [MAP],
  };
}
