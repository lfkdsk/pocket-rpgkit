import { describe, expect, test } from "bun:test";
import {
  acquireSessionMap,
  createSession,
  prepareSessionMapStep,
  releaseSessionMapLayers,
  releaseSessionMapsExcept,
  startSession,
  stepSession,
  type SessionState,
} from "../src/engine/session.ts";
import { createJsonMapRepository } from "../src/engine/map-repository.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";
import type { MapDef, MapRepository, Project, ProjectShell } from "../src/engine/types.ts";

function map(id: string, next?: string): MapDef {
  return {
    id,
    name: id,
    width: 4,
    height: 4,
    sheets: ["tiles"],
    ground: new Array(16).fill("tiles.0"),
    events: next ? [{
      id: "door",
      x: 1,
      y: 1,
      pages: [{
        trigger: "action",
        commands: [{ op: "transfer", map: next, x: 1, y: 1, dir: "up", fade: 0 }],
      }],
    }] : [],
  };
}

function project(): Project {
  return {
    format: "rpgkit-project/v1",
    title: "layered cache fixture",
    tileSize: 16,
    start: { map: "map_a", x: 1, y: 1, dir: "up" },
    sheets: [{ id: "tiles", pak: "tiles", cols: 1, rows: 1, defaultPassage: "pass" }],
    items: [],
    maps: [map("map_a"), map("map_b"), map("map_c")],
  };
}

/** Two maps with action transfers into each other, for revisit cycles. */
function transferProject(): Project {
  return {
    ...project(),
    maps: [map("map_a", "map_b"), map("map_b", "map_a"), map("map_c")],
  };
}

/** Wraps a repository to count source reads, so cache eviction is observable. */
function setup() {
  const split = splitProjectMaps(project());
  const files = new Map(split.entries.map((entry) => [entry.meta.id, entry.bytes]));
  const base = createJsonMapRepository(split.shell.mapIndex, {
    read: (entry) => {
      const meta = split.shell.mapIndex.find((m) => m.entry === entry);
      return meta ? files.get(meta.id) : undefined;
    },
  });
  const session = createSession(split.shell, 60, base);
  startSession(split.shell, session);
  return { session, base };
}

describe("releaseSessionMapLayers", () => {
  test("keeps parsed, compiled and mutable layers on different sets", () => {
    const { session } = setup();
    acquireSessionMap(session, "map_b");
    acquireSessionMap(session, "map_c");
    // Seed the mutable layer for two maps as a real fold would.
    session.runtimeTables.set("map_a", {} as never);
    session.runtimeTables.set("map_b", {} as never);

    releaseSessionMapLayers(session, ["map_a", "map_b"], ["map_a"], "map_a");

    expect([...session.maps.keys()].sort()).toEqual(["map_a", "map_b"]);
    expect([...session.worlds.keys()]).toEqual(["map_a"]);
    expect([...session.tables.keys()]).toEqual(["map_a"]);
    expect([...session.runtimeTables.keys()]).toEqual(["map_a"]);
  });

  test("drops unpublished staged preparation for a map outside the parsed set", () => {
    const { session } = setup();
    expect(prepareSessionMapStep(session, "map_c")).toBe(false); // parse stage
    expect(session.preparingMaps.get("map_c")?.id).toBe("map_c");

    releaseSessionMapLayers(session, ["map_a", "map_b"], ["map_a"], "map_a");
    expect(session.preparingMaps.has("map_c")).toBe(false);
    // The map is gone from the repository cache too: a later acquire re-reads.
    expect(session.maps.has("map_c")).toBe(false);
  });

  test("trims staged preparation for a map inside parsed but outside compiled", () => {
    const { session } = setup();
    expect(prepareSessionMapStep(session, "map_c")).toBe(false); // repository read/parse
    expect(prepareSessionMapStep(session, "map_c")).toBe(false); // repository decode
    expect(session.preparingMaps.get("map_c")!.map).toBeDefined();
    expect(prepareSessionMapStep(session, "map_c")).toBe(false); // world
    expect(prepareSessionMapStep(session, "map_c")).toBe(true); // table
    const preparation = session.preparingMaps.get("map_c")!;
    expect(preparation.world).toBeDefined();
    expect(preparation.table).toBeDefined();

    // map_c stays in the parsed (visible) set but leaves the compiled set.
    releaseSessionMapLayers(session, ["map_a", "map_b", "map_c"], ["map_a", "map_b"], "map_a");
    const trimmed = session.preparingMaps.get("map_c")!;
    expect(trimmed.map).toBeDefined(); // parsed stage retained
    expect(trimmed.world).toBeUndefined(); // compiled stages dropped
    expect(trimmed.table).toBeUndefined();
    expect(session.maps.has("map_c")).toBe(false); // still unpublished

    // Re-staging re-runs only the compiled stages, then publishes cleanly.
    expect(prepareSessionMapStep(session, "map_c")).toBe(false); // world re-run
    expect(prepareSessionMapStep(session, "map_c")).toBe(true); // table re-run
    expect(() => acquireSessionMap(session, "map_c")).not.toThrow();
    expect(session.worlds.has("map_c")).toBe(true);
    expect(session.tables.has("map_c")).toBe(true);
  });

  test("a parsed-only map rebuilds its compiled layers on reacquire", () => {
    const { session } = setup();
    acquireSessionMap(session, "map_b");
    // Seed the mutable layer as a real fold would.
    session.runtimeTables.set("map_b", {} as never);

    // Evict the compiled layers while keeping the parsed MapDef.
    releaseSessionMapLayers(session, ["map_a", "map_b"], ["map_a"], "map_a");
    expect(session.maps.has("map_b")).toBe(true);
    expect(session.worlds.has("map_b")).toBe(false);
    expect(session.tables.has("map_b")).toBe(false);
    expect(session.runtimeTables.has("map_b")).toBe(false);

    // Reacquire: the compiled layers are rebuilt, never a half-cached map,
    // and the mutable layer starts fresh rather than resurrecting stale data.
    expect(() => acquireSessionMap(session, "map_b")).not.toThrow();
    expect(session.maps.has("map_b")).toBe(true);
    expect(session.worlds.has("map_b")).toBe(true);
    expect(session.tables.has("map_b")).toBe(true);
    expect(session.runtimeTables.has("map_b")).toBe(false);
  });

  test("a parsed-only transfer target is rebuilt at the boundary and survives ticks", () => {
    const split = splitProjectMaps(transferProject());
    const files = new Map(split.entries.map((entry) => [entry.meta.id, entry.bytes]));
    const repository = createJsonMapRepository(split.shell.mapIndex, {
      read: (entry) => {
        const meta = split.shell.mapIndex.find((m) => m.entry === entry);
        return meta ? files.get(meta.id) : undefined;
      },
    });
    const session = createSession(split.shell, 60, repository);
    let state: SessionState = startSession(split.shell, session);
    const confirm = (tick: number): Parameters<typeof stepSession>[2] => ({
      buttons: 0,
      confirmEdge: tick === 0,
      cancelEdge: false,
      upEdge: false,
      downEdge: false,
      leftEdge: false,
      rightEdge: false,
    });

    // Visit map_b, then evict it back to parsed-only from the outside.
    acquireSessionMap(session, "map_b");
    releaseSessionMapLayers(session, ["map_a", "map_b"], ["map_a"], "map_a");
    expect(session.worlds.has("map_b")).toBe(false);

    // Transfer into map_b: the boundary rebuilds the compiled layers.
    state = stepSession(session, state, confirm(0));
    expect(state.mapId).toBe("map_b");
    // At least one tick on the rebuilt map (crashed before the fix).
    expect(() => { state = stepSession(session, state, confirm(1)); }).not.toThrow();
    expect(state.mapId).toBe("map_b");

    // Return to map_a, make map_b parsed-only again, and revisit.
    state = stepSession(session, state, confirm(0));
    expect(state.mapId).toBe("map_a");
    acquireSessionMap(session, "map_b"); // visible neighbour: parsed + compiled
    releaseSessionMapLayers(session, ["map_a", "map_b"], ["map_a"], "map_a");
    expect(session.maps.has("map_b")).toBe(true);
    expect(session.worlds.has("map_b")).toBe(false);
    state = stepSession(session, state, confirm(0));
    expect(state.mapId).toBe("map_b");
    expect(session.worlds.has("map_b")).toBe(true);
    expect(session.tables.has("map_b")).toBe(true);
  });

  test("evicts the repository cache to the parsed keep-set", () => {
    const split = splitProjectMaps(project());
    const files = new Map(split.entries.map((entry) => [entry.meta.id, entry.bytes]));
    let reads = 0;
    const base = createJsonMapRepository(split.shell.mapIndex, {
      read: (entry) => {
        reads++;
        const meta = split.shell.mapIndex.find((m) => m.entry === entry);
        return meta ? files.get(meta.id) : undefined;
      },
    });
    const session = createSession(split.shell, 60, base);
    acquireSessionMap(session, "map_b");
    acquireSessionMap(session, "map_c");
    const readsBefore = reads;

    releaseSessionMapLayers(session, ["map_a", "map_b"], ["map_a"], "map_a");
    acquireSessionMap(session, "map_b"); // still cached: no re-read
    expect(reads).toBe(readsBefore);
    expect(() => acquireSessionMap(session, "map_c")).not.toThrow(); // re-read + parse
    expect(reads).toBeGreaterThan(readsBefore);
  });

  test("releaseSessionMapsExcept keeps the legacy single-set behaviour", () => {
    const { session } = setup();
    acquireSessionMap(session, "map_b");
    acquireSessionMap(session, "map_c");
    session.runtimeTables.set("map_b", {} as never);

    releaseSessionMapsExcept(session, ["map_a"]);
    expect([...session.maps.keys()]).toEqual(["map_a"]);
    expect([...session.worlds.keys()]).toEqual(["map_a"]);
    expect([...session.tables.keys()]).toEqual(["map_a"]);
    expect([...session.runtimeTables.keys()]).toEqual([]);
  });

  test("is a no-op for inline projects without a repository", () => {
    const session = createSession(project(), 60);
    expect(() => releaseSessionMapLayers(session, ["map_a"], ["map_a"], "map_a")).not.toThrow();
    expect([...session.maps.keys()].sort()).toEqual(["map_a", "map_b", "map_c"]);
  });
});
