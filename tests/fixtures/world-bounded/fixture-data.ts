// tests/fixtures/world-bounded/fixture-data.ts — a line of small placed
// maps for the W2+W3 bounded-residency sim. Twelve 4x4 maps sit in one
// component; playerTouch events on the east/west edges transfer the player
// to the neighbour, so a sim can walk the whole line and back. The maps
// are intentionally tiny so a full there-and-back traversal is a few
// hundred frames, while the line is wider than the viewport so the
// working set evicts maps behind the player.

import type { MapDef, Project, TileId, WorldLayout } from "../../../src/engine/types.ts";

export const MAP_COUNT = 12;
export const MAP_SIZE = 4;
const TILE = 16;

// Distinct ground colours so a rendered frame shows which maps are in view.
const GROUND_COLOURS: readonly (readonly [number, number, number, number])[] = [
  [18, 26, 20, 255],
  [52, 126, 82, 255],
  [104, 62, 146, 255],
  [164, 82, 54, 255],
  [196, 92, 178, 255],
  [244, 190, 66, 255],
  [238, 104, 112, 255],
  [76, 214, 218, 255],
  [156, 224, 82, 255],
  [248, 146, 54, 255],
  [34, 74, 126, 255],
  [250, 244, 248, 255],
];

export const MAP_IDS: readonly string[] = Array.from(
  { length: MAP_COUNT },
  (_, i) => `wb-${String(i).padStart(2, "0")}`,
);

export const MAP_WORLD: Readonly<Record<string, { w: number; h: number }>> = Object.fromEntries(
  MAP_IDS.map((id) => [id, { w: MAP_SIZE * TILE, h: MAP_SIZE * TILE }]),
);

const groundTile = (index: number): TileId => `tiles.${index}`;

function mapDef(index: number): MapDef {
  const id = MAP_IDS[index]!;
  const events: MapDef["events"] = [];
  // East edge: transfer to the next map, landing one tile in.
  if (index + 1 < MAP_COUNT) {
    events.push({
      id: "east",
      x: MAP_SIZE - 1,
      y: 1,
      pages: [{
        trigger: "playerTouch",
        commands: [{
          op: "transfer",
          map: MAP_IDS[index + 1]!,
          x: 1,
          y: 1,
          dir: "right",
          fade: 0,
        }],
      }],
    });
  }
  // West edge: transfer to the previous map, landing one tile in.
  if (index > 0) {
    events.push({
      id: "west",
      x: 0,
      y: 1,
      pages: [{
        trigger: "playerTouch",
        commands: [{
          op: "transfer",
          map: MAP_IDS[index - 1]!,
          x: MAP_SIZE - 2,
          y: 1,
          dir: "left",
          fade: 0,
        }],
      }],
    });
  }
  return {
    id,
    name: id,
    width: MAP_SIZE,
    height: MAP_SIZE,
    sheets: ["tiles"],
    ground: new Array(MAP_SIZE * MAP_SIZE).fill(groundTile(index)),
    events,
  };
}

export const WORLD_LAYOUT: WorldLayout = {
  topologyHash: "c".repeat(64),
  components: [{
    worldId: "wb-world",
    componentId: "wb-line",
    bounds: {
      minTileX: 0,
      minTileY: 0,
      maxTileX: MAP_COUNT * MAP_SIZE,
      maxTileY: MAP_SIZE,
    },
    placements: MAP_IDS.map((id, i) => ({
      mapId: id,
      originTileX: i * MAP_SIZE,
      originTileY: 0,
      width: MAP_SIZE,
      height: MAP_SIZE,
    })),
    seams: MAP_IDS.slice(0, -1).map((id, i) => ({
      mapA: id,
      sideA: "east" as const,
      spanA: { start: 0, end: MAP_SIZE },
      mapB: MAP_IDS[i + 1]!,
      sideB: "west" as const,
      spanB: { start: 0, end: MAP_SIZE },
      axis: "y" as const,
      offsetAtoB: 0,
      openingIds: [`wb-opening-${String(i).padStart(2, "0")}`],
    })),
    openings: MAP_IDS.slice(0, -1).map((id, i) => ({
      portalId: `wb-opening-${String(i).padStart(2, "0")}`,
      source: { mapId: id, side: "east" as const, span: { start: 0, end: MAP_SIZE } },
      target: {
        mapId: MAP_IDS[i + 1]!,
        side: "west" as const,
        span: { start: 0, end: MAP_SIZE },
      },
      axis: "y" as const,
      offset: 0,
      compatibility: "coordinate-preserving" as const,
    })),
  }],
};

export const WORLD_BOUNDED_PROJECT: Project = {
  format: "rpgkit-project/v1",
  title: "World bounded residency fixture",
  tileSize: TILE,
  start: { map: MAP_IDS[0]!, x: 1, y: 1, dir: "right" },
  sheets: [{
    id: "tiles",
    pak: "tiles",
    cols: MAP_COUNT,
    rows: 1,
    defaultPassage: "pass",
  }],
  items: [],
  worldLayout: WORLD_LAYOUT,
  maps: MAP_IDS.map((_, i) => mapDef(i)),
};

export const GROUND_COLOUR_BYTES: readonly (readonly [number, number, number, number])[] =
  GROUND_COLOURS;
