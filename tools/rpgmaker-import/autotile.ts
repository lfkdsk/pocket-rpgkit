// tools/rpgmaker-import/autotile.ts — RPG Maker MV/MZ tile ids and the
// autotile shape rules.
//
// Tile id ranges (MV/MZ Tilemap):
//
//   0..1023      B, C, D, E sheets (256 each)
//   1536..1663   A5 (8 x 16 plain tiles)
//   2048..2815   A1 autotiles, kinds 0..15     (animated water, waterfalls)
//   2816..4351   A2 autotiles, kinds 16..47    (ground)
//   4352..5887   A3 autotiles, kinds 48..79    (roofs, building walls)
//   5888..8191   A4 autotiles, kinds 80..127   (wall tops and wall sides)
//
// An autotile id is 2048 + kind * 48 + shape. The editor stores the shape:
// it is recomputed from the eight neighbours whenever a cell is painted,
// and the runtime only reads it. `autotileShape` reproduces the editor's
// rule so hand-written fixtures (and `--reshape`) can produce the ids an
// editor would have saved. The shape picks four 8x8 (quarter-tile) pieces
// from the autotile's source block through one of three tables (floor,
// wall, waterfall), exactly as Tilemap._drawAutotile does.

export const TILE_ID_B = 0;
export const TILE_ID_C = 256;
export const TILE_ID_D = 512;
export const TILE_ID_E = 768;
export const TILE_ID_A5 = 1536;
export const TILE_ID_A1 = 2048;
export const TILE_ID_A2 = 2816;
export const TILE_ID_A3 = 4352;
export const TILE_ID_A4 = 5888;
export const TILE_ID_MAX = 8192;

export const isAutotile = (id: number): boolean => id >= TILE_ID_A1 && id < TILE_ID_MAX;
export const isTileA1 = (id: number): boolean => id >= TILE_ID_A1 && id < TILE_ID_A2;
export const isTileA2 = (id: number): boolean => id >= TILE_ID_A2 && id < TILE_ID_A3;
export const isTileA3 = (id: number): boolean => id >= TILE_ID_A3 && id < TILE_ID_A4;
export const isTileA4 = (id: number): boolean => id >= TILE_ID_A4 && id < TILE_ID_MAX;
export const isTileA5 = (id: number): boolean => id >= TILE_ID_A5 && id < TILE_ID_A5 + 128;
export const isTileBtoE = (id: number): boolean => id > 0 && id < 1024;

export const autotileKind = (id: number): number => Math.floor((id - TILE_ID_A1) / 48);
export const autotileShape = (id: number): number => (id - TILE_ID_A1) % 48;
export const makeAutotileId = (kind: number, shape: number): number => TILE_ID_A1 + kind * 48 + shape;

/** A1 kinds 4.. with an odd index are waterfalls (three vertical frames,
 *  WATERFALL table). */
export const isWaterfallTile = (id: number): boolean =>
  isTileA1(id) && autotileKind(id) >= 4 && autotileKind(id) % 2 === 1;
/** A4 rows 0, 2, 4 (kind % 16 < 8) are wall tops (FLOOR table). */
export const isWallTopTile = (id: number): boolean => isTileA4(id) && autotileKind(id) % 16 < 8;
/** A3 rows 1, 3 and A4 rows 1, 3, 5 (kind % 16 >= 8) are wall sides. */
export const isWallSideTile = (id: number): boolean =>
  (isTileA3(id) || isTileA4(id)) && autotileKind(id) % 16 >= 8;
/** A3 rows 0, 2 (kind % 16 < 8) are roofs (WALL table). */
export const isRoofTile = (id: number): boolean => isTileA3(id) && autotileKind(id) % 16 < 8;

export type QuarterTable = readonly (readonly (readonly [number, number])[])[];

/** 48 floor shapes: [TL, TR, BL, BR] quarter sources as [qx, qy] in the
 *  2x3-tile (4x6-quarter) autotile block. Shape 47 is the isolated preview
 *  tile (top-left tile of the block). */
export const FLOOR_AUTOTILE_TABLE: QuarterTable = [
  [[2, 4], [1, 4], [2, 3], [1, 3]], [[2, 0], [1, 4], [2, 3], [1, 3]],
  [[2, 4], [3, 0], [2, 3], [1, 3]], [[2, 0], [3, 0], [2, 3], [1, 3]],
  [[2, 4], [1, 4], [2, 3], [3, 1]], [[2, 0], [1, 4], [2, 3], [3, 1]],
  [[2, 4], [3, 0], [2, 3], [3, 1]], [[2, 0], [3, 0], [2, 3], [3, 1]],
  [[2, 4], [1, 4], [2, 1], [1, 3]], [[2, 0], [1, 4], [2, 1], [1, 3]],
  [[2, 4], [3, 0], [2, 1], [1, 3]], [[2, 0], [3, 0], [2, 1], [1, 3]],
  [[2, 4], [1, 4], [2, 1], [3, 1]], [[2, 0], [1, 4], [2, 1], [3, 1]],
  [[2, 4], [3, 0], [2, 1], [3, 1]], [[2, 0], [3, 0], [2, 1], [3, 1]],
  [[0, 4], [1, 4], [0, 3], [1, 3]], [[0, 4], [3, 0], [0, 3], [1, 3]],
  [[0, 4], [1, 4], [0, 3], [3, 1]], [[0, 4], [3, 0], [0, 3], [3, 1]],
  [[2, 2], [1, 2], [2, 3], [1, 3]], [[2, 2], [1, 2], [2, 3], [3, 1]],
  [[2, 2], [1, 2], [2, 1], [1, 3]], [[2, 2], [1, 2], [2, 1], [3, 1]],
  [[2, 4], [3, 4], [2, 3], [3, 3]], [[2, 4], [3, 4], [2, 1], [3, 3]],
  [[2, 0], [3, 4], [2, 3], [3, 3]], [[2, 0], [3, 4], [2, 1], [3, 3]],
  [[2, 4], [1, 4], [2, 5], [1, 5]], [[2, 0], [1, 4], [2, 5], [1, 5]],
  [[2, 4], [3, 0], [2, 5], [1, 5]], [[2, 0], [3, 0], [2, 5], [1, 5]],
  [[0, 4], [3, 4], [0, 3], [3, 3]], [[2, 2], [1, 2], [2, 5], [1, 5]],
  [[0, 2], [1, 2], [0, 3], [1, 3]], [[0, 2], [1, 2], [0, 3], [3, 1]],
  [[2, 2], [3, 2], [2, 3], [3, 3]], [[2, 2], [3, 2], [2, 1], [3, 3]],
  [[2, 4], [3, 4], [2, 5], [3, 5]], [[2, 0], [3, 4], [2, 5], [3, 5]],
  [[0, 4], [1, 4], [0, 5], [1, 5]], [[0, 4], [3, 0], [0, 5], [1, 5]],
  [[0, 2], [3, 2], [0, 3], [3, 3]], [[0, 2], [1, 2], [0, 5], [1, 5]],
  [[0, 4], [3, 4], [0, 5], [3, 5]], [[2, 2], [3, 2], [2, 5], [3, 5]],
  [[0, 2], [3, 2], [0, 5], [3, 5]], [[0, 0], [1, 0], [0, 1], [1, 1]],
];

/** 16 wall shapes (A3, A4 wall sides) in a 2x2-tile (4x4-quarter) block.
 *  Bits: 1 left edge, 2 top edge, 4 right edge, 8 bottom edge. */
export const WALL_AUTOTILE_TABLE: QuarterTable = [
  [[2, 2], [1, 2], [2, 1], [1, 1]], [[0, 2], [1, 2], [0, 1], [1, 1]],
  [[2, 0], [1, 0], [2, 1], [1, 1]], [[0, 0], [1, 0], [0, 1], [1, 1]],
  [[2, 2], [3, 2], [2, 1], [3, 1]], [[0, 2], [3, 2], [0, 1], [3, 1]],
  [[2, 0], [3, 0], [2, 1], [3, 1]], [[0, 0], [3, 0], [0, 1], [3, 1]],
  [[2, 2], [1, 2], [2, 3], [1, 3]], [[0, 2], [1, 2], [0, 3], [1, 3]],
  [[2, 0], [1, 0], [2, 3], [1, 3]], [[0, 0], [1, 0], [0, 3], [1, 3]],
  [[2, 2], [3, 2], [2, 3], [3, 3]], [[0, 2], [3, 2], [0, 3], [3, 3]],
  [[2, 0], [3, 0], [2, 3], [3, 3]], [[0, 0], [3, 0], [0, 3], [3, 3]],
];

/** 4 waterfall shapes in a 2x1-tile block (per frame). Bits: 1 left edge,
 *  2 right edge. */
export const WATERFALL_AUTOTILE_TABLE: QuarterTable = [
  [[2, 0], [1, 0], [2, 1], [1, 1]], [[0, 0], [1, 0], [0, 1], [1, 1]],
  [[2, 0], [3, 0], [2, 1], [3, 1]], [[0, 0], [3, 0], [0, 1], [3, 1]],
];

/** The quarter table that draws an autotile id. */
export function autotileTable(id: number): QuarterTable {
  if (isWaterfallTile(id)) return WATERFALL_AUTOTILE_TABLE;
  if (isTileA3(id)) return WALL_AUTOTILE_TABLE;
  if (isTileA4(id) && !isWallTopTile(id)) return WALL_AUTOTILE_TABLE;
  return FLOOR_AUTOTILE_TABLE;
}

// --- shape from neighbours ---------------------------------------------------

/** What one floor-table quarter shows, judged by its two orthogonal sides and
 *  its diagonal. */
type QuarterLook = "interior" | "inner" | "edgeX" | "edgeY" | "outer";

/** Classify a FLOOR table quarter source by its position in the block:
 *  quarter i (0 TL, 1 TR, 2 BL, 3 BR) has its outer column at qx 0 (left
 *  quarters) or 3 (right) and its outer row at qy 2 (top) or 5 (bottom). */
function floorQuarterLook(i: number, qx: number, qy: number): QuarterLook {
  if (qy <= 1) return "inner";
  const borderX = i % 2 === 0 ? 0 : 3;
  const borderY = i < 2 ? 2 : 5;
  const onX = qx === borderX;
  const onY = qy === borderY;
  if (onX && onY) return "outer";
  if (onX) return "edgeX";
  if (onY) return "edgeY";
  return "interior";
}

const FLOOR_LOOKUP = new Map<string, number>();
for (let shape = 0; shape < 47; shape++) {
  const key = FLOOR_AUTOTILE_TABLE[shape]!.map(([qx, qy], i) => floorQuarterLook(i, qx, qy)).join(",");
  if (FLOOR_LOOKUP.has(key)) throw new Error(`autotile: duplicate floor shape key ${key}`);
  FLOOR_LOOKUP.set(key, shape);
}

/** `same(dx, dy)` answers whether the neighbour at that offset joins this
 *  autotile (the map edge counts as joined, as in the editor). */
export type Joins = (dx: number, dy: number) => boolean;

/** Floor (47-piece blob) shape from the eight neighbours. */
export function floorShape(same: Joins): number {
  const looks: QuarterLook[] = [];
  // Quarter order TL, TR, BL, BR with its horizontal side, vertical side
  // and diagonal.
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const h = same(sx, 0);
    const v = same(0, sy);
    const d = same(sx, sy);
    looks.push(
      !h && !v ? "outer" : !h ? "edgeX" : !v ? "edgeY" : d ? "interior" : "inner",
    );
  }
  const shape = FLOOR_LOOKUP.get(looks.join(","));
  if (shape === undefined) throw new Error(`autotile: no floor shape for ${looks.join(",")}`);
  return shape;
}

/** Wall/roof shape (16 pieces): a bit per open side. */
export function wallShape(same: Joins): number {
  return (same(-1, 0) ? 0 : 1) | (same(0, -1) ? 0 : 2) | (same(1, 0) ? 0 : 4) | (same(0, 1) ? 0 : 8);
}

/** Waterfall shape (4 pieces): a bit per open horizontal side. */
export function waterfallShape(same: Joins): number {
  return (same(-1, 0) ? 0 : 1) | (same(1, 0) ? 0 : 2);
}

/** Recompute the stored shape of every autotile in z-planes `layers` of a
 *  map's `data` (layout (z * height + y) * width + x), as the editor does
 *  after painting. Two cells join when they hold the same autotile kind.
 *  Returns a new array; non-autotile ids are untouched. */
export function reshapeAutotiles(
  data: readonly number[],
  width: number,
  height: number,
  layers: readonly number[] = [0, 1, 2, 3],
): number[] {
  const out = data.slice();
  for (const z of layers) {
    const base = z * width * height;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const id = data[base + y * width + x]!;
        if (!isAutotile(id)) continue;
        const kind = autotileKind(id);
        const same: Joins = (dx, dy) => {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) return true;
          const n = data[base + ny * width + nx]!;
          return isAutotile(n) && autotileKind(n) === kind;
        };
        const table = autotileTable(id);
        const shape = table === FLOOR_AUTOTILE_TABLE
          ? floorShape(same)
          : table === WALL_AUTOTILE_TABLE
            ? wallShape(same)
            : waterfallShape(same);
        out[base + y * width + x] = makeAutotileId(kind, shape);
      }
    }
  }
  return out;
}
