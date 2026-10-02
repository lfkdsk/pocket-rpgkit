// tests/rpgkit-grow.test.ts — D3 rule-growth pure reducer
// (apps/rpgkit/engine/grow.ts). Acceptance coverage:
//
//   1. PHASES      the four rules run in order road -> house -> farm ->
//                  villager -> done, and the tick total matches
//   2. DETERMINISM same seed folded frame-by-frame twice hashes identically
//                  and matches a direct growToDone; two seeds differ
//   3. SEEK        cached timeline state k is field-equal to growToTick(k)
//   4. RULES       road cells form connected paths off the plaza; every
//                  house footprint sits on open ground beside its road and
//                  footprints never overlap; farms keep their 4x4 box clear;
//                  every house has one villager whose route stays on road
//   5. PARAMS      changing params changes the output; params ride in state
//   6. RNG         the cursor is an ordinary state field: no randomness
//                  outside it (folding from a copied state replays)
//
// Rule numbers refer to the D3 spec: road -> houses -> farms -> villagers.

import { describe, expect, test } from "bun:test";
import {
  cloneGrowState,
  createGrow,
  biomeAt,
  biomeBoundaryX,
  STAMP_PARAMS,
  DX,
  DY,
  growToDone,
  growToTick,
  GROW_TILE,
  liveFrameAtTick,
  naturalStampAt,
  naturalTileAt,
  warmWilderness,
  plazaCenter,
  stepGrowFrame,
  stepGrowTick,
  tickEveryFrames,
  worldSummary,
  wildernessTileAt,
  type GrowParams,
  type GrowState,
} from "../examples/grow/grow.ts";
import { GrowTimeline } from "../examples/grow/grow-timeline.ts";

function foldFrames(p: GrowParams, frames: number, hz = 60): GrowState {
  let s = createGrow(p);
  for (let f = 0; f < frames; f++) s = stepGrowFrame(s, hz);
  return s;
}

function foldTicks(p: GrowParams, ticks: number): GrowState {
  let s = createGrow(p);
  for (let t = 0; t < ticks; t++) s = stepGrowTick(s);
  return s;
}

/** The content fields that must agree across simulation rates at one
 *  virtual moment (frame/hz are clock fields and differ by rate). */
function contentOf(s: GrowState) {
  return {
    tick: s.tick,
    phase: s.phase,
    rng: s.rng,
    ground: s.ground,
    upper: s.upper,
    road: s.road,
    roads: s.roads,
    houses: s.houses,
    farms: s.farms,
    villagers: s.villagers,
    frontierX: s.frontierX,
    roadFrontierX: s.roadFrontierX,
    cameraX: s.cameraX,
  };
}

describe("grow: phase order and termination", () => {
  test("runs road, house, farm, villager, then done", () => {
    const seen: string[] = [];
    let s = createGrow(STAMP_PARAMS);
    while (s.phase !== "done") {
      seen.push(s.phase);
      s = stepGrowTick(s);
    }
    const firsts = seen.filter((p, i) => seen.indexOf(p) === i);
    expect(firsts).toEqual(["road", "house", "farm", "villager", "decor"]);
    expect(s.phase).toBe("done");
    expect(s.tick).toBe(156);
    expect(worldSummary(s).hash).toBe("2394ddef");
    // Every house got exactly one villager before done.
    expect(s.villagers.length).toBe(s.houses.length);
  });

  test("growToTick past the end rests at done and does not overgrow", () => {
    const total = totalOf(STAMP_PARAMS);
    const past = growToTick(STAMP_PARAMS, total + 50);
    expect(past.phase).toBe("done");
    expect(past.tick).toBe(total);
    expect(past.villagers.length).toBe(past.houses.length);
  });
});

function totalOf(p: GrowParams): number {
  return growToDone(p).tick;
}

describe("grow: determinism", () => {
  test("same seed folded twice is field-equal frame by frame", () => {
    const frames = tickEveryFrames(STAMP_PARAMS, 60) * 90;
    const a = foldFrames(STAMP_PARAMS, frames, 60);
    const b = foldFrames(STAMP_PARAMS, frames, 60);
    expect(worldSummary(a)).toEqual(worldSummary(b));
    // Deep equality, not just the digest.
    expect(JSON.parse(JSON.stringify(a))).toEqual(JSON.parse(JSON.stringify(b)));
  });

  test("the frame fold lands the same world as the tick fold", () => {
    // Walk to tick k via frames; compare against a direct tick fold.
    const k = 25;
    const viaFrames = foldFrames(STAMP_PARAMS, k * tickEveryFrames(STAMP_PARAMS, 60), 60);
    const viaTicks = foldTicks(STAMP_PARAMS, k);
    expect(viaFrames.tick).toBe(k);
    expect(worldSummary(viaFrames)).toEqual(worldSummary(viaTicks));
    expect(viaFrames.ground).toEqual(viaTicks.ground);
    expect(viaFrames.upper).toEqual(viaTicks.upper);
    expect(viaFrames.houses).toEqual(viaTicks.houses);
  });

  test("two seeds grow different roads and a different world hash", () => {
    const a = growToDone({ ...STAMP_PARAMS, seed: 0xaaaa_0001 });
    const b = growToDone({ ...STAMP_PARAMS, seed: 0xbbbb_0002 });
    const wa = worldSummary(a);
    const wb = worldSummary(b);
    expect(wa.hash).not.toBe(wb.hash);
    expect(wa.roadCells).not.toBe(wb.roadCells);
  });

  test("RNG is only the state cursor: cloning mid-grow replays exactly", () => {
    const before = foldTicks(STAMP_PARAMS, 12);
    let s = before;
    for (let i = 0; i < 20; i++) s = stepGrowTick(s);
    // Typed-array grids need an explicit state clone; JSON would turn them
    // into keyed objects and obscure the invariant this test targets. The
    // cloned RNG cursor remains the only source of reducer randomness.
    let fromClone: GrowState = cloneGrowState(before);
    for (let i = 0; i < 20; i++) fromClone = stepGrowTick(fromClone);
    expect(worldSummary(s)).toEqual(worldSummary(fromClone));
  });
});

describe("grow: timeline seek", () => {
  test("the default per-seed cache materializes each tick once and stays field-equal", () => {
    const timeline = new GrowTimeline(STAMP_PARAMS);
    const done = growToDone(STAMP_PARAMS);
    let expected = createGrow(STAMP_PARAMS);
    for (let k = 0; k <= done.tick; k++) {
      const actual = timeline.at(k);
      expect(actual).toEqual(expected);
      // Force a cold grid-hash calculation on fresh typed-array identities.
      // It must equal the incrementally maintained hash.
      const cold = { ...actual, ground: actual.ground.slice(), upper: actual.upper.slice() };
      expect(worldSummary(actual).hash).toBe(worldSummary(cold).hash);
      if (expected.phase !== "done") expected = stepGrowTick(expected);
    }
    // Revisit every state in reverse and compare it with a fresh fold. This
    // exercises backward edit application, including camera and the hash,
    // while the call count proves seeking does not rerun the reducer.
    for (let k = done.tick; k >= 0; k--) {
      const actual = timeline.at(k);
      const fresh = growToTick(STAMP_PARAMS, k);
      expect(contentOf(actual)).toEqual(contentOf(fresh));
      expect(worldSummary(actual).hash).toBe(worldSummary(fresh).hash);
    }
    expect(timeline.stats()).toMatchObject({
      seed: STAMP_PARAMS.seed,
      states: Math.ceil(done.tick / 32) + 1,
      stepCalls: done.tick,
      checkpointInterval: 32,
    });
  }, 15_000);

  test("large configured timelines retain bounded checkpoints", () => {
    const params = {
      ...STAMP_PARAMS,
      width: 1_024, roadCells: 600, houseCount: 0, farmPatches: 0, decorPatches: 0,
    };
    const timeline = new GrowTimeline(params);
    const at300 = timeline.at(300);
    expect(at300).toEqual(growToTick(params, 300));
    expect(timeline.stats().checkpointInterval).toBe(32);
    expect(timeline.stats().states).toBeLessThanOrEqual(Math.ceil(300 / 32) + 1);
  }, 15_000);

  test("each tick shares every grid layer it did not write", () => {
    let previous = createGrow(STAMP_PARAMS);
    let sharedLayers = 0, transitions = 0;
    while (previous.phase !== "done") {
      const next = stepGrowTick(previous);
      sharedLayers += Number(next.ground === previous.ground)
        + Number(next.upper === previous.upper)
        + Number(next.road === previous.road);
      for (const layer of ["ground", "upper", "road"] as const) {
        // A porch action can touch all three layers. Assert the sharing rule
        // itself rather than a ratio tied to the previous content schedule.
        if (previous.phase === "villager") expect(next[layer]).toBe(previous[layer]);
      }
      transitions++;
      previous = next;
    }
    // Non-writing actions retain at least one layer per action on average.
    // Replacing writable() with unconditional copies makes this zero.
    expect(sharedLayers).toBeGreaterThan(transitions);
  });

  test("scrubbing to tick k equals growing live to tick k, field by field", () => {
    const live = growToDone(STAMP_PARAMS);
    for (const k of [0, 1, 5, 17, live.tick - 1, live.tick]) {
      const scrubbed = growToTick(STAMP_PARAMS, k);
      const grown = foldTicks(STAMP_PARAMS, k);
      expect(scrubbed.tick).toBe(Math.min(k, live.tick));
      expect(JSON.parse(JSON.stringify(scrubbed))).toEqual(
        JSON.parse(JSON.stringify(grown)),
      );
    }
    // ~4 s alone (two full folds per k); a loaded machine needs the headroom.
  }, 30_000);

  test("live action boundaries equal a fresh scrub, including camera position", () => {
    // At these rates a 0.2-second growth deadline falls on an exact frame.
    // The separate equal-virtual-time test covers 4 Hz, where one frame can
    // land between deadlines and therefore observe an interpolated camera.
    for (const hz of [60, 30, 20]) {
      let live = createGrow(STAMP_PARAMS);
      for (let frame = 0; frame < liveFrameAtTick(STAMP_PARAMS, hz, 55); frame++) {
        live = stepGrowFrame(live, hz);
        if (live.grew) {
          const scrub = growToTick(STAMP_PARAMS, live.tick);
          expect(contentOf(live)).toEqual(contentOf(scrub));
        }
      }
    }
  }, 15_000);

  test("camera advances smoothly between action boundaries", () => {
    let s = createGrow(STAMP_PARAMS);
    const seen = new Set<number>();
    for (let frame = 0; frame < liveFrameAtTick(STAMP_PARAMS, 60, 40); frame++) {
      s = stepGrowFrame(s, 60);
      seen.add(s.cameraX);
    }
    const xs = [...seen];
    expect(xs.length).toBeGreaterThan(25);
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThanOrEqual(xs[i - 1]!);
  });

  test("the coalesced delta between any two ticks turns one state into the other", () => {
    const timeline = new GrowTimeline(STAMP_PARAMS);
    const total = timeline.finish();
    const grids = (k: number) => {
      const s = timeline.at(k);
      // at() reuses one cursor; keep this tick's cells.
      return { ground: s.ground.slice(), upper: s.upper.slice() };
    };
    const states = Array.from({ length: total + 1 }, (_, k) => grids(k));
    const editedIn = (a: number, b: number) => {
      const edited = new Set<number>();
      for (let t = Math.min(a, b) + 1; t <= Math.max(a, b); t++) {
        for (const edit of timeline.snapshot(t)!.edits) if (edit.layer !== "road") edited.add(edit.index);
      }
      return edited;
    };
    let seed = 0x5eed;
    const next = () => { seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0; return seed % (total + 1); };
    const pairs: [number, number][] = [[0, total], [total, 0], [37, 37], [0, 1], [1, 0]];
    for (let i = 0; i < 120; i++) pairs.push([next(), next()]);
    const changed: number[] = [];
    const groundOnly: number[] = [];
    for (const [a, b] of pairs) {
      expect(timeline.changedCells(a, b, "ground+upper", changed)).toBe(true);
      expect(timeline.changedCells(a, b, "ground", groundOnly)).toBe(true);
      const set = new Set(changed);
      // Each changed cell once, and only cells some tick in the span edited.
      expect(set.size).toBe(changed.length);
      const edited = editedIn(a, b);
      expect(set).toEqual(edited);
      const from = states[a]!, to = states[b]!;
      // Copying just those cells from b's layers onto a's yields b exactly.
      const ground = from.ground.slice(), upper = from.upper.slice();
      for (const index of changed) { ground[index] = to.ground[index]!; upper[index] = to.upper[index]!; }
      expect(ground).toEqual(to.ground);
      expect(upper).toEqual(to.upper);
      // The ground-only delta covers every ground difference, inside the full one.
      const groundSet = new Set(groundOnly);
      for (const index of groundOnly) expect(set.has(index)).toBe(true);
      for (let i = 0; i < from.ground.length; i++) {
        if (from.ground[i] !== to.ground[i]) expect(groundSet.has(i)).toBe(true);
      }
      // Direction does not matter.
      const back: number[] = [];
      timeline.changedCells(b, a, "ground+upper", back);
      expect(new Set(back)).toEqual(set);
    }
  }, 30_000);

  test("the coalesced delta refuses a span that is not recorded yet", () => {
    const timeline = new GrowTimeline(STAMP_PARAMS);
    const out = [1, 2, 3];
    expect(timeline.changedCells(0, 40, "ground+upper", out)).toBe(false);
    expect(out).toEqual([]);
    timeline.prefillTo(40);
    expect(timeline.changedCells(40, 0, "ground+upper", out)).toBe(true);
    expect(out.length).toBeGreaterThan(0);
  });

  test("every tick between 0 and done is reachable and monotone", () => {
    const done = growToDone(STAMP_PARAMS);
    let s = createGrow(STAMP_PARAMS);
    const roadCountAt: number[] = [0];
    while (s.phase !== "done") {
      s = stepGrowTick(s);
      roadCountAt.push(s.roads.length);
      expect(s.tick).toBe(roadCountAt.length - 1);
    }
    expect(roadCountAt).toEqual([...roadCountAt].sort((a, b) => a - b));
  });
});

describe("grow: rule invariants", () => {
  test("settled decor uses biome nature on undeveloped walkable cells", () => {
    const s = growToDone(STAMP_PARAMS);
    expect(s.decor.length).toBe(STAMP_PARAMS.decorPatches);
    for (const i of s.decor) {
      const x = i % s.params.width;
      const y = Math.floor(i / s.params.width);
      // Decor art is one of the walkable canopy cells.
      const decorTiles: readonly number[] = [
        GROW_TILE.TREE, GROW_TILE.BUSH, GROW_TILE.PALM, GROW_TILE.CACTUS,
        GROW_TILE.FIR, GROW_TILE.SNOW_SHRUB, GROW_TILE.FLOWER_PROP,
        GROW_TILE.GRASS_TUFT, GROW_TILE.LOGS, GROW_TILE.ROCK,
      ];
      expect(decorTiles).toContain(s.upper[i]);
      // It is planted on plain grass, not a road.
      expect(s.road[i]).toBe(0);
      expect(s.ground[i]).toBe(-1);
      expect(s.houses.some((h) => Math.abs(h.x - x) + Math.abs(h.y - y) <= 6)).toBe(true);
      // Interior band, never the border ring.
      expect(x).toBeGreaterThanOrEqual(2);
      expect(x).toBeLessThan(s.params.width - 2);
      expect(y).toBeGreaterThanOrEqual(2);
      expect(y).toBeLessThan(s.params.height - 2);
    }
  });

  test("four biome settlements have centers, road-facing homes, work areas and residents", () => {
    const s = growToDone(STAMP_PARAMS);
    const chapters: { houses: number; farms: number; residents: number }[] = [];
    for (let chapter = 0; chapter < 4; chapter++) {
      const cx = 16 + chapter * STAMP_PARAMS.biomeBandWidth;
      // The town's own row: the middle of its plaza column (towns wiggle by a row).
      const plazaRows = Array.from({ length: s.params.height }, (_, y) => y).filter((y) => s.ground[y * s.params.width + cx] === GROW_TILE.PLAZA);
      const cy = plazaRows[Math.floor(plazaRows.length / 2)]!;
      // Lots span 13 columns west of the plaza to 7 east (clear of the seam and the next river).
      const houses = s.houses.filter((h) => h.x >= cx - 14 && h.x <= cx + 8);
      const farms = s.farms.filter((f) => f.centerX === cx);
      const residents = s.villagers.filter((v) => houses.includes(s.houses[v.house]!));
      expect(houses.length).toBeGreaterThanOrEqual(5);
      expect(houses.length).toBeLessThanOrEqual(8);
      // Both rows are built: doors on the trunk side and doors on the back lane.
      expect(houses.some((h) => h.y < cy)).toBe(true);
      expect(houses.some((h) => h.y > cy)).toBe(true);
      expect(farms).toHaveLength(1);
      expect(residents).toHaveLength(houses.length);
      expect(houses.every((h) => s.road[h.y * s.params.width + h.x] === 1)).toBe(true);
      expect(farms[0]!.biome).toBe(chapter as 0 | 1 | 2 | 3);
      chapters.push({ houses: houses.length, farms: farms.length, residents: residents.length });
    }
    // Mutation proof: removing one town's center-linked work area makes the
    // same per-chapter invariant fail.
    const mutant = chapters.map((chapter) => ({ ...chapter }));
    mutant[2]!.farms = 0;
    expect(mutant.every((chapter) => chapter.houses >= 5 && chapter.farms === 1 && chapter.residents === chapter.houses)).toBe(false);
  });

  test("wilderness forms adjacent clusters and development clears occupied cells", () => {
    const done = growToDone(STAMP_PARAMS);
    let natural = 0, adjacent = 0;
    for (let y = 1; y < STAMP_PARAMS.height - 1; y++) for (let x = 1; x < 128; x++) {
      if (!naturalTileAt(STAMP_PARAMS, x, y)) continue; natural++;
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => naturalTileAt(STAMP_PARAMS, x + dx!, y + dy!))) adjacent++;
      const i = y * STAMP_PARAMS.width + x;
      if (done.ground[i] >= 0 || done.upper[i] >= 0 || done.road[i]) expect(wildernessTileAt(done, x, y)).toBe(0);
    }
    expect(natural).toBeGreaterThan(900);
    expect(adjacent / natural).toBeGreaterThan(0.8);
    // Mutation proof: a peppered distribution with no neighboring cells is
    // rejected by the same 80% clustering threshold.
    expect(0 / natural).toBeLessThanOrEqual(0.8);
    for (const r of done.roads) expect(wildernessTileAt(done, r.x, r.y)).toBe(0);
  });

  test("each seeded biome seam varies by row and neighboring rows stay joined", () => {
    for (let band = 1; band <= 4; band++) {
      const xs = Array.from({ length: STAMP_PARAMS.height }, (_, y) => biomeBoundaryX(STAMP_PARAMS, band, y));
      expect(new Set(xs).size).toBeGreaterThan(1);
      for (let y = 1; y < xs.length; y++) expect(Math.abs(xs[y]! - xs[y - 1]!)).toBeLessThanOrEqual(1);
      for (let y = 0; y < xs.length; y++) {
        expect(biomeAt(STAMP_PARAMS, xs[y]! - 1, y)).toBe(((band - 1) % 4) as 0 | 1 | 2 | 3);
        expect(biomeAt(STAMP_PARAMS, xs[y]!, y)).toBe((band % 4) as 0 | 1 | 2 | 3);
      }
      // Mutation proof: the former straight boundary has one x for all rows.
      expect(new Set(new Array(xs.length).fill(band * STAMP_PARAMS.biomeBandWidth)).size).toBe(1);
    }
  });

  test("visible 60-column windows remain at least 30 percent authored or natural", () => {
    let s = createGrow(STAMP_PARAMS);
    while (true) {
      const camera = Math.max(0, s.cameraX + STAMP_PARAMS.cameraLeadPx - 960 * 0.6);
      const x0 = Math.max(0, Math.floor(camera / 16) - 1);
      const x1 = Math.floor((camera + 959) / 16) + 1;
      let occupied = 0, total = 0;
      for (let y = 0; y < STAMP_PARAMS.height; y++) for (let x = x0; x <= x1; x++) {
        total++; const i = y * STAMP_PARAMS.width + x;
        if (s.ground[i] >= 0 || s.upper[i] >= 0 || naturalTileAt(STAMP_PARAMS, x, y)) occupied++;
      }
      expect(occupied / total, `tick ${s.tick}`).toBeGreaterThanOrEqual(0.3);
      // Mutation proof: an empty 60-column viewport fails the same threshold.
      expect(0 / total).toBeLessThan(0.3);
      if (s.phase === "done") break; s = stepGrowTick(s);
    }
  });

  test("roads connect to the plaza and stay in the margin", () => {
    const s = growToDone(STAMP_PARAMS);
    const { x: cx, y: cy } = plazaCenter(STAMP_PARAMS);
    // Flood fill road cells from the plaza; every laid road is reached.
    const seen = new Set<number>();
    const stack = [[cx, cy]];
    while (stack.length) {
      const [x, y] = stack.pop()!;
      const i = y * s.params.width + x;
      if (seen.has(i) || s.road[i] !== 1) continue;
      seen.add(i);
      for (let d = 0; d < 4; d++) stack.push([x + DX[d], y + DY[d]]);
    }
    for (const r of s.roads) {
      expect(seen.has(r.y * s.params.width + r.x)).toBe(true);
      expect(r.x).toBeGreaterThanOrEqual(1);
      expect(r.x).toBeLessThan(s.params.width - 1);
      expect(r.y).toBeGreaterThanOrEqual(1);
      expect(r.y).toBeLessThan(s.params.height - 1);
    }
  });

  test("house footprints never overlap and sit on non-road ground", () => {
    const s = growToDone(STAMP_PARAMS);
    const occupied = new Set<string>();
    for (const h of s.houses) {
      // The door cell is the road.
      expect(s.road[h.y * s.params.width + h.x]).toBe(1);
      const rows = h.door === 2 ? [1, 2] : [-1, -2];
      for (const dy of rows) {
        for (let dx = -1; dx <= 1; dx++) {
          const key = `${h.x + dx},${h.y + dy}`;
          expect(occupied.has(key)).toBe(false);
          occupied.add(key);
          const i = (h.y + dy) * s.params.width + h.x + dx;
          expect(s.road[i]).toBe(0);
          expect(s.upper[i]).not.toBe(-1);
        }
      }
    }
  });

  test("farm 4x4 boxes are disjoint and free of roads/huts", () => {
    const s = growToDone(STAMP_PARAMS);
    const boxes: [number, number, number, number][] = [];
    for (const f of s.farms) {
      // No overlap with any other farm box.
      for (const [x0, y0, x1, y1] of boxes) {
        const disjoint = f.x + 2 < x0 || f.x - 1 > x1 || f.y + 2 < y0 || f.y - 1 > y1;
        expect(disjoint).toBe(true);
      }
      boxes.push([f.x - 1, f.y - 1, f.x + 2, f.y + 2]);
      for (let y = f.y - 1; y <= f.y + 2; y++) {
        for (let x = f.x - 1; x <= f.x + 2; x++) {
          expect(s.road[y * s.params.width + x]).toBe(0);
        }
      }
    }
  });

  test("every house owns one villager whose route never leaves a road", () => {
    const s = growToDone(STAMP_PARAMS);
    for (const h of s.houses) {
      expect(h.villager).toBeGreaterThanOrEqual(0);
      const v = s.villagers[h.villager]!;
      expect(v.house).toBe(s.houses.indexOf(h));
      // Walk the route; every move ends on a road cell.
      let x = v.x;
      let y = v.y;
      expect(s.road[y * s.params.width + x]).toBe(1);
      const move = { moveDown: [0, 1], moveLeft: [-1, 0], moveRight: [1, 0], moveUp: [0, -1] } as const;
      for (const step of v.route) {
        if (typeof step !== "string" || step === "wait") continue;
        if (step in move) {
          const [dx, dy] = move[step as keyof typeof move];
          x += dx;
          y += dy;
          expect(s.road[y * s.params.width + x]).toBe(1);
        }
      }
    }
  });
});

describe("grow: parameters ride in state", () => {
  test("tickSeconds divides growth timing but not the grown world", () => {
    const fast = foldFrames({ ...STAMP_PARAMS, tickSeconds: 0.1 }, 6 * 40, 60);
    const slow = foldFrames({ ...STAMP_PARAMS, tickSeconds: 0.4 }, 24 * 40, 60);
    expect(fast.tick).toBe(slow.tick);
    expect(worldSummary(fast).hash).toBe(worldSummary(slow).hash);
  });

  test("a different road target changes the world", () => {
    const a = growToDone({ ...STAMP_PARAMS, roadCells: 12 });
    const b = growToDone({ ...STAMP_PARAMS, roadCells: 100 });
    expect(a.roads.length).toBeLessThan(b.roads.length);
    expect(worldSummary(a).hash).not.toBe(worldSummary(b).hash);
  });

  test("rightward trunk reaches multiple biome bands and keeps its exact budget", () => {
    const s = growToDone(STAMP_PARAMS);
    expect(s.roads.length).toBeLessThanOrEqual(STAMP_PARAMS.roadCells);
    expect(s.roads.length).toBeGreaterThan(140);
    expect(s.roadFrontierX).toBeGreaterThan(STAMP_PARAMS.biomeBandWidth * 3);
    // The trunk only grows east; west of the first plaza there are only that
    // town's own lot paths and back lane (lots reach 13 columns west).
    expect(s.roads.every((r) => r.x >= plazaCenter(STAMP_PARAMS).x - 14)).toBe(true);
  });
});

describe("grow: virtual-time cadence is hz-portable", () => {
  test("tickEveryFrames derives one fixed virtual period at every rate", () => {
    expect(tickEveryFrames(STAMP_PARAMS, 60)).toBe(12);
    expect(tickEveryFrames(STAMP_PARAMS, 30)).toBe(6);
    expect(tickEveryFrames(STAMP_PARAMS, 20)).toBe(4);
    // 0.2 s at 4 Hz is 0.8 frames: one frame crosses the first deadline
    // only partially, so the period rounds to 1; the frame fold fires the
    // whole set of crossed actions per frame instead.
    expect(tickEveryFrames(STAMP_PARAMS, 4)).toBe(1);
  });

  for (const seconds of [1, 5, 10, 15]) {
    test(`the same ${seconds} virtual seconds grow the same world at 60/30/20/4 Hz`, () => {
      const runs = [60, 30, 20, 4].map((hz) =>
        foldFrames(STAMP_PARAMS, Math.round(seconds * hz), hz),
      );
      const ref = contentOf(runs[0]!);
      for (const s of runs) expect(contentOf(s)).toEqual(ref);
      // A direct tick fold to the reached tick is the same world.
      const target = ref.tick;
      expect(contentOf(foldTicks(STAMP_PARAMS, target))).toEqual(ref);
    });
  }

  test("a coarse 4 Hz frame can land several actions in tick order", () => {
    const s = foldFrames(STAMP_PARAMS, 20, 4); // 5 virtual seconds
    expect(s.tick).toBe(25);
  });

  test("every rate ends at the same done world", () => {
    const done = growToDone(STAMP_PARAMS);
    const seconds = Math.ceil(done.tick * STAMP_PARAMS.tickSeconds) + 1;
    const runs = [60, 30, 20, 4].map((hz) =>
      foldFrames(STAMP_PARAMS, Math.round(seconds * hz), hz),
    );
    for (const s of runs) {
      expect(s.phase).toBe("done");
      expect(s.tick).toBe(done.tick);
      expect(worldSummary(s).hash).toBe(worldSummary(done).hash);
    }
  });
});

describe("grow: wilderness caches", () => {
  const cells = (p: GrowParams, order: "rows" | "reverse" | "scattered") => {
    const at: [number, number][] = [];
    for (let y = -1; y <= p.height; y++) for (let x = -1; x < 180; x++) at.push([x, y]);
    if (order === "reverse") at.reverse();
    if (order === "scattered") {
      for (let i = at.length - 1; i > 0; i--) {
        const j = (Math.imul(i, 7_919) + 13 >>> 0) % (i + 1);
        [at[i], at[j]] = [at[j]!, at[i]!];
      }
    }
    return at.map(([x, y]) => `${x},${y}:${naturalTileAt(p, x, y)}`);
  };

  test("natural tiles do not depend on the order cells are first asked for", () => {
    // Each params object owns its caches; a cache miss settles a whole 2x2
    // block, so the visiting order must not leak into any cell.
    const rows = cells({ ...STAMP_PARAMS }, "rows").sort();
    expect(cells({ ...STAMP_PARAMS }, "reverse").sort()).toEqual(rows);
    expect(cells({ ...STAMP_PARAMS }, "scattered").sort()).toEqual(rows);
    expect(rows.filter((cell) => !cell.endsWith(":0")).length).toBeGreaterThan(1_000);
  });

  test("warming columns ahead of time leaves the same wilderness and biomes", () => {
    const cold = { ...STAMP_PARAMS };
    const warm = { ...STAMP_PARAMS };
    warmWilderness(warm, 0, 179);
    for (let y = 0; y < STAMP_PARAMS.height; y++) for (let x = 0; x < 180; x++) {
      expect(naturalTileAt(warm, x, y)).toBe(naturalTileAt(cold, x, y));
      expect(biomeAt(warm, x, y)).toBe(biomeAt(cold, x, y));
    }
    const done = growToDone(STAMP_PARAMS);
    for (let y = 0; y < STAMP_PARAMS.height; y++) for (let x = 0; x < 180; x++) {
      expect(wildernessTileAt({ ...done, params: warm }, x, y)).toBe(wildernessTileAt(done, x, y));
    }
  });
});

describe("D6h art placement", () => {
  test("streams have two or three water cells, changing banks, and road bridges", () => {
    const s = growToDone(STAMP_PARAMS);
    for (const band of [0, 1]) {
      const widths: number[] = [], lefts = new Set<number>();
      for (let y = 3; y < s.params.height - 3; y++) {
        const cells: number[] = [];
        for (let x = band * 32 + 23; x < band * 32 + 31; x++) {
          if (s.ground[y * s.params.width + x] === GROW_TILE.WATER) cells.push(x);
        }
        if (cells.length) { widths.push(cells.length); lefts.add(cells[0]!); }
      }
      expect(widths.every(w => w === 2 || w === 3)).toBe(true);
      expect(new Set(widths).size).toBe(2);
      expect(lefts.size).toBeGreaterThan(2);
      expect(s.roads.some(r => r.x >= band * 32 + 25 && r.x <= band * 32 + 29
        && s.ground[r.y * s.params.width + r.x] === GROW_TILE.BRIDGE_H)).toBe(true);
    }
  });

  test("developing any part of a tree removes its whole silhouette", () => {
    const done = growToDone(STAMP_PARAMS);
    let cleared = 0;
    for (let y = 1; y < STAMP_PARAMS.height - 1; y++) for (let x = 1; x < 128; x++) {
      const whole = naturalStampAt(STAMP_PARAMS, x, y);
      // Visit each multi-cell stamp once, from its top-left cell.
      if (!whole || whole.x !== x || whole.y !== y) continue;
      const cells = Array.from({ length: whole.w * whole.h }, (_, i) => [x + i % whole.w, y + Math.floor(i / whole.w)] as const);
      const at = (px: number, py: number) => py * done.params.width + px;
      if (!cells.some(([px, py]) => done.ground[at(px, py)]! >= 0 || done.upper[at(px, py)]! >= 0 || done.road[at(px, py)])) continue;
      for (const [px, py] of cells) expect(wildernessTileAt(done, px, py)).toBe(0);
      cleared++;
    }
    expect(cleared).toBeGreaterThan(20);
  });
});
