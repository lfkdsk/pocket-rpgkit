// KRM3 select-item visual fixture: an autorun director opens the built-in
// item picker over a small map. The catalog spans all four item types and a
// long name so the screenshot proves wrapping/marquee without truncation.

import type { GameEvent, Item, MapDef } from "../../../src/engine/types.ts";

export const MAP_ID = "krm3-select-room";
export const MAP_SIZE = { width: 16, height: 16 } as const;

export const ITEMS: Item[] = [
  { id: "item001", name: "Potion", sprite: "plain.0", type: "regular" },
  { id: "item002", name: "Hi-Potion", sprite: "plain.0", type: "regular" },
  { id: "item003", name: "Ether", sprite: "plain.0", type: "regular" },
  { id: "item004", name: "Key Card", sprite: "plain.0", type: "key" },
  { id: "item005", name: "Basement Key", sprite: "plain.0", type: "key" },
  { id: "item006", name: "Hidden A", sprite: "plain.0", type: "hiddenA" },
  { id: "item007", name: "Hidden B", sprite: "plain.0", type: "hiddenB" },
  {
    id: "item008",
    name: "A very long item name that must wrap or scroll rather than be cut off",
    sprite: "plain.0",
    type: "regular",
  },
];

const DIRECTOR: GameEvent = {
  id: "director",
  x: 1,
  y: 1,
  pages: [
    {
      trigger: "autorun",
      commands: [
        // The picker lists only held database items, so grant the regular
        // ones first (the key/hidden items stay out of the list).
        { op: "item", item: "item001", set: "add", count: 1 },
        { op: "item", item: "item002", set: "add", count: 1 },
        { op: "item", item: "item003", set: "add", count: 1 },
        { op: "item", item: "item008", set: "add", count: 1 },
        { op: "selectItem", variable: "pick", itemType: "regular" },
        { op: "switch", id: "done", value: true },
      ],
      blocks: false,
      sprite: null,
    },
    {
      condition: { switch: "done" },
      trigger: "action",
      commands: [],
      blocks: false,
      sprite: null,
    },
  ],
};

export const MAP: MapDef = {
  id: MAP_ID,
  name: "Select Room",
  width: MAP_SIZE.width,
  height: MAP_SIZE.height,
  sheets: ["plain"],
  ground: new Array(MAP_SIZE.width * MAP_SIZE.height).fill("plain.0"),
  events: [DIRECTOR],
};
