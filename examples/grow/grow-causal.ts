// examples/grow/grow-causal.ts — the causal rules for the grown world.
//
// Under these rules nothing is stamped by schedule. Each biome band holds
// resources (a stream, oasis or lake for water; woods for timber; fertile
// soil near water; rock outcrops for stone). Settlers found a village beside
// water, and every tick each village eats, drinks, burns firewood, logs the
// nearest standing trees (stumps regrow), quarries rock, ploughs fields on
// the most fertile free ground, and builds a house when its people outgrow
// their homes. The source's flow and stored level cap the drinking water;
// a village whose source is diverted or exhausted thirsts. Villagers walk
// between homes, the well, the fields, the woodlot and the quarry along the
// cheapest path; the footfall worn into each cell turns wild ground into a
// trodden trail, then a dirt road, then (with stone in store) a paved road,
// and cheaper roads draw more feet. Two villages that each hold a surplus
// the other needs open a trade route, and its caravans wear a road between
// them; without trade there is no road. A village whose food, firewood or
// water runs out loses people; an empty house falls into ruin and an empty
// village is abandoned. Everything noteworthy is written to an append-only
// event record (tick, place, settlements, kind) that can be queried by
// place and time.
//
// Pure reducer: all randomness is the state's RNG cursor or a coordinate
// hash of the seed, arithmetic is integer, and every array a later state
// may share is replaced rather than edited.

import type { GrowBiome, GrowHouse, GrowParams, GrowState, GrowVillager, WritableGrids } from "./grow.ts";
import {
  biomeAt, cameraTarget, chance, growHash, GROW_TILE, idx, inBounds, naturalTileAt, occupyGround,
  occupyUpper, wildernessTileAt, writeGrid,
} from "./grow.ts";
import { HOUSE_STAMPS, STAMPS, stampCell, stampOwner } from "./grow-stamps.ts";

export type Goods = "food" | "wood" | "stone";
export const GOODS: readonly Goods[] = ["food", "wood", "stone"];

/** Something done to history from outside (phase C: change the past). */
export type GrowIntervention =
  | { tick: number; kind: "supply"; settlement: number; goods: Goods; amount: number }
  | { tick: number; kind: "blight"; settlement: number }
  | { tick: number; kind: "dry"; settlement: number };

export interface CausalParams {
  /** Simulated years; the world settles after years x 4 seasons. */
  years: number;
  seasonTicks: number;
  /** A new village is founded every this many ticks, one per biome band. */
  foundEvery: number;
  /** Footfall at which wild ground becomes a trail, a dirt road, a paved road. */
  wornAt: number;
  roadAt: number;
  pavedAt: number;
  /** Ticks between caravans on an open trade route. */
  caravanEvery: number;
  /** Two villages trade only within this many bands of each other. */
  tradeRange: number;
  interventions?: readonly GrowIntervention[];
}

export const DEFAULT_CAUSAL: CausalParams = {
  years: 5, seasonTicks: 12, foundEvery: 10,
  wornAt: 24, roadAt: 90, pavedAt: 260,
  caravanEvery: 4, tradeRange: 2,
};

export type SettlementStatus = "growing" | "stalled" | "declining" | "abandoned";

export type GrowEventKind =
  | "founded" | "house" | "field" | "first-road" | "paved" | "bridge" | "market"
  | "trade-opened" | "trade-road" | "trade-lapsed"
  | "poor-harvest" | "famine" | "cold" | "drought" | "forest-cleared" | "exodus" | "ruin" | "abandoned"
  | "intervention";

/** One entry of the history record. `x`, `y` are tile coordinates. */
export interface GrowEvent {
  tick: number;
  kind: GrowEventKind;
  x: number;
  y: number;
  /** Settlement id (its band/chapter index). */
  settlement: number;
  /** The other settlement of a trade or migration. */
  other?: number;
  goods?: Goods;
  /** Goods received in return on a trade route. */
  returns?: Goods;
  amount?: number;
  /** What an outside hand did: "dry" diverts the settlement's water. */
  detail?: "dry";
}

/** Events that mark the timeline and pull the camera. */
export const MAJOR_EVENTS: ReadonlySet<GrowEventKind> = new Set<GrowEventKind>([
  "founded", "first-road", "paved", "bridge", "market", "trade-opened", "trade-road", "trade-lapsed",
  "poor-harvest", "famine", "cold", "drought", "forest-cleared", "exodus", "abandoned", "intervention",
]);

export type RouteKind = "home" | "water" | "field" | "wood" | "stone";
export interface CausalRoute { kind: RouteKind; weight: number; cells: Int32Array }

export interface CausalSettlement {
  id: number; name: string; biome: GrowBiome; cx: number; cy: number; founded: number;
  pop: number; food: number; wood: number; stone: number;
  /** Drinking water in the cistern, and the source's stored level. */
  water: number; source: number;
  /** Consecutive ticks short of food, firewood (winter) or water. */
  hunger: number;
  /** Consecutive ticks short of drinking water. */
  thirst: number;
  status: SettlementStatus;
  /** Indices into GrowState.houses. */
  houses: readonly number[];
  /** Top-left cell index of each field (FIELD_W x FIELD_H). */
  fields: readonly number[];
  /** This season's harvest in quarters (2 poor, 4 normal). */
  harvest: number;
  routes: readonly CausalRoute[];
  routesDirty: boolean;
  /** Cumulative people who left or died, and the most ever living here. */
  lost: number; peak: number;
  roadCells: number; pavedCells: number;
  /** Tick of the last famine/cold/drought/exodus record, so one bad season logs once. */
  lastFamine: number; lastCold: number; lastDrought: number; lastExodus: number;
  /** Tick of the last cut tree (the woodlot path follows it) and its cell. */
  /** Tick the woods within reach were last found empty (-999: never). */
  woodlot: number; forestCleared: number;
  quarry: number;
}

export interface TradeLink {
  a: number; b: number;
  /** What a sends to b, and what b returns. */
  give: Goods; take: Goods;
  opened: number; active: boolean; lastMutual: number; caravans: number;
  /** Tick of the last caravan that actually carried goods (-1: none yet). */
  lastCaravan: number;
  /** Plaza-to-plaza path the caravans walk. */
  cells: Int32Array;
  roadFormed: number;
}

interface Regrow { at: number; w: number; due: number; stage: 0 | 1 }

export interface CausalSim {
  settlements: readonly CausalSettlement[];
  links: readonly TradeLink[];
  events: readonly GrowEvent[];
  regrow: readonly Regrow[];
  /** Tick the camera focus last moved to an event, and the column it seeks. */
  focusTick: number;
  focusX: number;
}

const FIELD_W = 5, FIELD_H = 3, HOUSE_H = 3, PEOPLE_PER_HOUSE = 3;
const HOUSE_WOOD = 8, FIELD_WOOD = 3, BRIDGE_WOOD = 2;
const TREE_WOOD = 5, ROCK_STONE = 3;
const WINDOW = 18;
const REGROW_TICKS = 40;
const FOCUS_PAN = 6;

// Water. Each band's source (a stream, an oasis or a lake) holds a stored
// level that recharges by its flow every tick. Drinking need grows with the
// people and the summer heat; villagers carry less home the farther the
// source, and a source that is diverted or exhausted gives nothing at all.
const SOURCE_MAX = 80;
const SOURCE_FLOW = { stream: 40, oasis: 24, lake: 16 } as const;
/** A source farther than this cannot supply the village. */
const WATER_REACH = 14;

function waterNeed(town: CausalSettlement, season: number): number {
  let need = town.pop;
  if (season === 1) need += Math.ceil(town.pop / 2); // summer heat
  return need;
}

// ---------------------------------------------------------------------------
// Helpers on the state.

function causalOf(s: GrowState): CausalParams { return s.params.causal!; }
function seasonOf(c: CausalParams, tick: number): number { return Math.floor(Math.max(0, tick - 1) / c.seasonTicks) % 4; }
export function seasonAt(p: GrowParams, tick: number): number { return seasonOf(p.causal!, tick); }
export const SEASON_NAMES = ["SPRING", "SUMMER", "AUTUMN", "WINTER"] as const;
export function causalTotalTicks(p: GrowParams): number { return p.causal!.years * 4 * p.causal!.seasonTicks; }

function bandStart(p: GrowParams, chapter: number): number { return chapter * p.biomeBandWidth; }
function midY(p: GrowParams): number { return Math.floor(p.height / 2); }

const NAME_A: readonly (readonly string[])[] = [
  ["GREEN", "CLOVER", "MEADOW", "BRIGHT"], ["MOSS", "FEN", "PEAT", "ALDER"],
  ["SUN", "DUNE", "AMBER", "SALT"], ["FROST", "WINTER", "ICE", "PINE"],
];
const NAME_B: readonly (readonly string[])[] = [
  ["FORD", "FIELD", "DALE", "WICK"], ["HOLLOW", "MOOR", "WOOD", "MERE"],
  ["WELL", "SPRING", "ROCK", "GATE"], ["HOLM", "REACH", "HOLD", "FELL"],
];
/** A settlement's name, a pure function of seed and band. */
export function settlementName(p: GrowParams, chapter: number): string {
  const biome = chapter % 4;
  const h = growHash(p.seed, chapter, 7, 0x4a3e);
  return NAME_A[biome]![h % 4]! + NAME_B[biome]![(h >>> 8) % 4]!;
}

// ---------------------------------------------------------------------------
// The landscape's resources. Water and rock are placed when the world is
// created; woods are the coordinate-hashed wilderness.

/** Where a band's water lies: a stream column, or a pond's center. */
export function waterSite(p: GrowParams, chapter: number): { kind: "stream" | "oasis" | "lake"; x: number; y: number } {
  const biome = chapter % 4;
  const x0 = bandStart(p, chapter);
  const h = growHash(p.seed, chapter, 1, 0x3a7e);
  if (biome <= 1) return { kind: "stream", x: x0 + 21 + (h % 4), y: midY(p) };
  const y = midY(p) + (((h >>> 6) % 2) ? -1 : 1) * (5 + (h >>> 9) % 3);
  return { kind: biome === 2 ? "oasis" : "lake", x: x0 + 13 + ((h >>> 3) % 6), y };
}

/** A village is founded on dry ground a short walk from its water. */
export function settlementSite(p: GrowParams, chapter: number): { x: number; y: number } {
  const w = waterSite(p, chapter);
  const h = growHash(p.seed, chapter, 2, 0x517e);
  if (w.kind === "stream") return { x: w.x - 7 - (h % 3), y: midY(p) + ((h >>> 4) % 3) - 1 };
  return { x: w.x + (((h >>> 2) % 2) ? 6 : -6), y: midY(p) - Math.sign(w.y - midY(p)) * 2 };
}

const OUTCROP_ROCKS = [2, 6, 10, 11] as const;

function paintStream(s: GrowState, grids: WritableGrids, x0: number, salt: number): void {
  for (let y = 2; y < s.params.height - 2; y++) {
    const wiggle = growHash(s.params.seed, x0, y >> 2, salt) % 3;
    const left = x0 + wiggle - 1;
    const width = 2 + Number(y % 7 < 3);
    for (let x = left; x < left + width; x++) occupyGround(s, grids, x, y, GROW_TILE.WATER);
    occupyGround(s, grids, left - 1, y, GROW_TILE.BANK_L);
    occupyGround(s, grids, left + width, y, GROW_TILE.BANK_R);
    if (y % 3 === 0) occupyUpper(s, grids, left + width, y, GROW_TILE.GRASS_TUFT);
  }
}

function paintPond(s: GrowState, grids: WritableGrids, cx: number, cy: number, rx: number, ry: number, tile: number): void {
  for (let y = cy - ry; y <= cy + ry; y++) for (let x = cx - rx; x <= cx + rx; x++) {
    const dx = x - cx, dy = y - cy;
    if (dx * dx * ry * ry + dy * dy * rx * rx <= rx * rx * ry * ry) occupyGround(s, grids, x, y, tile);
  }
}

function paintOutcrop(s: GrowState, grids: WritableGrids, chapter: number): void {
  const p = s.params;
  const site = settlementSite(p, chapter);
  const h = growHash(p.seed, chapter, 3, 0x0c7a);
  const side = (h % 2) ? 1 : -1;
  const ox = site.x + side * (7 + (h >>> 3) % 4), oy = site.y + (((h >>> 5) % 2) ? -7 : 7);
  let placed = 0;
  for (let r = 0; r < 4 && placed < OUTCROP_ROCKS[chapter % 4]!; r++) {
    for (let dy = -r; dy <= r && placed < OUTCROP_ROCKS[chapter % 4]!; dy++) for (let dx = -r; dx <= r && placed < OUTCROP_ROCKS[chapter % 4]!; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = ox + dx, y = oy + dy;
      if (!inBounds(s, x, y) || y < 2 || y > p.height - 3) continue;
      const i = idx(s, x, y);
      if (s.ground[i] !== -1 || s.upper[i] !== -1) continue;
      if (growHash(p.seed, x, y, 0x70c4) % 5 === 0) continue;
      occupyUpper(s, grids, x, y, GROW_TILE.ROCK);
      placed++;
    }
  }
}

/** Water, rock and the empty sim: the landscape before anyone arrives. */
export function createCausalWorld(s: GrowState, grids: WritableGrids): void {
  const p = s.params;
  const bands = Math.min(8, p.settlements);
  for (let chapter = 0; chapter < bands; chapter++) {
    const w = waterSite(p, chapter);
    if (w.kind === "stream") paintStream(s, grids, w.x, 0x57e0 + chapter);
    else if (w.kind === "oasis") { paintPond(s, grids, w.x, w.y, 2, 1, GROW_TILE.OASIS); occupyUpper(s, grids, w.x + 3, w.y - 1, stampCell("palm", 0, 0)); }
    else paintPond(s, grids, w.x, w.y, 3, 2, GROW_TILE.WATER);
    paintOutcrop(s, grids, chapter);
  }
  s.phase = "sim";
  s.frontierX = 0;
  s.roadFrontierX = settlementSite(p, 0).x + 3;
  // Canonical at tick 0: the camera rests on its target (timeline seeks
  // restore cameraX from cameraFromX).
  s.cameraFromX = cameraTarget(p, s.roadFrontierX);
  s.sim = { settlements: [], links: [], events: [], regrow: [], focusTick: 0, focusX: s.roadFrontierX };
}

// ---------------------------------------------------------------------------
// Copy-on-write. A tick replaces each settlement and link it touches.

export function copyCausal(sim: CausalSim): CausalSim {
  return { ...sim, settlements: sim.settlements.map((t) => ({ ...t })), links: sim.links.map((l) => ({ ...l })) };
}

interface Tick {
  s: GrowState; grids: WritableGrids; sim: CausalSim; c: CausalParams; season: number;
  towns: CausalSettlement[]; links: TradeLink[]; events: GrowEvent[] | undefined;
}

function log(t: Tick, e: Omit<GrowEvent, "tick">): void {
  if (!t.events) { t.events = t.sim.events.slice(); t.sim.events = t.events; }
  const event: GrowEvent = { tick: t.s.tick, ...e };
  t.events.push(event);
  if (MAJOR_EVENTS.has(e.kind) && t.s.tick - t.sim.focusTick >= 6) {
    t.sim.focusTick = t.s.tick;
    t.sim.focusX = Math.max(8, e.x + 3);
  }
}

// ---------------------------------------------------------------------------
// Walking costs. Zero is impassable.

let blockingCells: Uint8Array | undefined;
/** Upper cells walkers cannot cross (homes, ruins, rock, fences, plaza props). */
export function blocksWalking(cell: number): boolean { return blocks(cell); }
function blocks(cell: number): boolean {
  if (!blockingCells) {
    blockingCells = new Uint8Array(1024);
    for (const c of [GROW_TILE.WELL, GROW_TILE.NOTICE, GROW_TILE.STALL, GROW_TILE.FENCE_H, GROW_TILE.FENCE_V,
      GROW_TILE.ROCK, GROW_TILE.LOGS, GROW_TILE.FIREWOOD, GROW_TILE.RUIN_L, GROW_TILE.RUIN_M, GROW_TILE.RUIN_R]) blockingCells[c] = 1;
    for (const list of HOUSE_STAMPS) for (const key of list) {
      const st = STAMPS[key]!;
      for (let i = 0; i < st.w * st.h; i++) blockingCells[st.base + i] = 1;
    }
  }
  return cell >= 0 && cell < 1024 && blockingCells[cell] === 1;
}

const BASE_COST = [6, 7, 8, 8] as const;
function isTreeStamp(cell: number): boolean {
  const owner = stampOwner(cell);
  return !!owner && owner.w === 2 && (owner.key.startsWith("tree") || owner.key.startsWith("palm"));
}

function stepCost(s: GrowState, i: number): number {
  const u = s.upper[i]!;
  if (u >= 0 && blocks(u)) return 0;
  const g = s.ground[i]!;
  let cost: number;
  switch (g) {
    case GROW_TILE.PATH_STONE: case GROW_TILE.BRIDGE_H: cost = 2; break;
    case GROW_TILE.ROAD_H: cost = 3; break;
    case GROW_TILE.WORN_GRASS: case GROW_TILE.WORN_MUD: case GROW_TILE.WORN_SAND: case GROW_TILE.WORN_SNOW: cost = 5; break;
    case GROW_TILE.WATER: case GROW_TILE.OASIS: cost = 36; break;
    case GROW_TILE.BANK_L: case GROW_TILE.BANK_R: cost = 8; break;
    case GROW_TILE.FARM_A: case GROW_TILE.FARM_B: case GROW_TILE.WINTER_PLOT: cost = 14; break;
    case GROW_TILE.GRAVEL: cost = 7; break;
    case -1: {
      const w = s.params.width;
      cost = BASE_COST[biomeAt(s.params, i % w, (i - (i % w)) / w)]!;
      if (u < 0) {
        const natural = wildernessTileAt(s, i % w, (i - (i % w)) / w);
        if (natural && isTreeStamp(natural)) cost += 12;
        else if (natural) cost += 2;
      }
      break;
    }
    default: cost = 6;
  }
  return u >= 0 ? cost + 3 : cost;
}

// ---------------------------------------------------------------------------
// Dijkstra over a column window, integer costs, ties by cell order.

let distBuf = new Int32Array(0), parentBuf = new Int32Array(0), heapBuf = new Float64Array(0), costBuf = new Int32Array(0);

interface PathField { x0: number; x1: number; dist: Int32Array; parent: Int32Array; cost: Int32Array }

function pathField(s: GrowState, sourceX: number, sourceY: number, x0: number, x1: number): PathField {
  const p = s.params;
  x0 = Math.max(1, x0); x1 = Math.min(p.width - 2, x1);
  const cols = x1 - x0 + 1, rows = p.height, n = cols * rows;
  if (distBuf.length < n) {
    distBuf = new Int32Array(n); parentBuf = new Int32Array(n); costBuf = new Int32Array(n); heapBuf = new Float64Array(n * 4);
  }
  const dist = distBuf, parent = parentBuf, cost = costBuf, heap = heapBuf;
  for (let y = 0; y < rows; y++) for (let x = x0; x <= x1; x++) {
    const local = y * cols + (x - x0);
    dist[local] = 0x7fffffff; parent[local] = -1;
    cost[local] = y < 1 || y >= rows - 1 ? 0 : stepCost(s, y * p.width + x);
  }
  const start = sourceY * cols + (sourceX - x0);
  let size = 0;
  const push = (key: number) => {
    let i = size++;
    heap[i] = key;
    while (i > 0) { const up = (i - 1) >> 1; if (heap[up]! <= heap[i]!) break; const t = heap[up]!; heap[up] = heap[i]!; heap[i] = t; i = up; }
  };
  const pop = (): number => {
    const top = heap[0]!; const last = heap[--size]!;
    if (size > 0) {
      heap[0] = last; let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1; let m = i;
        if (l < size && heap[l]! < heap[m]!) m = l;
        if (r < size && heap[r]! < heap[m]!) m = r;
        if (m === i) break;
        const t = heap[m]!; heap[m] = heap[i]!; heap[i] = t; i = m;
      }
    }
    return top;
  };
  if (start >= 0 && start < n) { dist[start] = 0; push(start); }
  const SCALE = 16384;
  while (size > 0) {
    const key = pop();
    const local = key % SCALE, d = (key - local) / SCALE;
    if (d !== dist[local]) continue;
    const lx = local % cols, ly = (local - lx) / cols;
    for (let k = 0; k < 4; k++) {
      const nx = lx + (k === 1 ? -1 : k === 3 ? 1 : 0), ny = ly + (k === 0 ? 1 : k === 2 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const nl = ny * cols + nx;
      const c = cost[nl]!;
      if (c === 0) continue;
      const nd = d + c;
      if (nd < dist[nl]!) { dist[nl] = nd; parent[nl] = local; push(nd * SCALE + nl); }
    }
  }
  return { x0, x1, dist, parent, cost };
}

/** Cells from the source to (x, y), or empty when unreachable. */
function pathTo(s: GrowState, f: PathField, x: number, y: number): Int32Array {
  const cols = f.x1 - f.x0 + 1;
  if (x < f.x0 || x > f.x1) return new Int32Array(0);
  let local = y * cols + (x - f.x0);
  if (f.dist[local] === 0x7fffffff) return new Int32Array(0);
  const out: number[] = [];
  for (let guard = 0; local >= 0 && guard < 4096; guard++) {
    const lx = local % cols;
    out.push(((local - lx) / cols) * s.params.width + lx + f.x0);
    local = f.parent[local]!;
  }
  return Int32Array.from(out.reverse());
}

/** The reachable cell next to any `target` cell with the least walk. */
function nearestBeside(s: GrowState, f: PathField, isTarget: (i: number) => boolean, cx: number, cy: number, radius: number): { x: number; y: number } | undefined {
  const cols = f.x1 - f.x0 + 1, w = s.params.width;
  let best: { x: number; y: number } | undefined, bestD = 0x7fffffff;
  for (let y = Math.max(1, cy - radius); y <= Math.min(s.params.height - 2, cy + radius); y++) {
    for (let x = Math.max(f.x0, cx - radius); x <= Math.min(f.x1, cx + radius); x++) {
      const d = f.dist[y * cols + (x - f.x0)]!;
      if (d >= bestD) continue;
      const i = y * w + x;
      if (isTarget(i)) continue;
      if (isTarget(i - 1) || isTarget(i + 1) || isTarget(i - w) || isTarget(i + w)) { best = { x, y }; bestD = d; }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Settlement actions.

function isWater(s: GrowState, i: number): boolean {
  const g = s.ground[i]; return g === GROW_TILE.WATER || g === GROW_TILE.OASIS;
}
function isField(g: number): boolean { return g === GROW_TILE.FARM_A || g === GROW_TILE.FARM_B || g === GROW_TILE.WINTER_PLOT; }
function isWorn(g: number): boolean { return g >= GROW_TILE.WORN_GRASS && g <= GROW_TILE.WORN_SNOW; }

function found(t: Tick, chapter: number): void {
  const { s, grids } = t;
  const p = s.params;
  const site = settlementSite(p, chapter);
  const biome = biomeAt(p, site.x, site.y);
  const town: CausalSettlement = {
    id: chapter, name: settlementName(p, chapter), biome, cx: site.x, cy: site.y, founded: s.tick,
    // Settlers of the hard lands bring stores for their first winter.
    pop: 5, food: [40, 40, 50, 90][biome]!, wood: [14, 14, 14, 40][biome]!, stone: 0,
    water: 10, source: SOURCE_MAX, thirst: 0, hunger: 0, status: "growing", houses: [], fields: [], harvest: 4,
    routes: [], routesDirty: true, lost: 0, peak: 5, roadCells: 0, pavedCells: 0,
    lastFamine: -999, lastCold: -999, lastDrought: -999, lastExodus: -999, woodlot: -1, forestCleared: -999, quarry: -1,
  };
  occupyUpper(s, grids, site.x - 1, site.y - 1, biome === 3 ? GROW_TILE.FIREWOOD : GROW_TILE.WELL);
  occupyUpper(s, grids, site.x + 1, site.y - 1, GROW_TILE.NOTICE);
  t.towns.push(town);
  log(t, { kind: "founded", x: site.x, y: site.y, settlement: chapter });
}

function houseCapacity(town: CausalSettlement, s: GrowState): number {
  let n = 0;
  for (const h of town.houses) if (s.houses[h]!.ruined === undefined) n++;
  return n * PEOPLE_PER_HOUSE;
}

function footprintFree(s: GrowState, x0: number, y0: number, w: number, h: number, margin: number, c: CausalParams): boolean {
  const p = s.params;
  if (x0 - margin < 1 || y0 - margin < 2 || x0 + w + margin > p.width - 1 || y0 + h + margin > p.height - 2) return false;
  for (let y = y0 - margin; y < y0 + h + margin; y++) for (let x = x0 - margin; x < x0 + w + margin; x++) {
    const i = y * p.width + x;
    const g = s.ground[i]!, u = s.upper[i]!;
    const inner = x >= x0 && x < x0 + w && y >= y0 && y < y0 + h;
    if (u >= 0 && (inner || blocks(u))) return false;
    if (g >= 0 && (inner || isField(g) || g === GROW_TILE.WATER || g === GROW_TILE.OASIS)) return false;
    if (inner && (s.road[i] || s.wear![i]! >= c.wornAt)) return false;
  }
  return true;
}

/**
 * Manhattan distance to the nearest water cell within the (2r+1)^2 square
 * around (x, y), or 99 when there is none. Rings grow outward so the scan
 * stops at the first hit; past `limit` the answer no longer matters to the
 * caller and `limit` is returned instead.
 */
function nearestWater(s: GrowState, x: number, y: number, radius: number, limit = 99): number {
  const p = s.params, w = p.width;
  for (let d = 0; d <= radius * 2; d++) {
    if (d >= limit) return limit;
    for (let dy = Math.max(-radius, -d); dy <= Math.min(radius, d); dy++) {
      const yy = y + dy;
      if (yy < 1 || yy >= p.height - 1) continue;
      const rest = d - Math.abs(dy);
      if (rest > radius) continue;
      const xa = x - rest, xb = x + rest;
      if (xa >= 1 && xa < w - 1) { const g = s.ground[yy * w + xa]; if (g === GROW_TILE.WATER || g === GROW_TILE.OASIS) return d; }
      if (rest !== 0 && xb >= 1 && xb < w - 1) { const g = s.ground[yy * w + xb]; if (g === GROW_TILE.WATER || g === GROW_TILE.OASIS) return d; }
    }
  }
  return 99;
}

/**
 * nearestWater for every cell of a rectangle at once, for site searches
 * that would otherwise ring-scan around each candidate: per row the
 * distance to the nearest water within `radius` columns, then per cell the
 * best of those over the rows within `radius`. Exact, square bound included.
 */
// The field shares module buffers: it is valid until the next waterField call.
interface WaterField { x0: number; y0: number; x1: number; y1: number; radius: number; d: Int32Array }
let rowBuf = new Int32Array(0), waterBuf = new Int32Array(0);
function waterField(s: GrowState, x0: number, y0: number, x1: number, y1: number, radius: number): WaterField {
  const p = s.params, w = p.width;
  const cols = x1 - x0 + 1, rows = y1 - y0 + 1, n = cols * rows;
  if (rowBuf.length < n) { rowBuf = new Int32Array(n); waterBuf = new Int32Array(n); }
  const row = rowBuf, d = waterBuf;
  const FAR = 1 << 20;
  for (let r = 0; r < rows; r++) {
    const y = y0 + r;
    let run = FAR;
    for (let c = 0; c < cols; c++) {
      const x = x0 + c;
      const g = x >= 1 && x < w - 1 && y >= 1 && y < p.height - 1 ? s.ground[y * w + x] : -1;
      run = g === GROW_TILE.WATER || g === GROW_TILE.OASIS ? 0 : run + 1;
      row[r * cols + c] = run;
    }
    run = FAR;
    for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c;
      run = row[i] === 0 ? 0 : run + 1;
      if (run < row[i]!) row[i] = run;
      if (row[i]! > radius) row[i] = FAR;
    }
  }
  for (let r = radius; r < rows - radius; r++) for (let c = radius; c < cols - radius; c++) {
    let best = FAR;
    for (let dy = -radius; dy <= radius; dy++) {
      const v = row[(r + dy) * cols + c]! + (dy < 0 ? -dy : dy);
      if (v < best) best = v;
    }
    d[r * cols + c] = best >= FAR ? 99 : best;
  }
  return { x0, y0, x1, y1, radius, d };
}

/** nearestWater(s, x, y, f.radius, limit), from the field when it covers the square. */
function nearestWaterIn(s: GrowState, f: WaterField, x: number, y: number, limit: number): number {
  const r = f.radius;
  if (x - r < f.x0 || x + r > f.x1 || y - r < f.y0 || y + r > f.y1) return nearestWater(s, x, y, r, limit);
  const d = f.d[(y - f.y0) * (f.x1 - f.x0 + 1) + (x - f.x0)]!;
  // The ring scan gives up at `limit` when that comes before its last ring.
  return d >= limit && limit <= r * 2 ? limit : d;
}

function buildHouse(t: Tick, town: CausalSettlement): boolean {
  const { s, grids, c } = t;
  const p = s.params;
  const list = HOUSE_STAMPS[town.biome] ?? HOUSE_STAMPS[0]!;
  let best: { x0: number; top: number; key: string; score: number } | undefined;
  const wet = waterField(s, town.cx - 24, town.cy - 10 + HOUSE_H - 8, town.cx + 30, town.cy + 6 + HOUSE_H + 8, 8);
  for (let top = town.cy - 10; top <= town.cy + 6; top++) for (let x0 = town.cx - 14; x0 <= town.cx + 12; x0++) {
    const key = list[growHash(p.seed, x0, top, 0x40e5) % list.length]!;
    const st = STAMPS[key]!;
    const fx = x0 + (st.door ?? 1), fy = top + HOUSE_H;
    // Expansion leans toward water and fields, away from crowding the well.
    const plaza = Math.abs(fx - town.cx) + Math.abs(fy - town.cy);
    if (plaza < 3) continue;
    let fieldD = 12;
    for (const f of town.fields) {
      const fxx = f % p.width, fyy = (f - fxx) / p.width;
      fieldD = Math.min(fieldD, Math.abs(fx - fxx - 2) + Math.abs(fy - fyy - 1));
    }
    const rest = plaza * 3 + fieldD + (growHash(p.seed, x0, top, 0x5c0e) % 3);
    // Any water distance at or past this cannot beat the best site so far.
    const limit = best ? Math.max(0, Math.ceil((best.score - rest) / 2)) : 99;
    const score = rest + nearestWaterIn(s, wet, fx, fy, limit) * 2;
    if (best && score >= best.score) continue;
    if (!footprintFree(s, x0, top, st.w, HOUSE_H, 1, c)) continue;
    const fi = idx(s, fx, fy);
    if (stepCost(s, fi) === 0 || isWater(s, fi)) continue;
    best = { x0, top, key, score };
  }
  if (!best) return false;
  const st = STAMPS[best.key]!;
  for (let dy = 0; dy < st.h; dy++) for (let dx = 0; dx < st.w; dx++) occupyUpper(s, grids, best.x0 + dx, best.top + dy, stampCell(best.key, dx, dy));
  const fx = best.x0 + (st.door ?? 1), fy = best.top + HOUSE_H;
  const house: GrowHouse = { x: fx, y: fy, door: 0, variant: town.biome, villager: s.villagers.length, owner: town.id, x0: best.x0, top: best.top, key: best.key };
  const hi = s.houses.length;
  s.houses.push(house);
  const villager: GrowVillager = { x: fx, y: fy, dir: 0, route: [], house: hi };
  s.villagers.push(villager);
  town.houses = [...town.houses, hi];
  town.wood -= HOUSE_WOOD;
  town.routesDirty = true;
  if (town.houses.length === 1 || town.houses.length % 4 === 0) log(t, { kind: "house", x: fx, y: fy, settlement: town.id, amount: town.houses.length });
  return true;
}

function fieldYieldBase(town: CausalSettlement, s: GrowState, field: number): number {
  const w = s.params.width;
  const x = field % w, y = (field - x) / w;
  const wet = nearestWater(s, x + 2, y + 1, 5) <= 5;
  return [6, 4, wet ? 4 : 2, 4][town.biome]! + (wet ? 1 : 0);
}

function buildField(t: Tick, town: CausalSettlement): boolean {
  const { s, grids, c } = t;
  const p = s.params;
  let best: { x: number; y: number; score: number } | undefined;
  const wet = waterField(s, town.cx - 15 + 2 - 6, town.cy - 12 + 1 - 6, town.cx + 12 + 2 + 6, town.cy + 10 + 1 + 6, 6);
  for (let y = town.cy - 12; y <= town.cy + 10; y++) for (let x = town.cx - 15; x <= town.cx + 12; x++) {
    const dist = Math.abs(x + 2 - town.cx) + Math.abs(y + 1 - town.cy);
    if (dist < 5) continue;
    const rest = dist + (growHash(p.seed, x, y, 0xf1e1) % 3);
    const limit = best ? Math.max(0, Math.ceil((best.score - rest) / 3)) : 99;
    // Fertile ground is wet ground: fields climb toward the water.
    const score = rest + nearestWaterIn(s, wet, x + 2, y + 1, limit) * 3;
    if (best && score >= best.score) continue;
    if (!footprintFree(s, x, y, FIELD_W, FIELD_H, 1, c)) continue;
    best = { x, y, score };
  }
  if (!best) return false;
  for (let y = best.y; y < best.y + FIELD_H; y++) for (let x = best.x; x < best.x + FIELD_W; x++) {
    const tile = town.biome === 3 ? GROW_TILE.WINTER_PLOT : town.biome === 2 ? GROW_TILE.FARM_B : (y & 1) ? GROW_TILE.FARM_A : GROW_TILE.FARM_B;
    occupyGround(s, grids, x, y, tile);
  }
  const at = best.y * p.width + best.x;
  town.fields = [...town.fields, at];
  // Replace, never push: earlier states share the farms array.
  s.farms = [...s.farms, { x: best.x, y: best.y, biome: town.biome, kind: town.biome === 3 ? GROW_TILE.WINTER_PLOT : GROW_TILE.FARM_A, centerX: town.cx }];
  town.wood -= FIELD_WOOD;
  town.routesDirty = true;
  log(t, { kind: "field", x: best.x + 2, y: best.y + 1, settlement: town.id, amount: town.fields.length });
  return true;
}

/** Natural tree origins near a village, nearest first (pure, cached). */
const treeLists = new WeakMap<GrowParams, Map<number, Int32Array>>();
function treesNear(p: GrowParams, town: CausalSettlement): Int32Array {
  let byTown = treeLists.get(p);
  if (!byTown) { byTown = new Map(); treeLists.set(p, byTown); }
  let list = byTown.get(town.id);
  if (list) return list;
  const found: [number, number][] = [];
  const R = 15;
  for (let y = Math.max(1, town.cy - R); y <= Math.min(p.height - 2, town.cy + R); y++) {
    for (let x = Math.max(1, town.cx - R); x <= Math.min(p.width - 2, town.cx + R); x++) {
      const cell = naturalTileAt(p, x, y);
      const owner = cell ? stampOwner(cell) : undefined;
      if (!owner || cell !== owner.base || !isTreeStamp(cell)) continue;
      const d = Math.abs(x - town.cx) + Math.abs(y - town.cy);
      found.push([d * 65536 + y * 256 + (x - town.cx + 128), y * p.width + x]);
    }
  }
  found.sort((a, b) => a[0] - b[0]);
  list = Int32Array.from(found.map((f) => f[1]));
  byTown.set(town.id, list);
  return list;
}

function cutTree(t: Tick, town: CausalSettlement): boolean {
  const { s, grids } = t;
  const w = s.params.width;
  const list = treesNear(s.params, town);
  for (let n = 0; n < list.length; n++) {
    const at = list[n]!;
    const x = at % w, y = (at - x) / w;
    if (!wildernessTileAt(s, x, y)) continue;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) writeGrid(s, grids, "upper", at + dy * w + dx, stampCell("stump-big", dx, dy));
    t.sim.regrow = [...t.sim.regrow, { at, w: 2, due: s.tick + REGROW_TICKS, stage: 0 }];
    town.wood += TREE_WOOD;
    if (town.woodlot < 0 || Math.abs(town.woodlot - at) > 2 * w + 4) town.routesDirty = true;
    town.woodlot = at;
    return true;
  }
  if (s.tick - town.forestCleared > t.c.seasonTicks * 4) log(t, { kind: "forest-cleared", x: town.cx, y: town.cy, settlement: town.id });
  town.forestCleared = s.tick;
  return false;
}

function quarry(t: Tick, town: CausalSettlement): boolean {
  const { s, grids } = t;
  const p = s.params;
  let best = -1, bestD = 99;
  for (let y = Math.max(1, town.cy - 14); y <= Math.min(p.height - 2, town.cy + 14); y++) {
    for (let x = Math.max(1, town.cx - 16); x <= Math.min(p.width - 2, town.cx + 16); x++) {
      const i = y * p.width + x;
      if (s.upper[i] !== GROW_TILE.ROCK) continue;
      const d = Math.abs(x - town.cx) + Math.abs(y - town.cy);
      if (d < bestD) { bestD = d; best = i; }
    }
  }
  if (best < 0) return false;
  writeGrid(s, grids, "upper", best, -1);
  writeGrid(s, grids, "ground", best, GROW_TILE.GRAVEL);
  town.stone += ROCK_STONE;
  if (town.quarry !== best) town.routesDirty = true;
  town.quarry = best;
  return true;
}

function regrowTick(t: Tick): void {
  const { s, grids } = t;
  const w = s.params.width;
  if (!t.sim.regrow.length || t.sim.regrow[0]!.due > s.tick) return;
  const keep: Regrow[] = [];
  const later: Regrow[] = [];
  for (const r of t.sim.regrow) {
    if (r.due > s.tick) { keep.push(r); continue; }
    // A stump trodden into a path or built over never regrows: every cell
    // must still be wild ground holding this stand's stump or sapling.
    const expect = r.stage === 0 ? "stump-big" : biomeAt(s.params, r.at % w, Math.floor(r.at / w)) === 3 ? "bush-snow" : "tree-small";
    let intact = true;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const i = r.at + dy * w + dx;
      if (s.ground[i] !== -1 || s.upper[i] !== stampCell(expect, dx, dy)) intact = false;
    }
    if (!intact) continue;
    if (r.stage === 0) {
      // Saplings: a snowy bush in the snow, a young broadleaf elsewhere.
      const sapling = biomeAt(s.params, r.at % w, Math.floor(r.at / w)) === 3 ? "bush-snow" : "tree-small";
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) writeGrid(s, grids, "upper", r.at + dy * w + dx, stampCell(sapling, dx, dy));
      later.push({ ...r, stage: 1, due: s.tick + REGROW_TICKS });
    } else {
      // The sapling is grown: the wild tree is back.
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) writeGrid(s, grids, "upper", r.at + dy * w + dx, -1);
    }
  }
  t.sim.regrow = [...keep, ...later].sort((a, b) => a.due - b.due || a.at - b.at);
}

function ruinHouse(t: Tick, town: CausalSettlement, hi: number): void {
  const { s, grids } = t;
  const h = s.houses[hi]!;
  const st = STAMPS[h.key!]!;
  for (let dy = 0; dy < st.h; dy++) for (let dx = 0; dx < st.w; dx++) {
    const x = h.x0! + dx, y = h.top! + dy;
    writeGrid(s, grids, "ground", idx(s, x, y), GROW_TILE.GRAVEL);
    const piece = dy === 0
      ? ((dx + hi) % 2 === 0 ? GROW_TILE.RUBBLE : -1)
      : dx === 0 ? GROW_TILE.RUIN_L : dx === st.w - 1 ? GROW_TILE.RUIN_R : GROW_TILE.RUIN_M;
    writeGrid(s, grids, "upper", idx(s, x, y), piece);
  }
  s.houses[hi] = { ...h, ruined: s.tick };
  if (h.villager >= 0 && s.villagers[h.villager] && s.villagers[h.villager]!.left === undefined) {
    s.villagers[h.villager] = { ...s.villagers[h.villager]!, left: s.tick };
  }
  town.routesDirty = true;
  log(t, { kind: "ruin", x: h.x, y: h.y - 1, settlement: town.id });
}

/** Houses beyond the people's need stand empty; long-empty houses fall. */
function housingTick(t: Tick, town: CausalSettlement): void {
  const s = t.s;
  const standing = town.houses.filter((hi) => s.houses[hi]!.ruined === undefined);
  const needed = Math.ceil(town.pop / PEOPLE_PER_HOUSE);
  // The newest homes empty first.
  for (let n = 0; n < standing.length; n++) {
    const hi = standing[n]!;
    const h = s.houses[hi]!;
    const empty = n >= needed;
    if (empty && h.vacant === undefined) s.houses[hi] = { ...h, vacant: s.tick };
    else if (!empty && h.vacant !== undefined) s.houses[hi] = { ...h, vacant: undefined };
  }
  const limit = town.status === "abandoned" ? t.c.seasonTicks : t.c.seasonTicks * 2;
  for (const hi of standing) {
    const h = s.houses[hi]!;
    if (h.vacant !== undefined && s.tick - h.vacant >= limit) { ruinHouse(t, town, hi); return; }
  }
}

// ---------------------------------------------------------------------------
// Walking and wear.

function tread(t: Tick, town: CausalSettlement, cells: Int32Array, weight: number, link?: TradeLink): void {
  const { s, grids, c } = t;
  const wear = s.wear!;
  for (let n = 0; n < cells.length; n++) {
    const i = cells[n]!;
    const before = wear[i]!;
    const after = Math.min(65535, before + weight);
    writeGrid(s, grids, "wear", i, after);
    const g = s.ground[i]!;
    if ((g === -1 || g === GROW_TILE.BANK_L || g === GROW_TILE.BANK_R || isWorn(g) || g === GROW_TILE.GRAVEL) && after >= c.roadAt) {
      if (s.upper[i]! >= 0 && !blocks(s.upper[i]!)) writeGrid(s, grids, "upper", i, -1);
      writeGrid(s, grids, "ground", i, GROW_TILE.ROAD_H);
      writeGrid(s, grids, "road", i, 1);
      s.frontierX = Math.max(s.frontierX, i % s.params.width);
      const owner = link ? t.towns[link.a]! : town;
      owner.roadCells++;
      if (owner.roadCells === 1) log(t, { kind: "first-road", x: i % s.params.width, y: Math.floor(i / s.params.width), settlement: owner.id });
      town.routesDirty = true;
    } else if (g === -1 && after >= c.wornAt) {
      if (s.upper[i]! >= 0 && !blocks(s.upper[i]!)) writeGrid(s, grids, "upper", i, -1);
      writeGrid(s, grids, "ground", i, GROW_TILE.WORN_GRASS + biomeAt(s.params, i % s.params.width, Math.floor(i / s.params.width)));
      town.routesDirty = true;
    } else if (g === GROW_TILE.ROAD_H && after >= c.pavedAt && town.stone >= 1) {
      writeGrid(s, grids, "ground", i, GROW_TILE.PATH_STONE);
      town.stone--;
      town.pavedCells++;
      if (town.pavedCells === 1) log(t, { kind: "paved", x: i % s.params.width, y: Math.floor(i / s.params.width), settlement: town.id });
    } else if ((g === GROW_TILE.WATER || g === GROW_TILE.OASIS) && after >= c.roadAt && town.wood >= BRIDGE_WOOD) {
      writeGrid(s, grids, "ground", i, GROW_TILE.BRIDGE_H);
      writeGrid(s, grids, "road", i, 1);
      town.wood -= BRIDGE_WOOD;
      town.routesDirty = true;
      const x = i % s.params.width, y = Math.floor(i / s.params.width);
      // One record per crossing: the first plank of a span.
      if (s.ground[i - 1] !== GROW_TILE.BRIDGE_H && s.ground[i + 1] !== GROW_TILE.BRIDGE_H) log(t, { kind: "bridge", x, y, settlement: town.id, ...(link ? { other: link.a === town.id ? link.b : link.a } : {}) });
    }
  }
}

function recomputeRoutes(t: Tick, town: CausalSettlement): void {
  const s = t.s;
  const w = s.params.width;
  const f = pathField(s, town.cx, town.cy, town.cx - WINDOW, town.cx + WINDOW);
  const routes: CausalRoute[] = [];
  for (const hi of town.houses) {
    const h = s.houses[hi]!;
    if (h.ruined !== undefined || h.vacant !== undefined) continue;
    const cells = pathTo(s, f, h.x, h.y);
    if (cells.length) routes.push({ kind: "home", weight: PEOPLE_PER_HOUSE, cells });
  }
  const water = nearestBeside(s, f, (i) => isWater(s, i), town.cx, town.cy, 14);
  if (water) routes.push({ kind: "water", weight: Math.max(1, Math.ceil(town.pop / 3)), cells: pathTo(s, f, water.x, water.y) });
  for (const field of town.fields) {
    const fx = field % w, fy = (field - fx) / w;
    const inField = (i: number) => { const x = i % w, y = (i - x) / w; return x >= fx && x < fx + FIELD_W && y >= fy && y < fy + FIELD_H; };
    const gate = nearestBeside(s, f, inField, fx + 2, fy + 1, 4);
    if (gate) routes.push({ kind: "field", weight: Math.max(1, Math.ceil(town.pop / (2 * town.fields.length))), cells: pathTo(s, f, gate.x, gate.y) });
  }
  if (town.woodlot >= 0) {
    const wx = town.woodlot % w, wy = (town.woodlot - wx) / w;
    const lot = nearestBeside(s, f, (i) => i === town.woodlot || i === town.woodlot + 1 || i === town.woodlot + w || i === town.woodlot + w + 1, wx, wy, 3);
    if (lot) routes.push({ kind: "wood", weight: 2, cells: pathTo(s, f, lot.x, lot.y) });
  }
  if (town.quarry >= 0) {
    const qx = town.quarry % w, qy = (town.quarry - qx) / w;
    const pit = nearestBeside(s, f, (i) => i === town.quarry, qx, qy, 2);
    if (pit) routes.push({ kind: "stone", weight: 1, cells: pathTo(s, f, pit.x, pit.y) });
  }
  town.routes = routes.filter((r) => r.cells.length > 1);
  town.routesDirty = false;
}

// ---------------------------------------------------------------------------
// Needs, surplus and trade.

function woodTarget(town: CausalSettlement): number { return 10 + town.pop * 2; }
function needs(town: CausalSettlement, g: Goods): boolean {
  switch (g) {
    case "food": return town.food < town.pop * 4 + (town.biome === 3 ? town.pop * 4 : 0);
    case "wood": return town.wood < woodTarget(town);
    case "stone": return town.stone < 3 && town.roadCells >= 6;
  }
}
function surplus(town: CausalSettlement, g: Goods): number {
  switch (g) {
    case "food": return Math.max(0, town.food - town.pop * 8);
    case "wood": return Math.max(0, town.wood - woodTarget(town) * 2);
    case "stone": return Math.max(0, town.stone - 8);
  }
}
function add(town: CausalSettlement, g: Goods, n: number): void {
  if (g === "food") town.food += n; else if (g === "wood") town.wood += n; else town.stone += n;
}

/** The mutual deal between two villages, in either direction. */
export function mutualTrade(a: CausalSettlement, b: CausalSettlement): { give: Goods; take: Goods } | undefined {
  for (const give of GOODS) {
    if (surplus(a, give) <= 0 || !needs(b, give)) continue;
    for (const take of GOODS) if (take !== give && surplus(b, take) > 0 && needs(a, take)) return { give, take };
  }
  return undefined;
}

/** The deal a link between a and b should carry right now, a's exports first. */
function currentDeal(a: CausalSettlement, b: CausalSettlement): { give: Goods; take: Goods } | undefined {
  return mutualTrade(a, b) ?? (() => { const r = mutualTrade(b, a); return r && { give: r.take, take: r.give }; })();
}

function tradeTick(t: Tick): void {
  const { s, c } = t;
  const alive = t.towns.filter((town) => town.status !== "abandoned");
  for (let i = 0; i < alive.length; i++) for (let j = i + 1; j < alive.length; j++) {
    const a = alive[i]!, b = alive[j]!;
    if (Math.abs(a.id - b.id) > c.tradeRange) continue;
    const existing = t.links.find((l) => l.a === a.id && l.b === b.id);
    const deal = currentDeal(a, b);
    if (existing) {
      if (deal) {
        existing.lastMutual = s.tick;
        // The route carries whatever the villages actually trade this tick:
        // a link keeps its goods only while they are the live deal.
        existing.give = deal.give; existing.take = deal.take;
        if (!existing.active) {
          existing.active = true;
          log(t, { kind: "trade-opened", x: (a.cx + b.cx) >> 1, y: (a.cy + b.cy) >> 1, settlement: a.id, other: b.id, goods: deal.give, returns: deal.take });
        }
      } else if (existing.active && s.tick - existing.lastMutual > c.seasonTicks * 2) {
        existing.active = false;
        log(t, { kind: "trade-lapsed", x: (a.cx + b.cx) >> 1, y: (a.cy + b.cy) >> 1, settlement: a.id, other: b.id });
      }
      continue;
    }
    if (!deal) continue;
    const f = pathField(s, a.cx, a.cy, Math.min(a.cx, b.cx) - 6, Math.max(a.cx, b.cx) + 6);
    const cells = pathTo(s, f, b.cx, b.cy);
    if (cells.length < 2) continue;
    t.links.push({ a: a.id, b: b.id, give: deal.give, take: deal.take, opened: s.tick, active: true, lastMutual: s.tick, caravans: 0, lastCaravan: -1, cells, roadFormed: -1 });
    log(t, { kind: "trade-opened", x: (a.cx + b.cx) >> 1, y: (a.cy + b.cy) >> 1, settlement: a.id, other: b.id, goods: deal.give, returns: deal.take });
    for (const town of [a, b]) {
      if (town.food >= 0 && !t.links.some((l) => l !== t.links[t.links.length - 1] && (l.a === town.id || l.b === town.id))) {
        // The first trade partner brings a market stall to the plaza.
        const x = town.cx + 2, y = town.cy + 1;
        if (inBounds(s, x, y) && s.upper[idx(s, x, y)] === -1 && stepCost(s, idx(s, x, y)) > 0) {
          occupyUpper(s, t.grids, x, y, GROW_TILE.STALL);
          log(t, { kind: "market", x, y, settlement: town.id, other: town === a ? b.id : a.id });
        }
      }
    }
  }
  for (const link of t.links) {
    if (!link.active) continue;
    const a = t.towns[link.a]!, b = t.towns[link.b]!;
    if (a.status === "abandoned" || b.status === "abandoned") { link.active = false; continue; }
    if ((s.tick - link.opened) % c.caravanEvery !== 0) continue;
    // A caravan carries the live deal only. With no deal, or nothing to
    // spare either way, no cart leaves and the route gains no footfall:
    // without trade there is no road.
    const deal = currentDeal(a, b);
    if (!deal) continue;
    const out = Math.min(12, surplus(a, deal.give)), back = Math.min(12, surplus(b, deal.take));
    if (out === 0 && back === 0) continue;
    link.give = deal.give; link.take = deal.take;
    add(a, deal.give, -out); add(b, deal.give, out);
    add(b, deal.take, -back); add(a, deal.take, back);
    link.caravans++;
    link.lastCaravan = s.tick;
    if (link.caravans % 6 === 0) {
      // Re-route along the roads the caravans have worn so far.
      const f = pathField(s, a.cx, a.cy, Math.min(a.cx, b.cx) - 6, Math.max(a.cx, b.cx) + 6);
      const cells = pathTo(s, f, b.cx, b.cy);
      if (cells.length > 1) link.cells = cells;
    }
    tread(t, a, link.cells, 8, link);
    if (link.roadFormed < 0) {
      let road = 0;
      for (const i of link.cells) if (s.road[i]) road++;
      if (road * 5 >= link.cells.length * 4) {
        link.roadFormed = s.tick;
        log(t, { kind: "trade-road", x: (a.cx + b.cx) >> 1, y: (a.cy + b.cy) >> 1, settlement: a.id, other: b.id });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// One village's tick: harvest, eat, burn, gather, grow or shrink, build, walk.

const SEASON_YIELD: readonly (readonly number[])[] = [
  // spring, summer, autumn, winter (quarters of the base yield) per biome
  [4, 5, 5, 1], [4, 5, 4, 1], [3, 4, 4, 3], [3, 5, 3, 0],
];
const FUEL_DIV: readonly (readonly number[])[] = [
  [10, 12, 10, 5], [10, 12, 10, 5], [12, 12, 12, 8], [8, 10, 6, 2],
];

function villageTick(t: Tick, town: CausalSettlement): void {
  const { s, c, season } = t;
  if (town.status === "abandoned") { housingTick(t, town); return; }
  const seasonStart = (s.tick - 1) % c.seasonTicks === 0;
  if (seasonStart) {
    const odds = town.biome === 3 ? 0.25 : town.biome === 2 ? 0.2 : 0.12;
    town.harvest = chance(s) < odds ? 2 : 4;
    if (town.harvest < 4 && town.fields.length && season !== 3) {
      log(t, { kind: "poor-harvest", x: town.cx, y: town.cy, settlement: town.id });
    }
  }
  // Food: fields feed, people eat, stores spoil a little.
  let grown = 0;
  for (const field of town.fields) grown += fieldYieldBase(town, s, field);
  town.food += Math.floor(grown * SEASON_YIELD[town.biome]![season]! * town.harvest / 16);
  town.food -= town.pop + (town.food >> 5);
  // Firewood: more in winter, most in the snow.
  town.wood -= Math.ceil(town.pop / FUEL_DIV[town.biome]![season]!);
  // Water: villagers carry drinking water from the source. The source's
  // flow and stored level cap the supply, and a diverted or exhausted
  // source gives nothing; sources beyond WATER_REACH cannot supply the
  // village at all.
  const wdist = nearestWater(s, town.cx, town.cy, WATER_REACH, WATER_REACH + 1);
  const flow = wdist > WATER_REACH ? 0 : SOURCE_FLOW[waterSite(s.params, town.id).kind];
  const need = waterNeed(town, season);
  const intake = wdist > WATER_REACH ? 0 : Math.max(0, Math.min(need + 2, town.pop * 4, town.source + flow));
  town.source = Math.min(SOURCE_MAX, town.source + flow - intake);
  town.water = Math.min(town.water + intake, town.pop * 4 + 12) - need;
  let thirsty = false;
  if (town.water < 0) { town.water = 0; thirsty = true; }
  if ((wdist <= WATER_REACH) !== town.routes.some((r) => r.kind === "water")) town.routesDirty = true;
  let hungry = false, cold = false;
  if (town.food < 0) { town.food = 0; hungry = true; }
  if (town.wood < 0) { town.wood = 0; cold = season === 3; }
  town.thirst = thirsty ? town.thirst + 1 : 0;
  town.hunger = hungry || cold || thirsty ? town.hunger + 1 : 0;

  // Gather: woodcutters stock up while the woods last; rock is broken
  // once there are roads to pave or nothing else to trade.
  if (town.wood < woodTarget(town) * 3) {
    for (let n = 1 + Math.floor(town.pop / 10); n > 0 && cutTree(t, town); n--) { /* one tree each */ }
  }
  if (town.stone < 12 && (town.roadCells >= 4 || town.biome >= 2) && s.tick % 3 === town.id % 3) quarry(t, town);

  // People: hunger drives them away, plenty and room bring more.
  if (town.hunger >= 3) {
    if (hungry && s.tick - town.lastFamine > c.seasonTicks) {
      town.lastFamine = s.tick;
      log(t, { kind: "famine", x: town.cx, y: town.cy, settlement: town.id });
    } else if (cold && s.tick - town.lastCold > c.seasonTicks) {
      town.lastCold = s.tick;
      log(t, { kind: "cold", x: town.cx, y: town.cy, settlement: town.id });
    } else if (thirsty && s.tick - town.lastDrought > c.seasonTicks) {
      town.lastDrought = s.tick;
      log(t, { kind: "drought", x: town.cx, y: town.cy, settlement: town.id });
    }
    if (town.pop > 0 && (town.biome === 3 || s.tick % 2 === 0)) {
      town.pop--; town.lost++;
      // Leavers walk to the best-fed neighbor with room, if any.
      let to: CausalSettlement | undefined;
      for (const other of t.towns) {
        if (other === town || other.status === "abandoned" || other.food < other.pop * 6 || houseCapacity(other, s) <= other.pop) continue;
        if (!to || other.food - other.pop * 6 > to.food - to.pop * 6) to = other;
      }
      if (to) to.pop++;
      if (town.lost - Math.max(0, town.lastExodus) >= 0 && town.pop > 0 && town.pop * 3 <= town.peak * 2 && s.tick - town.lastExodus > c.seasonTicks * 2) {
        town.lastExodus = s.tick;
        log(t, { kind: "exodus", x: town.cx, y: town.cy, settlement: town.id, ...(to ? { other: to.id } : {}), amount: town.peak - town.pop });
      }
    }
  } else if (town.hunger === 0 && s.tick % 3 === town.id % 3 && town.food >= town.pop * 5 && houseCapacity(town, s) > town.pop) {
    town.pop++;
    town.peak = Math.max(town.peak, town.pop);
  }
  if (town.pop <= 2 && town.hunger >= 3) {
    // Too few to hold on: the last families leave too.
    town.lost += town.pop;
    town.pop = 0; town.status = "abandoned";
    log(t, { kind: "abandoned", x: town.cx, y: town.cy, settlement: town.id, amount: town.peak });
    for (const hi of town.houses) {
      const h = s.houses[hi]!;
      if (h.ruined === undefined && h.vacant === undefined) s.houses[hi] = { ...h, vacant: s.tick };
    }
    return;
  }
  town.status = town.hunger > 0 ? (town.hunger >= 3 ? "declining" : "stalled") : "growing";

  // Build: one project a tick, food first, then homes.
  if (town.hunger === 0) {
    const yieldNow = town.fields.reduce((n, f) => n + fieldYieldBase(town, s, f), 0);
    const wantField = yieldNow * 4 < town.pop * 5 + 8 && town.fields.length < 6;
    if (wantField && town.wood >= FIELD_WOOD && season !== 3) buildField(t, town);
    else if (town.pop + 2 > houseCapacity(town, s) && town.wood >= HOUSE_WOOD + 2 && town.food >= town.pop * 3) buildHouse(t, town);
  }
  housingTick(t, town);

  // Walk: one of the village's daily errands a tick, carrying the
  // footfall all its trips since the last time.
  if (town.routesDirty && (s.tick % 3 === town.id % 3 || !town.routes.length)) recomputeRoutes(t, town);
  const routes = town.routes;
  if (routes.length) {
    const r = routes[s.tick % routes.length]!;
    tread(t, town, r.cells, r.weight * Math.min(routes.length, 8));
  }
}

function applyInterventions(t: Tick): void {
  const list = t.c.interventions;
  if (!list) return;
  for (const iv of list) {
    if (iv.tick !== t.s.tick) continue;
    const town = t.towns[iv.settlement];
    if (!town || town.status === "abandoned") continue;
    if (iv.kind === "supply") add(town, iv.goods, iv.amount);
    else if (iv.kind === "blight") town.harvest = 1;
    else drySource(t, iv.settlement);
    log(t, { kind: "intervention", x: town.cx, y: town.cy, settlement: town.id,
      ...(iv.kind === "supply" ? { goods: iv.goods, amount: iv.amount } : iv.kind === "dry" ? { detail: "dry" as const } : {}) });
  }
}

/** A band's water source runs dry: its cells return to wild ground. */
function drySource(t: Tick, chapter: number): void {
  const { s, grids } = t;
  const p = s.params;
  const w = waterSite(p, chapter);
  const dryCell = (x: number, y: number): void => {
    if (x < 1 || y < 1 || x >= p.width - 1 || y >= p.height - 1) return;
    const i = idx(s, x, y);
    const g = s.ground[i]!;
    if (g !== GROW_TILE.WATER && g !== GROW_TILE.OASIS && g !== GROW_TILE.BANK_L && g !== GROW_TILE.BANK_R) return;
    writeGrid(s, grids, "ground", i, -1);
    if (s.upper[i]! >= 0) writeGrid(s, grids, "upper", i, -1);
  };
  if (w.kind === "stream") {
    for (let y = 2; y < p.height - 2; y++) {
      const wiggle = growHash(p.seed, w.x, y >> 2, 0x57e0 + chapter) % 3;
      const left = w.x + wiggle - 1;
      const width = 2 + Number(y % 7 < 3);
      for (let x = left; x < left + width; x++) dryCell(x, y);
      dryCell(left - 1, y); dryCell(left + width, y);
    }
  } else {
    const rx = w.kind === "oasis" ? 2 : 3, ry = w.kind === "oasis" ? 1 : 2;
    for (let y = w.y - ry; y <= w.y + ry; y++) for (let x = w.x - rx; x <= w.x + rx; x++) {
      const dx = x - w.x, dy = y - w.y;
      if (dx * dx * ry * ry + dy * dy * rx * rx <= rx * rx * ry * ry) dryCell(x, y);
    }
  }
  const town = t.towns[chapter];
  if (town) { town.source = 0; town.routesDirty = true; }
}

/** One causal tick. The caller has copied the state and advanced `tick`. */
export function causalTick(s: GrowState, grids: WritableGrids): void {
  const c = causalOf(s);
  const sim = s.sim!;
  const t: Tick = {
    s, grids, sim, c, season: seasonOf(c, s.tick),
    towns: sim.settlements as CausalSettlement[], links: sim.links as TradeLink[], events: undefined,
  };
  const bands = Math.min(8, s.params.settlements);
  const due = Math.floor((s.tick - 1) / c.foundEvery);
  if (t.towns.length < bands && t.towns.length <= due) found(t, t.towns.length);
  applyInterventions(t);
  regrowTick(t);
  for (const town of t.towns) villageTick(t, town);
  tradeTick(t);
  // The camera pans toward the latest event's place a few columns a tick
  // (it eases within each tick), never in one jump across the world.
  const pan = sim.focusX - s.roadFrontierX;
  s.roadFrontierX += Math.max(-FOCUS_PAN, Math.min(FOCUS_PAN, pan));
  if (s.tick >= causalTotalTicks(s.params)) s.phase = "done";
}

// ---------------------------------------------------------------------------
// Queries (phase B reads history; phase C forks it).

/** Events within `radius` tiles (Chebyshev) of (x, y) up to `tick`, oldest first. */
export function eventsNear(s: GrowState, x: number, y: number, radius = 2, tick = s.tick): GrowEvent[] {
  return (s.sim?.events ?? []).filter((e) => e.tick <= tick && Math.max(Math.abs(e.x - x), Math.abs(e.y - y)) <= radius);
}
/** Events with from <= tick <= to. */
export function eventsBetween(s: GrowState, from: number, to: number): GrowEvent[] {
  return (s.sim?.events ?? []).filter((e) => e.tick >= from && e.tick <= to);
}
/** Every event naming a settlement (as actor or trade partner). */
export function eventsOf(s: GrowState, settlement: number): GrowEvent[] {
  return (s.sim?.events ?? []).filter((e) => e.settlement === settlement || e.other === settlement);
}
/** The most recent major event at or before `tick`, optionally within columns x0..x1. */
export function latestMajorEvent(s: GrowState, tick = s.tick, x0 = -Infinity, x1 = Infinity): GrowEvent | undefined {
  const events = s.sim?.events ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.tick <= tick && e.x >= x0 && e.x <= x1 && MAJOR_EVENTS.has(e.kind)) return e;
  }
  return undefined;
}

/** Short uppercase caption for one event (the HUD font is ASCII). */
export function describeEvent(s: GrowState, e: GrowEvent): string {
  const sim = s.sim;
  const name = (id: number | undefined) => id === undefined ? "?" : sim?.settlements[id]?.name ?? settlementName(s.params, id);
  const here = name(e.settlement);
  switch (e.kind) {
    case "founded": return `${here} FOUNDED BY THE WATER`;
    case "house": return e.amount === 1 ? `${here}: FIRST HOUSE` : `${here}: ${e.amount} HOUSES`;
    case "field": return `${here}: FIELD ${e.amount} PLOUGHED`;
    case "first-road": return `${here}: FEET WEAR A ROAD`;
    case "paved": return `${here}: FIRST STONE ROAD`;
    case "bridge": return `${here}: A BRIDGE IS BUILT`;
    case "market": return `${here}: MARKET STALL OPENS`;
    case "trade-opened": return `TRADE ${here}-${name(e.other)}: ${(e.goods ?? "").toUpperCase()} FOR ${(e.returns ?? "").toUpperCase()}`;
    case "trade-road": return `CARAVANS WEAR A ROAD ${here}-${name(e.other)}`;
    case "trade-lapsed": return `TRADE ${here}-${name(e.other)} FALLS SILENT`;
    case "poor-harvest": return `${here}: POOR HARVEST`;
    case "famine": return `${here}: FAMINE`;
    case "cold": return `${here}: NO FIREWOOD IN WINTER`;
    case "drought": return `${here}: DROUGHT`;
    case "forest-cleared": return `${here}: WOODS CUT BACK`;
    case "exodus": return `${here}: PEOPLE LEAVE${e.other !== undefined ? ` FOR ${name(e.other)}` : ""}`;
    case "ruin": return `${here}: AN EMPTY HOUSE FALLS`;
    case "abandoned": return `${here} IS ABANDONED`;
    case "intervention": return `${here}: ${e.goods ? `${e.amount} ${e.goods.toUpperCase()} ARRIVES` : e.detail === "dry" ? "THE WATER DRIES UP" : "BLIGHT"}`;
  }
}

/** Re-simulate from a recorded state with outside interventions added. */
export function forkGrow(state: GrowState, interventions: readonly GrowIntervention[]): GrowState {
  const causal = state.params.causal;
  if (!causal) throw new Error("forkGrow: only causal worlds have a history to change");
  const params: GrowParams = { ...state.params, causal: { ...causal, interventions: [...(causal.interventions ?? []), ...interventions] } };
  return {
    ...state, params, ground: state.ground.slice(), upper: state.upper.slice(), road: state.road.slice(),
    wear: state.wear!.slice(), houses: state.houses.slice(), villagers: state.villagers.slice(),
    sim: copyCausal(state.sim!),
  };
}

export function causalSummary(s: GrowState): {
  settlements: { name: string; biome: number; status: SettlementStatus; pop: number; peak: number; food: number; water: number; wood: number; stone: number; thirst: number; houses: number; ruins: number; fields: number; roads: number; paved: number }[];
  links: { a: number; b: number; active: boolean; caravans: number; give: Goods; take: Goods; road: boolean }[];
  events: number; roadCells: number;
} {
  const sim = s.sim!;
  let roadCells = 0;
  for (let i = 0; i < s.road.length; i++) roadCells += s.road[i]!;
  return {
    settlements: sim.settlements.map((t) => ({
      name: t.name, biome: t.biome, status: t.status, pop: t.pop, peak: t.peak, food: t.food, water: t.water, wood: t.wood, stone: t.stone, thirst: t.thirst,
      houses: t.houses.filter((h) => s.houses[h]!.ruined === undefined).length,
      ruins: t.houses.filter((h) => s.houses[h]!.ruined !== undefined).length,
      fields: t.fields.length, roads: t.roadCells, paved: t.pavedCells,
    })),
    links: sim.links.map((l) => ({ a: l.a, b: l.b, active: l.active, caravans: l.caravans, give: l.give, take: l.take, road: l.roadFormed >= 0 })),
    events: sim.events.length, roadCells,
  };
}

/** Fold the sim's own numbers into the HUD hash. */
export function causalHashMix(s: GrowState, hash: number): number {
  const mix = (n: number) => { hash ^= n >>> 0; hash = Math.imul(hash, 0x01000193) >>> 0; };
  const sim = s.sim!;
  for (const t of sim.settlements) { mix(t.pop); mix(t.food); mix(t.water); mix(t.wood); mix(t.stone); mix(t.source); mix(t.hunger); mix(t.thirst); mix(t.houses.length); mix(t.fields.length); }
  for (const l of sim.links) { mix(l.a); mix(l.b); mix(l.caravans); mix(l.active ? 1 : 0); }
  mix(sim.events.length);
  for (const r of sim.regrow) { mix(r.at); mix(r.due); }
  const wear = s.wear!;
  let w = 0;
  for (let i = 0; i < wear.length; i += 1) if (wear[i]) { w = (Math.imul(w ^ i, 0x01000193) + wear[i]!) >>> 0; }
  mix(w);
  return hash;
}

export { cameraTarget };
