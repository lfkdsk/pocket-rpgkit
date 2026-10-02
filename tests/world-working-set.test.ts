import { describe, expect, test } from "bun:test";
import {
  componentOfMap,
  imminentMaps,
  visibleMaps,
  workingSet,
  type WorldPixelRect,
} from "../src/engine/world-working-set.ts";
import type { WorldLayout } from "../src/engine/types.ts";

// Mirrors the fixture in world-layout.test.ts: west (-12,-7) 12x9,
// east (0,-7) 8x9, north (-12,-11) 12x4, tile 16. west has two east-side
// openings: safe spans local y 2..3, fixed spans local y 4..6, plus a
// north-side door (local x 6..8) into the north map.
const LAYOUT: WorldLayout = {
  topologyHash: "a".repeat(64),
  components: [{
    worldId: "overworld",
    componentId: "main",
    bounds: { minTileX: -12, minTileY: -11, maxTileX: 8, maxTileY: 2 },
    placements: [
      { mapId: "east", originTileX: 0, originTileY: -7, width: 8, height: 9 },
      { mapId: "north", originTileX: -12, originTileY: -11, width: 12, height: 4 },
      { mapId: "west", originTileX: -12, originTileY: -7, width: 12, height: 9 },
    ],
    seams: [
      {
        mapA: "west", sideA: "east", spanA: { start: 0, end: 9 },
        mapB: "east", sideB: "west", spanB: { start: 0, end: 9 },
        axis: "y", offsetAtoB: 0, openingIds: ["west:east:fixed", "west:east:safe"],
      },
      {
        mapA: "west", sideA: "north", spanA: { start: 0, end: 12 },
        mapB: "north", sideB: "south", spanB: { start: 0, end: 12 },
        axis: "x", offsetAtoB: 0, openingIds: ["west:north:door"],
      },
    ],
    openings: [
      {
        portalId: "west:east:fixed",
        source: { mapId: "west", side: "east", span: { start: 4, end: 6 } },
        target: { mapId: "east", side: "west", span: { start: 4, end: 6 } },
        axis: "y", offset: 0, compatibility: "portal-only",
      },
      {
        portalId: "west:east:safe",
        source: { mapId: "west", side: "east", span: { start: 2, end: 3 } },
        target: { mapId: "east", side: "west", span: { start: 2, end: 3 } },
        axis: "y", offset: 0, compatibility: "coordinate-preserving",
      },
      {
        portalId: "west:north:door",
        source: { mapId: "west", side: "north", span: { start: 6, end: 8 } },
        target: { mapId: "north", side: "south", span: { start: 6, end: 8 } },
        axis: "x", offset: 0, compatibility: "coordinate-preserving",
      },
    ],
  }],
};

const COMPONENT = LAYOUT.components[0]!;
const TILE = 16;

const rect = (x: number, y: number, w: number, h: number): WorldPixelRect => ({ x, y, w, h });

describe("visibleMaps", () => {
  test("a camera inside one map returns only that map", () => {
    // Camera x in [-192, 0): inside west only (west spans x [-192, 0)).
    expect(visibleMaps(COMPONENT, rect(-192, 0, 100, 272), TILE)).toEqual(["west"]);
  });

  test("a camera straddling the west/east seam returns both in map-id order", () => {
    // 480px wide camera centred on the seam x=0.
    expect(visibleMaps(COMPONENT, rect(-240, 0, 480, 272), TILE)).toEqual(["east", "west"]);
  });

  test("a camera touching an edge without overlap does not include the map", () => {
    // Camera ends exactly on west's east edge (x=0): half-open, no overlap.
    expect(visibleMaps(COMPONENT, rect(-480, 0, 480, 272), TILE)).toEqual(["west"]);
  });

  test("a camera in a gap between components returns nothing", () => {
    expect(visibleMaps(COMPONENT, rect(5000, 5000, 320, 240), TILE)).toEqual([]);
  });

  test("negative origins place north above west", () => {
    // Camera x in [-192, 0) excludes east; y covers the north/west seam at -7*16.
    const got = visibleMaps(COMPONENT, rect(-12 * TILE, -8 * TILE, 192, 200), TILE);
    expect(got).toEqual(["north", "west"]);
  });
});

describe("imminentMaps", () => {
  test("facing right (3) ranks the faced east side first, then distance, then portal id", () => {
    // Player at west local (11, 5): adjacent to the east edge, tangent y=5 is
    // inside the fixed opening (4..6) and 2 away from the safe opening (2..3).
    const got = imminentMaps(COMPONENT, "west", { x: -1, y: -2 }, 3 /* right */);
    expect(got.map((e) => e.portalId)).toEqual(["west:east:fixed", "west:east:safe", "west:north:door"]);
    expect(got[0]).toEqual({
      mapId: "east", portalId: "west:east:fixed", side: "east",
      distance: 0, compatibility: "portal-only",
    });
    expect(got[1]!.distance).toBe(3); // tangent y=5 is 3 past the safe span
  });

  test("facing up (2) ranks the north opening first even when it is farther", () => {
    // Same player: the north door is 9 tiles away (tangent 4 + normal 5) and
    // the east fixed opening is adjacent, but facing up (2 = north per the
    // engine's Facing enum) puts the north side first.
    const got = imminentMaps(COMPONENT, "west", { x: -1, y: -2 }, 2 /* up */);
    expect(got.map((e) => e.portalId)).toEqual(["west:north:door", "west:east:fixed", "west:east:safe"]);
    expect(got[0]!.side).toBe("north");
  });

  test("openings behind the player rank after faced ones, never dropped", () => {
    // Facing west: every opening (east side and north side) ranks behind any
    // faced-side opening — but one-hop prefetch still lists them all, by
    // distance then portal id.
    const got = imminentMaps(COMPONENT, "west", { x: -1, y: -5 }, 1 /* west */);
    expect(got.map((e) => e.portalId)).toEqual(["west:east:safe", "west:east:fixed", "west:north:door"]);
  });

  test("distance counts tangent gap plus normal distance to the edge", () => {
    // Player at west local (0, 0): 11 tiles from the east edge, tangent y=0
    // is 2 away from the safe span (2..3).
    const got = imminentMaps(COMPONENT, "west", { x: -12, y: -7 }, 2 /* up */);
    expect(got.find((e) => e.portalId === "west:east:safe")!.distance).toBe(13);
  });

  test("maxDistance and limit bound the result deterministically", () => {
    const far = imminentMaps(COMPONENT, "west", { x: -12, y: -7 }, 2, { maxDistance: 5 });
    expect(far).toEqual([]);
    const limited = imminentMaps(COMPONENT, "west", { x: -1, y: -2 }, 3 /* right */, { limit: 1 });
    expect(limited.map((e) => e.portalId)).toEqual(["west:east:fixed"]);
  });

  test("an unplaced active map has no imminent targets", () => {
    expect(imminentMaps(COMPONENT, "indoor_map", { x: 0, y: 0 }, 2)).toEqual([]);
  });
});

describe("workingSet", () => {
  test("unions active, visible and imminent into sorted keep-sets", () => {
    const set = workingSet(
      LAYOUT, "west", rect(-240, 0, 480, 272), TILE,
      { x: -1, y: -2 }, 2,
    );
    expect(set.active).toBe("west");
    expect(set.visible).toEqual(["east", "west"]);
    expect(set.imminent.map((e) => e.mapId)).toEqual(["north", "east", "east"]);
    expect(set.parsedKeep).toEqual(["east", "north", "west"]);
    expect(set.compiledKeep).toEqual(["east", "north", "west"]);
  });

  test("compiled keep-set is a subset of the parsed keep-set", () => {
    // Camera on west only: visible drops east, but the imminent targets keep
    // east and north compiled while parsed retention also covers them.
    const set = workingSet(
      LAYOUT, "west", rect(-192, 0, 192, 240), TILE,
      { x: -1, y: -2 }, 2,
    );
    expect(set.visible).toEqual(["west"]);
    expect(set.parsedKeep).toEqual(["east", "north", "west"]);
    expect(set.compiledKeep).toEqual(["east", "north", "west"]);
    for (const id of set.compiledKeep) expect(set.parsedKeep).toContain(id);
  });

  test("an unplaced active map degenerates to the legacy single-map set", () => {
    const set = workingSet(
      LAYOUT, "indoor_map", rect(0, 0, 320, 240), TILE,
      { x: 0, y: 0 }, 0,
    );
    expect(set).toEqual({
      active: "indoor_map", visible: [], imminent: [],
      parsedKeep: ["indoor_map"], compiledKeep: ["indoor_map"],
    });
  });

  test("is deterministic: repeated calls return equal results", () => {
    const args = [LAYOUT, "west", rect(-240, 0, 480, 272), TILE, { x: -1, y: -2 }, 2 /* up */] as const;
    const a = workingSet(...args);
    const b = workingSet(...args);
    expect(a).toEqual(b);
    expect(componentOfMap(LAYOUT, "east")).toBe(COMPONENT);
    expect(componentOfMap(LAYOUT, "indoor_map")).toBeUndefined();
  });
});
