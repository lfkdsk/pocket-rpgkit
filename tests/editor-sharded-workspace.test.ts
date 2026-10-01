import { describe, expect, test } from "bun:test";
import {
  MAP_SCHEMA_HASH,
  canonicalMapJson,
  mapManifestHash,
  sha256Text,
} from "../src/engine/map-repository.ts";
import type { MapDef, Project } from "../src/engine/types.ts";
import {
  createShardedEditorWorkspace,
  type ShardedEditorWorkspace,
} from "../editor/engine/sharded-workspace.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";

const MAP_COUNT = 263;
const LARGE_MAP_ID = "map_262";

function map(id: string, width = 4, height = 4): MapDef {
  return {
    id,
    name: id,
    width,
    height,
    sheets: ["tiles"],
    ground: new Array(width * height).fill("tiles.0"),
    events: [],
  };
}

function largeProject(): Project {
  const maps = Array.from({ length: MAP_COUNT }, (_, index) => {
    const id = `map_${String(index).padStart(3, "0")}`;
    return index === MAP_COUNT - 1 ? map(id, 100, 100) : map(id);
  });
  return {
    format: "rpgkit-project/v1",
    title: "263-map editor fixture",
    tileSize: 16,
    start: { map: maps[0]!.id, x: 0, y: 0, dir: "down" },
    sheets: [{ id: "tiles", pak: "tiles", cols: 2, rows: 1 }],
    items: [],
    maps,
  };
}

const split = splitProjectMaps(largeProject());

function trackedWorkspace(maxLoadedMaps = 4): {
  workspace: ShardedEditorWorkspace;
  reads: string[];
} {
  const sources = new Map(split.entries.map((entry) => [entry.path, entry.text]));
  const reads: string[] = [];
  const workspace = createShardedEditorWorkspace(split.shell, async (meta) => {
    reads.push(meta.entry);
    const source = sources.get(meta.entry);
    if (source === undefined) throw new Error(`missing test shard ${meta.entry}`);
    return JSON.parse(source) as MapDef;
  }, { maxLoadedMaps });
  return { workspace, reads };
}

describe("sharded editor workspace", () => {
  test("opens a 263-map catalog without loading shards and targets the 100x100 map", async () => {
    const { workspace, reads } = trackedWorkspace();

    expect(workspace.catalog).toHaveLength(263);
    expect(workspace.activeMap).toBeNull();
    expect(workspace.loadedMapIds).toEqual([]);
    expect(reads).toEqual([]);

    const active = await workspace.activateMap(LARGE_MAP_ID);
    expect(active.width).toBe(100);
    expect(active.height).toBe(100);
    expect(active.ground).toHaveLength(10_000);
    expect(workspace.activeMapId).toBe(LARGE_MAP_ID);
    expect(workspace.loadedMapIds).toEqual([LARGE_MAP_ID]);
    expect(reads).toEqual([`maps/${LARGE_MAP_ID}.json`]);
  });

  test("evicts clean inactive maps by LRU while retaining dirty maps", async () => {
    const { workspace, reads } = trackedWorkspace(2);
    await workspace.activateMap("map_000");
    await workspace.activateMap("map_001");
    await workspace.activateMap("map_000"); // touch map_000
    await workspace.activateMap("map_002");

    expect(workspace.loadedMapIds).toEqual(["map_000", "map_002"]);
    expect(reads).toHaveLength(3);

    workspace.setGroundCell("map_000", 0, "tiles.1");
    workspace.setGroundCell("map_002", 0, "tiles.1");
    await workspace.activateMap("map_003");
    await workspace.activateMap("map_004");

    // Both dirty maps survive above the soft bound; clean map_003 does not.
    expect(workspace.loadedMapIds).toEqual(["map_000", "map_002", "map_004"]);
    expect(workspace.dirtyMapIds).toEqual(["map_000", "map_002"]);
    expect(workspace.getLoadedMap("map_003")).toBeUndefined();
  });

  test("saves only dirty shards and clears only an acknowledged revision", async () => {
    const { workspace } = trackedWorkspace();
    const map = await workspace.activateMap(LARGE_MAP_ID);
    const meta = workspace.catalog.find((entry) => entry.id === LARGE_MAP_ID)!;
    const oldHash = meta.sha256;

    workspace.setGroundCell(LARGE_MAP_ID, 9_999, "tiles.1");
    const failed = workspace.buildSavePayload();
    expect(Object.keys(failed.shards)).toEqual([meta.entry]);
    expect(workspace.isDirty).toBe(true);
    expect(workspace.dirtyMapIds).toEqual([LARGE_MAP_ID]);

    const savedMap = JSON.parse(failed.shards[meta.entry]!) as MapDef;
    expect(savedMap.ground[9_999]).toBe("tiles.1");
    const savedMeta = failed.shell.mapIndex.find((entry) => entry.id === LARGE_MAP_ID)!;
    expect(savedMeta.sha256).toBe(sha256Text(canonicalMapJson(savedMap)));
    expect(savedMeta.sha256).not.toBe(oldHash);
    expect(failed.shell.mapSchemaHash).toBe(MAP_SCHEMA_HASH);
    expect(failed.shell.mapManifestHash).toBe(mapManifestHash(failed.shell));

    workspace.acknowledgeSave(failed.token, false);
    expect(workspace.isDirty).toBe(true);

    const inFlight = workspace.buildSavePayload();
    workspace.updateMap(LARGE_MAP_ID, (draft) => {
      draft.name = "edited while saving";
    });
    workspace.acknowledgeSave(inFlight.token, true);
    expect(workspace.isDirty).toBe(true);
    expect(workspace.activeMap?.name).toBe("edited while saving");

    const latest = workspace.buildSavePayload();
    expect(Object.keys(latest.shards)).toEqual([meta.entry]);
    workspace.acknowledgeSave(latest.token, true);
    expect(workspace.isDirty).toBe(false);
    expect(workspace.dirtyMapIds).toEqual([]);
    expect(workspace.shell.mapManifestHash).toBe(latest.shell.mapManifestHash);
    expect(workspace.activeMap).not.toBe(map);
    expect(workspace.activeMap?.name).toBe("edited while saving");
  });
});
