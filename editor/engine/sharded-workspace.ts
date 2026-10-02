// editor/engine/sharded-workspace.ts — lazy, bounded ProjectShell editing.

import {
  MAP_SCHEMA_HASH,
  describeMapSchemaRefusal,
  isCompatibleMapSchemaHash,
  canonicalMapJson,
  mapManifestHash,
  resolveMapManifestHash,
  sha256Text,
  validateMapDefStructure,
  validateMapIndex,
} from "../../src/engine/map-repository.ts";
import { deepClone } from "../../src/engine/clone.ts";
import type {
  MapDef,
  MapIndexEntry,
  ProjectShell,
  TileId,
} from "../../src/engine/types.ts";

/** Load one map named by the shell catalog. The loader may wrap a
 * MapRepository, fetch the entry, or read it from a browser file handle. */
export type ShardedMapLoader = (meta: MapIndexEntry) => Promise<MapDef>;

export interface ShardedWorkspaceOptions {
  /** Soft resident-map bound. Dirty and active maps are never evicted, so
   * those maps may temporarily take the workspace above this limit. */
  maxLoadedMaps?: number;
}

/** A host writes `shell` and precisely the entries present in `shards`, then
 * acknowledges `token`. Building this value does not make any map clean. */
export interface ShardedWorkspaceSavePayload {
  readonly token: number;
  readonly shell: ProjectShell;
  readonly shards: Readonly<Record<string, string>>;
}

type MapUpdate = (draft: MapDef) => MapDef | void;

interface ResidentMap {
  map: MapDef;
  revision: number;
  used: number;
}

interface SavedMapRevision {
  revision: number;
  meta: MapIndexEntry;
}

interface PendingSave {
  maps: Map<string, SavedMapRevision>;
}

// deepClone, not structuredClone: the desktop QuickJS guest has no
// structuredClone (tests/guest-globals.test.ts).
const clone = deepClone;

/**
 * Editor-side working set for a ProjectShell. Read accessors return stable,
 * workspace-owned map objects; mutations must pass through updateMap or
 * replaceMap so dirty tracking remains accurate.
 */
export class ShardedEditorWorkspace {
  private currentShell: ProjectShell;
  private readonly byId: Map<string, MapIndexEntry>;
  private readonly resident = new Map<string, ResidentMap>();
  private readonly loading = new Map<string, Promise<MapDef>>();
  private readonly savedRevision = new Map<string, number>();
  private readonly pendingSaves = new Map<number, PendingSave>();
  private activeId: string | null = null;
  private activation = 0;
  private clock = 0;
  private revision = 0;
  private saveToken = 0;
  private readonly maxLoadedMaps: number;

  constructor(
    shell: ProjectShell,
    private readonly loadMap: ShardedMapLoader,
    options: ShardedWorkspaceOptions = {},
  ) {
    const maxLoadedMaps = options.maxLoadedMaps ?? 4;
    if (!Number.isInteger(maxLoadedMaps) || maxLoadedMaps < 1) {
      throw new Error("sharded workspace: maxLoadedMaps must be a positive integer");
    }
    if (shell.mapSchemaHash !== undefined && !isCompatibleMapSchemaHash(shell.mapSchemaHash)) {
      throw new Error(`sharded workspace: map schema hash does not match this RPG Kit build: ${describeMapSchemaRefusal(shell.mapSchemaHash)}`);
    }
    validateMapIndex(shell.mapIndex);
    resolveMapManifestHash(shell, shell.mapManifestHash !== undefined);

    this.currentShell = clone(shell);
    this.byId = new Map(this.currentShell.mapIndex.map((meta) => [meta.id, meta]));
    this.maxLoadedMaps = maxLoadedMaps;
  }

  /** A defensive snapshot of the last acknowledged shell/catalog. */
  get shell(): ProjectShell {
    return clone(this.currentShell);
  }

  get catalog(): readonly MapIndexEntry[] {
    return this.currentShell.mapIndex;
  }

  get activeMapId(): string | null {
    return this.activeId;
  }

  get activeMap(): MapDef | null {
    return this.activeId === null ? null : this.resident.get(this.activeId)?.map ?? null;
  }

  get isDirty(): boolean {
    for (const [id, item] of this.resident) {
      if (item.revision > (this.savedRevision.get(id) ?? 0)) return true;
    }
    return false;
  }

  get loadedMapIds(): readonly string[] {
    return this.currentShell.mapIndex
      .map((meta) => meta.id)
      .filter((id) => this.resident.has(id));
  }

  get dirtyMapIds(): readonly string[] {
    return this.currentShell.mapIndex
      .map((meta) => meta.id)
      .filter((id) => this.isMapDirty(id));
  }

  getLoadedMap(id: string): MapDef | undefined {
    const item = this.resident.get(id);
    if (item) item.used = ++this.clock;
    return item?.map;
  }

  /** Load and select one catalog map. Concurrent requests for the same map
   * share a load; if activations race, the most recently requested map wins. */
  async activateMap(id: string): Promise<MapDef> {
    const meta = this.byId.get(id);
    if (!meta) throw new Error(`sharded workspace: unknown map ${id}`);
    const request = ++this.activation;
    let item = this.resident.get(id);
    if (!item) {
      let pending = this.loading.get(id);
      if (!pending) {
        pending = this.loadAndValidate(meta);
        this.loading.set(id, pending);
        pending.then(
          () => this.loading.delete(id),
          () => this.loading.delete(id),
        );
      }
      const map = await pending;
      item = this.resident.get(id);
      if (!item) {
        item = { map, revision: 0, used: ++this.clock };
        this.resident.set(id, item);
      }
    }
    item.used = ++this.clock;
    if (request === this.activation) this.activeId = id;
    this.evictCleanInactive();
    return item.map;
  }

  /** Edit a clone of a loaded map and atomically install the result. */
  updateMap(id: string, update: MapUpdate): MapDef {
    const item = this.requireResident(id);
    const draft = clone(item.map);
    const result = update(draft);
    return this.installMap(id, item, result === undefined || result === draft ? draft : clone(result));
  }

  /** Replace a loaded map after an editor reducer produces a new snapshot.
   * Map ids stay tied to their shard entry; dimensions may change and will be
   * reflected in the next save's index. */
  replaceMap(id: string, map: MapDef): MapDef {
    const item = this.requireResident(id);
    if (item.map === map) return map;
    return this.installMap(id, item, clone(map));
  }

  /** Convenience mutation for the editor's hottest one-cell operation. */
  setGroundCell(id: string, index: number, tile: TileId): MapDef {
    const item = this.requireResident(id);
    if (!Number.isInteger(index) || index < 0 || index >= item.map.ground.length) {
      throw new Error(`sharded workspace: ground index ${index} is outside map ${id}`);
    }
    if (item.map.ground[index] === tile) return item.map;
    const next: MapDef = { ...item.map, ground: item.map.ground.slice() };
    next.ground[index] = tile;
    return this.installMap(id, item, next);
  }

  /** Build a deterministic multi-file save without changing dirty state. */
  buildSavePayload(): ShardedWorkspaceSavePayload {
    const snapshots = new Map<string, SavedMapRevision>();
    const shards = Object.create(null) as Record<string, string>;
    const mapIndex = this.currentShell.mapIndex.map((oldMeta) => {
      const item = this.resident.get(oldMeta.id);
      if (!item || item.revision <= (this.savedRevision.get(oldMeta.id) ?? 0)) {
        return clone(oldMeta);
      }
      const text = canonicalMapJson(item.map);
      const meta: MapIndexEntry = {
        id: item.map.id,
        width: item.map.width,
        height: item.map.height,
        entry: oldMeta.entry,
        sha256: sha256Text(text),
      };
      shards[meta.entry] = text;
      snapshots.set(meta.id, { revision: item.revision, meta });
      return meta;
    });
    const unhashed: ProjectShell = {
      ...clone(this.currentShell),
      mapIndex,
      mapSchemaHash: MAP_SCHEMA_HASH,
    };
    delete unhashed.mapManifestHash;
    const shell: ProjectShell = {
      ...unhashed,
      mapManifestHash: mapManifestHash(unhashed),
    };
    const token = ++this.saveToken;
    this.pendingSaves.set(token, { maps: snapshots });
    return { token, shell, shards };
  }

  /** Apply a host save result. Failure changes no dirty/catalog state. A
   * successful stale acknowledgement cannot clear or overwrite newer edits. */
  acknowledgeSave(token: number, succeeded: boolean): void {
    const pending = this.pendingSaves.get(token);
    if (!pending) throw new Error(`sharded workspace: unknown save token ${token}`);
    this.pendingSaves.delete(token);
    if (!succeeded) return;

    const index = this.currentShell.mapIndex.map((oldMeta) => {
      const saved = pending.maps.get(oldMeta.id);
      if (!saved) return oldMeta;
      const previous = this.savedRevision.get(oldMeta.id) ?? 0;
      if (saved.revision < previous) return oldMeta;
      this.savedRevision.set(oldMeta.id, saved.revision);
      return clone(saved.meta);
    });
    const unhashed: ProjectShell = {
      ...this.currentShell,
      mapIndex: index,
      mapSchemaHash: MAP_SCHEMA_HASH,
    };
    delete unhashed.mapManifestHash;
    this.currentShell = {
      ...unhashed,
      mapManifestHash: mapManifestHash(unhashed),
    };
    this.rebuildCatalog();
    this.evictCleanInactive();
  }

  private isMapDirty(id: string): boolean {
    const item = this.resident.get(id);
    return item !== undefined && item.revision > (this.savedRevision.get(id) ?? 0);
  }

  private requireResident(id: string): ResidentMap {
    const item = this.resident.get(id);
    if (!item) throw new Error(`sharded workspace: map ${id} is not loaded`);
    return item;
  }

  private installMap(id: string, item: ResidentMap, map: MapDef): MapDef {
    validateMapDefStructure(map);
    if (map.id !== id) {
      throw new Error(`sharded workspace: cannot replace ${id} with map ${map.id}`);
    }
    item.map = map;
    item.revision = ++this.revision;
    item.used = ++this.clock;
    this.evictCleanInactive();
    return map;
  }

  private async loadAndValidate(meta: MapIndexEntry): Promise<MapDef> {
    const map = clone(await this.loadMap(clone(meta)));
    validateMapDefStructure(map);
    if (map.id !== meta.id || map.width !== meta.width || map.height !== meta.height) {
      throw new Error(`sharded workspace: metadata mismatch for ${meta.id}`);
    }
    if (sha256Text(canonicalMapJson(map)) !== meta.sha256) {
      throw new Error(`sharded workspace: checksum mismatch for ${meta.id}`);
    }
    return map;
  }

  private rebuildCatalog(): void {
    this.byId.clear();
    for (const meta of this.currentShell.mapIndex) this.byId.set(meta.id, meta);
  }

  private evictCleanInactive(): void {
    while (this.resident.size > this.maxLoadedMaps) {
      let oldestId: string | undefined;
      let oldestUse = Infinity;
      for (const [id, item] of this.resident) {
        if (id === this.activeId || this.isMapDirty(id)) continue;
        if (item.used < oldestUse) {
          oldestId = id;
          oldestUse = item.used;
        }
      }
      if (oldestId === undefined) return;
      this.resident.delete(oldestId);
    }
  }
}

export function createShardedEditorWorkspace(
  shell: ProjectShell,
  loadMap: ShardedMapLoader,
  options?: ShardedWorkspaceOptions,
): ShardedEditorWorkspace {
  return new ShardedEditorWorkspace(shell, loadMap, options);
}
