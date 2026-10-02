// Authored geometry for the component-world renderer fixture. Four maps meet
// at a signed world origin; a fifth small placement occupies only part of the
// component's east edge so camera clamping cannot hide accidental stretching.

import type { MapDef, Project, TileId, WorldLayout } from "../../../src/engine/types.ts";
import type { AnimatedTile } from "../../../src/ui/game-assets.ts";

export type Rgba = readonly [number, number, number, number];

export const MAPS = [
  { id: "a-northwest", width: 64, height: 40, originTileX: -64, originTileY: -40, ground: [34, 74, 126, 255] as Rgba, upper: [244, 190, 66, 255] as Rgba },
  { id: "b-northeast", width: 64, height: 40, originTileX: 0, originTileY: -40, ground: [52, 126, 82, 255] as Rgba, upper: [238, 104, 112, 255] as Rgba },
  { id: "c-southwest", width: 64, height: 40, originTileX: -64, originTileY: 0, ground: [104, 62, 146, 255] as Rgba, upper: [76, 214, 218, 255] as Rgba },
  { id: "d-southeast", width: 64, height: 40, originTileX: 0, originTileY: 0, ground: [164, 82, 54, 255] as Rgba, upper: [156, 224, 82, 255] as Rgba },
  { id: "e-small", width: 16, height: 10, originTileX: 64, originTileY: 15, ground: [196, 92, 178, 255] as Rgba, upper: [248, 146, 54, 255] as Rgba },
] as const;

export const PLAYER_COLOUR: Rgba = [250, 244, 248, 255];
export const PLAYER_OUTLINE: Rgba = [24, 18, 34, 255];
export const BELOW_ANIM_COLOUR: Rgba = [38, 224, 246, 255];
export const ABOVE_ANIM_COLOUR: Rgba = [248, 72, 220, 255];

export const WORLD_LAYOUT: WorldLayout = {
  topologyHash: "7".repeat(64),
  components: [{
    worldId: "fixture-world",
    componentId: "five-map-component",
    bounds: { minTileX: -64, minTileY: -40, maxTileX: 80, maxTileY: 40 },
    placements: MAPS.map(({ id: mapId, originTileX, originTileY, width, height }) => ({
      mapId, originTileX, originTileY, width, height,
    })),
    seams: [
      { mapA: "a-northwest", sideA: "east", spanA: { start: 0, end: 40 }, mapB: "b-northeast", sideB: "west", spanB: { start: 0, end: 40 }, axis: "y", offsetAtoB: 0, openingIds: [] },
      { mapA: "a-northwest", sideA: "south", spanA: { start: 0, end: 64 }, mapB: "c-southwest", sideB: "north", spanB: { start: 0, end: 64 }, axis: "x", offsetAtoB: 0, openingIds: [] },
      { mapA: "b-northeast", sideA: "south", spanA: { start: 0, end: 64 }, mapB: "d-southeast", sideB: "north", spanB: { start: 0, end: 64 }, axis: "x", offsetAtoB: 0, openingIds: [] },
      { mapA: "c-southwest", sideA: "east", spanA: { start: 0, end: 40 }, mapB: "d-southeast", sideB: "west", spanB: { start: 0, end: 40 }, axis: "y", offsetAtoB: 0, openingIds: [] },
      { mapA: "d-southeast", sideA: "east", spanA: { start: 15, end: 25 }, mapB: "e-small", sideB: "west", spanB: { start: 0, end: 10 }, axis: "y", offsetAtoB: -15, openingIds: [] },
    ],
    openings: [],
  }],
};
const ground = (width: number, height: number): TileId[] =>
  Array.from({ length: width * height }, () => "fixture.0");

const mapDef = (entry: typeof MAPS[number]): MapDef => ({
  id: entry.id,
  name: entry.id,
  width: entry.width,
  height: entry.height,
  sheets: ["fixture"],
  ground: ground(entry.width, entry.height),
  events: [],
});

export const WORLD_STREAMED_PROJECT: Project = {
  format: "rpgkit-project/v1",
  title: "Five-map streamed world fixture",
  tileSize: 16,
  start: { map: "a-northwest", x: 62, y: 38, dir: "right" },
  sheets: [{ id: "fixture", cols: 1, rows: 1, pak: "fixture", defaultPassage: "pass" }],
  items: [],
  worldLayout: WORLD_LAYOUT,
  maps: MAPS.map(mapDef),
};

export const ANIMATED: Readonly<Record<string, readonly AnimatedTile[]>> = {
  "a-northwest": [
    { x: 59, y: 36, above: false, sprite: "assets/anim/below.png" },
    { x: 60, y: 36, above: true, sprite: "assets/anim/above.png" },
  ],
  "b-northeast": [
    { x: 3, y: 36, above: false, sprite: "assets/anim/below.png" },
    { x: 4, y: 36, above: true, sprite: "assets/anim/above.png" },
  ],
  "c-southwest": [
    { x: 59, y: 3, above: false, sprite: "assets/anim/below.png" },
    { x: 60, y: 3, above: true, sprite: "assets/anim/above.png" },
  ],
  "d-southeast": [
    { x: 3, y: 3, above: false, sprite: "assets/anim/below.png" },
    { x: 4, y: 3, above: true, sprite: "assets/anim/above.png" },
  ],
  "e-small": [
    { x: 1, y: 1, above: false, sprite: "assets/anim/below.png" },
    { x: 2, y: 1, above: true, sprite: "assets/anim/above.png" },
  ],
};
