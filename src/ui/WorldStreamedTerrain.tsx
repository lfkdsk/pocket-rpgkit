// Component-wide viewport streaming for placed world terrain. Unlike the
// single-map StreamedChunkLayer, this renderer keeps one node/texture pool per
// paint band and addresses live chunks by map id, so crossing a placement edge
// neither rebuilds the scene tree nor gives every map its own upload budget.

import { onCleanup, type Accessor, type JSX as SolidJSX } from "solid-js";
import { jump } from "@pocketjs/framework/animation";
import { getOps } from "@pocketjs/framework/host";
import { onFrame } from "@pocketjs/framework/lifecycle";
import {
  createElement,
  insertNode,
  setProp,
  type NodeMirror,
} from "@pocketjs/framework/renderer";
import { freeTileTexture, loadTileTexture } from "../../vendor/pocketjs/framework/src/tiles.ts";
import {
  chunkWindow,
  expandChunkWindow,
  type ChunkPoint,
  type ChunkViewport,
  type ChunkWindow,
} from "../engine/chunk-window.ts";
import { TILE } from "../engine/tiles.ts";
import type { WorldComponent, WorldPlacement } from "../engine/types.ts";
import type { StreamedChunkLayerStats } from "./StreamedChunkLayer.tsx";

export type WorldStreamedTerrainBand = "ground" | "upper";

export interface WorldStreamedTerrainBandSource {
  /** Map id -> row-major `ui:tile.*#index` refs; null is transparent. */
  refs: Accessor<Readonly<Record<string, readonly (string | null)[]>>>;
  /** Map id -> chunk columns. Rows are derived from the corresponding refs. */
  columns: Accessor<Readonly<Record<string, number>>>;
  /** Change this whenever the meaning of refs changes in place. */
  sourceKey?: Accessor<string>;
  /** Paint-only gate. Hidden bands retain textures and pooled nodes. */
  visible?: Accessor<boolean>;
  /** Pixel prefetch margin around the viewport (default one tile). */
  margin?: Accessor<number | undefined>;
  /** Uploads from this band per frame. Omit for no limit; zero pauses. */
  loadBudget?: Accessor<number | undefined>;
}

export interface WorldStreamedTerrainStats extends StreamedChunkLayerStats {
  worldId: string;
  componentId: string;
  /** Sorted map ids offered by visiblePlacements for this sync. */
  visibleMaps: readonly string[];
}

export interface WorldStreamedTerrainProps {
  /** Used for the compatible StreamedChunkLayerStats.mapId field. */
  activeMapId: Accessor<string>;
  /** The currently rendered connected component. Immutable objects are ideal. */
  component: WorldComponent | Accessor<WorldComponent>;
  /** Stable viewport-relevant placements. Origins are component-world tiles. */
  visiblePlacements: Accessor<readonly WorldPlacement[]>;
  /** Camera top-left in the component's signed world-pixel coordinates. */
  camera: Accessor<ChunkPoint>;
  viewport: Accessor<ChunkViewport>;
  chunkPx: number;
  /** Optional runtime tile loader; returned handles are freed with freeTileTexture. */
  loadTile?: (key: string, index: number) => number;
  ground: WorldStreamedTerrainBandSource;
  upper: WorldStreamedTerrainBandSource;
  /** While false, residency and uploads pause with the kept-alive world. */
  active?: Accessor<boolean>;
  debugName?: string;
  /** Slots are deliberately siblings: ground -> below -> actors -> upper -> above. */
  below?: SolidJSX.Element;
  actors?: SolidJSX.Element;
  above?: SolidJSX.Element;
  onStats?: (band: WorldStreamedTerrainBand, stats: WorldStreamedTerrainStats) => void;
}

interface LiveChunk {
  node: NodeMirror;
  handle: number;
  mapId: string;
  index: number;
}

interface BandState {
  readonly band: WorldStreamedTerrainBand;
  readonly source: WorldStreamedTerrainBandSource;
  readonly root: NodeMirror;
  readonly live: Map<string, LiveChunk>;
  readonly pool: NodeMirror[];
  sourceKey: string;
  refs: Readonly<Record<string, readonly (string | null)[]>> | undefined;
  columns: Readonly<Record<string, number>> | undefined;
  margin: number | undefined;
  placements: readonly WorldPlacement[] | undefined;
  /** Reused scratch point for projecting the world camera into each map. */
  readonly localCamera: ChunkPoint;
  readonly windows: Map<string, ChunkWindow>;
  visible: boolean;
  pending: boolean;
  created: number;
  uploads: number;
  frees: number;
}

interface MissingChunk {
  worldId: string;
  mapId: string;
  band: WorldStreamedTerrainBand;
  index: number;
  ref: string;
  x: number;
  y: number;
}

const BAND_ORDER: Readonly<Record<WorldStreamedTerrainBand, number>> = {
  ground: 0,
  upper: 1,
};

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sameComponent(a: WorldComponent | undefined, b: WorldComponent): boolean {
  return a === b || !!a && a.worldId === b.worldId && a.componentId === b.componentId &&
    a.bounds.minTileX === b.bounds.minTileX && a.bounds.minTileY === b.bounds.minTileY &&
    a.bounds.maxTileX === b.bounds.maxTileX && a.bounds.maxTileY === b.bounds.maxTileY;
}

function liveKey(mapId: string, band: WorldStreamedTerrainBand, index: number): string {
  return `${mapId}\0${band}\0${index}`;
}

function parseRef(ref: string): { key: string; index: number } {
  const hash = ref.lastIndexOf("#");
  const index = Number(ref.slice(hash + 1));
  if (hash <= 0 || !Number.isInteger(index) || index < 0) {
    throw new Error(`WorldStreamedTerrain: bad ref ${JSON.stringify(ref)}`);
  }
  return { key: ref.slice(0, hash), index };
}

function readComponent(source: WorldComponent | Accessor<WorldComponent>): WorldComponent {
  return typeof source === "function" ? source() : source;
}

function configuredBudget(source: WorldStreamedTerrainBandSource, band: WorldStreamedTerrainBand): number {
  const configured = source.loadBudget?.();
  if (configured !== undefined && (!Number.isFinite(configured) || configured < 0)) {
    throw new Error(
      `WorldStreamedTerrain: ${band} loadBudget must be a non-negative number, got ${configured}`,
    );
  }
  return configured === undefined ? Number.POSITIVE_INFINITY : Math.floor(configured);
}

/**
 * Two streamed terrain bands sharing one component-wide scheduling pass.
 * Placement origins and the camera use the same signed world-pixel space; the
 * caller owns any component-bounds normalization outside this component.
 */
export function WorldStreamedTerrain(props: WorldStreamedTerrainProps): SolidJSX.Element {
  if (!Number.isFinite(props.chunkPx) || props.chunkPx <= 0) {
    throw new Error(`WorldStreamedTerrain: chunkPx must be positive, got ${props.chunkPx}`);
  }

  const makeBand = (
    band: WorldStreamedTerrainBand,
    source: WorldStreamedTerrainBandSource,
  ): BandState => {
    const root = createElement("view");
    const visible = source.visible?.() ?? true;
    setProp(root, "style", {
      posType: 1,
      insetL: 0,
      insetT: 0,
      width: 0,
      height: 0,
      display: visible ? 0 : 1,
    });
    setProp(root, "debugName", `${props.debugName ?? "rpgkit-world-terrain"}-${band}`);
    return {
      band,
      source,
      root,
      live: new Map(),
      pool: [],
      sourceKey: source.sourceKey?.() ?? "",
      refs: undefined,
      columns: undefined,
      margin: undefined,
      placements: undefined,
      localCamera: { x: 0, y: 0 },
      windows: new Map(),
      visible,
      pending: false,
      created: 0,
      uploads: 0,
      frees: 0,
    };
  };

  const ground = makeBand("ground", props.ground);
  const upper = makeBand("upper", props.upper);
  const bands = [ground, upper] as const;
  let currentComponent: WorldComponent | undefined;
  let reportedPlacements: readonly WorldPlacement[] | undefined;
  let visibleMapIds: readonly string[] = [];

  const release = (state: BandState, key: string, chunk: LiveChunk): void => {
    getOps().setImage(chunk.node.id, -1);
    if (chunk.handle >= 0) {
      freeTileTexture(chunk.handle);
      state.frees++;
    }
    state.live.delete(key);
    state.pool.push(chunk.node);
  };

  const clear = (state: BandState): void => {
    for (const [key, chunk] of [...state.live]) release(state, key, chunk);
    state.windows.clear();
    state.pending = false;
  };

  const nodeFor = (state: BandState, mapId: string, index: number): NodeMirror => {
    const reused = state.pool.pop();
    if (reused) {
      setProp(
        reused,
        "debugName",
        `${props.debugName ?? "rpgkit-world-terrain"}-${state.band}-${mapId}-${index}`,
        reused.domAttrs?.debugName,
      );
      return reused;
    }
    const node = createElement("image");
    setProp(node, "style", {
      posType: 1,
      insetL: 0,
      insetT: 0,
      width: props.chunkPx,
      height: props.chunkPx,
    });
    setProp(node, "debugName", `${props.debugName ?? "rpgkit-world-terrain"}-${state.band}-${mapId}-${index}`);
    insertNode(state.root, node);
    state.created++;
    return node;
  };

  const report = (state: BandState, component: WorldComponent, pending: number): void => {
    if (!props.onStats) return;
    let textures = 0;
    for (const chunk of state.live.values()) if (chunk.handle >= 0) textures++;
    props.onStats(state.band, {
      mapId: props.activeMapId(),
      worldId: component.worldId,
      componentId: component.componentId,
      visibleMaps: visibleMapIds,
      resident: state.live.size,
      textures,
      textureBytes: textures * (1024 + props.chunkPx * props.chunkPx),
      pooled: state.pool.length,
      created: state.created,
      uploads: state.uploads,
      frees: state.frees,
      pending,
    });
  };

  const workFor = (
    state: BandState,
    component: WorldComponent,
    placements: readonly WorldPlacement[],
    camera: ChunkPoint,
    viewport: ChunkViewport,
    componentChanged: boolean,
  ): MissingChunk[] | undefined => {
    const sourceKey = state.source.sourceKey?.() ?? "";
    const refs = state.source.refs();
    const columnsByMap = state.source.columns();
    const margin = state.source.margin?.() ?? TILE;
    if (!Number.isFinite(margin) || margin < 0) {
      throw new Error(`WorldStreamedTerrain: ${state.band} margin must be non-negative, got ${margin}`);
    }
    const sourceChanged = sourceKey !== state.sourceKey || refs !== state.refs || columnsByMap !== state.columns;
    if (componentChanged || sourceChanged) clear(state);

    const placementsChanged = placements !== state.placements;
    const geometryChanged = componentChanged || sourceChanged || placementsChanged || margin !== state.margin;
    let windowChanged = geometryChanged;
    // A pixel camera change normally remains inside the same chunk windows.
    // Compare those integer boundaries before allocating retention/missing sets.
    for (const placement of placements) {
      const mapRefs = refs[placement.mapId] ?? [];
      const columns = columnsByMap[placement.mapId] ?? 0;
      if (!Number.isInteger(columns) || columns < 1 || mapRefs.length % columns !== 0) {
        if (mapRefs.length !== 0 || columns !== 0) {
          throw new Error(
            `WorldStreamedTerrain: ${state.band} map ${JSON.stringify(placement.mapId)} has ` +
            `${mapRefs.length} refs and ${columns} columns`,
          );
        }
      }
      const originX = placement.originTileX * TILE;
      const originY = placement.originTileY * TILE;
      state.localCamera.x = camera.x - originX;
      state.localCamera.y = camera.y - originY;
      const previous = state.windows.get(placement.mapId);
      const requested = chunkWindow(
        state.localCamera,
        viewport,
        props.chunkPx,
        columns,
        columns === 0 ? 0 : mapRefs.length / columns,
        margin,
        previous,
      );
      if (requested !== previous) {
        state.windows.set(placement.mapId, requested);
        windowChanged = true;
      }
    }
    if (placementsChanged) {
      for (const mapId of [...state.windows.keys()]) {
        if (!placements.some((placement) => placement.mapId === mapId)) state.windows.delete(mapId);
      }
    }

    const shouldSync = windowChanged || state.pending;

    state.sourceKey = sourceKey;
    state.refs = refs;
    state.columns = columnsByMap;
    state.margin = margin;
    state.placements = placements;
    if (!shouldSync) return undefined;

    const retained = new Set<string>();
    const missing: MissingChunk[] = [];
    for (const placement of placements) {
      const mapRefs = refs[placement.mapId] ?? [];
      const columns = columnsByMap[placement.mapId] ?? 0;
      if (!Number.isInteger(columns) || columns < 1 || mapRefs.length % columns !== 0) {
        if (mapRefs.length === 0 && columns === 0) continue;
        throw new Error(
          `WorldStreamedTerrain: ${state.band} map ${JSON.stringify(placement.mapId)} has ` +
          `${mapRefs.length} refs and ${columns} columns`,
        );
      }
      const originX = placement.originTileX * TILE;
      const originY = placement.originTileY * TILE;
      const rows = mapRefs.length / columns;
      const requested = state.windows.get(placement.mapId)!;
      const retention = expandChunkWindow(requested, 1, columns, rows);
      for (let y = retention.y0; y <= retention.y1; y++) {
        for (let x = retention.x0; x <= retention.x1; x++) {
          retained.add(liveKey(placement.mapId, state.band, y * columns + x));
        }
      }
      for (let y = requested.y0; y <= requested.y1; y++) {
        for (let x = requested.x0; x <= requested.x1; x++) {
          const index = y * columns + x;
          const ref = mapRefs[index];
          const key = liveKey(placement.mapId, state.band, index);
          if (!ref || state.live.has(key)) continue;
          missing.push({
            worldId: component.worldId,
            mapId: placement.mapId,
            band: state.band,
            index,
            ref,
            x: originX + x * props.chunkPx,
            y: originY + y * props.chunkPx,
          });
        }
      }
    }

    for (const [key, chunk] of [...state.live]) {
      if (!retained.has(key)) release(state, key, chunk);
    }
    return missing;
  };

  const sync = (): void => {
    if (props.active && !props.active()) return;
    const component = readComponent(props.component);
    const componentChanged = !sameComponent(currentComponent, component);
    currentComponent = component;

    // The culler promises a stable array identity; retain it so an unchanged
    // camera/window is a true no-work frame. Scheduling is sorted separately.
    const placements = props.visiblePlacements();
    if (props.onStats && placements !== reportedPlacements) {
      reportedPlacements = placements;
      visibleMapIds = placements.map((placement) => placement.mapId).sort(compareText);
    }
    const camera = props.camera();
    const viewport = props.viewport();

    let visibilityChanged = false;
    for (const state of bands) {
      const visible = state.source.visible?.() ?? true;
      if (visible !== state.visible) {
        state.visible = visible;
        visibilityChanged = true;
        setProp(state.root, "style", { display: visible ? 0 : 1 }, state.root.domAttrs?.style);
      }
    }

    const groundMissing = workFor(ground, component, placements, camera, viewport, componentChanged);
    const upperMissing = workFor(upper, component, placements, camera, viewport, componentChanged);
    if (groundMissing === undefined && upperMissing === undefined) {
      if (visibilityChanged) {
        report(ground, component, 0);
        report(upper, component, 0);
      }
      return;
    }
    const missing = groundMissing === undefined
      ? upperMissing!
      : upperMissing === undefined
        ? groundMissing
        : [...groundMissing, ...upperMissing];
    missing.sort((a, b) =>
      compareText(a.worldId, b.worldId) ||
      compareText(a.mapId, b.mapId) ||
      BAND_ORDER[a.band] - BAND_ORDER[b.band] ||
      a.index - b.index
    );

    const budget: Record<WorldStreamedTerrainBand, number> = {
      ground: configuredBudget(props.ground, "ground"),
      upper: configuredBudget(props.upper, "upper"),
    };
    const loaded: Record<WorldStreamedTerrainBand, number> = { ground: 0, upper: 0 };
    const load = props.loadTile ?? loadTileTexture;
    for (const entry of missing) {
      if (loaded[entry.band] >= budget[entry.band]) continue;
      const state = entry.band === "ground" ? ground : upper;
      const parsed = parseRef(entry.ref);
      const node = nodeFor(state, entry.mapId, entry.index);
      jump(node, "translateX", entry.x);
      jump(node, "translateY", entry.y);
      const handle = load(parsed.key, parsed.index);
      if (handle >= 0) {
        getOps().setImage(node.id, handle);
        state.uploads++;
      }
      state.live.set(liveKey(entry.mapId, entry.band, entry.index), {
        node,
        handle,
        mapId: entry.mapId,
        index: entry.index,
      });
      loaded[entry.band]++;
    }

    // A failed (-1) load still consumes one unit and becomes resident,
    // matching the single-map layer's retry semantics.
    if (groundMissing !== undefined) {
      const pending = Math.max(0, groundMissing.length - loaded.ground);
      ground.pending = pending > 0;
      report(ground, component, pending);
    } else if (visibilityChanged) report(ground, component, 0);
    if (upperMissing !== undefined) {
      const pending = Math.max(0, upperMissing.length - loaded.upper);
      upper.pending = pending > 0;
      report(upper, component, pending);
    } else if (visibilityChanged) report(upper, component, 0);
  };

  onFrame(sync);
  onCleanup(() => {
    const component = currentComponent;
    for (const state of bands) {
      clear(state);
      if (component) report(state, component, 0);
      state.pool.length = 0;
    }
  });

  return (
    <>
      {ground.root as unknown as SolidJSX.Element}
      {props.below}
      {props.actors}
      {upper.root as unknown as SolidJSX.Element}
      {props.above}
    </>
  );
}
