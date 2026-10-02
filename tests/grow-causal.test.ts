// tests/grow-causal.test.ts — the causal rules of the grown world
// (examples/grow/grow-causal.ts) under DEFAULT_PARAMS. Coverage:
//
//   1. DETERMINISM  same seed folds to a byte-identical state (every field,
//                   typed layers and the sim); seeds differ; frame fold ==
//                   tick fold
//   2. TIMELINE     GrowTimeline.at(k) equals growToTick(k) in any seek order,
//                   wear included, without drift
//   3. WORN ROADS   every trail/road/paving/bridge transition is driven by
//                   footfall crossing its threshold; nothing is pre-drawn;
//                   roads never revert; routes ride the roads they wore
//   4. TRADE        no trade, no road between villages; trade wears one
//   5. DECLINE      famine/cold -> abandoned -> ruins; supplies prevent it
//   6. FORK         forkGrow(k, ivs) == folding with params interventions
//   7. EVENTS       query helpers agree with manual filters; ASCII captions
//   8. RESOURCES    trees are cut and regrow, rock is quarried to gravel
//   9. STAMP RULES  the original rules are untouched
//
// The regression tests near the end of some groups pin defects found
// while this file was written (shared arrays, saplings on roads, hunger
// that outlived the famine, a non-canonical tick-0 camera).

import { describe, expect, test } from "bun:test";
import {
  createGrow, DEFAULT_PARAMS, growStateHash, growToDone, growToTick, GROW_TILE, naturalTileAt,
  STAMP_PARAMS, stepGrowFrame, stepGrowTick, wildernessTileAt, worldSummary,
  type GrowParams, type GrowState,
} from "../examples/grow/grow.ts";
import {
  DEFAULT_CAUSAL, causalSummary, describeEvent, eventsBetween, eventsNear, eventsOf, forkGrow, GOODS,
  latestMajorEvent, MAJOR_EVENTS, settlementSite,
  type CausalParams, type Goods, type GrowEvent, type GrowIntervention,
} from "../examples/grow/grow-causal.ts";
import { stampCell, stampOwner, STAMPS } from "../examples/grow/grow-stamps.ts";
import { GrowTimeline } from "../examples/grow/grow-timeline.ts";

const W = DEFAULT_PARAMS.width;
const H = DEFAULT_PARAMS.height;
const C = DEFAULT_CAUSAL;
/** Column half-width of a village's own walking/building (grow-causal.ts WINDOW). */
const VILLAGE_WINDOW = 18;
const ROADLIKE = new Set<number>([GROW_TILE.ROAD_H, GROW_TILE.PATH_STONE, GROW_TILE.BRIDGE_H]);
const isWorn = (g: number) => g >= GROW_TILE.WORN_GRASS && g <= GROW_TILE.WORN_SNOW;

function withSeed(seed: number, causal: CausalParams = DEFAULT_CAUSAL): GrowParams {
  return { ...DEFAULT_PARAMS, seed, causal };
}

// ---------------------------------------------------------------------------
// Canonical serialization: every field of the state, typed layers as arrays.

const typedToArray = (_key: string, v: unknown) => ArrayBuffer.isView(v) ? Array.from(v as unknown as ArrayLike<number>) : v;

/** Per-field digest of the whole state, so a mismatch names the field. */
function canon(s: GrowState, omit: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(s).sort()) {
    if (omit.includes(key)) continue;
    const text = JSON.stringify((s as unknown as Record<string, unknown>)[key], typedToArray) ?? "undefined";
    out[key] = `${text.length}:${Bun.hash(text).toString(16)}`;
  }
  return out;
}
const canonText = (s: GrowState) => JSON.stringify(canon(s));

// ---------------------------------------------------------------------------
// Shared folds (each full fold is ~0.3 s; tests reuse them).

const doneMemo = new Map<string, GrowState>();
function doneOf(seed: number, causal: CausalParams = DEFAULT_CAUSAL): GrowState {
  const key = `${seed}:${JSON.stringify(causal)}`;
  let s = doneMemo.get(key);
  if (!s) { s = growToDone(withSeed(seed, causal)); doneMemo.set(key, s); }
  return s;
}
const timelineMemo = new Map<number, { tl: GrowTimeline; end: number }>();
function timelineOf(seed: number): { tl: GrowTimeline; end: number } {
  let t = timelineMemo.get(seed);
  if (!t) { const tl = new GrowTimeline(withSeed(seed)); t = { tl, end: tl.finish() }; timelineMemo.set(seed, t); }
  return t;
}
function foldTo(s: GrowState, tick = Infinity): GrowState {
  while (s.phase !== "done" && s.tick < tick) s = stepGrowTick(s);
  return s;
}

const SEED = DEFAULT_PARAMS.seed;
const SEARCH_SEEDS = [SEED, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

// ---------------------------------------------------------------------------

describe("grow-causal: determinism", () => {
  test("the same seed folds to a byte-identical state; other seeds differ", () => {
    const a = growToDone(DEFAULT_PARAMS);
    const b = growToDone(DEFAULT_PARAMS);
    expect(a.phase).toBe("done");
    expect(a.wear).toBeInstanceOf(Uint16Array);
    expect(a.sim!.events.length).toBeGreaterThan(20);
    expect(canon(a)).toEqual(canon(b));
    expect(growStateHash(a)).toBe(growStateHash(b));

    const m1 = growToTick(DEFAULT_PARAMS, 97), m2 = growToTick(DEFAULT_PARAMS, 97);
    expect(m1.tick).toBe(97);
    expect(canon(m1)).toEqual(canon(m2));

    const other = doneOf(7);
    expect(canonText(other)).not.toBe(canonText(a));
    expect(canon(other).wear).not.toBe(canon(a).wear);
    expect(canon(other).sim).not.toBe(canon(a).sim);
    expect(growStateHash(other)).not.toBe(growStateHash(a));
  }, 15_000);

  test("folding 60 Hz frames lands on the same state as folding ticks", () => {
    let s = createGrow(DEFAULT_PARAMS);
    while (s.tick < 97) s = stepGrowFrame(s, 60);
    expect(s.tick).toBe(97);
    const clock = ["frame", "hz", "cameraX", "grew"];
    expect(canon(s, clock)).toEqual(canon(growToTick(DEFAULT_PARAMS, 97), clock));
  }, 15_000);
});

describe("grow-causal: timeline", () => {
  test("timeline.at(k) equals growToTick(k) in any seek order, without drift", () => {
    const timeline = new GrowTimeline(DEFAULT_PARAMS);
    const omit = (_k: number): string[] => [];
    const expected = new Map<number, { canon: Record<string, string>; hash: string }>();
    const order = [0, 240, 13, 200, 97, 1, 239, 120, 64, 13, 240, 0, 97, 1, 200, 2, 239];
    for (const k of order) {
      if (!expected.has(k)) {
        const fold = growToTick(DEFAULT_PARAMS, k);
        expected.set(k, { canon: canon(fold, omit(k)), hash: growStateHash(fold) });
      }
      const at = timeline.at(k);
      expect(at.tick).toBe(k);
      expect(canon(at, omit(k))).toEqual(expected.get(k)!.canon);
      expect(growStateHash(at)).toBe(expected.get(k)!.hash);
    }
    // Back and forth over the same span many times: still exact.
    for (let round = 0; round < 6; round++) {
      for (const k of [239, 3, 150, 97]) {
        const at = timeline.at(k);
        if (expected.has(k)) expect(canon(at, omit(k))).toEqual(expected.get(k)!.canon);
      }
    }
    expect(canon(timeline.at(97), omit(97))).toEqual(expected.get(97)!.canon);
    expect(timeline.at(10_000).tick).toBe(240);
  }, 20_000);

  test("regression: an earlier state's farms are not rewritten by later ticks", () => {
    // copyCausalTickState shares `farms` between ticks, so a field must
    // replace the array; a push once appended it to every earlier state
    // (timeline records, forkGrow bases).
    const s97 = growToTick(DEFAULT_PARAMS, 97);
    const before = canon(s97);
    const farms97 = s97.farms.length;
    foldTo(s97);
    expect(s97.farms.length).toBe(farms97);
    expect(canon(s97)).toEqual(before);

    const timeline = new GrowTimeline(DEFAULT_PARAMS);
    timeline.finish();
    expect(timeline.at(13).farms.length).toBe(growToTick(DEFAULT_PARAMS, 13).farms.length);

    const base = growToTick(DEFAULT_PARAMS, 60);
    const baseFarms = base.farms.length;
    foldTo(forkGrow(base, []));
    expect(base.farms.length).toBe(baseFarms);
  }, 15_000);

  test("regression: timeline.at(0) keeps the initial camera of createGrow", () => {
    // GrowTimeline's canonical() sets cameraX = cameraFromX; the causal
    // createGrow must start with both on the first village.
    const timeline = new GrowTimeline(DEFAULT_PARAMS);
    expect(timeline.at(0).cameraX).toBe(createGrow(DEFAULT_PARAMS).cameraX);
  });

  test("regression: a kept at() or snapshot() state is not rewritten by later seeks", () => {
    // The seek cursor's grids are reused, so a state handed out without a
    // copy used to mutate under the caller when a later seek replayed edits
    // through the same buffers. at() without a reusable and snapshot() now
    // hand out copies.
    const timeline = new GrowTimeline(DEFAULT_PARAMS);
    timeline.finish();
    const kept = timeline.at(10);
    const keptGround = kept.ground.slice();
    const keptWear = kept.wear!.slice();
    const snap = timeline.snapshot(13)!;
    const snapGround = snap.state.ground.slice();
    // Seek far away, back, and past: the kept states must not change.
    timeline.at(80);
    timeline.at(3);
    timeline.at(200);
    expect(kept.tick).toBe(10);
    expect(Array.from(kept.ground)).toEqual(Array.from(keptGround));
    expect(Array.from(kept.wear!)).toEqual(Array.from(keptWear));
    expect(snap.state.ground).toEqual(snapGround);
    // A snapshot's grids are that tick's grids, not the builder's live ones.
    const direct = growToTick(DEFAULT_PARAMS, 13);
    expect(snap.state.ground).toEqual(direct.ground);
    expect(snap.state.upper).toEqual(direct.upper);
    expect(snap.state.wear).toEqual(direct.wear);
    // A caller that passes its state as reusable transfers ownership: the
    // timeline may rewrite it, and the next returned state is stable again.
    const reused = timeline.at(40, kept);
    expect(reused.tick).toBe(40);
    const stable = timeline.at(99);
    const stableGround = stable.ground.slice();
    timeline.at(5);
    expect(stable.ground).toEqual(stableGround);
  }, 20_000);
});

describe("grow-causal: worn roads come from footfall", () => {
  test("nothing is pre-drawn: at tick 0 there is no road, trail or wear", () => {
    const s = createGrow(DEFAULT_PARAMS);
    expect(s.wear!.every((w) => w === 0)).toBe(true);
    expect(s.road.every((r) => r === 0)).toBe(true);
    for (let i = 0; i < s.ground.length; i++) {
      expect(ROADLIKE.has(s.ground[i]!) || isWorn(s.ground[i]!)).toBe(false);
    }
    // Tick 1 founds the first village, and still nothing is trodden to a trail.
    const t1 = growToTick(DEFAULT_PARAMS, 1);
    expect(t1.sim!.settlements.length).toBe(1);
    expect(t1.sim!.events[0]).toMatchObject({ tick: 1, kind: "founded", settlement: 0 });
    expect(t1.road.every((r) => r === 0)).toBe(true);
    expect(t1.ground.some((g) => ROADLIKE.has(g) || isWorn(g))).toBe(false);
  });

  test("every trail, road, paving and bridge appears exactly when its footfall crosses the threshold", () => {
    const { tl, end } = timelineOf(SEED);
    let roads = 0, trails = 0, paved = 0, bridges = 0;
    const roadTicks = new Map<number, number>();
    for (let k = 1; k <= end; k++) {
      const edits = tl.snapshot(k)!.edits;
      const wear = new Map<number, { before: number; after: number }>();
      const ground = new Map<number, { before: number; after: number }>();
      for (const e of edits) {
        if (e.layer === "wear") wear.set(e.index, e);
        if (e.layer === "ground") ground.set(e.index, e);
      }
      for (const e of wear.values()) expect(e.after).toBeGreaterThan(e.before); // footfall only grows
      for (const e of edits) {
        if (e.layer === "road") {
          // Roads are never removed, and only a road or bridge sets the flag.
          expect([e.before, e.after]).toEqual([0, 1]);
          expect<number[]>([GROW_TILE.ROAD_H, GROW_TILE.BRIDGE_H]).toContain(ground.get(e.index)?.after ?? -99);
          roadTicks.set(e.index, k);
        }
        if (e.layer !== "ground") continue;
        // A road surface never reverts (only dirt road -> paved road).
        if (ROADLIKE.has(e.before)) expect([e.before, e.after]).toEqual([GROW_TILE.ROAD_H, GROW_TILE.PATH_STONE]);
        const w = wear.get(e.index)?.after ?? -1;
        if (e.after === GROW_TILE.ROAD_H) {
          roads++;
          expect(w).toBeGreaterThanOrEqual(C.roadAt);
        } else if (isWorn(e.after)) {
          trails++;
          expect(e.before).toBe(-1);
          expect(w).toBeGreaterThanOrEqual(C.wornAt);
          expect(w).toBeLessThan(C.roadAt);
        } else if (e.after === GROW_TILE.PATH_STONE) {
          paved++;
          expect(e.before).toBe(GROW_TILE.ROAD_H);
          expect(w).toBeGreaterThanOrEqual(C.pavedAt);
        } else if (e.after === GROW_TILE.BRIDGE_H) {
          bridges++;
          expect<number[]>([GROW_TILE.WATER, GROW_TILE.OASIS]).toContain(e.before);
          expect(w).toBeGreaterThanOrEqual(C.roadAt);
        }
      }
    }
    // The mechanism actually ran at every stage.
    expect(roads).toBeGreaterThan(100);
    expect(trails).toBeGreaterThan(100);
    expect(paved).toBeGreaterThan(10);
    expect(bridges).toBeGreaterThan(0);

    // The finished world agrees cell by cell.
    const done = doneOf(SEED);
    let roadCells = 0;
    for (let i = 0; i < done.ground.length; i++) {
      const g = done.ground[i]!, w = done.wear![i]!;
      if (done.road[i]) {
        roadCells++;
        expect(ROADLIKE.has(g)).toBe(true);
        expect(w).toBeGreaterThanOrEqual(C.roadAt);
        expect(roadTicks.has(i)).toBe(true);
      }
      if (g === GROW_TILE.ROAD_H || g === GROW_TILE.PATH_STONE) expect(done.road[i]).toBe(1);
      if (isWorn(g)) { expect(w).toBeGreaterThanOrEqual(C.wornAt); expect(w).toBeLessThan(C.roadAt); }
    }
    expect(roadCells).toBe(roads + bridges);
  }, 15_000);

  test("routes ride the roads they wore, and roads concentrate footfall", () => {
    const done = doneOf(SEED);
    const walked = new Set<number>();
    for (const t of done.sim!.settlements) for (const r of t.routes) for (const i of r.cells) walked.add(i);
    for (const l of done.sim!.links) for (const i of l.cells) walked.add(i);
    let road = 0, onPath = 0;
    for (let i = 0; i < done.road.length; i++) if (done.road[i]) { road++; if (walked.has(i)) onPath++; }
    expect(road).toBeGreaterThan(100);
    expect(onPath / road).toBeGreaterThan(0.8);

    // Cheaper roads draw more feet: with trails and roads disabled the same
    // villages spread their footfall over more cells, each trodden less.
    // Each world has its own history, so compare totals over four seeds.
    const spread = (s: GrowState) => {
      let cells = 0, sum = 0, onRoad = 0;
      for (let i = 0; i < s.wear!.length; i++) {
        const w = s.wear![i]!;
        if (w) { cells++; sum += w; if (s.road[i]) onRoad += w; }
      }
      return { cells, sum, onRoad };
    };
    const never = 65_000;
    let roadedCells = 0, roadedSum = 0, roadlessCells = 0, roadlessSum = 0;
    for (const seed of [SEED, 0x5eed_0001, 1, 7]) {
      const roaded = spread(doneOf(seed));
      const roadless = spread(doneOf(seed, { ...DEFAULT_CAUSAL, wornAt: never, roadAt: never, pavedAt: never }));
      roadedCells += roaded.cells; roadedSum += roaded.sum;
      roadlessCells += roadless.cells; roadlessSum += roadless.sum;
      // Almost all footfall ends up on the roads it wore.
      expect(roaded.onRoad / roaded.sum).toBeGreaterThan(0.9);
      expect(roadless.onRoad).toBe(0);
    }
    expect(roadedCells).toBeLessThan(roadlessCells * 0.95);
    expect(roadedSum / roadedCells).toBeGreaterThan((roadlessSum / roadlessCells) * 1.1);
  }, 15_000);
});

/** Columns between the first and last village farther than any village's own reach. */
function betweenVillages(p: GrowParams): number[] {
  const xs = [0, 1, 2, 3].map((c) => settlementSite(p, c).x);
  const cols: number[] = [];
  for (let x = Math.min(...xs); x <= Math.max(...xs); x++) if (xs.every((cx) => Math.abs(x - cx) > VILLAGE_WINDOW)) cols.push(x);
  return cols;
}
function stripCells(s: GrowState, cols: readonly number[], layer: "road" | "wear"): number {
  let n = 0;
  for (const x of cols) for (let y = 0; y < H; y++) if (s[layer]![y * W + x]) n++;
  return n;
}

describe("grow-causal: trade roads", () => {
  // Seeds whose villages leave open country between them.
  const seeds = [0x5eed_0001, 2, 7];

  // An independent copy of the deal semantics, so the test pins what the
  // route ought to carry even if the sim's own lookup is rewritten.
  const woodTarget = (t: { pop: number }) => 10 + t.pop * 2;
  function needs(t: { pop: number; biome: number; food: number; wood: number; stone: number; roadCells: number }, g: Goods): boolean {
    if (g === "food") return t.food < t.pop * 4 + (t.biome === 3 ? t.pop * 4 : 0);
    if (g === "wood") return t.wood < woodTarget(t);
    return t.stone < 3 && t.roadCells >= 6;
  }
  function surplus(t: { pop: number; food: number; wood: number; stone: number }, g: Goods): number {
    if (g === "food") return Math.max(0, t.food - t.pop * 8);
    if (g === "wood") return Math.max(0, t.wood - woodTarget(t) * 2);
    return Math.max(0, t.stone - 8);
  }
  function deal(a: { pop: number; biome: number; food: number; wood: number; stone: number; roadCells: number }, b: typeof a): { give: Goods; take: Goods } | undefined {
    for (const give of GOODS) {
      if (surplus(a, give) <= 0 || !needs(b, give)) continue;
      for (const take of GOODS) if (take !== give && surplus(b, take) > 0 && needs(a, take)) return { give, take };
    }
    return undefined;
  }
  /** The mutual deal in either direction, with a first and b as the link records. */
  function linkDeal(a: Parameters<typeof deal>[0], b: Parameters<typeof deal>[0]): { give: Goods; take: Goods } | undefined {
    const ab = deal(a, b);
    if (ab) return ab;
    const ba = deal(b, a);
    return ba ? { give: ba.take, take: ba.give } : undefined;
  }

  /** Columns between two villages farther than either village's own reach. */
  function openColsBetween(p: GrowParams, a: number, b: number): number[] {
    const xs = [a, b].map((c) => settlementSite(p, c).x);
    const cols: number[] = [];
    for (let x = Math.min(...xs); x <= Math.max(...xs); x++) {
      if (xs.every((cx) => Math.abs(x - cx) > VILLAGE_WINDOW)) cols.push(x);
    }
    return cols;
  }

  test("without trade there is no link, no caravan and no footfall between villages", () => {
    const noTrade: CausalParams = { ...DEFAULT_CAUSAL, tradeRange: 0 };
    for (const seed of seeds) {
      const cols = betweenVillages(withSeed(seed));
      expect(cols.length).toBeGreaterThan(0);
      const s = doneOf(seed, noTrade);
      expect(s.sim!.links).toEqual([]);
      expect(s.sim!.events.filter((e) => e.kind.startsWith("trade-") || e.kind === "market")).toEqual([]);
      expect(stripCells(s, cols, "road")).toBe(0);
      expect(stripCells(s, cols, "wear")).toBe(0);
    }
  }, 15_000);

  test("trade wears a road across open country, and only between trading villages", () => {
    let roadedSeeds = 0;
    for (const seed of seeds) {
      const s = doneOf(seed);
      const p = s.params;
      const sim = s.sim!;
      for (const link of sim.links) {
        // The open country between this link's two villages.
        const cols = openColsBetween(p, link.a, link.b);
        const strip = stripCells(s, cols, "road");
        if (strip > 0 && link.roadFormed >= 0) roadedSeeds++;
        // Every road cell out in the open lies within some link's corridor.
        for (const x of cols) for (let y = 0; y < H; y++) {
          if (!s.road[y * W + x]) continue;
          expect(sim.links.some((l) => {
            const a = sim.settlements[l.a]!, b = sim.settlements[l.b]!;
            return x >= Math.min(a.cx, b.cx) - 6 && x <= Math.max(a.cx, b.cx) + 6;
          })).toBe(true);
        }
      }
      // A trade opens on a mutual need: different goods each way, in range.
      const opened = sim.events.filter((e) => e.kind === "trade-opened");
      expect(opened.length).toBeGreaterThanOrEqual(sim.links.length);
      for (const e of opened) {
        expect(GOODS).toContain(e.goods!);
        expect(GOODS).toContain(e.returns!);
        expect(e.goods).not.toBe(e.returns);
        expect(e.other).toBeDefined();
        expect(Math.abs(e.settlement - e.other!)).toBeLessThanOrEqual(p.causal!.tradeRange);
        const link = sim.links.find((l) => l.a === e.settlement && l.b === e.other);
        expect(link).toBeDefined();
        expect(link!.opened).toBeLessThanOrEqual(e.tick);
      }
      for (const link of sim.links) {
        expect(opened.some((e) => e.tick === link.opened && e.settlement === link.a && e.other === link.b)).toBe(true);
        const roadEvents = sim.events.filter((e) => e.kind === "trade-road" && e.settlement === link.a && e.other === link.b);
        expect(roadEvents.map((e) => e.tick)).toEqual(link.roadFormed >= 0 ? [link.roadFormed] : []);
        if (link.roadFormed >= 0) expect(link.caravans).toBeGreaterThan(0);
      }
    }
    expect(roadedSeeds).toBeGreaterThan(0);
  }, 15_000);

  test("regression: a caravan carries the current deal, and an empty deal sends no caravan", () => {
    // seed 17, link 0-1: the review's case. It opens on food<->stone; the
    // food surplus is gone by tick 56 and no other deal exists, so the
    // dispatch ticks 58, 62 and 66 must send no caravan at all.
    const p17 = withSeed(17);
    const at17 = (tick: number) => growToTick(p17, tick);
    const link17 = (tick: number) => at17(tick).sim!.links.find((l) => l.a === 0 && l.b === 1)!;
    expect(link17(38).opened).toBe(38);
    for (const dispatch of [58, 62, 66]) {
      expect(link17(dispatch).caravans, `tick ${dispatch}: no deal, no caravan`).toBe(link17(dispatch - 1).caravans);
    }
    // No trade, no footfall: cells of the trade road that no village route
    // walks (only caravans can reach them) gain no wear on those ticks.
    for (const dispatch of [58, 62, 66]) {
      const after = at17(dispatch);
      const link = after.sim!.links.find((l) => l.a === 0 && l.b === 1)!;
      const village = new Set<number>();
      for (const t of after.sim!.settlements) for (const r of t.routes) for (const i of r.cells) village.add(i);
      const cells = [...link.cells].filter((i) => !village.has(i));
      const before = at17(dispatch - 1);
      let wearBefore = 0, wearAfter = 0;
      for (const i of cells) { wearBefore += before.wear![i]!; wearAfter += after.wear![i]!; }
      expect(wearAfter - wearBefore, `tick ${dispatch}: no caravan tread past the villages`).toBe(0);
    }

    // seed 15, link 1-3: the complementary goods change while the route is
    // open (food<->wood, then food<->stone). The route must record the live
    // deal every tick, and a caravan must carry the current goods.
    const p15 = withSeed(15);
    const at15 = (tick: number) => growToTick(p15, tick);
    const link15 = (tick: number) => at15(tick).sim!.links.find((l) => l.a === 1 && l.b === 3)!;
    // The route opens on food<->stone; by tick 78 the live deal is
    // food<->wood, by tick 80 food<->stone again.
    expect([link15(76).give, link15(76).take]).toEqual(["food", "stone"]);
    // At every non-dispatch tick the route's goods are the live deal (a
    // dispatch tick changes stocks, so its end-of-tick deal may differ).
    for (const k of [76, 77, 78, 80, 81, 82]) {
      const s = at15(k);
      const d = linkDeal(s.sim!.settlements[1]!, s.sim!.settlements[3]!);
      if (d) expect([link15(k).give, link15(k).take], `tick ${k}`).toEqual([d.give, d.take]);
    }
    // The goods actually changed: at tick 78 the route carries wood, not
    // the stone it opened on; at tick 80 it is back to stone.
    expect([link15(78).give, link15(78).take]).toEqual(["food", "wood"]);
    expect([link15(80).give, link15(80).take]).toEqual(["food", "stone"]);
    // The dispatch at tick 79 carried wood back to a: against a no-trade
    // fold of the same seed, a holds more wood because of that caravan.
    const traded = at15(79), noTrade = growToTick(withSeed(15, { ...DEFAULT_CAUSAL, tradeRange: 0 }), 79);
    expect(link15(79).caravans).toBe(link15(78).caravans + 1);
    expect(traded.sim!.settlements[1]!.wood).toBeGreaterThan(noTrade.sim!.settlements[1]!.wood);
    expect(traded.sim!.settlements[3]!.food).toBeGreaterThan(noTrade.sim!.settlements[3]!.food);
  }, 30_000);
});

describe("grow-causal: decline and abandonment", () => {
  function findAbandoned(): { seed: number; event: GrowEvent } {
    for (const seed of SEARCH_SEEDS) {
      const event = doneOf(seed).sim!.events.find((e) => e.kind === "abandoned");
      if (event) return { seed, event };
    }
    throw new Error("no abandoned village in the searched seeds");
  }

  test("famine or cold empties a village, which is abandoned and falls to ruin", () => {
    const { seed, event } = findAbandoned();
    const id = event.settlement;
    const done = doneOf(seed);
    const mine = done.sim!.events.filter((e) => e.settlement === id);
    expect(mine.filter((e) => e.kind === "abandoned")).toEqual([event]);
    expect(mine.some((e) => (e.kind === "famine" || e.kind === "cold") && e.tick < event.tick)).toBe(true);
    const site = settlementSite(done.params, id);
    expect([event.x, event.y]).toEqual([site.x, site.y]);

    const { tl, end } = timelineOf(seed);
    expect(tl.snapshot(event.tick - 1)!.state.sim!.settlements[id]!.status).not.toBe("abandoned");
    for (let k = event.tick; k <= end; k++) {
      const town = tl.snapshot(k)!.state.sim!.settlements[id]!;
      expect(town.status).toBe("abandoned");
      expect(town.pop).toBe(0);
    }

    // Every home is a ruin by the end: collapsed walls on gravel.
    const town = done.sim!.settlements[id]!;
    expect(town.houses.length).toBeGreaterThan(0);
    const ruins = new Set<number>([GROW_TILE.RUIN_L, GROW_TILE.RUIN_M, GROW_TILE.RUIN_R]);
    let fellAfter = 0;
    for (const hi of town.houses) {
      const h = done.houses[hi]!;
      expect(h.ruined).toBeDefined();
      if (h.ruined! > event.tick) fellAfter++;
      expect(mine.some((e) => e.kind === "ruin" && e.tick === h.ruined)).toBe(true);
      const st = STAMPS[h.key!]!;
      for (let dy = 1; dy < st.h; dy++) for (let dx = 0; dx < st.w; dx++) {
        const i = (h.top! + dy) * W + h.x0! + dx;
        expect(ruins.has(done.upper[i]!)).toBe(true);
        expect(done.ground[i]).toBe(GROW_TILE.GRAVEL);
      }
    }
    expect(fellAfter).toBeGreaterThan(0);
  }, 20_000);

  test("supplies sent before the hunger keep the same village alive", () => {
    const { seed, event } = findAbandoned();
    const id = event.settlement;
    const { tl } = timelineOf(seed);
    // The last tick the village was still fed before its fall.
    let calm = -1;
    for (let k = 1; k < event.tick; k++) if (tl.snapshot(k)!.state.sim!.settlements[id]?.hunger === 0) calm = k;
    expect(calm).toBeGreaterThan(0);
    const relief: GrowIntervention[] = [
      { tick: calm, kind: "supply", settlement: id, goods: "food", amount: 300 },
      { tick: calm, kind: "supply", settlement: id, goods: "wood", amount: 150 },
    ];
    const forked = foldTo(forkGrow(growToTick(withSeed(seed), calm - 3), relief), event.tick);
    const town = forked.sim!.settlements[id]!;
    expect(town.status).not.toBe("abandoned");
    expect(town.pop).toBeGreaterThan(2);
    expect(forked.sim!.events.some((e) => e.kind === "abandoned" && e.settlement === id)).toBe(false);
    const arrived = forked.sim!.events.filter((e) => e.kind === "intervention");
    expect(arrived.map((e) => [e.tick, e.settlement, e.goods, e.amount])).toEqual([[calm, id, "food", 300], [calm, id, "wood", 150]]);
    expect(describeEvent(forked, arrived[0]!)).toContain("300 FOOD ARRIVES");

    // The same history from tick 0 via params.causal.interventions.
    const scratch = growToTick(withSeed(seed, { ...DEFAULT_CAUSAL, interventions: relief }), event.tick);
    expect(canon(scratch)).toEqual(canon(forked));
  }, 15_000);

  test("regression: a village with full stores is not abandoned", () => {
    // `hunger` counts consecutive short ticks: one fed tick resets it. A
    // decrement once kept people leaving with barns full after a famine
    // (seed 9, village 1, tick 162: 325 food for 3 people). A village
    // abandoned with full food, firewood and water is the same defect;
    // thirst alone (dry source) is a legitimate cause.
    const offenders: string[] = [];
    for (const seed of SEARCH_SEEDS) {
      for (const e of doneOf(seed).sim!.events) {
        if (e.kind !== "abandoned") continue;
        const town = growToTick(withSeed(seed), e.tick - 1).sim!.settlements[e.settlement]!;
        if (town.food >= town.pop * 10 && town.wood >= 10 && town.water >= town.pop) {
          offenders.push(`seed ${seed} village ${e.settlement} tick ${e.tick}: food ${town.food} wood ${town.wood} water ${town.water} pop ${town.pop}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  }, 20_000);
});

describe("grow-causal: water is a settlement need", () => {
  test("villages by their sources drink their fill; cistern and source are queryable", () => {
    const done = doneOf(SEED);
    for (const t of done.sim!.settlements) {
      expect(t.water).toBeGreaterThanOrEqual(0);
      expect(t.source).toBeGreaterThanOrEqual(0);
      if (t.status !== "abandoned") expect(t.thirst).toBe(0);
    }
    const sum = causalSummary(done);
    for (const t of sum.settlements) {
      expect(t.water).toBeGreaterThanOrEqual(0);
      expect(t.thirst).toBeGreaterThanOrEqual(0);
    }
    // The stream villages never run dry in the default world.
    const grass = done.sim!.settlements[0]!;
    expect(grass.thirst).toBe(0);
    expect(grass.water).toBeGreaterThan(0);
    expect(grass.source).toBeGreaterThan(0);
  });

  test("regression: diverting the source declines the village by thirst, not by hunger", () => {
    // The review's B1 counterfactual, as a test: remove the water and the
    // village must decline for lack of water, not merely for poorer fields.
    const dry: GrowIntervention = { tick: 50, kind: "dry", settlement: 0 };
    const fed: GrowIntervention = { tick: 50, kind: "supply", settlement: 0, goods: "food", amount: 400 };
    const control = growToTick(withSeed(SEED), 90);
    const dried = growToTick(withSeed(SEED, { ...DEFAULT_CAUSAL, interventions: [dry] }), 90);
    const driedFed = growToTick(withSeed(SEED, { ...DEFAULT_CAUSAL, interventions: [dry, fed] }), 90);
    const c0 = control.sim!.settlements[0]!;
    const d0 = dried.sim!.settlements[0]!;
    const f0 = driedFed.sim!.settlements[0]!;
    // The untouched village is fine; both dried folds collapse for water.
    expect(c0.status).toBe("growing");
    expect(c0.thirst).toBe(0);
    for (const [name, t] of [["dry", d0], ["dry+food", f0]] as const) {
      expect(t.status, name).toBe("abandoned");
      expect(t.thirst, name).toBeGreaterThan(3);
      expect(t.water, name).toBe(0);
      expect(t.pop, name).toBeLessThan(c0.pop);
    }
    // Even with full granaries the village dies: the cause is water, not food.
    expect(f0.food).toBeGreaterThan(300);
    // The drought and the diversion are both on the record.
    const droughts = driedFed.sim!.events.filter((e) => e.kind === "drought" && e.settlement === 0);
    expect(droughts.length).toBeGreaterThan(0);
    const diversion = driedFed.sim!.events.find((e) => e.kind === "intervention" && e.detail === "dry");
    expect(diversion).toBeDefined();
    expect(describeEvent(driedFed, diversion!)).toContain("WATER DRIES UP");
    // The dry riverbed no longer draws a water route or supplies the village.
    expect(d0.source).toBe(0);
    expect(d0.routes.some((r) => r.kind === "water")).toBe(false);
  }, 20_000);

  test("a dry intervention equals forking the same intervention from tick 0", () => {
    const dry: GrowIntervention = { tick: 50, kind: "dry", settlement: 0 };
    const viaParams = growToTick(withSeed(SEED, { ...DEFAULT_CAUSAL, interventions: [dry] }), 90);
    const viaFork = foldTo(forkGrow(growToTick(withSeed(SEED), 49), [dry]), 90);
    expect(canon(viaFork)).toEqual(canon(viaParams));
  }, 15_000);
});

describe("grow-causal: forkGrow", () => {
  test("forking at k with later interventions equals folding them from tick 0", () => {
    const k = 60;
    const ivs: GrowIntervention[] = [
      { tick: 70, kind: "supply", settlement: 1, goods: "food", amount: 120 },
      { tick: 100, kind: "blight", settlement: 2 },
      { tick: 130, kind: "supply", settlement: 0, goods: "stone", amount: 40 },
    ];
    const forked = foldTo(forkGrow(growToTick(DEFAULT_PARAMS, k), ivs));
    const scratch = growToDone({ ...DEFAULT_PARAMS, causal: { ...DEFAULT_CAUSAL, interventions: ivs } });
    expect(forked.tick).toBe(240);
    expect(canon(forked)).toEqual(canon(scratch));
    expect(forked.sim!.events.filter((e) => e.kind === "intervention").map((e) => e.tick)).toEqual([70, 100, 130]);
    // The interventions changed history, and a fork without any does not.
    expect(canon(forked).sim).not.toBe(canon(doneOf(SEED)).sim);
    const unchanged = foldTo(forkGrow(growToTick(DEFAULT_PARAMS, k), []));
    expect(canon(unchanged, ["params"])).toEqual(canon(doneOf(SEED), ["params"]));
    expect(() => forkGrow(growToTick(STAMP_PARAMS, 3), [])).toThrow();
  }, 15_000);
});

describe("grow-causal: event record", () => {
  test("query helpers agree with manual filters", () => {
    const done = doneOf(SEED);
    const events = done.sim!.events;
    for (let i = 1; i < events.length; i++) expect(events[i]!.tick).toBeGreaterThanOrEqual(events[i - 1]!.tick);

    const sites = done.sim!.settlements.map((t) => ({ x: t.cx, y: t.cy }));
    const probes = [...sites.map((s) => ({ ...s, r: 0 })), ...sites.map((s) => ({ ...s, r: 3 })), { x: 60, y: 10, r: 12 }, { x: 3000, y: 5, r: 4 }];
    for (const { x, y, r } of probes) {
      const manual = events.filter((e) => e.tick <= done.tick && Math.max(Math.abs(e.x - x), Math.abs(e.y - y)) <= r);
      expect(eventsNear(done, x, y, r)).toEqual(manual);
      expect(eventsNear(done, x, y, r, 100)).toEqual(manual.filter((e) => e.tick <= 100));
    }
    expect(eventsNear(done, sites[0]!.x, sites[0]!.y, 0).length).toBeGreaterThan(0);
    expect(eventsBetween(done, 50, 120)).toEqual(events.filter((e) => e.tick >= 50 && e.tick <= 120));
    expect(eventsBetween(done, 120, 50)).toEqual([]);

    let partnerOnly = 0;
    for (const t of done.sim!.settlements) {
      const of = eventsOf(done, t.id);
      expect(of).toEqual(events.filter((e) => e.settlement === t.id || e.other === t.id));
      partnerOnly += of.filter((e) => e.settlement !== t.id).length;
      const founded = events.filter((e) => e.kind === "founded" && e.settlement === t.id);
      expect(founded.length).toBe(1);
      expect(founded[0]!.tick).toBe(t.founded);
      expect(t.founded).toBe(1 + t.id * C.foundEvery);
      expect([founded[0]!.x, founded[0]!.y]).toEqual([settlementSite(done.params, t.id).x, settlementSite(done.params, t.id).y]);
    }
    expect(partnerOnly).toBeGreaterThan(0);

    let sawMinorLast = false;
    for (let t = 0; t <= done.tick; t++) {
      const upTo = events.filter((e) => e.tick <= t);
      const manual = upTo.filter((e) => MAJOR_EVENTS.has(e.kind)).at(-1);
      expect(latestMajorEvent(done, t)).toBe(manual);
      if (upTo.length && !MAJOR_EVENTS.has(upTo.at(-1)!.kind)) sawMinorLast = true;
    }
    expect(sawMinorLast).toBe(true);
    expect(latestMajorEvent(done)).toBe(events.filter((e) => MAJOR_EVENTS.has(e.kind)).at(-1));
  });

  test("the record is append-only and captions are uppercase ASCII", () => {
    const { tl, end } = timelineOf(SEED);
    const all = tl.snapshot(end)!.state.sim!.events;
    for (let k = 0; k <= end; k += 7) {
      const at = tl.snapshot(k)!.state.sim!.events;
      expect(at.length).toBeLessThanOrEqual(all.length);
      expect(at).toEqual(all.slice(0, at.length));
      expect(at.every((e) => e.tick <= k)).toBe(true);
      expect(all.slice(at.length).every((e) => e.tick > k)).toBe(true);
    }
    const kinds = new Set<string>();
    for (const seed of SEARCH_SEEDS) {
      const s = doneOf(seed);
      for (const e of s.sim!.events) {
        kinds.add(e.kind);
        const text = describeEvent(s, e);
        expect(text).toMatch(/^[ -~]+$/);
        expect(text).not.toMatch(/[a-z]/);
        expect(text).not.toContain("?");
        expect(text).not.toContain("UNDEFINED");
      }
    }
    // The searched worlds exercise every kind except the outside hand.
    expect(kinds.size).toBeGreaterThanOrEqual(16);
  }, 20_000);
});

describe("grow-causal: resources", () => {
  test("trees are cut to stumps that regrow, and rock is quarried to gravel", () => {
    const { tl, end } = timelineOf(SEED);
    const stump = stampCell("stump-big", 0, 0);
    // A cut regrows as a 2x2 sapling (a snow bush in the snow band).
    const saplings = new Set([stampCell("tree-small", 0, 0), stampCell("bush-snow", 0, 0)]);
    const cutAt = new Map<number, number>(), sapAt = new Map<number, number>();
    const regrown: { at: number; tick: number }[] = [];
    let quarried = 0;
    for (let k = 1; k <= end; k++) {
      const edits = tl.snapshot(k)!.edits;
      const ground = new Map<number, number>();
      for (const e of edits) if (e.layer === "ground") ground.set(e.index, e.after);
      for (const e of edits) {
        if (e.layer !== "upper") continue;
        if (e.after === stump) {
          // A cut tree is a natural 2x2 tree or palm standing at that cell.
          const owner = stampOwner(naturalTileAt(DEFAULT_PARAMS, e.index % W, Math.floor(e.index / W)));
          expect(owner?.w).toBe(2);
          expect(/^(tree|palm)/.test(owner!.key)).toBe(true);
          cutAt.set(e.index, k);
        } else if (saplings.has(e.after) && cutAt.has(e.index)) {
          sapAt.set(e.index, k);
        } else if (e.after === -1 && saplings.has(e.before) && sapAt.has(e.index)) {
          expect(sapAt.get(e.index)!).toBeGreaterThan(cutAt.get(e.index)!);
          regrown.push({ at: e.index, tick: k });
        }
        if (e.before === GROW_TILE.ROCK && e.after === -1) {
          quarried++;
          expect(ground.get(e.index)).toBe(GROW_TILE.GRAVEL);
        }
      }
    }
    expect(cutAt.size).toBeGreaterThan(20);
    expect(regrown.length).toBeGreaterThan(0);
    // The wild tree stands again where nothing else claimed the ground.
    const back = regrown.filter((r) => {
      const x = r.at % W, y = Math.floor(r.at / W);
      return wildernessTileAt(tl.at(r.tick), x, y) === naturalTileAt(DEFAULT_PARAMS, x, y);
    });
    expect(back.length).toBeGreaterThan(0);

    const rocks = (g: Int32Array) => g.reduce((n, v) => n + Number(v === GROW_TILE.ROCK), 0);
    expect(quarried).toBeGreaterThan(0);
    expect(rocks(createGrow(DEFAULT_PARAMS).upper) - rocks(doneOf(SEED).upper)).toBe(quarried);
  }, 15_000);

  test("forest-cleared is recorded at most once per four seasons per village", () => {
    let seen = 0;
    for (const seed of SEARCH_SEEDS) {
      const last = new Map<number, number>();
      for (const e of doneOf(seed).sim!.events) {
        if (e.kind !== "forest-cleared") continue;
        seen++;
        const prev = last.get(e.settlement);
        if (prev !== undefined) expect(e.tick - prev).toBeGreaterThan(C.seasonTicks * 4);
        last.set(e.settlement, e.tick);
      }
    }
    expect(seen).toBeGreaterThan(SEARCH_SEEDS.length);
  }, 15_000);

  test("regression: a sapling never grows on ground that was trodden or built meanwhile", () => {
    // regrowTick once wrote the sapling over the stump's 2x2 cells
    // unconditionally, so a stump worn into a road sprouted in the road
    // (default seed: tick 44, x 17..18, y 15 on ROAD_H).
    const { tl, end } = timelineOf(SEED);
    const sapling = (cell: number) => ["tree-small", "bush-snow"].includes(stampOwner(cell)?.key ?? "");
    const offenders: string[] = [];
    for (let k = 1; k <= end && offenders.length < 5; k++) {
      const edits = tl.snapshot(k)!.edits.filter((e) => e.layer === "upper" && sapling(e.after));
      if (!edits.length) continue;
      const s = tl.at(k);
      for (const e of edits) if (s.ground[e.index] !== -1) offenders.push(`tick ${k} (${e.index % W},${Math.floor(e.index / W)}) ground ${s.ground[e.index]}`);
    }
    expect(offenders).toEqual([]);
  }, 15_000);
});

describe("grow-causal: stamp rules untouched", () => {
  test("STAMP_PARAMS grows the original world with no causal layers", () => {
    const s = growToDone(STAMP_PARAMS);
    expect(s.wear).toBeUndefined();
    expect(s.sim).toBeUndefined();
    expect(STAMP_PARAMS.causal).toBeUndefined();
    expect(worldSummary(s).hash).toBe("2394ddef");
  });
});
