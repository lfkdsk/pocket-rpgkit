// examples/grow/grow.ts — deterministic rightward settlement growth.
//
// The 4,096-column backing strip is divided into 32-column chapters. A
// chapter advances its trunk to a crossroads, grows a biome-specific center,
// road-facing houses, an outer work area, and residents, then releases the
// trunk toward the next chapter. Ambient wilderness is coordinate-hashed
// from the seed and is removed wherever development paints a cell.
//
// Those are the stamp rules (STAMP_PARAMS). The demo's DEFAULT_PARAMS run the
// causal rules of grow-causal.ts instead: villages with needs, roads worn by
// footfall, trade, decline and an event record (see README.md).
//
// Do not import host APIs here: this is a pure reducer.

import { rngNext } from "../../src/engine/interpreter.ts";
import type { MoveStep } from "../../src/engine/types.ts";
import { HOUSE_STAMPS, STAMPS, stampCell, stampOfCell, stampOwner } from "./grow-stamps.ts";
import {
  causalHashMix, causalSummary, causalTick, copyCausal, createCausalWorld, DEFAULT_CAUSAL,
  type CausalParams, type CausalSim,
} from "./grow-causal.ts";

export type Dir4 = 0 | 1 | 2 | 3;
export const DX = [0, -1, 0, 1] as const;
export const DY = [1, 0, -1, 0] as const;
const DIR_STEP: readonly MoveStep[] = ["moveDown", "moveLeft", "moveUp", "moveRight"];

export type GrowPhase = "road" | "house" | "farm" | "villager" | "decor" | "sim" | "done";
export type GrowBiome = 0 | 1 | 2 | 3; // grass, mud, sand, snow
export type SettlementStage = "road" | "center" | "house" | "industry" | "villager" | "done";

/** Semantic overlay ids consumed by grow-project.ts and assets-grow.ts. */
export const GROW_TILE = {
  ROAD_H: 1, ROAD_V: 2, ROAD_CROSS: 3, PLAZA: 4, FARM_A: 5, FARM_B: 6,
  BRIDGE_H: 7, WATER: 8, FLOWERS: 9, ORCHARD: 10, WORK_YARD: 11, OASIS: 12,
  WINTER_PLOT: 13, MARKET_RUG: 14, BANK_L: 15, BANK_R: 16,
  ROOF_L: 20, ROOF_M: 21, ROOF_R: 22, WALL_L: 23, DOOR: 24, WALL_R: 25,
  FENCE_H: 26, FENCE_V: 27, TREE: 28, BUSH: 29,
  WELL: 30, NOTICE: 31, LOGS: 32, ROCK: 33, PALM: 34, CACTUS: 35, FIR: 36,
  FIREWOOD: 37, TENT_L: 38, TENT_M: 39, TENT_R: 40, STALL: 41, FLOWER_PROP: 42,
  GRASS_TUFT: 43, SNOW_SHRUB: 44, BRIDGE_RAIL: 45,
  TENT_WALL_L: 70, TENT_DOOR: 71, TENT_WALL_R: 72,
  SNOW_ROOF_L: 73, SNOW_ROOF_M: 74, SNOW_ROOF_R: 75,
  SNOW_WALL_L: 76, SNOW_DOOR: 77, SNOW_WALL_R: 78,
  // Causal world (grow-causal.ts): ground worn by feet in each biome, paved
  // road, quarried/ruined floor, and the collapsed walls of abandoned homes.
  WORN_GRASS: 79, WORN_MUD: 80, WORN_SAND: 81, WORN_SNOW: 82,
  PATH_STONE: 83, GRAVEL: 84,
  RUIN_L: 85, RUIN_M: 86, RUIN_R: 87, RUBBLE: 88,
} as const;

export interface GrowParams {
  seed: number;
  /** Backing-store width. 4,096 columns is treated as unbounded by the demo. */
  width: number;
  height: number;
  tickSeconds: number;
  roadCells: number;
  houseCount: number;
  farmPatches: number;
  branchProb: number;
  bendProb: number;
  initialRoads: number;
  villagerRouteLen: number;
  decorPatches: number;
  /** One settlement chapter and biome band span this many columns. */
  biomeBandWidth: number;
  /** Settlements grown before the world settles (one per biome band). */
  settlements: number;
  /** PSP camera lead. Wider viewports derive a 60% frontier position. */
  cameraLeadPx: number;
  /**
   * Causal rules (grow-causal.ts): settlements with needs, worn roads,
   * trade, decline and an event record. Absent: the original stamp rules.
   */
  causal?: CausalParams;
}

/** The original rules: each chapter stamps road, center, houses, work area. */
export const STAMP_PARAMS: GrowParams = {
  seed: 0x5eed_0001, width: 4096, height: 33, tickSeconds: 0.2,
  roadCells: 600, houseCount: 64, farmPatches: 4, branchProb: 0.38, bendProb: 0.3,
  initialRoads: 1, villagerRouteLen: 24, decorPatches: 16,
  biomeBandWidth: 32, settlements: 4, cameraLeadPx: 288,
};

/**
 * The demo's world: the same strip and biomes under the causal rules. Its
 * seed shows the whole arc: a trade lifeline wears a road to the snow
 * village, the trade falls silent, and a later famine empties it.
 */
export const DEFAULT_PARAMS: GrowParams = { ...STAMP_PARAMS, seed: 0x5eed_0022, causal: DEFAULT_CAUSAL };

export function tickEveryFrames(p: GrowParams, hz: number): number {
  return Math.max(1, Math.round(p.tickSeconds * hz));
}
export function liveFrameAtTick(p: GrowParams, hz: number, tick: number): number {
  return tick * p.tickSeconds * hz;
}

export interface GrowTip { x: number; y: number; dir: Dir4 }
export interface GrowHouse {
  x: number; y: number; door: Dir4; variant: number; villager: number;
  /** Causal rules: owning settlement, stamp origin, and when it fell empty or into ruin. */
  owner?: number; x0?: number; top?: number; key?: string; vacant?: number; ruined?: number;
}
export interface GrowFarm { x: number; y: number; biome?: GrowBiome; kind?: number; centerX?: number }
export interface GrowVillager { x: number; y: number; dir: Dir4; route: MoveStep[]; house: number; left?: number }
export interface GrowSettlement {
  chapter: number; biome: GrowBiome; centerX: number; centerY: number; stage: SettlementStage;
  roadStartX: number; roadEndX: number; houses: number; industries: number; villagers: number;
}

export interface GrowState {
  frame: number; hz: number; tick: number; phase: GrowPhase; rng: number; params: GrowParams;
  ground: Int32Array; upper: Int32Array; road: Uint8Array; tips: GrowTip[];
  /** Causal rules: footfall per cell (absent under the stamp rules). */
  wear?: Uint16Array;
  /** Causal rules: settlements, trade, regrowth and the event record. */
  sim?: CausalSim;
  roads: { x: number; y: number }[]; houses: GrowHouse[]; farms: GrowFarm[];
  villagers: GrowVillager[]; decor: number[]; chapter: number;
  frontierX: number; roadFrontierX: number; cameraFromX: number; cameraX: number; grew: boolean;
}

const START_X = 8;
const TILE = 16;
const VIEW_W = 480;
const ROAD_Y_MIN = 4;

function roadYMax(p: GrowParams): number { return Math.max(ROAD_Y_MIN, p.height - 5); }
function hutYMin(p: GrowParams): number { return Math.min(2, Math.max(0, p.height - 2)); }
function hutYMax(p: GrowParams): number { return Math.max(hutYMin(p), p.height - 3); }

export function plazaCenter(p: GrowParams): { x: number; y: number } {
  return { x: Math.min(START_X, p.width - 5), y: Math.floor(p.height / 2) };
}

/** Hash only presentation/world coordinates; it does not consume reducer RNG. */
export function growHash(seed: number, x: number, y: number, salt = 0): number {
  let h = (seed ^ Math.imul(x + 0x9e37, 0x85eb_ca6b) ^ Math.imul(y + 0x7f4a, 0xc2b2_ae35) ^ salt) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb_352d); h ^= h >>> 15; h = Math.imul(h, 0x846c_a68b);
  return (h ^ (h >>> 16)) >>> 0;
}

const CACHE_EMPTY = 0xffff;
interface GrowParamCache {
  boundaries: Map<number, Int32Array>;
  bands: Uint16Array;
  natural: Uint16Array;
}
const paramCaches = new WeakMap<GrowParams, GrowParamCache>();

function paramCache(p: GrowParams): GrowParamCache {
  let cache = paramCaches.get(p);
  if (cache) return cache;
  cache = {
    boundaries: new Map(),
    bands: new Uint16Array(p.width * p.height).fill(CACHE_EMPTY),
    natural: new Uint16Array(p.width * p.height).fill(CACHE_EMPTY),
  };
  paramCaches.set(p, cache);
  return cache;
}

/** The seam meanders by -2..2 cells and adjacent rows change by at most one. */
export function biomeBoundaryX(p: GrowParams, boundary: number, y: number): number {
  const center = boundary * Math.max(1, p.biomeBandWidth);
  if (y >= 0 && y < p.height) {
    const cache = paramCache(p);
    let rows = cache.boundaries.get(boundary);
    if (!rows) {
      rows = new Int32Array(p.height);
      let offset = (growHash(p.seed, boundary, 0, 0x51ea) % 5) - 2;
      for (let row = 0; row < p.height; row++) {
        if (row > 0) {
          const step = (growHash(p.seed, boundary, row, 0xb0ad) % 3) - 1;
          offset = Math.max(-2, Math.min(2, offset + step));
        }
        rows[row] = center + offset;
      }
      cache.boundaries.set(boundary, rows);
    }
    return rows[y]!;
  }
  let offset = (growHash(p.seed, boundary, 0, 0x51ea) % 5) - 2;
  for (let row = 1; row <= Math.max(0, y); row++) {
    const step = (growHash(p.seed, boundary, row, 0xb0ad) % 3) - 1;
    offset = Math.max(-2, Math.min(2, offset + step));
  }
  return center + offset;
}

export function biomeBandAt(p: GrowParams, x: number, y = Math.floor(p.height / 2)): number {
  const inCache = x >= 0 && x < p.width && y >= 0 && y < p.height;
  const cache = inCache ? paramCache(p) : undefined;
  const index = inCache ? y * p.width + x : -1;
  const cached = cache?.bands[index];
  if (cached !== undefined && cached !== CACHE_EMPTY) return cached;
  let band = Math.max(0, Math.floor(Math.max(0, x) / Math.max(1, p.biomeBandWidth)));
  while (band > 0 && x < biomeBoundaryX(p, band, y)) band--;
  while (x >= biomeBoundaryX(p, band + 1, y)) band++;
  if (cache) cache.bands[index] = band;
  return band;
}
export function biomeAt(p: GrowParams, x: number, y = Math.floor(p.height / 2)): GrowBiome {
  return (biomeBandAt(p, x, y) % 4) as GrowBiome;
}
export function biomeTransitionKind(p: GrowParams, x: number, y = Math.floor(p.height / 2)): "fill" | "transition" | "blend" | "fringe" {
  const band = biomeBandAt(p, x, y);
  const distance = x - biomeBoundaryX(p, band, y);
  return band > 0 && distance >= 0 && distance < 3 ? (["transition", "blend", "fringe"] as const)[distance]! : "fill";
}

// ---------------------------------------------------------------------------
// Wilderness. A smooth forest field decides where woods, edges, meadows and
// clearings are, so trees gather into groves with open ground between them
// instead of a uniform wallpaper. Everything is a pure hash of (seed, x, y):
// it never consumes reducer RNG, and construction only hides it.

function lattice(seed: number, ix: number, iy: number, salt: number): number {
  return (growHash(seed, ix, iy, salt) % 10007) / 10006;
}
/** Smoothstep-interpolated value noise in [0, 1]. */
function valueNoise(seed: number, x: number, y: number, scale: number, salt: number): number {
  const fx = x / scale, fy = y / scale;
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const tx = fx - ix, ty = fy - iy;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const a = lattice(seed, ix, iy, salt), b = lattice(seed, ix + 1, iy, salt);
  const c = lattice(seed, ix, iy + 1, salt), d = lattice(seed, ix + 1, iy + 1, salt);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
function smooth01(e0: number, e1: number, v: number): number {
  const t = Math.max(0, Math.min(1, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
/** 0 inside a settlement's clearing, 1 in open country. */
function clearingFactor(p: GrowParams, x: number, y: number): number {
  // Causal settlers clear their own ground (logging, building, fields).
  if (p.causal) return 1;
  const chapter = Math.max(0, Math.round((x - START_X - 8) / Math.max(1, p.biomeBandWidth)));
  const cx = settlementCenterX(p, chapter);
  const cy = Math.floor(p.height / 2);
  const dx = (x - cx + 3) / 1.25, dy = (y - cy) * 1.1;
  return smooth01(8, 15, Math.sqrt(dx * dx + dy * dy));
}
/** Forest density in [0, 1]: two octaves, thinned inside settlement clearings. */
export function forestDensity(p: GrowParams, x: number, y: number): number {
  const f = 0.68 * valueNoise(p.seed, x, y, 11, 0xf0e5) + 0.32 * valueNoise(p.seed, x, y, 4.5, 0x1ea7);
  return f * (0.55 + 0.45 * clearingFactor(p, x, y));
}

type Pick = readonly (readonly [string, number])[];
function pick(list: Pick, r: number): string {
  let total = 0; for (const [, w] of list) total += w;
  let at = r * total;
  for (const [key, w] of list) { if (at < w) return key; at -= w; }
  return list[list.length - 1]![0];
}
// Per-biome species: canopy trees, woodland edge, meadow dressing, stray bits.
const WOOD: readonly Pick[] = [
  [["tree-round", 5], ["tree-round-b", 4], ["tree-round-c", 3], ["tree-pine", 3], ["tree-cherry", 0.35]],
  [["tree-pine", 6], ["tree-round-c", 1.2], ["tree-dead", 2.4], ["stump-big", 0.3], ["boulder-brown", 0.4]],
  [["palm", 5], ["palm-b", 4], ["boulder-brown", 0.8]],
  [["tree-snowpine", 5], ["tree-snowpine-moss", 3], ["tree-snowround", 2], ["bush-snow", 0.8]],
];
const EDGE: readonly Pick[] = [
  [["bush-a", 3], ["bush-b", 3], ["bush-c", 2], ["tuft-b", 1]],
  [["bush-c", 3], ["stump", 1.5], ["rock-brown", 1.5], ["twig", 0.6]],
  [["tuft-c", 2], ["rock-brown", 2]],
  [["snow-round", 3], ["snow-grass", 2], ["snow-rock", 1.5]],
];
const MEADOW: readonly Pick[] = [
  [["flower-sun", 2], ["flower-sun-b", 1.5], ["flower-daisy", 2], ["clover", 2], ["tuft-a", 2.5], ["tuft-c", 2]],
  [["tuft-b", 3], ["clover", 1.5], ["leaves", 0.6]],
  [["tuft-c", 2], ["rock-brown", 0.5]],
  [["snow-grass", 3], ["snow-grass-b", 3], ["snowball", 1]],
];
const STRAY: readonly Pick[] = [
  [["rock-grey", 1], ["tuft-a", 2], ["bush-b", 1]],
  [["rock-brown", 2], ["stump", 1]],
  [["rock-brown", 2], ["tuft-c", 1]],
  [["snow-rock", 2], ["snowball", 1]],
];
const WOOD_THRESHOLD = 0.5, EDGE_THRESHOLD = 0.39, MEADOW_THRESHOLD = 0.56;

/** Block origin: odd block rows shift one cell so canopies stagger, not grid. */
function blockOrigin(bx: number, by: number): { x0: number; y0: number } {
  return { x0: bx * 2 + (by & 1), y0: 1 + by * 2 };
}
/** What one 2x2 wilderness block holds: a stamp and its top-left cell. */
function blockStamp(p: GrowParams, bx: number, by: number): { key: string; x: number; y: number } | undefined {
  const { x0, y0 } = blockOrigin(bx, by);
  if (x0 < 1 || x0 + 1 >= p.width - 1 || y0 + 1 > p.height - 2) return undefined;
  const h = growHash(p.seed, bx, by, 0xb10c);
  const r = (h % 10007) / 10007, jitter = ((h >>> 14) % 10007) / 10007;
  const biome = biomeAt(p, x0, y0 + 1);
  // Species follow slow patches (a pine wood, a dead wood) with a little mixing.
  const patch = valueNoise(p.seed, x0, y0, 9, 0x5bec);
  const species = Math.min(0.9999, Math.max(0, 0.78 * patch + 0.22 * jitter));
  const sparse = biome === 2 ? 0.8 : 1; // the desert stays open
  const d = forestDensity(p, x0 + 1, y0 + 1) * sparse;
  const cell = h >>> 28; // which cell of the block a 1x1 item sits in
  const one = (key: string) => ({ key, x: x0 + (cell & 1), y: y0 + ((cell >> 1) & 1) });
  if (d >= WOOD_THRESHOLD) {
    if (r < 0.84) return { key: pick(WOOD[biome]!, species), x: x0, y: y0 };
    return r < 0.9 ? one(pick(EDGE[biome]!, jitter)) : undefined;
  }
  if (d >= EDGE_THRESHOLD) {
    const t = (d - EDGE_THRESHOLD) / (WOOD_THRESHOLD - EDGE_THRESHOLD);
    if (r < 0.1 + 0.32 * t) return { key: biome === 0 && jitter < 0.4 ? "tree-small" : pick(WOOD[biome]!, species), x: x0, y: y0 };
    if (r < 0.5) return one(pick(EDGE[biome]!, jitter));
    return undefined;
  }
  const m = valueNoise(p.seed, x0, y0, 6, 0x3ead);
  if (m >= MEADOW_THRESHOLD && r < 0.6 + (m - MEADOW_THRESHOLD)) return one(pick(MEADOW[biome]!, jitter));
  if (r < 0.03) return one(pick(STRAY[biome]!, jitter));
  return undefined;
}

/** Ambient cell visible before development. Zero means no upper object. */
export function naturalTileAt(p: GrowParams, x: number, y: number): number {
  if (x < 1 || x >= p.width - 1 || y < 1 || y >= p.height - 1) return 0;
  const index = y * p.width + x;
  const cache = paramCache(p);
  const cached = cache.natural[index]!;
  if (cached !== CACHE_EMPTY) return cached;
  // Each cell belongs to exactly one 2x2 block, and that block's stamp
  // decides all four of its cells: settle them together. A timeline jump
  // into unvisited country asks for every cell of the window at once.
  const by = Math.floor((y - 1) / 2);
  const bx = Math.floor((x - (by & 1)) / 2);
  const placed = blockStamp(p, bx, by);
  const { x0, y0 } = blockOrigin(bx, by);
  for (let cy = y0; cy <= y0 + 1; cy++) for (let cx = x0; cx <= x0 + 1; cx++) {
    if (cx < 1 || cx >= p.width - 1 || cy < 1 || cy >= p.height - 1) continue;
    let result = 0;
    if (placed) {
      const st = STAMPS[placed.key]!;
      const dx = cx - placed.x, dy = cy - placed.y;
      if (dx >= 0 && dy >= 0 && dx < st.w && dy < st.h) result = stampCell(placed.key, dx, dy);
    }
    cache.natural[cy * p.width + cx] = result;
  }
  return cache.natural[index]!;
}

/** Settle the natural-stamp and biome caches of columns x0..x1 ahead of
 *  time, so a timeline jump into country the camera has not visited yet
 *  does not compute them all in one frame. */
export function warmWilderness(p: GrowParams, x0: number, x1: number): void {
  const last = Math.min(p.width - 1, x1);
  for (let x = Math.max(0, x0); x <= last; x++) {
    for (let y = 0; y < p.height; y++) { naturalTileAt(p, x, y); biomeBandAt(p, x, y); }
  }
}

/** Top-left cell and size of the natural stamp covering (x, y), if any. */
export function naturalStampAt(p: GrowParams, x: number, y: number): { x: number; y: number; w: number; h: number } | undefined {
  const natural = naturalTileAt(p, x, y);
  const owner = natural ? stampOfCell(natural) : undefined;
  if (!owner || owner.stamp.w * owner.stamp.h === 1) return undefined;
  return { x: x - owner.dx, y: y - owner.dy, w: owner.stamp.w, h: owner.stamp.h };
}

/** Natural art still visible in a state. Authored development wins, and a
 *  multi-cell stamp disappears whole rather than being cut by a road. */
export function wildernessTileAt(s: GrowState, x: number, y: number): number {
  const w = s.params.width;
  if (x < 0 || y < 0 || x >= w || y >= s.params.height) return 0;
  const i = y * w + x;
  if (s.ground[i]! >= 0 || s.upper[i]! >= 0 || s.road[i]) return 0;
  const natural = naturalTileAt(s.params, x, y);
  if (!natural) return 0;
  // naturalStampAt without its allocations: the view asks this for every
  // newly visible cell of a timeline jump.
  const owner = stampOwner(natural);
  if (owner && owner.w * owner.h > 1) {
    const part = natural - owner.base;
    const x0 = x - part % owner.w, y0 = y - Math.floor(part / owner.w);
    for (let dy = 0; dy < owner.h; dy++) for (let dx = 0; dx < owner.w; dx++) {
      const at = (y0 + dy) * w + x0 + dx;
      if (s.ground[at]! >= 0 || s.upper[at]! >= 0 || s.road[at]) return 0;
    }
  }
  return natural;
}

export function idx(s: GrowState, x: number, y: number): number { return y * s.params.width + x; }
export function chance(s: GrowState): number { const r = rngNext(s.rng); s.rng = r.next; return r.value; }
function rollInt(s: GrowState, min: number, max: number): number { return min + Math.floor(chance(s) * (max - min + 1)); }
export function inBounds(s: GrowState, x: number, y: number): boolean {
  return x >= 1 && x < s.params.width - 1 && y >= 1 && y < s.params.height - 1;
}
function setFrontier(s: GrowState, x: number): void { s.frontierX = Math.max(s.frontierX, x); }
function clearNatural(s: GrowState, x: number, y: number): void {
  if (!inBounds(s, x, y)) return;
  const i = idx(s, x, y);
  if (s.decor.includes(i)) s.decor.splice(s.decor.indexOf(i), 1);
}
export type GrowGridLayer = "ground" | "upper" | "road" | "wear";
export interface GrowGridEdit { layer: GrowGridLayer; index: number; before: number; after: number }
export interface WritableGrids {
  ground: boolean; upper: boolean; road: boolean; wear?: boolean; edits: Map<number, GrowGridEdit>;
}

function writable(s: GrowState, grids: WritableGrids, layer: "ground" | "upper"): Int32Array;
function writable(s: GrowState, grids: WritableGrids, layer: "road"): Uint8Array;
function writable(s: GrowState, grids: WritableGrids, layer: "wear"): Uint16Array;
function writable(s: GrowState, grids: WritableGrids, layer: GrowGridLayer): Int32Array | Uint8Array | Uint16Array {
  if (layer === "wear") {
    if (!grids.wear) { s.wear = s.wear!.slice(); grids.wear = true; }
    return s.wear!;
  }
  if (layer === "ground") {
    if (!grids.ground) { s.ground = s.ground.slice(); grids.ground = true; }
    return s.ground;
  }
  if (layer === "upper") {
    if (!grids.upper) { s.upper = s.upper.slice(); grids.upper = true; }
    return s.upper;
  }
  if (!grids.road) { s.road = s.road.slice(); grids.road = true; }
  return s.road;
}

export function writeGrid(s: GrowState, grids: WritableGrids, layer: GrowGridLayer, index: number, value: number): void {
  const target = layer === "road" ? writable(s, grids, "road") : layer === "wear" ? writable(s, grids, "wear") : writable(s, grids, layer);
  const before = target[index]!;
  if (before === value) return;
  const layerId = layer === "ground" ? 0 : layer === "upper" ? 1 : layer === "road" ? 2 : 3;
  const key = index * 4 + layerId;
  const edit = grids.edits.get(key);
  if (edit) {
    edit.after = value;
    if (edit.before === value) grids.edits.delete(key);
  } else {
    grids.edits.set(key, { layer, index, before, after: value });
  }
  target[index] = value;
}

export function occupyGround(s: GrowState, grids: WritableGrids, x: number, y: number, tile: number, road = false): void {
  if (!inBounds(s, x, y)) return;
  const i = idx(s, x, y);
  clearNatural(s, x, y); writeGrid(s, grids, "ground", i, tile);
  if (road) writeGrid(s, grids, "road", i, 1);
  setFrontier(s, x);
}
export function occupyUpper(s: GrowState, grids: WritableGrids, x: number, y: number, tile: number): void {
  if (!inBounds(s, x, y)) return;
  clearNatural(s, x, y); writeGrid(s, grids, "upper", idx(s, x, y), tile); setFrontier(s, x);
}

export function cameraTarget(p: GrowParams, frontierX: number): number {
  const max = Math.max(0, p.width * TILE - VIEW_W);
  return Math.max(0, Math.min(max, frontierX * TILE + TILE - p.cameraLeadPx));
}
export function cameraXForState(s: GrowState): number {
  const now = cameraTarget(s.params, s.roadFrontierX);
  if (s.tick <= 0) return now;
  if (s.hz <= 0) return s.cameraFromX;
  const deadline = liveFrameAtTick(s.params, s.hz, s.tick);
  const span = Math.max(1, s.params.tickSeconds * s.hz);
  const t = Math.max(0, Math.min(1, (s.frame - deadline) / span));
  const eased = t * t * (3 - 2 * t);
  return Math.round((s.cameraFromX + (now - s.cameraFromX) * eased) * 1000) / 1000;
}
function refreshCamera(s: GrowState): GrowState { s.cameraX = cameraXForState(s); return s; }

function settlementCenterX(p: GrowParams, chapter: number): number {
  return Math.min(p.width - 8, START_X + 8 + chapter * p.biomeBandWidth);
}
function createSettlement(p: GrowParams, chapter: number): GrowSettlement {
  const centerX = settlementCenterX(p, chapter);
  const wiggle = (growHash(p.seed, chapter, 0, 0x5e77) % 3) - 1;
  const centerY = Math.max(7, Math.min(p.height - 8, Math.floor(p.height / 2) + wiggle));
  return { chapter, biome: biomeAt(p, centerX, centerY), centerX, centerY, stage: "road", roadStartX: chapter ? centerX - p.biomeBandWidth + 7 : START_X, roadEndX: centerX + 7, houses: 0, industries: 0, villagers: 0 };
}

export function createGrow(params: GrowParams = DEFAULT_PARAMS): GrowState {
  const p: GrowParams = { ...params, seed: params.seed >>> 0 };
  const size = p.width * p.height;
  const s: GrowState = {
    frame: 0, hz: 0, tick: 0, phase: "road", rng: p.seed, params: p,
    ground: new Int32Array(size).fill(-1), upper: new Int32Array(size).fill(-1),
    road: new Uint8Array(size), tips: [], roads: [], houses: [], farms: [], villagers: [],
    decor: [], chapter: 0, frontierX: 0, roadFrontierX: 0,
    cameraFromX: 0, cameraX: 0, grew: false,
  };
  const grids: WritableGrids = { ground: true, upper: true, road: true, wear: true, edits: new Map() };
  if (p.causal) {
    s.wear = new Uint16Array(size);
    createCausalWorld(s, grids);
    return refreshCamera(s);
  }
  const { x: cx, y: cy } = plazaCenter(p);
  for (let x = cx - 2; x <= cx; x++) layRoad(s, grids, x, cy, GROW_TILE.ROAD_H);
  s.tips.push({ x: cx, y: cy, dir: 3 });
  return refreshCamera(s);
}

export function layRoad(s: GrowState, grids: WritableGrids, x: number, y: number, kind: number): void {
  if (!inBounds(s, x, y)) return;
  const i = idx(s, x, y);
  if (!s.road[i]) s.roads.push({ x, y });
  occupyGround(s, grids, x, y, kind, true);
  s.roadFrontierX = Math.max(s.roadFrontierX, x);
}
function paintPlaza(s: GrowState, grids: WritableGrids, town: GrowSettlement): void {
  for (let x = town.centerX - 7; x <= town.centerX + 7; x++)
    layRoad(s, grids, x, town.centerY, Math.abs(x - town.centerX) <= 1 ? GROW_TILE.PLAZA : GROW_TILE.ROAD_H);
  for (let y = town.centerY - 4; y <= town.centerY + 4; y++)
    layRoad(s, grids, town.centerX, y, Math.abs(y - town.centerY) <= 1 ? GROW_TILE.PLAZA : GROW_TILE.ROAD_V);
  occupyUpper(s, grids, town.centerX - 1, town.centerY - 1, town.biome === 3 ? GROW_TILE.FIREWOOD : GROW_TILE.WELL);
  occupyUpper(s, grids, town.centerX + 1, town.centerY + 1, GROW_TILE.NOTICE);
}

// ---------------------------------------------------------------------------
// Houses. Each town lays out a row of lots on the north side of the trunk
// (doors face the road) and a second row south of it, whose doors open onto
// a back lane joined to the plaza. Lot widths follow the chosen house, gaps
// vary, so no two towns share a rhythm. The plan is a pure function of the
// seed; the reducer builds one lot per tick, nearest the plaza first.

const HOUSE_H = 3;
const LOT_LEFT = 13, LOT_RIGHT = 7; // keep clear of the chapter seam and the next river
interface HouseLot { x0: number; side: 0 | 1; kind: number; order: number }
function houseStampKey(biome: number, kind: number): string {
  const list = HOUSE_STAMPS[biome] ?? HOUSE_STAMPS[0]!;
  return list[kind % list.length]!;
}
function backLaneY(town: GrowSettlement): number { return town.centerY + HOUSE_H + 2; }
function townLots(p: GrowParams, town: GrowSettlement): HouseLot[] {
  const lots: HouseLot[] = [];
  for (const side of [0, 1] as const) {
    for (const dir of [1, -1] as const) {
      let edge = town.centerX + dir * (2 + (growHash(p.seed, town.chapter, side * 2 + (dir > 0 ? 1 : 0), 0x10a7) % 2));
      let prev = side === 0 ? -1 : (growHash(p.seed, town.chapter, dir, 0x5ed0) % 3);
      for (let n = 0; n < 6; n++) {
        const h = growHash(p.seed, town.chapter * 16 + n, side * 2 + (dir > 0 ? 1 : 0), 0x1075);
        let kind = [0, 0, 0, 1, 1, 1, 2, 2][h % 8]!; // the plainest variant is the rarest
        if (kind === prev) kind = (kind + 1 + ((h >>> 3) % 2)) % 3; // neighbours never repeat
        prev = kind;
        const w = STAMPS[houseStampKey(town.biome, kind)]!.w;
        const x0 = dir > 0 ? edge : edge - w + 1;
        if (x0 < town.centerX - LOT_LEFT || x0 + w - 1 > town.centerX + LOT_RIGHT) break;
        lots.push({ x0, side, kind, order: n * 2 + (dir > 0 ? 0 : 1) + side });
        edge = dir > 0 ? x0 + w + 1 + ((h >>> 8) % 2) : x0 - 2 - ((h >>> 8) % 2);
      }
    }
  }
  return lots.sort((a, b) => a.order - b.order || a.x0 - b.x0);
}
function lotGeometry(town: GrowSettlement, lot: HouseLot, w: number, door: number): { top: number; doorX: number; frontY: number } {
  const top = lot.side === 0 ? town.centerY - 1 - HOUSE_H : town.centerY + 2;
  return { top, doorX: lot.x0 + door, frontY: top + HOUSE_H };
}
function lotFits(s: GrowState, x0: number, top: number, w: number): boolean {
  if (top < 1 || top + HOUSE_H > s.params.height - 2 || x0 < 1 || x0 + w >= s.params.width - 1) return false;
  for (let y = top; y < top + HOUSE_H; y++) for (let x = x0; x < x0 + w; x++) {
    const i = idx(s, x, y); if (s.upper[i] !== -1 || s.road[i] !== 0 || s.ground[i] !== -1) return false;
  }
  return true;
}
function inTown(town: GrowSettlement, x: number): boolean {
  return x >= town.centerX - LOT_LEFT - 1 && x <= town.centerX + LOT_RIGHT + 1;
}
function placeTownHouse(s: GrowState, grids: WritableGrids, town: GrowSettlement): boolean {
  const built = townHouses(s, town).length;
  const lots = townLots(s.params, town);
  for (let n = built; n < lots.length; n++) {
    const lot = lots[n]!;
    const key = houseStampKey(town.biome, lot.kind);
    const st = STAMPS[key]!;
    const { top, doorX, frontY } = lotGeometry(town, lot, st.w, st.door ?? 1);
    if (!lotFits(s, lot.x0, top, st.w)) continue;
    for (let dy = 0; dy < st.h; dy++) for (let dx = 0; dx < st.w; dx++) occupyUpper(s, grids, lot.x0 + dx, top + dy, stampCell(key, dx, dy));
    if (lot.side === 0) {
      // Walk the door path down until it meets the trunk, which may still be
      // easing toward the town's row at the western lots.
      for (let py = frontY; py < frontY + 4 && inBounds(s, doorX, py); py++) {
        if (s.road[idx(s, doorX, py)] && py > frontY) break;
        layRoad(s, grids, doorX, py, GROW_TILE.ROAD_V);
      }
    } else {
      // South row: the door opens onto the back lane, which runs to the plaza lane.
      const laneY = backLaneY(town);
      for (let px = Math.min(doorX, town.centerX); px <= Math.max(doorX, town.centerX); px++) layRoad(s, grids, px, laneY, GROW_TILE.ROAD_H);
      for (let py = town.centerY + 1; py < laneY; py++) layRoad(s, grids, town.centerX, py, GROW_TILE.ROAD_V);
    }
    // A little yard life: a front fence for some north lots, a pot or bush by the wall.
    const h = growHash(s.params.seed, lot.x0, top, 0x7a2d);
    if (lot.side === 0 && h % 5 < 2) {
      for (let x = lot.x0; x < lot.x0 + st.w; x++) {
        const i = idx(s, x, frontY);
        if (x !== doorX && !s.road[i] && s.upper[i] === -1) occupyUpper(s, grids, x, frontY, GROW_TILE.FENCE_H);
      }
    }
    const sideX = (h >>> 4) % 2 ? lot.x0 - 1 : lot.x0 + st.w;
    const propY = top + HOUSE_H - 1;
    const pi = idx(s, sideX, propY);
    if ((h >>> 6) % 3 !== 0 && inBounds(s, sideX, propY) && !s.road[pi] && s.upper[pi] === -1 && s.ground[pi] === -1) {
      const prop = town.biome === 2 ? ((h >>> 9) % 2 ? stampCell("pot-red", 0, 0) : stampCell("pot-gold", 0, 0))
        : town.biome === 3 ? stampCell("snow-round", 0, 0)
        : town.biome === 1 ? GROW_TILE.FIREWOOD
        : (h >>> 9) % 2 ? stampCell("flower-sun", 0, 0) : stampCell("bush-b", 0, 0);
      occupyUpper(s, grids, sideX, propY, prop);
    }
    const house: GrowHouse = { x: doorX, y: frontY, door: 0, variant: town.biome, villager: -1 };
    s.houses.push(house); town.houses++; return true;
  }
  return false;
}

function plotFits(s: GrowState, x0: number, y0: number, w: number, h: number): boolean {
  if (!inBounds(s, x0, y0) || !inBounds(s, x0 + w - 1, y0 + h - 1)) return false;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const i = idx(s, x, y); if (s.road[i] || s.upper[i] !== -1 || s.ground[i] !== -1) return false;
  }
  return true;
}
function paintIndustry(s: GrowState, grids: WritableGrids, town: GrowSettlement): boolean {
  const above = Math.max(2, town.centerY - 12);
  const right = town.centerX - 5;
  const left = town.centerX + 8;
  const x0 = plotFits(s, right, above, 11, 5) ? right : left;
  const y0 = above;
  if (!plotFits(s, x0, y0, 11, 5)) return false;
  const ground = [GROW_TILE.FARM_A, GROW_TILE.WORK_YARD, GROW_TILE.OASIS, GROW_TILE.WINTER_PLOT][town.biome]!;
  for (let y = y0; y < y0 + 5; y++) for (let x = x0; x < x0 + 11; x++) {
    const edge = x === x0 || x === x0 + 10 || y === y0 || y === y0 + 4;
    if (town.biome === 0 || town.biome === 3) {
      if (edge) occupyUpper(s, grids, x, y, y === y0 || y === y0 + 4 ? GROW_TILE.FENCE_H : GROW_TILE.FENCE_V);
      else occupyGround(s, grids, x, y, town.biome === 3 ? ground : (y & 1) ? GROW_TILE.FARM_A : GROW_TILE.FARM_B);
    } else if (town.biome === 1) {
      occupyGround(s, grids, x, y, ground);
      if (y === y0 + 1 && x % 3 !== 0) occupyUpper(s, grids, x, y, GROW_TILE.LOGS);
    } else {
      occupyGround(s, grids, x, y, GROW_TILE.MARKET_RUG);
      if (y === y0 + 1 && (x - x0) % 3 === 1) occupyUpper(s, grids, x, y, GROW_TILE.STALL);
    }
  }
  // A gate opens into a lane reaching the crossroad, with grouped tools beside it.
  const gateX = town.centerX;
  writeGrid(s, grids, "upper", idx(s, gateX, y0 + 4), -1);
  for (let py = y0 + 4; py <= town.centerY - 4; py++) layRoad(s, grids, gateX, py, GROW_TILE.ROAD_V);
  if (town.biome === 0) occupyUpper(s, grids, x0 + 9, y0 + 3, GROW_TILE.FLOWER_PROP);
  if (town.biome === 1) { occupyUpper(s, grids, x0 + 2, y0 + 1, GROW_TILE.LOGS); occupyUpper(s, grids, x0 + 4, y0 + 2, GROW_TILE.ROCK); }
  if (town.biome === 2) { occupyUpper(s, grids, x0 + 2, y0 + 1, GROW_TILE.STALL); occupyUpper(s, grids, x0 + 4, y0 + 2, GROW_TILE.STALL); }
  if (town.biome === 3) { occupyUpper(s, grids, x0 + 2, y0 + 1, GROW_TILE.FIREWOOD); occupyUpper(s, grids, x0 + 4, y0 + 2, GROW_TILE.FIR); }
  s.farms.push({ x: x0, y: y0, biome: town.biome, kind: ground, centerX: town.centerX });
  return true;
}

function roadRoute(s: GrowState, x0: number, y0: number, dir0: Dir4): MoveStep[] {
  const out: Dir4[] = []; let x = x0, y = y0, dir = dir0;
  const maxOut = Math.max(2, Math.floor(s.params.villagerRouteLen / 2));
  for (let n = 0; n < maxOut; n++) {
    const options: Dir4[] = [];
    for (let d = 0 as Dir4; d < 4; d = (d + 1) as Dir4) {
      const nx = x + DX[d], ny = y + DY[d];
      if (nx >= 0 && ny >= 0 && nx < s.params.width && ny < s.params.height && s.road[idx(s, nx, ny)] === 1) options.push(d);
    }
    if (!options.length) break;
    const next = options.includes(dir) && chance(s) < 0.7 ? dir : options[rollInt(s, 0, options.length - 1)]!;
    out.push(next); x += DX[next]; y += DY[next]; dir = next;
  }
  const steps = out.map((d) => DIR_STEP[d]!);
  if (steps.length) { steps.push("wait"); for (let i = out.length - 1; i >= 0; i--) steps.push(DIR_STEP[(out[i]! ^ 2) as Dir4]!); }
  return steps;
}
function birthTownVillager(s: GrowState, town: GrowSettlement): boolean {
  const h = s.houses.find((v) => v.villager === -1 && inTown(town, v.x));
  if (!h) return false;
  const v: GrowVillager = { x: h.x, y: h.y, dir: h.door, route: roadRoute(s, h.x, h.y, h.door), house: s.houses.indexOf(h) };
  h.villager = s.villagers.length; s.villagers.push(v); town.villagers++; return true;
}

function activeSettlement(s: GrowState): GrowSettlement { return createSettlement(s.params, s.chapter); }
function townHouses(s: GrowState, town: GrowSettlement): GrowHouse[] {
  return s.houses.filter((h) => inTown(town, h.x));
}
function townFarms(s: GrowState, town: GrowSettlement): GrowFarm[] {
  return s.farms.filter((f) => f.centerX === town.centerX);
}
function townVillagers(s: GrowState, town: GrowSettlement): GrowVillager[] {
  return s.villagers.filter((v) => inTown(town, s.houses[v.house]!.x));
}
function finishOrStartNext(s: GrowState, town: GrowSettlement): void {
  const canContinue = s.roads.length < s.params.roadCells && s.houses.length < s.params.houseCount
    && town.chapter < Math.min(7, (s.params.settlements ?? 8) - 1) && settlementCenterX(s.params, town.chapter + 1) < s.params.width - 8;
  if (!canContinue) { s.phase = "decor"; return; }
  s.chapter++; s.tips[0] = { x: town.roadEndX, y: town.centerY, dir: 3 }; s.phase = "road";
}
function seedSettledDecor(s: GrowState, grids: WritableGrids): void {
  if (s.params.decorPatches <= 0) return;
  const candidates: number[] = [];
  for (const h of s.houses) for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    if (Math.abs(dx) + Math.abs(dy) < 3) continue;
    const x = h.x + dx, y = h.y + dy;
    if (!inBounds(s, x, y)) continue;
    const i = idx(s, x, y);
    if (!s.road[i] && s.upper[i] === -1 && s.ground[i] === -1 && !candidates.includes(i)) candidates.push(i);
  }
  while (s.decor.length < s.params.decorPatches && candidates.length) {
    const at = rollInt(s, 0, candidates.length - 1);
    const i = candidates.splice(at, 1)[0]!;
    const x = i % s.params.width, y = Math.floor(i / s.params.width);
    const natural = naturalTileAt(s.params, x, y);
    writeGrid(s, grids, "upper", i, natural && natural < 46 ? natural : (biomeAt(s.params, x, y) === 3 ? GROW_TILE.SNOW_SHRUB : GROW_TILE.BUSH));
    s.decor.push(i);
  }
}

function roadTick(s: GrowState, grids: WritableGrids): void {
  const town = activeSettlement(s); const tip = s.tips[0]!;
  if (tip.x >= town.centerX) { paintPlaza(s, grids, town); s.phase = "house"; return; }
  const nx = tip.x + 1;
  const targetY = town.centerY;
  if (tip.y !== targetY && nx % 3 === 0) { tip.y += Math.sign(targetY - tip.y); layRoad(s, grids, tip.x, tip.y, GROW_TILE.ROAD_V); }
  tip.x = nx; tip.dir = 3;
  const biome = biomeAt(s.params, nx, tip.y);
  const bridge = (biome === 0 || biome === 1) && nx % s.params.biomeBandWidth === 26;
  layRoad(s, grids, nx, tip.y, bridge || s.ground[idx(s, nx, tip.y)] === GROW_TILE.BRIDGE_H ? GROW_TILE.BRIDGE_H : GROW_TILE.ROAD_H);
  if (bridge) {
    // A short, meandering stream ends in reed beds rather than cutting the screen.
    for (let y = 3; y < s.params.height - 3; y++) {
      const bend = Math.round(Math.sin((y - tip.y) / 4) * 1.5);
      const left = nx + bend;
      const width = 2 + Number(y % 7 < 3);
      for (let x = left; x < left + width; x++) {
        if (s.road[idx(s, x, y)] || y === tip.y) layRoad(s, grids, x, y, GROW_TILE.BRIDGE_H);
        else occupyGround(s, grids, x, y, GROW_TILE.WATER);
      }
      for (const x of [left - 1, left + width]) {
        if (s.road[idx(s, x, y)]) continue;
        occupyGround(s, grids, x, y, x === left - 1 ? GROW_TILE.BANK_L : GROW_TILE.BANK_R);
        if (y % 3 === 0) occupyUpper(s, grids, x, y, GROW_TILE.GRASS_TUFT);
      }
    }
    occupyUpper(s, grids, nx, tip.y - 1, GROW_TILE.BRIDGE_RAIL);
    occupyUpper(s, grids, nx + 1, tip.y + 1, GROW_TILE.BRIDGE_RAIL);
  }
}
function houseTick(s: GrowState, grids: WritableGrids): void {
  const town = activeSettlement(s); const target = Math.min(townLots(s.params, town).length, s.params.houseCount - (s.houses.length - townHouses(s, town).length));
  if (townHouses(s, town).length < target && s.houses.length < s.params.houseCount && placeTownHouse(s, grids, town)) return;
  s.phase = "farm";
}
function farmTick(s: GrowState, grids: WritableGrids): void {
  const town = activeSettlement(s);
  if (townFarms(s, town).length < 1 && s.farms.length < s.params.farmPatches && paintIndustry(s, grids, town)) return;
  s.phase = "villager";
}
function villagerTick(s: GrowState): void {
  const town = activeSettlement(s);
  if (townVillagers(s, town).length < townHouses(s, town).length && birthTownVillager(s, town)) return;
  finishOrStartNext(s, town);
}

function stepGrowTickImpl(s0: GrowState, ownsGrids: boolean): GrowState {
  // Prime the sparse descriptions before an owned fold mutates the buffers.
  gridHash(s0.ground, s0.upper);
  const previousGround = s0.ground, previousUpper = s0.upper;
  const s = s0.sim ? copyCausalTickState(s0) : copyTickState(s0);
  const grids: WritableGrids = { ground: ownsGrids, upper: ownsGrids, road: ownsGrids, wear: ownsGrids, edits: new Map() };
  const previousTarget = cameraTarget(s.params, s.roadFrontierX);
  s.cameraFromX = previousTarget; s.grew = true; s.tick++;
  if (s.sim) {
    if (s.phase !== "done") causalTick(s, grids);
  } else switch (s.phase) {
    case "road": roadTick(s, grids); break; case "house": houseTick(s, grids); break; case "farm": farmTick(s, grids); break;
    case "villager": villagerTick(s); break; case "decor": seedSettledDecor(s, grids); s.phase = "done"; break; case "done": break;
  }
  const edits = [...grids.edits.values()];
  tickGridEdits.set(s, edits);
  rememberEditedGridHash(previousGround, previousUpper, s.ground, s.upper, edits);
  s.cameraX = previousTarget; return s;
}

/** Immutable public reducer step. Grid layers copy only when that layer changes. */
export function stepGrowTick(s0: GrowState): GrowState {
  return stepGrowTickImpl(s0, false);
}

/**
 * Timeline-only fold. The caller owns all three grid buffers and promises not
 * to expose an older view after this call, so edits can be applied in place.
 */
export function stepGrowTickOwned(s0: GrowState): GrowState {
  return stepGrowTickImpl(s0, true);
}
export function stepGrowFrame(s0: GrowState, hz: number = s0.hz || 60): GrowState {
  const nextFrame = s0.frame + 1;
  if (s0.phase === "done") return refreshCamera({ ...s0, hz, frame: nextFrame, grew: false });
  const period = s0.params.tickSeconds * hz; const due = Math.max(0, Math.floor(nextFrame / period + 1e-9));
  let s = s0; for (let fired = s.tick; fired < due && s.phase !== "done"; fired++) s = stepGrowTick(s);
  return refreshCamera({ ...s, hz, frame: nextFrame, grew: s !== s0 });
}
export function growToTick(params: GrowParams, k: number): GrowState {
  let s = createGrow(params); for (let i = 0; i < Math.max(0, k) && s.phase !== "done"; i++) s = stepGrowTick(s); return s;
}
export function growToDone(params: GrowParams): GrowState {
  let s = createGrow(params), guard = 0; while (s.phase !== "done" && guard++ < 10000) s = stepGrowTick(s); return s;
}
export function totalTicks(params: GrowParams): number { return growToDone(params).tick; }

export function worldSummary(s: GrowState): {
  seed: number; tick: number; phase: GrowPhase; roads: number; houses: number; farms: number; villagers: number; frontierX: number; roadFrontierX: number; cameraX: number; roadCells: string; hash: string;
  causal?: ReturnType<typeof causalSummary>;
} {
  const summary = { seed: s.params.seed, tick: s.tick, phase: s.phase, roads: s.roads.length, houses: s.houses.length, farms: s.farms.length, villagers: s.villagers.length, frontierX: s.frontierX, roadFrontierX: s.roadFrontierX, cameraX: s.cameraX, roadCells: s.roads.map((r) => `${r.x},${r.y}`).join(" "), hash: growStateHash(s) };
  return s.sim ? { ...summary, causal: causalSummary(s) } : summary;
}
const gridHashes = new WeakMap<Int32Array, WeakMap<Int32Array, number>>();
const tickGridEdits = new WeakMap<GrowState, readonly GrowGridEdit[]>();
interface SparseGrid { values: Map<number, number>; sorted?: Int32Array }
const sparseGrids = new WeakMap<Int32Array, SparseGrid>();
const FNV_PRIME = 0x01000193;

function rememberGridHash(ground: Int32Array, upper: Int32Array, hash: number): void {
  let byUpper = gridHashes.get(ground);
  if (!byUpper) { byUpper = new WeakMap<Int32Array, number>(); gridHashes.set(ground, byUpper); }
  byUpper.set(upper, hash >>> 0);
}

function sparseGrid(grid: Int32Array): SparseGrid {
  let sparse = sparseGrids.get(grid);
  if (sparse) return sparse;
  const values = new Map<number, number>();
  for (let i = 0; i < grid.length; i++) if (grid[i]! >= 0) values.set(i, grid[i]!);
  sparse = { values };
  sparseGrids.set(grid, sparse);
  return sparse;
}

// Composed maps of empty runs shorter than one backing row, filled on first
// use. Runs between occupied cells are mostly this short, and the timeline
// hashes both layers on every recorded tick.
const RUN_CACHE = 4096;
const runA = new Uint32Array(RUN_CACHE);
const runB = new Uint32Array(RUN_CACHE);
const runKnown = new Uint8Array(RUN_CACHE);

/** Apply N FNV mixes of -1. This step is affine modulo 2^32:
 *  (hash xor -1) * prime == (-prime) * hash - prime. */
function mixEmptyRun(hash: number, count: number): number {
  if (count === 0) return hash;
  if (count < RUN_CACHE && runKnown[count]) return (Math.imul(runA[count]!, hash) + runB[count]!) >>> 0;
  let resultA = 1, resultB = 0;
  let baseA = (-FNV_PRIME) >>> 0, baseB = (-FNV_PRIME) >>> 0;
  for (let n = count; n > 0; n = Math.floor(n / 2)) {
    if (n % 2 === 1) {
      resultB = (Math.imul(baseA, resultB) + baseB) >>> 0;
      resultA = Math.imul(baseA, resultA) >>> 0;
    }
    baseB = (Math.imul(baseA, baseB) + baseB) >>> 0;
    baseA = Math.imul(baseA, baseA) >>> 0;
  }
  if (count < RUN_CACHE) { runA[count] = resultA; runB[count] = resultB; runKnown[count] = 1; }
  return (Math.imul(resultA, hash) + resultB) >>> 0;
}

function mixSparseGrid(hash: number, grid: Int32Array): number {
  const sparse = sparseGrid(grid);
  // Typed-array sort is numeric and native; a comparator is slow on QuickJS.
  const indices = sparse.sorted ??= Int32Array.from(sparse.values.keys()).sort();
  let cursor = 0;
  for (const index of indices) {
    hash = mixEmptyRun(hash, index - cursor);
    hash = Math.imul(hash ^ sparse.values.get(index)!, FNV_PRIME) >>> 0;
    cursor = index + 1;
  }
  return mixEmptyRun(hash, grid.length - cursor);
}

function inheritSparseGrid(before: Int32Array, after: Int32Array, edits: readonly GrowGridEdit[], layer: "ground" | "upper"): void {
  const source = sparseGrid(before);
  const sorted = source.sorted;
  const target: SparseGrid = before === after ? source : { values: new Map(source.values), sorted };
  // Occupancy before this tick of every cell it edited.
  let was: Map<number, boolean> | undefined;
  for (const edit of edits) {
    if (edit.layer !== layer) continue;
    was ??= new Map();
    if (!was.has(edit.index)) was.set(edit.index, target.values.has(edit.index));
    if (edit.after < 0) target.values.delete(edit.index);
    else target.values.set(edit.index, edit.after);
  }
  sparseGrids.set(after, target);
  if (!was || !sorted) return;
  // Keep the sorted index list: most ticks add or clear a few cells, and a
  // merge is cheaper than re-sorting every occupied cell (shared arrays are
  // never edited, so earlier states keep theirs).
  let added: number[] | undefined, removed: Set<number> | undefined;
  for (const [index, had] of was) {
    const has = target.values.has(index);
    if (had && !has) (removed ??= new Set()).add(index);
    else if (!had && has) (added ??= []).push(index);
  }
  if (!added && !removed) { target.sorted = sorted; return; }
  const adds = added ? Int32Array.from(added).sort() : new Int32Array(0);
  const out = new Int32Array(sorted.length - (removed?.size ?? 0) + adds.length);
  let o = 0, a = 0;
  for (let i = 0; i < sorted.length; i++) {
    const index = sorted[i]!;
    if (removed?.has(index)) continue;
    while (a < adds.length && adds[a]! < index) out[o++] = adds[a++]!;
    out[o++] = index;
  }
  while (a < adds.length) out[o++] = adds[a++]!;
  target.sorted = out;
}

function rememberEditedGridHash(
  beforeGround: Int32Array, beforeUpper: Int32Array,
  ground: Int32Array, upper: Int32Array,
  edits: readonly GrowGridEdit[],
): void {
  inheritSparseGrid(beforeGround, ground, edits, "ground");
  inheritSparseGrid(beforeUpper, upper, edits, "upper");
  rememberGridHash(ground, upper, mixSparseGrid(mixSparseGrid(0x811c9dc5, ground), upper));
}

function gridHash(ground: Int32Array, upper: Int32Array): number {
  const byUpper = gridHashes.get(ground);
  const cached = byUpper?.get(upper);
  if (cached !== undefined) return cached;
  const hash = mixSparseGrid(mixSparseGrid(0x811c9dc5, ground), upper);
  rememberGridHash(ground, upper, hash);
  return hash;
}

export function growGridHash(state: GrowState): number {
  return gridHash(state.ground, state.upper);
}

export function rememberGrowGridHash(state: GrowState, hash: number): void {
  rememberGridHash(state.ground, state.upper, hash);
}

export function growGridEdits(state: GrowState): readonly GrowGridEdit[] {
  return tickGridEdits.get(state) ?? [];
}

/** Hash used by the live HUD without allocating the summary's roadCells string. */
export function growStateHash(s: GrowState): string {
  let hash = gridHash(s.ground, s.upper);
  const mix = (n: number) => { hash ^= n >>> 0; hash = Math.imul(hash, 0x01000193) >>> 0; };
  for (const h of s.houses) { mix(h.x); mix(h.y); mix(h.variant); }
  mix(s.chapter);
  mix(s.frontierX); mix(s.roadFrontierX); mix(Math.round(s.cameraX * 1000));
  if (s.sim) hash = causalHashMix(s, hash);
  return hash.toString(16).padStart(8, "0");
}

function copyTickState(s: GrowState): GrowState {
  return { ...s,
    tips: s.tips.map((t) => ({ ...t })), roads: s.roads.map((r) => ({ ...r })), houses: s.houses.map((h) => ({ ...h })),
    farms: s.farms.map((f) => ({ ...f })), villagers: s.villagers.map((v) => ({ ...v, route: [...v.route] })), decor: [...s.decor] };
}

/**
 * Causal tick copy. Houses and villagers are replaced, never edited, once
 * a later state may share them, so the arrays copy shallowly; the sim
 * copies its own changing parts.
 */
function copyCausalTickState(s: GrowState): GrowState {
  return { ...s, tips: [], roads: s.roads, houses: s.houses.slice(), farms: s.farms, villagers: s.villagers.slice(), decor: s.decor, sim: copyCausal(s.sim!) };
}

/** Deep copy used when a reducer state must cross a test/tool boundary. */
export function cloneGrowState(s: GrowState): GrowState {
  const base = s.sim ? copyCausalTickState(s) : copyTickState(s);
  const copy: GrowState = { ...base, ground: s.ground.slice(), upper: s.upper.slice(), road: s.road.slice() };
  if (s.wear) copy.wear = s.wear.slice();
  rememberGrowGridHash(copy, growGridHash(s));
  return copy;
}
