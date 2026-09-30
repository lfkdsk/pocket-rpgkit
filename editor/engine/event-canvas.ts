// editor/engine/event-canvas.ts — pure geometry shared by the editor's
// event-mode pointer handling and its canvas overlay. Event coordinates are
// world tiles; visible rectangles are returned in viewport-cell coordinates.

export interface CanvasEvent {
  id: string;
  x: number;
  y: number;
  /** Event footprint in tiles. Omitted dimensions retain the v1 1x1 rule. */
  w?: number;
  h?: number;
}

export interface TilePoint {
  x: number;
  y: number;
}

export interface MapSize {
  width: number;
  height: number;
}

export interface EventViewport extends MapSize {
  camX: number;
  camY: number;
  cols: number;
  rows: number;
}

/** The clipped marker box, relative to the visible map window. */
export interface VisibleEventRect {
  id: string;
  vx: number;
  vy: number;
  w: number;
  h: number;
}

export interface EventDragPreview extends TilePoint {
  id: string;
}

/** Normalize optional footprint dimensions at the editor boundary. Project
 * validation normally guarantees positive integers, but treating malformed
 * or non-finite values as one keeps canvas geometry finite and deterministic. */
export function eventSpan(span: number | undefined): number {
  return typeof span === "number" && Number.isFinite(span) ? Math.max(1, Math.floor(span)) : 1;
}

/** True when a world cell is in an event's complete rectangular footprint. */
export function eventContainsCell(event: CanvasEvent, x: number, y: number): boolean {
  const w = eventSpan(event.w);
  const h = eventSpan(event.h);
  return x >= event.x && x < event.x + w && y >= event.y && y < event.y + h;
}

/** Pick the marker visually on top at a world cell. Canvas markers render in
 * array order, so reverse iteration makes the last overlapping marker win. */
export function topmostEventAt(
  events: readonly CanvasEvent[],
  x: number,
  y: number,
): CanvasEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (eventContainsCell(event, x, y)) return event;
  }
  return null;
}

/** Clip an event first to the map and then to the camera window. This also
 * retains events whose origin is off screen but whose multi-cell body enters
 * the viewport. The result uses viewport-cell coordinates for direct drawing. */
export function visibleEventRect(
  event: CanvasEvent,
  viewport: EventViewport,
): VisibleEventRect | null {
  const left = Math.max(event.x, 0, viewport.camX);
  const top = Math.max(event.y, 0, viewport.camY);
  const right = Math.min(
    event.x + eventSpan(event.w),
    Math.max(0, viewport.width),
    viewport.camX + Math.max(0, viewport.cols),
  );
  const bottom = Math.min(
    event.y + eventSpan(event.h),
    Math.max(0, viewport.height),
    viewport.camY + Math.max(0, viewport.rows),
  );
  if (right <= left || bottom <= top) return null;
  return {
    id: event.id,
    vx: left - viewport.camX,
    vy: top - viewport.camY,
    w: right - left,
    h: bottom - top,
  };
}

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(max, value));
}

/** Clamp a proposed event origin so its complete footprint stays on the map.
 * An event wider/taller than the map has no fully fitting origin; zero is the
 * stable fallback for that axis. */
export function clampEventDestination(
  event: CanvasEvent,
  x: number,
  y: number,
  map: MapSize,
): TilePoint {
  const maxX = Math.max(0, Math.floor(map.width) - eventSpan(event.w));
  const maxY = Math.max(0, Math.floor(map.height) - eventSpan(event.h));
  return {
    x: clamp(Math.floor(x), maxX),
    y: clamp(Math.floor(y), maxY),
  };
}

/** Convert a pointer-cell drag into a clamped new origin while preserving the
 * cell of the event grabbed at drag start. */
export function eventDragDestination(
  event: CanvasEvent,
  startCell: TilePoint,
  currentCell: TilePoint,
  map: MapSize,
): TilePoint {
  return clampEventDestination(
    event,
    event.x + currentCell.x - startCell.x,
    event.y + currentCell.y - startCell.y,
    map,
  );
}
