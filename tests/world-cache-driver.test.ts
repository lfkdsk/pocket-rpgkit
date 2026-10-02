import { describe, expect, test } from "bun:test";
import {
  acquireSessionMap,
  createSession,
  prepareSessionMapStep,
  startSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import { createJsonMapRepository } from "../src/engine/map-repository.ts";
import { createWorldCacheDriver, type WorldCacheStats } from "../src/ui/world-cache-driver.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";
import type { CameraState, MapDef, Project, ProjectShell, WorldLayout } from "../src/engine/types.ts";

function map(id: string): MapDef {
  return {
    id,
    name: id,
    width: 4,
    height: 4,
    sheets: ["tiles"],
    ground: new Array(16).fill("tiles.0"),
    events: [],
  };
}

function project(): Project {
  return {
    format: "rpgkit-project/v1",
    title: "driver fixture",
    tileSize: 16,
    start: { map: "map_a", x: 1, y: 1, dir: "up" },
    sheets: [{ id: "tiles", pak: "tiles", cols: 1, rows: 1, defaultPassage: "pass" }],
    items: [],
    maps: [map("map_a"), map("map_b"), map("map_c"), map("map_d")],
  };
}

// map_a (0,0) 4x4 and map_b (4,0) 4x4 share an east/west opening; map_c is
// not placed (an indoor map); map_d (0,20) 4x4 is placed but has no opening
// from map_a, so it can be visible without being imminent.
const LAYOUT: WorldLayout = {
  topologyHash: "a".repeat(64),
  components: [{
    worldId: "w",
    componentId: "c",
    bounds: { minTileX: 0, minTileY: 0, maxTileX: 8, maxTileY: 24 },
    placements: [
      { mapId: "map_a", originTileX: 0, originTileY: 0, width: 4, height: 4 },
      { mapId: "map_b", originTileX: 4, originTileY: 0, width: 4, height: 4 },
      { mapId: "map_d", originTileX: 0, originTileY: 20, width: 4, height: 4 },
    ],
    seams: [],
    openings: [{
      portalId: "p1",
      source: { mapId: "map_a", side: "east", span: { start: 0, end: 4 } },
      target: { mapId: "map_b", side: "west", span: { start: 0, end: 4 } },
      axis: "y",
      offset: 0,
      compatibility: "coordinate-preserving",
    }],
  }],
};

interface Harness {
  session: Session;
  shell: ProjectShell;
}

function setup(): Harness {
  const split = splitProjectMaps(project());
  const files = new Map(split.entries.map((entry) => [entry.meta.id, entry.bytes]));
  const repository = createJsonMapRepository(split.shell.mapIndex, {
    read: (entry) => {
      const meta = split.shell.mapIndex.find((m) => m.entry === entry);
      return meta ? files.get(meta.id) : undefined;
    },
  });
  const session = createSession(split.shell, 60, repository);
  startSession(split.shell, session);
  return { session, shell: split.shell };
}

const stateOn = (mapId: string, tx = 3, ty = 2, facing = 2): SessionState =>
  ({ mapId, move: { tx, ty, facing } }) as SessionState;
const cameraAt = (x: number, y: number): CameraState => ({ x, y, facing: 2 });

describe("createWorldCacheDriver", () => {
  test("stages imminent targets and reports the layered keep-sets", () => {
    const { session } = setup();
    const stats: WorldCacheStats[] = [];
    const driver = createWorldCacheDriver(session, LAYOUT, {
      budgetMs: 1000,
      now: () => 0,
      onStats: (s) => stats.push(s),
    });

    driver.sync(stateOn("map_a"), cameraAt(0, 0), { w: 480, h: 272 });

    expect(stats).toHaveLength(1);
    expect(stats[0]!.active).toBe("map_a");
    expect(stats[0]!.visible).toEqual(["map_a", "map_b"]);
    expect(stats[0]!.parsedKeep).toEqual(["map_a", "map_b"]);
    expect(stats[0]!.compiledKeep).toEqual(["map_a", "map_b"]);
    expect(stats[0]!.staged).toBe(1); // map_b compiled, still unpublished
    expect(session.maps.has("map_b")).toBe(false);
  });

  test("a visible-but-not-imminent map keeps only its parsed stage", () => {
    const { session } = setup();
    // Stage map_d fully, as if it had been imminent on an earlier working set.
    for (let stage = 0; stage < 4; stage++) prepareSessionMapStep(session, "map_d");
    expect(session.preparingMaps.get("map_d")!.world).toBeDefined();
    expect(session.preparingMaps.get("map_d")!.table).toBeDefined();

    const stats: WorldCacheStats[] = [];
    const driver = createWorldCacheDriver(session, LAYOUT, {
      budgetMs: 1000,
      now: () => 0,
      onStats: (s) => stats.push(s),
    });
    // A 448 px-tall camera reaches map_d (placed at world y 320), but no
    // opening leads there: it is visible, not imminent.
    driver.sync(stateOn("map_a"), cameraAt(0, 0), { w: 480, h: 448 });

    expect(stats[0]!.visible).toContain("map_d");
    expect(stats[0]!.parsedKeep).toContain("map_d");
    expect(stats[0]!.compiledKeep).not.toContain("map_d");
    const preparation = session.preparingMaps.get("map_d")!;
    expect(preparation.map).toBeDefined(); // parsed stage retained
    expect(preparation.world).toBeUndefined(); // compiled stages dropped
    expect(preparation.table).toBeUndefined();
    expect(session.maps.has("map_d")).toBe(false); // still unpublished
  });

  test("evicts a resident map that left the keep-set", () => {
    const { session } = setup();
    const driver = createWorldCacheDriver(session, LAYOUT, { budgetMs: 1000, now: () => 0 });
    driver.sync(stateOn("map_a"), cameraAt(0, 0), { w: 480, h: 272 });

    // An indoor map is acquired (a scripted visit), then the player is back
    // outdoors: the working set no longer contains map_c.
    acquireSessionMap(session, "map_c");
    expect(session.maps.has("map_c")).toBe(true);
    driver.sync(stateOn("map_a"), cameraAt(0, 0), { w: 480, h: 272 });
    expect(session.maps.has("map_c")).toBe(false);
    expect(session.maps.has("map_a")).toBe(true);
    expect(session.maps.has("map_b")).toBe(false); // staged, not published
  });

  // The W3 layered release is what trims residency BETWEEN transfers: the
  // reducer's legacy releaseSessionMapsExcept only runs at a transfer and
  // keeps a single set, so it can neither retain a visible map's parsed
  // layer nor trim its compiled layer. This test never transfers, so the
  // legacy release never fires; disabling releaseSessionMapLayers must
  // turn it red.
  test("layered release keeps parsed and drops compiled between transfers", () => {
    const { session } = setup();
    const driver = createWorldCacheDriver(session, LAYOUT, { budgetMs: 1000, now: () => 0 });
    // map_d (world y 320) is visible through a 448px-tall camera but no
    // opening leads there: visible, not imminent.
    driver.sync(stateOn("map_a"), cameraAt(0, 0), { w: 480, h: 448 });

    // Publish map_d as a resident map with its compiled layers, exactly as
    // a transfer or an out-of-band acquire would leave it.
    acquireSessionMap(session, "map_d");
    expect(session.maps.has("map_d")).toBe(true);
    expect(session.worlds.has("map_d")).toBe(true);
    expect(session.tables.has("map_d")).toBe(true);
    // A mutable passage override on map_d, as a tileProperty command would
    // leave behind.
    type RuntimeEntry = Session["runtimeTables"] extends Map<string, infer V> ? V : never;
    session.runtimeTables.set("map_d", {} as RuntimeEntry);
    expect(session.runtimeTables.has("map_d")).toBe(true);

    // Re-sync with the same working set. No transfer occurs, so the legacy
    // releaseSessionMapsExcept never runs; only the layered release can
    // trim map_d.
    driver.sync(stateOn("map_a"), cameraAt(0, 0), { w: 480, h: 448 });

    // The parsed layer follows parsedKeep (map_d is visible): retained.
    expect(session.maps.has("map_d")).toBe(true);
    // The compiled layer follows compiledKeep (map_d is not imminent): trimmed.
    expect(session.worlds.has("map_d")).toBe(false);
    expect(session.tables.has("map_d")).toBe(false);
    // The mutable layer follows the active map only: dropped.
    expect(session.runtimeTables.has("map_d")).toBe(false);
    // The active map keeps every layer.
    expect(session.maps.has("map_a")).toBe(true);
    expect(session.worlds.has("map_a")).toBe(true);
    expect(session.tables.has("map_a")).toBe(true);
  });

  test("an unplaced active map falls back to the legacy single-map policy", () => {
    const { session } = setup();
    const driver = createWorldCacheDriver(session, LAYOUT, { budgetMs: 1000, now: () => 0 });
    driver.sync(stateOn("map_a"), cameraAt(0, 0), { w: 480, h: 272 });
    acquireSessionMap(session, "map_b"); // publish the staged target

    // The player transfers indoors: only map_c stays resident.
    acquireSessionMap(session, "map_c"); // the reducer acquires at the transfer
    driver.sync(stateOn("map_c"), cameraAt(0, 0), { w: 480, h: 272 });
    expect([...session.maps.keys()]).toEqual(["map_c"]);
    expect(session.preparingMaps.size).toBe(0);
  });

  test("re-enforces the keep-set on every sync", () => {
    const { session } = setup();
    let releases = 0;
    const driver = createWorldCacheDriver(session, LAYOUT, { budgetMs: 1000, now: () => 0 });
    // Count repository releaseExcept calls through a wrapping spy.
    const inner = session.repository!;
    (session as { repository: typeof inner }).repository = {
      meta: inner.meta,
      acquire: inner.acquire,
      acquireStep: inner.acquireStep,
      releaseExcept: (ids) => { releases++; inner.releaseExcept(ids); },
    };
    driver.sync(stateOn("map_a"), cameraAt(0, 0), { w: 480, h: 272 });
    driver.sync(stateOn("map_a"), cameraAt(0, 0), { w: 480, h: 272 });
    expect(releases).toBe(2); // one enforcement per sync
  });

  // The coordinate contract (see world-contract.ts): the camera passed to
  // sync is in component-world pixels, the same space as the world
  // renderer's cameraFor output. The driver must NOT add the placement
  // origin again. This is the review's Route 1 probe: a map placed at tile
  // (69, 64) and a world camera at pixel (1192, 1056) must intersect.
  test("a world camera on a non-zero-origin map keeps the map visible", () => {
    const originX = 69;
    const originY = 64;
    const routeProject: Project = {
      format: "rpgkit-project/v1",
      title: "route probe",
      tileSize: 16,
      start: { map: "classic_route_1", x: 10, y: 10, dir: "right" },
      sheets: [{ id: "tiles", pak: "tiles", cols: 1, rows: 1, defaultPassage: "pass" }],
      items: [],
      maps: [{
        id: "classic_route_1",
        name: "classic_route_1",
        width: 20,
        height: 20,
        sheets: ["tiles"],
        ground: new Array(400).fill("tiles.0"),
        events: [],
      }],
    };
    const split = splitProjectMaps(routeProject);
    const files = new Map(split.entries.map((entry) => [entry.meta.id, entry.bytes]));
    const repository = createJsonMapRepository(split.shell.mapIndex, {
      read: (entry) => {
        const meta = split.shell.mapIndex.find((m) => m.entry === entry);
        return meta ? files.get(meta.id) : undefined;
      },
    });
    const session = createSession(split.shell, 60, repository);
    startSession(split.shell, session);

    const layout: WorldLayout = {
      topologyHash: "b".repeat(64),
      components: [{
        worldId: "w",
        componentId: "c",
        bounds: { minTileX: originX, minTileY: originY, maxTileX: originX + 20, maxTileY: originY + 20 },
        placements: [
          { mapId: "classic_route_1", originTileX: originX, originTileY: originY, width: 20, height: 20 },
        ],
        seams: [],
        openings: [],
      }],
    };
    const stats: WorldCacheStats[] = [];
    const driver = createWorldCacheDriver(session, layout, {
      budgetMs: 1000,
      now: () => 0,
      onStats: (s) => stats.push(s),
    });

    // World camera (1192, 1056) over a 480x272 viewport. The map's world
    // rect is (1104, 1024)-(1424, 1344), so they intersect. Under the old
    // behaviour (driver re-adding the origin) the rect would be pushed to
    // (2296, 2080) and the visible set would be empty.
    driver.sync(
      stateOn("classic_route_1", 10, 10, 3),
      cameraAt(1192, 1056),
      { w: 480, h: 272 },
    );

    expect(stats).toHaveLength(1);
    expect(stats[0]!.visible).toContain("classic_route_1");
    expect(stats[0]!.parsedKeep).toContain("classic_route_1");
    // The player tile is converted from map-local (10, 10) to world
    // (79, 74) for the imminent ranking; with no openings there are none,
    // but the active map is always in both keep-sets.
    expect(stats[0]!.active).toBe("classic_route_1");
    expect(stats[0]!.compiledKeep).toEqual(["classic_route_1"]);
  });
});
