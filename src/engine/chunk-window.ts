// src/engine/chunk-window.ts — pure inclusive chunk-window arithmetic for
// viewport-streamed maps. The caller decides how to load/evict entries; this
// module only maps a camera rectangle plus pixel margin onto a clamped grid.

export interface ChunkPoint {
  x: number;
  y: number;
}

export interface ChunkViewport {
  w: number;
  h: number;
}

export interface ChunkWindow {
  /** Inclusive chunk bounds. Empty windows use x1 < x0 and y1 < y0. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function windowResult(
  previous: ChunkWindow | undefined,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): ChunkWindow {
  return previous &&
    previous.x0 === x0 && previous.y0 === y0 &&
    previous.x1 === x1 && previous.y1 === y1
    ? previous
    : { x0, y0, x1, y1 };
}

/** Chunks intersecting `[camera - margin, camera + viewport + margin)`. */
export function chunkWindow(
  camera: ChunkPoint,
  viewport: ChunkViewport,
  chunkPx: number,
  columns: number,
  rows: number,
  margin = 0,
  previous?: ChunkWindow,
): ChunkWindow {
  if (
    !Number.isFinite(chunkPx) || chunkPx <= 0 ||
    !Number.isInteger(columns) || columns < 0 ||
    !Number.isInteger(rows) || rows < 0 ||
    !Number.isFinite(margin) || margin < 0
  ) {
    throw new Error(`chunkWindow: invalid grid ${columns}x${rows}, chunk ${chunkPx}, margin ${margin}`);
  }
  if (
    columns === 0 || rows === 0 ||
    !Number.isFinite(camera.x) || !Number.isFinite(camera.y) ||
    !Number.isFinite(viewport.w) || !Number.isFinite(viewport.h) ||
    viewport.w <= 0 || viewport.h <= 0
  ) {
    return windowResult(previous, 0, 0, -1, -1);
  }

  const rawX0 = Math.floor((camera.x - margin) / chunkPx);
  const rawY0 = Math.floor((camera.y - margin) / chunkPx);
  // The viewed rectangle is half-open. ceil(end/chunk)-1 keeps an exact
  // chunk boundary in the preceding chunk instead of loading its neighbour.
  const rawX1 = Math.ceil((camera.x + viewport.w + margin) / chunkPx) - 1;
  const rawY1 = Math.ceil((camera.y + viewport.h + margin) / chunkPx) - 1;
  if (rawX1 < 0 || rawY1 < 0 || rawX0 >= columns || rawY0 >= rows) {
    return windowResult(previous, 0, 0, -1, -1);
  }
  return windowResult(
    previous,
    Math.max(0, rawX0),
    Math.max(0, rawY0),
    Math.min(columns - 1, rawX1),
    Math.min(rows - 1, rawY1),
  );
}

/** One layer's last window. Snapshot numbers: hosts may mutate the camera
 * or viewport object in place. The returned window belongs to this reader. */
export function createChunkWindowReader(): typeof chunkWindow {
  let x: number, y: number, w: number, h: number;
  let size: number, cols: number, rows: number, margin: number;
  let previous: ChunkWindow | undefined;
  return (camera, viewport, chunkPx, columns, rowCount, extra = 0) => {
    if (previous && x === camera.x && y === camera.y && w === viewport.w && h === viewport.h &&
        size === chunkPx && cols === columns && rows === rowCount && margin === extra) return previous;
    const next = chunkWindow(camera, viewport, chunkPx, columns, rowCount, extra, previous);
    x = camera.x; y = camera.y; w = viewport.w; h = viewport.h;
    size = chunkPx; cols = columns; rows = rowCount; margin = extra;
    return previous = next;
  };
}

export function chunkWindowContains(window: ChunkWindow, x: number, y: number): boolean {
  return x >= window.x0 && x <= window.x1 && y >= window.y0 && y <= window.y1;
}

/** Grow an inclusive window by whole chunks and clamp it to the map grid. */
export function expandChunkWindow(
  window: ChunkWindow,
  chunks: number,
  columns: number,
  rows: number,
): ChunkWindow {
  if (window.x1 < window.x0 || window.y1 < window.y0 || columns <= 0 || rows <= 0) {
    return { x0: 0, y0: 0, x1: -1, y1: -1 };
  }
  if (!Number.isInteger(chunks) || chunks < 0) {
    throw new Error(`expandChunkWindow: chunks must be a non-negative integer, got ${chunks}`);
  }
  return {
    x0: Math.max(0, window.x0 - chunks),
    y0: Math.max(0, window.y0 - chunks),
    x1: Math.min(columns - 1, window.x1 + chunks),
    y1: Math.min(rows - 1, window.y1 + chunks),
  };
}
