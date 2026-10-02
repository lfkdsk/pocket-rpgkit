import { describe, expect, test } from "bun:test";
import schema from "../src/data/schema.json" with { type: "json" };
import {
  localToWorld,
  validateWorldLayout,
  worldToLocal,
  type MapDef,
  type Project,
  type WorldLayout,
  type WorldPlacement,
} from "../src/engine/index.ts";
import { validateSchema } from "../src/engine/schema-validate.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const WEST: WorldPlacement = {
  mapId: "west",
  originTileX: -12,
  originTileY: -7,
  width: 12,
  height: 9,
};

const LAYOUT: WorldLayout = {
  topologyHash: HASH_A,
  components: [{
    worldId: "overworld",
    componentId: "west",
    bounds: { minTileX: -12, minTileY: -11, maxTileX: 8, maxTileY: 2 },
    placements: [
      { mapId: "east", originTileX: 0, originTileY: -7, width: 8, height: 9 },
      { mapId: "north", originTileX: -12, originTileY: -11, width: 12, height: 4 },
      WEST,
    ],
    seams: [
      {
        mapA: "north",
        sideA: "south",
        spanA: { start: 0, end: 12 },
        mapB: "west",
        sideB: "north",
        spanB: { start: 0, end: 12 },
        axis: "x",
        offsetAtoB: 0,
        openingIds: [],
      },
      {
        mapA: "west",
        sideA: "east",
        spanA: { start: 0, end: 9 },
        mapB: "east",
        sideB: "west",
        spanB: { start: 0, end: 9 },
        axis: "y",
        offsetAtoB: 0,
        openingIds: ["west:east:fixed", "west:east:safe"],
      },
    ],
    openings: [
      {
        portalId: "west:east:fixed",
        source: { mapId: "west", side: "east", span: { start: 4, end: 6 } },
        target: { mapId: "east", side: "west", span: { start: 4, end: 6 } },
        axis: "y",
        offset: 0,
        compatibility: "portal-only",
      },
      {
        portalId: "west:east:safe",
        source: { mapId: "west", side: "east", span: { start: 2, end: 3 } },
        target: { mapId: "east", side: "west", span: { start: 2, end: 3 } },
        axis: "y",
        offset: 0,
        compatibility: "coordinate-preserving",
      },
    ],
  }],
};

function map(id: string): MapDef {
  return {
    id,
    name: id,
    width: 2,
    height: 2,
    sheets: ["tiles"],
    ground: ["tiles.0", "tiles.0", "tiles.0", "tiles.0"],
    events: [],
  };
}

function project(worldLayout: WorldLayout = LAYOUT): Project {
  return {
    format: "rpgkit-project/v1",
    title: "World layout fixture",
    tileSize: 16,
    start: { map: "west", x: 0, y: 0, dir: "right" },
    sheets: [{ id: "tiles", pak: "tiles", cols: 1, rows: 1 }],
    items: [],
    worldLayout,
    maps: [map("west"), map("east"), map("north")],
  };
}

describe("WorldLayout coordinate contract", () => {
  test("round-trips negative origins without clamping or mutating inputs", () => {
    const local = Object.freeze({ x: 3, y: 5 });
    const placement = Object.freeze({ ...WEST });
    const before = JSON.stringify({ placement, local });

    const world = localToWorld(placement, local);
    expect(world).toEqual({ x: -9, y: -2 });
    expect(worldToLocal(placement, world)).toEqual(local);
    expect(worldToLocal(placement, { x: -13, y: -8 })).toEqual({ x: -1, y: -1 });
    expect(JSON.stringify({ placement, local })).toBe(before);
  });

  test("the optional project field represents component bounds and mixed opening safety", () => {
    expect(validateWorldLayout(LAYOUT)).toBe(LAYOUT);
    expect(validateSchema(schema, project())).toEqual([]);
    expect(LAYOUT.components[0]!.seams[0]!.openingIds).toEqual([]);
    expect(new Set(LAYOUT.components[0]!.openings.map((opening) => opening.compatibility))).toEqual(
      new Set(["coordinate-preserving", "portal-only"]),
    );

    const fractionalOrigin = structuredClone(project()) as Project;
    fractionalOrigin.worldLayout!.components[0]!.placements[0]!.originTileX = -11.5;
    expect(validateSchema(schema, fractionalOrigin).some((error) =>
      error.path.endsWith(".originTileX") && error.msg.includes("integer")
    )).toBeTrue();

    const unsafeDefault = structuredClone(project()) as Project;
    (unsafeDefault.worldLayout!.components[0]!.openings[0] as { compatibility: string }).compatibility = "seamless";
    expect(validateSchema(schema, unsafeDefault).some((error) =>
      error.path.endsWith(".compatibility")
    )).toBeTrue();
  });

  test("semantic validation rejects drifted bounds, overlap and opening mappings", () => {
    const driftedBounds = structuredClone(LAYOUT);
    driftedBounds.components[0]!.bounds.minTileX++;
    expect(() => validateWorldLayout(driftedBounds)).toThrow("bounds do not equal the placement union");

    const overlap = structuredClone(LAYOUT);
    overlap.components[0]!.placements[0]!.originTileX = -1;
    expect(() => validateWorldLayout(overlap)).toThrow("overlap");

    const badOpening = structuredClone(LAYOUT);
    badOpening.components[0]!.openings[0]!.offset = 1;
    expect(() => validateWorldLayout(badOpening)).toThrow("target span does not equal source span plus offset");

    const unreferenced = structuredClone(LAYOUT);
    unreferenced.components[0]!.seams[1]!.openingIds = ["west:east:fixed"];
    expect(() => validateWorldLayout(unreferenced)).toThrow("opening west:east:safe is not referenced by a seam");
  });

  test("topology participates in shell identity without changing map shards", () => {
    const first = splitProjectMaps(project());
    const second = splitProjectMaps(project({ ...LAYOUT, topologyHash: HASH_B }));

    expect(first.shell.worldLayout).toEqual(LAYOUT);
    expect(first.shell.mapManifestHash).not.toBe(second.shell.mapManifestHash);
    expect(first.entries.map((entry) => [entry.meta.id, entry.meta.sha256])).toEqual(
      second.entries.map((entry) => [entry.meta.id, entry.meta.sha256]),
    );
  });
});
