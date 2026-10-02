// src/ui/StreamedChunkLayer.tsx — viewport-windowed TILESET chunk renderer.
// Chunk textures are decoded/uploaded only while near the camera, retained
// for one extra chunk of hysteresis, and released through freeTexture when
// they fall outside that ring. Image nodes stay in a small pool so scrolling
// and map swaps do not churn the native scene tree.

import { onCleanup, type Accessor, type JSX as SolidJSX } from "solid-js";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { getOps } from "@pocketjs/framework/host";
import { jump } from "@pocketjs/framework/animation";
import { freeTileTexture, loadTileTexture } from "../../vendor/pocketjs/framework/src/tiles.ts";
import {
  createElement,
  insertNode,
  setProp,
  type NodeMirror,
} from "@pocketjs/framework/renderer";
import {
  createChunkWindowReader,
  chunkWindowContains,
  expandChunkWindow,
  type ChunkPoint,
  type ChunkViewport,
  type ChunkWindow,
} from "../engine/chunk-window.ts";
import { TILE } from "../engine/tiles.ts";

export interface StreamedChunkLayerStats {
  mapId: string;
  /** Requested chunks, including a failed -1 load, held in the live window. */
  resident: number;
  /** Resident textures that successfully uploaded. */
  textures: number;
  /** Exact fallback upload bytes for the resident CLUT8 textures. */
  textureBytes: number;
  pooled: number;
  created: number;
  uploads: number;
  frees: number;
  pending: number;
}

export interface StreamedChunkLayerProps {
  mapId: string;
  /** Map id -> row-major `ui:tile.*#index` refs; null means transparent. */
  refs: Readonly<Record<string, readonly (string | null)[]>>;
  /** Map id -> chunk columns. Rows are derived from refs.length. */
  columns: Readonly<Record<string, number>>;
  chunkPx: number;
  camera: () => ChunkPoint;
  viewport: () => ChunkViewport;
  /** Pixel prefetch margin around the viewport (default one 16px tile). */
  margin?: number;
  /** Loads per frame for this layer. Omit for no limit; zero pauses uploads. */
  loadBudget?: number;
  /** Tile loader used in place of loadTileTexture (StreamedGameAssets.loadTile). */
  loadTile?: (key: string, index: number) => number;
  /** While false, the layer's per-frame residency sync pauses (the subtree
   *  stays mounted and hidden). Omit for always active. */
  active?: Accessor<boolean>;
  /** Invalidates the current map's refs when a prepackaged variant changes. */
  sourceKey?: string;
  /** Keeps residency and the node pool warm while hiding only paint. */
  visible?: boolean;
  debugName?: string;
  /** Diagnostics callback, emitted only when streaming state changes. */
  onStats?: (stats: StreamedChunkLayerStats) => void;
}

interface LiveChunk {
  node: NodeMirror;
  handle: number;
}

const EMPTY_WINDOW: ChunkWindow = { x0: 0, y0: 0, x1: -1, y1: -1 };

function sameWindow(a: ChunkWindow, b: ChunkWindow): boolean {
  return a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;
}

function parseRef(ref: string): { key: string; index: number } {
  const hash = ref.lastIndexOf("#");
  const index = Number(ref.slice(hash + 1));
  if (hash <= 0 || !Number.isInteger(index) || index < 0) {
    throw new Error(`StreamedChunkLayer: bad ref ${JSON.stringify(ref)}`);
  }
  return { key: ref.slice(0, hash), index };
}

/** One streamed world layer. The parent owns camera translation; chunk nodes
 * remain at world coordinates and change only when the chunk window changes. */
export function StreamedChunkLayer(props: StreamedChunkLayerProps): SolidJSX.Element {
  const chunkWindow = createChunkWindowReader();
  const root = createElement("view");
  setProp(root, "style", {
    posType: 1, insetL: 0, insetT: 0, width: 0, height: 0,
    display: props.visible === false ? 1 : 0,
  });
  setProp(root, "debugName", props.debugName ?? "rpgkit-stream");

  const live = new Map<number, LiveChunk>();
  const pool: NodeMirror[] = [];
  let currentMap = "";
  let currentSourceKey = "";
  let visible = props.visible !== false;
  let currentRefs: readonly (string | null)[] = [];
  let columns = 0;
  let rows = 0;
  let lastWindow: ChunkWindow = EMPTY_WINDOW;
  let pending = false;
  let created = 0;
  let uploads = 0;
  let frees = 0;

  const report = (pendingCount: number): void => {
    if (!props.onStats) return;
    let textures = 0;
    for (const chunk of live.values()) if (chunk.handle >= 0) textures++;
    props.onStats({
      mapId: currentMap,
      resident: live.size,
      textures,
      textureBytes: textures * (1024 + props.chunkPx * props.chunkPx),
      pooled: pool.length,
      created,
      uploads,
      frees,
      pending: pendingCount,
    });
  };

  const release = (chunk: LiveChunk): void => {
    getOps().setImage(chunk.node.id, -1);
    if (chunk.handle >= 0) {
      freeTileTexture(chunk.handle);
      frees++;
    }
    pool.push(chunk.node);
  };

  const clear = (): void => {
    for (const chunk of live.values()) release(chunk);
    live.clear();
    pending = false;
    lastWindow = EMPTY_WINDOW;
  };

  const selectMap = (mapId: string, sourceKey: string): void => {
    clear();
    currentMap = mapId;
    currentSourceKey = sourceKey;
    currentRefs = props.refs[mapId] ?? [];
    columns = props.columns[mapId] ?? 0;
    if (!Number.isInteger(columns) || columns < 1 || currentRefs.length % columns !== 0) {
      if (currentRefs.length === 0 && columns === 0) {
        rows = 0;
        return;
      }
      throw new Error(
        `StreamedChunkLayer: map ${JSON.stringify(mapId)} has ${currentRefs.length} refs and ${columns} columns`,
      );
    }
    rows = currentRefs.length / columns;
  };

  const nodeFor = (index: number): NodeMirror => {
    const reused = pool.pop();
    if (reused) {
      setProp(reused, "debugName", `${props.debugName ?? "rpgkit-stream"}-chunk-${index}`);
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
    setProp(node, "debugName", `${props.debugName ?? "rpgkit-stream"}-chunk-${index}`);
    insertNode(root, node);
    created++;
    return node;
  };

  const sync = (): void => {
    if (props.active && !props.active()) return;
    const nextVisible = props.visible !== false;
    if (visible !== nextVisible) {
      visible = nextVisible;
      setProp(root, "style", { display: visible ? 0 : 1 }, root.domAttrs?.style);
    }
    const sourceKey = props.sourceKey ?? "";
    if (currentMap !== props.mapId || currentSourceKey !== sourceKey) selectMap(props.mapId, sourceKey);
    if (columns === 0 || rows === 0) {
      report(0);
      return;
    }
    const viewport = props.viewport();
    const camera = props.camera();
    const nextWindow = chunkWindow(
      camera,
      viewport,
      props.chunkPx,
      columns,
      rows,
      props.margin ?? TILE,
    );
    const moved = !sameWindow(lastWindow, nextWindow);
    if (!moved && !pending) return;
    lastWindow = nextWindow;

    // One whole chunk of hysteresis outside the requested load window.
    const retention = expandChunkWindow(nextWindow, 1, columns, rows);
    if (moved) {
      for (const [index, chunk] of live) {
        const x = index % columns;
        const y = Math.floor(index / columns);
        if (!chunkWindowContains(retention, x, y)) {
          release(chunk);
          live.delete(index);
        }
      }
    }

    const centerX = (camera.x + viewport.w / 2) / props.chunkPx - 0.5;
    const centerY = (camera.y + viewport.h / 2) / props.chunkPx - 0.5;
    const missing: { index: number; distance: number }[] = [];
    for (let y = nextWindow.y0; y <= nextWindow.y1; y++) {
      for (let x = nextWindow.x0; x <= nextWindow.x1; x++) {
        const index = y * columns + x;
        if (live.has(index) || !currentRefs[index]) continue;
        const dx = x - centerX;
        const dy = y - centerY;
        missing.push({ index, distance: dx * dx + dy * dy });
      }
    }
    missing.sort((a, b) => a.distance - b.distance || a.index - b.index);

    const configured = props.loadBudget;
    if (configured !== undefined && (!Number.isFinite(configured) || configured < 0)) {
      throw new Error(`StreamedChunkLayer: loadBudget must be a non-negative number, got ${configured}`);
    }
    const budget = configured === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor(configured));
    const count = Math.min(missing.length, budget);
    for (let i = 0; i < count; i++) {
      const index = missing[i]!.index;
      const ref = parseRef(currentRefs[index]!);
      const node = nodeFor(index);
      const x = index % columns;
      const y = Math.floor(index / columns);
      jump(node, "translateX", x * props.chunkPx);
      jump(node, "translateY", y * props.chunkPx);
      const handle = (props.loadTile ?? loadTileTexture)(ref.key, ref.index);
      if (handle >= 0) {
        getOps().setImage(node.id, handle);
        uploads++;
      }
      live.set(index, { node, handle });
    }
    pending = count < missing.length;
    report(missing.length - count);
  };

  onFrame(sync);
  onCleanup(() => {
    clear();
    report(0);
  });
  return root as unknown as SolidJSX.Element;
}
