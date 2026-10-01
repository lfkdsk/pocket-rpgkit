// Source-rectangle catalogue for every multi-cell prop and terrain family the
// feature gallery draws.  Each entry names one vendored Tuxemon PNG and the
// exact pixel rectangle that holds the whole object on that sheet; the art
// builder cuts it into 16px rows and places the rows on the ground or upper
// layer.  Rectangles were measured as tight alpha bounds on the source sheets.

export type ShowcaseSheet = "city" | "interior" | "buch" | "note";

/** Paths are relative to `assets/tuxemon/mods/tuxemon/`. */
export const SHOWCASE_SHEET_FILES: Readonly<Record<ShowcaseSheet, string>> = {
  city: "gfx/tilesets/core_city_and_country.png",
  interior: "gfx/tilesets/Interior_Tiles_by_ArMM1998.png",
  buch: "gfx/tilesets/Basic_Buch_Tiles_Compiled.png",
  note: "gfx/bubbles/note.png",
};

/** What a prop's footprint must stand on. */
export type ShowcaseGround = "grass" | "paved" | "water" | "floor" | "rug" | "wall" | "any";

export interface ShowcaseObject {
  sheet: ShowcaseSheet;
  /** Source pixel rectangle: x, y, width, height. */
  rect: readonly [number, number, number, number];
  /** Footprint in map cells. */
  cols: number;
  rows: number;
  /** Pixel offset of the rectangle's top-left corner inside the footprint. */
  anchor: readonly [number, number];
  /** Top footprint rows drawn on the upper layer, above walking characters. */
  upper: number;
  on: ShowcaseGround;
  /** Footprint cells (column, row) an event may stand in, e.g. an arch's passage. */
  passable?: readonly (readonly [number, number])[];
  /**
   * Opaque source pixels allowed in the one-pixel ring outside `rect`
   * (top, right, bottom, left).  Non-zero only where the sheet packs a
   * different object directly against this one.
   */
  contact?: readonly [number, number, number, number];
}

function prop(
  sheet: ShowcaseSheet,
  rect: readonly [number, number, number, number],
  cols: number,
  rows: number,
  anchor: readonly [number, number],
  upper: number,
  on: ShowcaseGround,
  extra: Pick<ShowcaseObject, "passable" | "contact"> = {},
): ShowcaseObject {
  return { sheet, rect, cols, rows, anchor, upper, on, ...extra };
}

export const SHOWCASE_OBJECTS = {
  // Outdoor architecture (core_city_and_country).
  fountain: prop("city", [352, 144, 48, 45], 3, 3, [0, 3], 1, "paved", { contact: [1, 16, 0, 0] }),
  house: prop("city", [99, 0, 74, 77], 5, 5, [3, 3], 3, "grass"),
  tunnel: prop("city", [168, 504, 48, 40], 3, 3, [0, 8], 2, "any", { passable: [[1, 1], [1, 2]] }),
  archway: prop("city", [392, 504, 48, 40], 3, 3, [0, 8], 2, "any", { passable: [[1, 0], [1, 1], [1, 2]] }),
  statue: prop("city", [128, 496, 32, 45], 2, 3, [0, 3], 2, "any", { contact: [4, 0, 1, 11] }),
  marketStall: prop("city", [288, 359, 80, 82], 5, 6, [0, 14], 3, "any", { contact: [1, 18, 0, 17] }),
  plankBridge: prop("city", [520, 505, 32, 42], 2, 3, [0, 3], 0, "water"),
  bench: prop("city", [451, 64, 43, 29], 3, 2, [2, 3], 1, "any", { contact: [15, 0, 0, 0] }),
  jugTable: prop("city", [256, 410, 32, 22], 2, 2, [0, 10], 0, "any", { contact: [1, 0, 0, 22] }),
  // Outdoor nature and small props.
  tree: prop("city", [80, 256, 32, 31], 2, 2, [0, 1], 1, "grass", { contact: [0, 29, 1, 20] }),
  hedge: prop("city", [33, 225, 14, 14], 1, 1, [1, 2], 0, "grass"),
  hedgeRow: prop("city", [1, 257, 30, 14], 2, 1, [1, 2], 0, "grass"),
  rocks: prop("city", [69, 26, 23, 20], 2, 2, [4, 12], 0, "grass"),
  stump: prop("city", [497, 54, 30, 25], 2, 2, [1, 7], 0, "grass"),
  crate: prop("city", [496, 0, 16, 30], 1, 2, [0, 2], 1, "any", { contact: [0, 3, 0, 26] }),
  barrel: prop("city", [528, 5, 16, 22], 1, 2, [0, 10], 0, "any", { contact: [1, 12, 0, 0] }),
  barrels: prop("city", [544, 0, 16, 28], 1, 2, [0, 4], 1, "any", { contact: [0, 0, 0, 8] }),
  sack: prop("city", [512, 2, 14, 14], 1, 1, [1, 2], 0, "any", { contact: [1, 0, 1, 14] }),
  pottedVine: prop("city", [512, 18, 14, 28], 1, 2, [1, 4], 1, "any", { contact: [1, 0, 1, 25] }),
  produceYellow: prop("city", [417, 320, 14, 21], 1, 2, [1, 11], 0, "any"),
  produceGreen: prop("city", [433, 320, 15, 21], 1, 2, [0, 11], 0, "any"),
  produceRed: prop("city", [449, 320, 14, 21], 1, 2, [1, 11], 0, "any"),
  // Small plants from the Buch sheet (transparent around the plant).
  redFlowers: prop("buch", [129, 81, 15, 14], 1, 1, [0, 2], 0, "grass"),
  leafyBush: prop("buch", [145, 81, 15, 14], 1, 1, [0, 2], 0, "grass", { contact: [1, 14, 1, 0] }),
  pine: prop("buch", [129, 112, 30, 32], 2, 2, [1, 0], 1, "grass"),
  // Interior furniture (Interior_Tiles_by_ArMM1998; rects include soft shadows).
  table: prop("interior", [161, 17, 47, 47], 3, 3, [0, 1], 1, "floor", { contact: [0, 0, 15, 0] }),
  clothTable: prop("interior", [209, 17, 47, 47], 3, 3, [0, 1], 1, "floor", { contact: [1, 44, 6, 0] }),
  bed: prop("interior", [272, 16, 32, 47], 2, 3, [0, 1], 1, "floor", { contact: [0, 45, 0, 46] }),
  sideboard: prop("interior", [161, 113, 47, 45], 3, 3, [0, 3], 1, "floor"),
  cabinet: prop("interior", [97, 146, 47, 46], 3, 3, [0, 2], 1, "floor"),
  dresser: prop("interior", [1, 194, 47, 46], 3, 3, [0, 2], 1, "floor", { contact: [0, 0, 48, 0] }),
  bookshelf: prop("interior", [49, 192, 47, 32], 3, 2, [0, 0], 1, "floor", { contact: [16, 29, 31, 0] }),
  counter: prop("interior", [96, 195, 32, 56], 2, 4, [0, 8], 1, "floor", { contact: [0, 1, 0, 15] }),
  lowBench: prop("interior", [225, 144, 46, 16], 3, 1, [1, 0], 0, "floor"),
  fireplace: prop("interior", [193, 160, 30, 47], 2, 3, [1, 1], 2, "wall"),
  plant: prop("interior", [128, 195, 15, 29], 1, 2, [0, 3], 1, "floor", { contact: [0, 0, 1, 29] }),
  medallion: prop("interior", [0, 160, 32, 32], 2, 2, [0, 0], 0, "rug", {
    contact: [28, 0, 0, 0],
    passable: [[0, 0], [1, 0], [0, 1], [1, 1]],
  }),
  lamp: prop("interior", [64, 247, 16, 16], 1, 1, [0, 0], 0, "any"),
  window: prop("interior", [147, 72, 26, 18], 2, 2, [3, 7], 0, "wall"),
  wallShelf: prop("interior", [225, 112, 46, 28], 3, 2, [1, 4], 0, "wall"),
  musicNote: prop("note", [1, 0, 14, 16], 1, 1, [1, 0], 1, "any"),
  nightPainting: prop("interior", [226, 0, 28, 15], 2, 1, [2, 1], 0, "wall"),
  forestPainting: prop("interior", [258, 0, 28, 15], 2, 1, [2, 1], 0, "wall"),
  fieldPainting: prop("interior", [194, 1, 28, 13], 2, 1, [2, 2], 0, "wall"),
} as const satisfies Record<string, ShowcaseObject>;

export type ShowcaseObjectId = keyof typeof SHOWCASE_OBJECTS;

/**
 * Outdoor autotile families from core_city_and_country.  The eight ring
 * tiles are grass with a lip of terrain facing the solid centre; the inner
 * corners close concave turns.  Inner-corner names list the sides that hold
 * terrain (innerNW = terrain to the north and west).
 */
export interface TerrainFamily {
  sheet: ShowcaseSheet;
  /** Top-left of the 3x3 block (NW .. SE); the centre is the solid fill. */
  block: readonly [number, number];
  innerNW: readonly [number, number];
  innerNE: readonly [number, number];
  innerSW: readonly [number, number];
  innerSE: readonly [number, number];
  /** The tiles contain transparent pixels and are drawn over plain grass. */
  underlay: boolean;
}

export const GRASS_TILE = [0, 0] as const;

export const TERRAIN_FAMILIES = {
  dirt: { sheet: "city", block: [0, 464], innerNW: [0, 512], innerNE: [16, 512], innerSW: [0, 528], innerSE: [16, 528], underlay: false },
  sand: { sheet: "city", block: [0, 48], innerNW: [0, 96], innerNE: [16, 96], innerSW: [0, 112], innerSE: [16, 112], underlay: false },
  water: { sheet: "city", block: [32, 96], innerNW: [32, 144], innerNE: [48, 144], innerSW: [32, 160], innerSE: [48, 160], underlay: false },
  stone: { sheet: "city", block: [240, 176], innerNW: [240, 224], innerNE: [256, 224], innerSW: [240, 240], innerSE: [256, 240], underlay: true },
} as const satisfies Record<string, TerrainFamily>;

export type TerrainKind = keyof typeof TERRAIN_FAMILIES;

/** Interior floors: single seamless tiles on the interior sheet. */
export const FLOOR_TILES = {
  brick: [0, 16],
  sandstone: [0, 32],
  checker: [0, 0],
} as const satisfies Record<string, readonly [number, number]>;

export type FloorKind = keyof typeof FLOOR_TILES;

/** The green rug: a 3x3 slice block on the interior sheet (1px transparent margin). */
export const RUG_BLOCK = [0, 112] as const;

/** Wood-panel wall with a baseboard: a 48x48 block that repeats horizontally. */
export const WALL_BLOCK = { x: 16, y: 48, width: 48, rows: 3 } as const;
