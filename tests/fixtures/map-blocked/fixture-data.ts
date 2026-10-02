// tests/fixtures/map-blocked/fixture-data.ts — the two maps shared by
// gen-assets.ts (bakes their chunk images) and map-blocked.tsx (mounts the
// shell). map_a's action event transfers to map_b, whose shard bytes are
// never resident: the transfer boundary reports MapNotReadyError and the
// async prepare path is what succeeds or fails.

import type { MapDef } from "../../../src/engine/types.ts";

export const MAP_A_ID = "map-blocked-a";
export const MAP_B_ID = "map-blocked-b";
const SIZE = { width: 4, height: 4 } as const;

export const MAP_A: MapDef = {
  id: MAP_A_ID,
  name: MAP_A_ID,
  width: SIZE.width,
  height: SIZE.height,
  sheets: ["plain"],
  ground: new Array(SIZE.width * SIZE.height).fill("plain.0"),
  events: [{
    id: "door",
    x: 1,
    y: 1,
    pages: [{
      trigger: "action",
      commands: [{ op: "transfer", map: MAP_B_ID, x: 1, y: 1, dir: "up", fade: 0 }],
    }],
  }],
};

export const MAP_B: MapDef = {
  id: MAP_B_ID,
  name: MAP_B_ID,
  width: SIZE.width,
  height: SIZE.height,
  sheets: ["plain"],
  ground: new Array(SIZE.width * SIZE.height).fill("plain.0"),
  events: [],
};

export const MAPS: readonly MapDef[] = [MAP_A, MAP_B];
