// Build-time composition for the feature gallery's Tuxemon town and rooms.
// Every prop comes from the source-rectangle catalogue in showcase-objects.ts
// and every terrain edge from a Tuxemon autotile family; this file only
// decides where they go.  The result is the streamed ground/upper layer pair
// used by the real renderer.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodePng } from "../../vendor/pocketjs/framework/compiler/pak.ts";
import { bakeAtlases } from "../../vendor/pocketjs/framework/compiler/bake-font.ts";
import { fontSlotFor } from "../../vendor/pocketjs/framework/compiler/tailwind.ts";
import type { MapDef } from "../../src/engine/types.ts";
import {
  FLOOR_TILES,
  GRASS_TILE,
  RUG_BLOCK,
  SHOWCASE_OBJECTS,
  SHOWCASE_SHEET_FILES,
  TERRAIN_FAMILIES,
  WALL_BLOCK,
  type FloorKind,
  type ShowcaseObjectId,
  type ShowcaseSheet,
  type TerrainKind,
} from "./showcase-objects.ts";

const TILE = 16;
const SOURCE = join(import.meta.dir, "assets", "tuxemon", "mods", "tuxemon");

export interface Bitmap {
  width: number;
  height: number;
  rgba: Uint8Array;
}

const sheets = new Map<ShowcaseSheet, Bitmap>();
export function showcaseSheet(sheet: ShowcaseSheet): Bitmap {
  let bitmap = sheets.get(sheet);
  if (!bitmap) {
    bitmap = decodePng(new Uint8Array(readFileSync(join(SOURCE, SHOWCASE_SHEET_FILES[sheet]))));
    sheets.set(sheet, bitmap);
  }
  return bitmap;
}

function blank(width: number, height: number): Bitmap {
  return { width, height, rgba: new Uint8Array(width * height * 4) };
}

export function crop(source: Bitmap, x: number, y: number, width: number, height: number): Bitmap {
  if (x < 0 || y < 0 || x + width > source.width || y + height > source.height) {
    throw new Error(`showcase art: crop ${x},${y} ${width}x${height} outside ${source.width}x${source.height}`);
  }
  const out = blank(width, height);
  for (let row = 0; row < height; row++) {
    const from = ((y + row) * source.width + x) * 4;
    out.rgba.set(source.rgba.subarray(from, from + width * 4), row * width * 4);
  }
  return out;
}

/** Straight-alpha "source over" for one pixel. */
export function over(target: Uint8Array, to: number, source: Uint8Array, from: number): void {
  const a = source[from + 3]!;
  if (a === 0) return;
  const b = target[to + 3]!;
  if (a === 255 || b === 0) {
    target.set(source.subarray(from, from + 4), to);
    return;
  }
  const sa = a / 255;
  const da = b / 255 * (1 - sa);
  const outA = sa + da;
  for (let c = 0; c < 3; c++) {
    target[to + c] = Math.round((source[from + c]! * sa + target[to + c]! * da) / outA);
  }
  target[to + 3] = Math.round(outA * 255);
}

/** Draw `source` rows [rowStart, rowEnd) at (x, y + rowStart). */
function draw(target: Bitmap, source: Bitmap, x: number, y: number, rowStart = 0, rowEnd = source.height): void {
  for (let sy = Math.max(0, rowStart); sy < Math.min(source.height, rowEnd); sy++) {
    const ty = y + sy;
    if (ty < 0 || ty >= target.height) continue;
    for (let sx = 0; sx < source.width; sx++) {
      const tx = x + sx;
      if (tx < 0 || tx >= target.width) continue;
      over(target.rgba, (ty * target.width + tx) * 4, source.rgba, (sy * source.width + sx) * 4);
    }
  }
}

function sheetTile(sheet: ShowcaseSheet, at: readonly [number, number]): Bitmap {
  return crop(showcaseSheet(sheet), at[0], at[1], TILE, TILE);
}

/** The exact source pixels of one catalogue object. */
export function showcaseObjectPixels(id: ShowcaseObjectId): Bitmap {
  const object = SHOWCASE_OBJECTS[id];
  return crop(showcaseSheet(object.sheet), ...object.rect);
}

// ---------------------------------------------------------------------------
// Plans: terrain, rugs, props and door plaques for one map.
// ---------------------------------------------------------------------------

export interface ObjectPlacement {
  object: ShowcaseObjectId;
  /** Top-left footprint cell. */
  x: number;
  y: number;
}

export interface Plaque {
  label: string;
  /** Pixel position of the board's bottom-centre point. */
  x: number;
  y: number;
}

export interface ShowcaseMapPlan {
  outdoor: boolean;
  width: number;
  height: number;
  /** Solid terrain per cell for outdoor maps (null = grass). */
  terrain: (TerrainKind | null)[];
  floor: FloorKind;
  /** Wall rows at the top of indoor rooms. */
  wallRows: number;
  rugs: { x: number; y: number; width: number; height: number }[];
  objects: ObjectPlacement[];
  plaques: Plaque[];
}

class PlanBuilder {
  readonly plan: ShowcaseMapPlan;
  constructor(map: MapDef, outdoor: boolean, floor: FloorKind = "brick") {
    this.plan = {
      outdoor,
      width: map.width,
      height: map.height,
      terrain: Array.from({ length: map.width * map.height }, () => null),
      floor,
      wallRows: outdoor ? 0 : WALL_BLOCK.rows,
      rugs: [],
      objects: [],
      plaques: [],
    };
  }

  area(kind: TerrainKind, x: number, y: number, width: number, height: number): this {
    for (let cy = y; cy < y + height; cy++) {
      for (let cx = x; cx < x + width; cx++) {
        if (cx < 0 || cy < 0 || cx >= this.plan.width || cy >= this.plan.height) continue;
        this.plan.terrain[cy * this.plan.width + cx] = kind;
      }
    }
    return this;
  }

  rug(x: number, y: number, width: number, height: number): this {
    this.plan.rugs.push({ x, y, width, height });
    return this;
  }

  put(object: ShowcaseObjectId, ...cells: (readonly [number, number])[]): this {
    for (const [x, y] of cells) this.plan.objects.push({ object, x, y });
    return this;
  }

  plaque(label: string, x: number, y: number): this {
    this.plan.plaques.push({ label, x, y });
    return this;
  }
}

/** Return gate shared by every hall: an open stone arch over the exit cell. */
function hallExit(b: PlanBuilder, path: TerrainKind = "dirt"): PlanBuilder {
  if (b.plan.outdoor) b.area(path, 2, 14, 1, 3);
  return b.put("archway", [1, 14]);
}

// The rooms share actor positions from hall-kit.ts: guide (6,8), curator
// (15,8), visitor (24,10), entry (2,14), exit (2,15) and the room sign (4,15).
// Props keep those cells, the entry row and the curator's approach clear.

function lobbyPlan(map: MapDef): ShowcaseMapPlan {
  const b = new PlanBuilder(map, true);
  b.area("stone", 2, 6, 26, 5);
  for (const event of map.events ?? []) {
    if (!event.id.startsWith("door-")) continue;
    const top = event.y < map.height / 2;
    const number = event.name?.split(".")[0];
    if (!number) throw new Error(`showcase art: door ${event.id} has no hall number`);
    if (top) {
      b.area("stone", event.x, 3, 1, 3);
      b.put("tunnel", [event.x - 1, 1]);
      b.plaque(number, event.x * TILE + TILE / 2, TILE + 8);
    } else {
      b.area("stone", event.x, 11, 1, 6);
      b.put("archway", [event.x - 1, 13]);
      b.plaque(number, event.x * TILE + TILE / 2, 13 * TILE + 8);
    }
  }
  b.put("fountain", [7, 6], [20, 6]);
  b.put("bench", [3, 6], [24, 6]);
  b.put("redFlowers", [4, 4], [12, 4], [21, 4], [13, 12], [25, 12]);
  b.put("leafyBush", [8, 4], [13, 4], [17, 4], [25, 4], [4, 12], [8, 12], [12, 12], [17, 12], [21, 12]);
  return b.plan;
}

function hallPlan(map: MapDef): ShowcaseMapPlan {
  switch (map.id) {
    case "showcase-screen-effects": {
      // Lantern garden: a path from the gate to the curator's terrace,
      // with a cottage, pond and trees framing the effect area.
      const b = hallExit(new PlanBuilder(map, true));
      b.area("dirt", 3, 13, 13, 2).area("dirt", 14, 9, 3, 4).area("dirt", 11, 6, 9, 3);
      b.area("water", 22, 3, 5, 3);
      b.put("house", [2, 1]);
      b.put("tree", [8, 2], [9, 10], [26, 12], [20, 12]);
      b.put("bench", [16, 3]);
      b.put("redFlowers", [22, 8], [26, 8], [7, 11], [19, 10]);
      b.put("leafyBush", [23, 8], [8, 6], [11, 11], [24, 13]);
      return b.plan;
    }
    case "showcase-map-animations": {
      // Waterside shrine: twin pools flank a paved court with a fountain.
      const b = hallExit(new PlanBuilder(map, true), "stone");
      b.area("water", 3, 3, 6, 3).area("water", 22, 3, 5, 3);
      b.area("stone", 11, 3, 9, 8).area("stone", 3, 13, 13, 2).area("stone", 14, 11, 3, 2);
      b.put("fountain", [14, 3]);
      b.put("statue", [11, 3], [18, 3]);
      b.put("bench", [21, 11]);
      b.put("redFlowers", [4, 8], [9, 8], [26, 8]);
      b.put("leafyBush", [5, 8], [21, 8], [25, 8]);
      b.put("tree", [26, 12], [6, 10]);
      return b.plan;
    }
    case "showcase-movement-controls": {
      // Terraced park: three walking lanes joined by short paths.
      const b = hallExit(new PlanBuilder(map, true));
      b.area("dirt", 3, 3, 15, 2).area("dirt", 11, 5, 3, 2).area("dirt", 11, 7, 11, 3);
      b.area("dirt", 14, 10, 3, 3).area("dirt", 3, 13, 13, 2);
      b.put("hedgeRow", [3, 7], [5, 7], [24, 11], [26, 11]);
      b.put("hedge", [7, 7], [23, 11]);
      b.put("tree", [20, 2], [26, 4], [24, 13], [7, 10]);
      b.put("rocks", [19, 12]);
      b.put("redFlowers", [22, 2], [9, 11]);
      b.put("leafyBush", [23, 6], [4, 10]);
      return b.plan;
    }
    case "showcase-shop": {
      // Open-air market: two stalls behind a cobbled square.
      const b = hallExit(new PlanBuilder(map, true), "stone");
      b.area("stone", 3, 6, 24, 9);
      b.put("marketStall", [2, 0], [23, 0]);
      b.put("jugTable", [9, 4]);
      b.put("produceYellow", [12, 4]);
      b.put("produceGreen", [13, 4]);
      b.put("produceRed", [14, 4]);
      b.put("crate", [18, 4]);
      b.put("barrels", [19, 4]);
      b.put("barrel", [20, 4]);
      b.put("sack", [10, 12]);
      b.put("pottedVine", [21, 12], [8, 9]);
      b.put("bench", [18, 11]);
      b.put("tree", [28, 12], [28, 7]);
      return b.plan;
    }
    case "hall-streaming": {
      // Forest trail: a river through both map edges and a plank crossing.
      // Trail ends stop two cells short of the banks so each edge keeps a
      // single Tuxemon transition family.
      const b = hallExit(new PlanBuilder(map, true));
      b.area("water", 13, 0, 2, 17);
      b.area("dirt", 3, 13, 8, 2).area("dirt", 9, 8, 2, 5);
      b.area("dirt", 17, 8, 2, 2).area("dirt", 17, 4, 2, 4).area("dirt", 19, 4, 7, 2);
      // The upper crossing joins the trail; the lower one carries the entry row.
      b.put("plankBridge", [13, 7], [13, 13]);
      b.put("pine", [3, 3], [6, 5], [20, 9], [24, 12], [26, 8], [4, 9]);
      b.put("tree", [9, 2], [21, 1], [26, 1]);
      b.put("stump", [6, 10]);
      b.put("rocks", [21, 13]);
      b.put("leafyBush", [7, 3], [23, 8]);
      return b.plan;
    }
    case "hall-attract": {
      // Formal garden: a cobbled loop around twin pools and a statue.
      const b = hallExit(new PlanBuilder(map, true), "stone");
      b.area("stone", 2, 1, 26, 2).area("stone", 2, 12, 26, 2);
      b.area("stone", 2, 3, 2, 9).area("stone", 26, 3, 2, 9).area("stone", 14, 8, 3, 4);
      b.area("water", 7, 5, 5, 3).area("water", 19, 5, 5, 3);
      b.put("statue", [14, 4]);
      b.put("redFlowers", [13, 5], [17, 5]);
      b.put("hedgeRow", [5, 10]);
      b.put("hedge", [7, 10]);
      b.put("bench", [9, 10]);
      b.put("tree", [21, 9]);
      return b.plan;
    }
    case "showcase-battle": {
      // Training arena: a paved ring watched from benches and statues.
      const b = hallExit(new PlanBuilder(map, true), "stone");
      b.area("stone", 5, 3, 20, 10).area("stone", 3, 13, 3, 2);
      b.put("statue", [5, 3], [23, 3]);
      b.put("bench", [8, 3], [19, 3]);
      b.put("tree", [1, 1], [27, 1], [27, 13]);
      b.put("redFlowers", [2, 6], [27, 6]);
      b.put("leafyBush", [2, 9], [27, 9]);
      return b.plan;
    }
    case "showcase-runtime-visuals": {
      // Costume workshop.
      const b = hallExit(new PlanBuilder(map, false, "sandstone"));
      b.rug(11, 5, 8, 6);
      b.put("cabinet", [2, 2], [25, 2]);
      b.put("dresser", [6, 2]);
      b.put("bed", [21, 2]);
      b.put("table", [3, 9]);
      b.put("plant", [10, 3], [19, 3]);
      b.put("lowBench", [21, 13]);
      b.put("fieldPainting", [13, 0]);
      return b.plan;
    }
    case "showcase-extensions": {
      // Oracle's salon.
      const b = hallExit(new PlanBuilder(map, false, "brick"));
      b.rug(11, 5, 9, 6);
      b.put("medallion", [14, 6]);
      b.put("bookshelf", [2, 2], [25, 2]);
      b.put("fireplace", [21, 0]);
      b.put("clothTable", [3, 9], [21, 11]);
      b.put("plant", [9, 3], [19, 3]);
      b.put("nightPainting", [13, 0]);
      return b.plan;
    }
    case "hall-theme": {
      // Portrait library.
      const b = hallExit(new PlanBuilder(map, false, "brick"));
      b.rug(11, 6, 8, 5);
      b.put("bookshelf", [2, 2], [7, 2], [20, 2], [25, 2]);
      b.put("table", [13, 3]);
      b.put("lowBench", [3, 11], [22, 12]);
      b.put("plant", [11, 3], [18, 3]);
      b.put("forestPainting", [11, 0], [17, 0]);
      b.put("window", [14, 0]);
      return b.plan;
    }
    case "showcase-input-and-idle": {
      // Small theatre: a stage rug, footlights and audience benches.
      const b = hallExit(new PlanBuilder(map, false, "brick"));
      b.rug(8, 3, 14, 5);
      b.put("lamp", [9, 7], [20, 7]);
      b.put("fireplace", [3, 0], [25, 0]);
      b.put("lowBench", [5, 10], [9, 11], [20, 10], [24, 12]);
      b.put("plant", [7, 3], [22, 3]);
      b.put("nightPainting", [14, 0]);
      return b.plan;
    }
    case "hall-save": {
      // Post office: counters, shelving and a waiting bench.
      const b = hallExit(new PlanBuilder(map, false, "sandstone"));
      b.put("counter", [9, 3], [19, 3]);
      b.put("bookshelf", [2, 2], [25, 2]);
      b.put("sideboard", [12, 2]);
      b.put("table", [10, 11]);
      b.put("lowBench", [21, 12]);
      b.put("plant", [17, 3], [23, 13]);
      b.put("window", [5, 0], [23, 0]);
      return b.plan;
    }
    case "hall-audio": {
      // Listening room.
      const b = hallExit(new PlanBuilder(map, false, "sandstone"));
      b.rug(9, 3, 12, 5);
      b.put("fireplace", [14, 0]);
      b.put("clothTable", [3, 4], [24, 4]);
      b.put("lowBench", [9, 11], [18, 11]);
      b.put("lamp", [10, 4], [19, 4]);
      b.put("plant", [8, 3], [21, 3]);
      b.put("fieldPainting", [5, 0], [23, 0]);
      b.put("musicNote", [12, 5], [17, 5], [6, 7]);
      return b.plan;
    }
    case "hall-registration": {
      // Registration office: desks flank the registrar's open counter.
      const b = hallExit(new PlanBuilder(map, false, "sandstone"));
      b.rug(13, 10, 5, 5);
      b.put("sideboard", [8, 9], [11, 9], [17, 9], [20, 9]);
      b.put("bookshelf", [2, 2], [25, 2], [9, 2], [18, 2]);
      b.put("lowBench", [3, 11], [23, 12]);
      b.put("plant", [7, 3], [22, 3]);
      b.put("window", [14, 0]);
      return b.plan;
    }
  }
  throw new Error(`showcase art: no plan for map ${map.id}`);
}

export function showcaseMapPlan(map: MapDef): ShowcaseMapPlan {
  return map.id === "showcase-lobby" ? lobbyPlan(map) : hallPlan(map);
}

// ---------------------------------------------------------------------------
// Terrain autotiling.
// ---------------------------------------------------------------------------

export type TerrainTile =
  | { kind: "grass" }
  | { kind: "solid"; family: TerrainKind; tile: readonly [number, number] }
  | { kind: "edge"; family: TerrainKind; tile: readonly [number, number] };

/**
 * Pick the Tuxemon transition tile for one cell.  Cells outside the map read
 * as their nearest edge cell so terrain can continue through the border.
 * Throws for a grass cell that would need two families or an impossible
 * neighbourhood (terrain on opposite sides, two diagonal-only neighbours).
 */
export function showcaseTerrainTile(plan: ShowcaseMapPlan, cx: number, cy: number): TerrainTile {
  const at = (x: number, y: number): TerrainKind | null => {
    const clampedX = Math.min(plan.width - 1, Math.max(0, x));
    const clampedY = Math.min(plan.height - 1, Math.max(0, y));
    return plan.terrain[clampedY * plan.width + clampedX] ?? null;
  };
  const own = at(cx, cy);
  if (own) {
    const family = TERRAIN_FAMILIES[own];
    return { kind: "solid", family: own, tile: [family.block[0] + TILE, family.block[1] + TILE] };
  }
  const families = new Set<TerrainKind>();
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const kind = at(cx + dx, cy + dy);
      if (kind) families.add(kind);
    }
  }
  if (families.size === 0) return { kind: "grass" };
  if (families.size > 1) throw new Error(`showcase terrain: cell ${cx},${cy} touches ${[...families].join(" and ")}`);
  const kind = [...families][0]!;
  const family = TERRAIN_FAMILIES[kind];
  const has = (dx: number, dy: number) => at(cx + dx, cy + dy) === kind;
  const n = has(0, -1), s = has(0, 1), w = has(-1, 0), e = has(1, 0);
  const nw = has(-1, -1), ne = has(1, -1), sw = has(-1, 1), se = has(1, 1);
  const bad = () => new Error(`showcase terrain: cell ${cx},${cy} has no ${kind} transition tile`);
  const ring = (col: number, row: number): TerrainTile => ({
    kind: "edge",
    family: kind,
    tile: [family.block[0] + col * TILE, family.block[1] + row * TILE],
  });
  const inner = (tile: readonly [number, number]): TerrainTile => ({ kind: "edge", family: kind, tile });
  if ((n && s) || (e && w)) throw bad();
  if (n && w) { if (se) throw bad(); return inner(family.innerNW); }
  if (n && e) { if (sw) throw bad(); return inner(family.innerNE); }
  if (s && w) { if (ne) throw bad(); return inner(family.innerSW); }
  if (s && e) { if (nw) throw bad(); return inner(family.innerSE); }
  if (s) { if (nw || ne) throw bad(); return ring(1, 0); }
  if (n) { if (sw || se) throw bad(); return ring(1, 2); }
  if (e) { if (nw || sw) throw bad(); return ring(0, 1); }
  if (w) { if (ne || se) throw bad(); return ring(2, 1); }
  if ([nw, ne, sw, se].filter(Boolean).length > 1) throw bad();
  if (se) return ring(0, 0);
  if (sw) return ring(2, 0);
  if (ne) return ring(0, 2);
  return ring(2, 2);
}

/** The 3x3 rug slice for one cell inside a rug rectangle. */
export function rugTile(rug: { x: number; y: number; width: number; height: number }, cx: number, cy: number): readonly [number, number] {
  const col = cx === rug.x ? 0 : cx === rug.x + rug.width - 1 ? 2 : 1;
  const row = cy === rug.y ? 0 : cy === rug.y + rug.height - 1 ? 2 : 1;
  return [RUG_BLOCK[0] + col * TILE, RUG_BLOCK[1] + row * TILE];
}

/** The terrain-only ground layer: grass/floor, autotiled terrain, walls and rugs. */
export function showcaseTerrainLayer(plan: ShowcaseMapPlan): Bitmap {
  const out = blank(plan.width * TILE, plan.height * TILE);
  const grass = sheetTile("city", GRASS_TILE);
  const floor = sheetTile("interior", FLOOR_TILES[plan.floor]);
  for (let cy = 0; cy < plan.height; cy++) {
    for (let cx = 0; cx < plan.width; cx++) {
      const x = cx * TILE;
      const y = cy * TILE;
      if (!plan.outdoor) {
        if (cy < plan.wallRows) {
          const wall = crop(showcaseSheet("interior"),
            WALL_BLOCK.x + (cx * TILE) % WALL_BLOCK.width, WALL_BLOCK.y + cy * TILE, TILE, TILE);
          draw(out, wall, x, y);
        } else {
          draw(out, floor, x, y);
        }
        continue;
      }
      const tile = showcaseTerrainTile(plan, cx, cy);
      if (tile.kind === "grass") {
        draw(out, grass, x, y);
        continue;
      }
      const family = TERRAIN_FAMILIES[tile.family];
      if (family.underlay) draw(out, grass, x, y);
      draw(out, sheetTile(family.sheet, tile.tile), x, y);
    }
  }
  for (const rug of plan.rugs) {
    for (let cy = rug.y; cy < rug.y + rug.height; cy++) {
      for (let cx = rug.x; cx < rug.x + rug.width; cx++) {
        draw(out, sheetTile("interior", rugTile(rug, cx, cy)), cx * TILE, cy * TILE);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Door plaques, lettered with the same baked font atlas the runtime uses.
// ---------------------------------------------------------------------------

export const PLAQUE_FONT_PX = 12;
const PLAQUE_HEIGHT = 15;
const PLAQUE_INK: readonly [number, number, number] = [55, 31, 52];

interface Glyphs {
  cellW: number;
  cellH: number;
  baseline: number;
  glyph: Map<number, { advance: number; xoff: number; coverage: Uint8Array }>;
}

let glyphCache: Glyphs | undefined;

/** Bake the plaque font slot exactly as a PocketJS app build does; call once before drawing. */
export async function prepareShowcaseArt(): Promise<void> {
  if (glyphCache) return;
  const [atlas] = await bakeAtlases({ codepoints: [], slots: [fontSlotFor(PLAQUE_FONT_PX, true)] });
  const bytes = atlas!.bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(6, true);
  const cellW = bytes[8]!;
  const cellH = bytes[9]!;
  const coverageStart = 16 + count * 8;
  const glyph = new Map<number, { advance: number; xoff: number; coverage: Uint8Array }>();
  for (let i = 0; i < count; i++) {
    const at = 16 + i * 8;
    const gid = view.getUint16(at + 4, true);
    const offset = coverageStart + gid * cellW * cellH;
    glyph.set(view.getUint32(at, true), {
      advance: bytes[at + 6]!,
      xoff: bytes[at + 7]!,
      coverage: bytes.subarray(offset, offset + cellW * cellH),
    });
  }
  glyphCache = { cellW, cellH, baseline: bytes[10]!, glyph };
}

function plaqueGlyphs(): Glyphs {
  if (!glyphCache) throw new Error("showcase art: call prepareShowcaseArt() before drawing plaques");
  return glyphCache;
}

/** A small wooden board carrying `label` in the game's bold 12px face. */
export function showcasePlaque(label: string): Bitmap {
  const glyphs = plaqueGlyphs();
  const textWidth = [...label].reduce((sum, ch) => sum + glyphs.glyph.get(ch.codePointAt(0)!)!.advance, 0);
  const width = textWidth + 8;
  const out = blank(width, PLAQUE_HEIGHT);
  for (let y = 0; y < PLAQUE_HEIGHT; y++) {
    for (let x = 0; x < width; x++) {
      const corner = (x === 0 || x === width - 1) && (y === 0 || y === PLAQUE_HEIGHT - 1);
      if (corner) continue;
      const edge = x === 0 || y === 0 || x === width - 1 || y === PLAQUE_HEIGHT - 1;
      const colour = edge ? [61, 35, 35] : y === 1 ? [222, 164, 92] : [190, 128, 66];
      out.rgba.set([...colour, 255], (y * width + x) * 4);
    }
  }
  let pen = 4;
  const top = Math.floor((PLAQUE_HEIGHT - glyphs.cellH) / 2) + 1;
  for (const ch of label) {
    const g = glyphs.glyph.get(ch.codePointAt(0)!)!;
    for (let gy = 0; gy < glyphs.cellH; gy++) {
      for (let gx = 0; gx < glyphs.cellW; gx++) {
        const alpha = g.coverage[gy * glyphs.cellW + gx]!;
        const px = pen - g.xoff + gx;
        const py = top + gy;
        if (alpha === 0 || px <= 0 || py <= 0 || px >= width - 1 || py >= PLAQUE_HEIGHT - 1) continue;
        const ink = new Uint8Array([...PLAQUE_INK, alpha]);
        over(out.rgba, (py * width + px) * 4, ink, 0);
      }
    }
    pen += g.advance;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Final layers.
// ---------------------------------------------------------------------------

export interface ShowcaseMapLayers {
  ground: Bitmap;
  upper: Bitmap;
}

/** Pixel rectangle covered by one placed object. */
export function placementRect(placement: ObjectPlacement): { x: number; y: number; width: number; height: number } {
  const object = SHOWCASE_OBJECTS[placement.object];
  return {
    x: placement.x * TILE + object.anchor[0],
    y: placement.y * TILE + object.anchor[1],
    width: object.rect[2],
    height: object.rect[3],
  };
}

export function showcaseMapLayers(map: MapDef, plan = showcaseMapPlan(map)): ShowcaseMapLayers {
  const ground = showcaseTerrainLayer(plan);
  const upper = blank(ground.width, ground.height);
  for (const placement of plan.objects) {
    const object = SHOWCASE_OBJECTS[placement.object];
    const pixels = showcaseObjectPixels(placement.object);
    const rect = placementRect(placement);
    // Rows above the cut sit on the upper layer; the cut is a footprint row
    // boundary expressed in the rectangle's own pixel rows.
    const cut = object.upper * TILE - object.anchor[1];
    draw(upper, pixels, rect.x, rect.y, 0, cut);
    draw(ground, pixels, rect.x, rect.y, cut);
  }
  for (const plaque of plan.plaques) {
    const board = showcasePlaque(plaque.label);
    draw(upper, board, plaque.x - Math.floor(board.width / 2), plaque.y - board.height);
  }
  return { ground, upper };
}

export function showcaseMapArt(map: MapDef): { ground: Uint8Array; upper: Uint8Array } {
  const layers = showcaseMapLayers(map);
  return { ground: layers.ground.rgba, upper: layers.upper.rgba };
}

/**
 * Authoring rules for one plan: every prop stands on its declared ground,
 * stays whole inside the map, overlaps no other prop or plaque, and leaves
 * every event cell clear except an archway's declared passage.
 */
export function showcasePlanProblems(map: MapDef, plan = showcaseMapPlan(map)): string[] {
  const problems: string[] = [];
  const width = plan.width * TILE;
  const height = plan.height * TILE;
  const boxes: { name: string; x: number; y: number; width: number; height: number }[] = [];
  const blocked = new Map<string, string>();
  for (const placement of plan.objects) {
    const object = SHOWCASE_OBJECTS[placement.object];
    const name = `${placement.object}@${placement.x},${placement.y}`;
    const rect = placementRect(placement);
    if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > width || rect.y + rect.height > height) {
      problems.push(`${name} is clipped by the map edge`);
    }
    boxes.push({ name, ...rect });
    const passable = new Set((object.passable ?? []).map(([c, r]) => `${c},${r}`));
    for (let row = 0; row < object.rows; row++) {
      for (let col = 0; col < object.cols; col++) {
        const cx = placement.x + col;
        const cy = placement.y + row;
        if (!passable.has(`${col},${row}`)) blocked.set(`${cx},${cy}`, name);
        if (cx < 0 || cy < 0 || cx >= plan.width || cy >= plan.height) continue;
        const ground = groundAt(plan, cx, cy);
        // Tall furniture may lean its upper rows over the wall behind it.
        const ok = object.on === "any" ? ground !== "water"
          : object.on === "paved" ? ground === "paved"
          : object.on === "floor"
            ? ground === "floor" || ground === "rug" || ground === "rugEdge" || (row < object.upper && ground === "wall")
          : ground === object.on;
        if (!ok) problems.push(`${name} needs ${object.on} but cell ${cx},${cy} is ${ground}`);
      }
    }
  }
  for (const plaque of plan.plaques) {
    const board = showcasePlaque(plaque.label);
    boxes.push({
      name: `plaque ${plaque.label}`,
      x: plaque.x - Math.floor(board.width / 2),
      y: plaque.y - board.height,
      width: board.width,
      height: board.height,
    });
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) {
        problems.push(`${a.name} overlaps ${b.name}`);
      }
    }
  }
  for (const event of map.events ?? []) {
    const owner = blocked.get(`${event.x},${event.y}`);
    if (owner) problems.push(`event ${event.id} at ${event.x},${event.y} stands inside ${owner}`);
  }
  return problems;
}

/** Ground class of one cell: plain grass, an autotile edge, paving, water, floor, rug interior or edge, or wall. */
export function groundAt(
  plan: ShowcaseMapPlan,
  cx: number,
  cy: number,
): "grass" | "edge" | "paved" | "water" | "floor" | "rug" | "rugEdge" | "wall" {
  if (!plan.outdoor) {
    if (cy < plan.wallRows) return "wall";
    const rug = plan.rugs.find((r) => cx >= r.x && cy >= r.y && cx < r.x + r.width && cy < r.y + r.height);
    if (!rug) return "floor";
    const edge = cx === rug.x || cy === rug.y || cx === rug.x + rug.width - 1 || cy === rug.y + rug.height - 1;
    return edge ? "rugEdge" : "rug";
  }
  const tile = showcaseTerrainTile(plan, cx, cy);
  if (tile.kind === "grass") return "grass";
  if (tile.kind === "edge") return "edge";
  return tile.family === "water" ? "water" : "paved";
}
