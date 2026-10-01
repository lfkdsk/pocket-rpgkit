// editor/engine/cursor.ts — buttons-mode focus cursor. Without
// a pointer companion the whole editor stays operable from a gamepad: one
// cursor roams three zones (canvas, palette strip, header row), and the
// confirm button activates whatever it is on. Pure reducer so sim tapes and
// the golden (which boots without any svc channel) drive it deterministically.

import { PAL_COLS } from "./layout.ts";

export type CursorZone = "canvas" | "palette" | "header";
export type Dir4 = 0 | 1 | 2 | 3; // 0 down, 1 left, 2 up, 3 right

export interface Cursor {
  zone: CursorZone;
  /** Canvas: world tile under the cursor. */
  tx: number;
  ty: number;
  /** Palette: slot index (0 = eraser). */
  slot: number;
  /** Header: button index 0..HEADER_ORDER-1. */
  button: number;
}

export const HEADER_ORDER = [
  "layer",
  "doc",
  "mapprev",
  "mapnext",
  "map",
  "proposals",
  "play",
  "state",
  "undo",
  "redo",
  "save",
] as const;
export type HeaderButton = (typeof HEADER_ORDER)[number];

export function initialCursor(tx: number, ty: number): Cursor {
  return { zone: "canvas", tx, ty, slot: 1, button: 0 };
}

export interface CursorWorld {
  mapW: number;
  mapH: number;
  viewCols: number;
  viewRows: number;
  camX: number;
  camY: number;
  paletteSize: number;
  /** Number of columns in the active palette/panel. Tile palettes default
   *  to PAL_COLS; compact tool panels pass their actual visual width. */
  paletteCols?: number;
  headerSize: number;
}

/** Column the cursor's canvas x maps to when it enters the header row. */
function headerColumnForX(tx: number, viewCols: number, headerSize: number): number {
  return Math.max(0, Math.min(headerSize - 1, Math.floor((tx + 0.5) / viewCols * headerSize)));
}

/** Canvas column under a header button when leaving the header. */
function canvasXForColumn(button: number, viewCols: number, headerSize: number): number {
  return Math.max(0, Math.min(viewCols - 1, Math.floor(((button + 0.5) / headerSize) * viewCols)));
}

/** Palette row a canvas row maps to (both are tile-ish bands). */
function paletteRowForY(ty: number, camY: number, viewRows: number): number {
  const screenRow = ty - camY;
  return Math.max(0, screenRow);
}

/** Move the cursor one d-pad step. Canvas motion past the window edge pans
 *  the camera one tile (returned in camX/camY). Crossing zone borders is
 *  explicit: LEFT from canvas col 0 enters the palette, RIGHT from the
 *  palette returns; UP on the canvas top row enters the header. */
export function stepCursor(
  cur: Cursor,
  dir: Dir4,
  world: CursorWorld,
): { cursor: Cursor; camX: number; camY: number } {
  let { camX, camY } = world;
  const x0 = world.camX;
  const y0 = world.camY;
  const visibleRight = Math.min(world.mapW, x0 + world.viewCols) - 1;
  const visibleBottom = Math.min(world.mapH, y0 + world.viewRows) - 1;

  if (cur.zone === "header") {
    // The header sits above the canvas; DOWN returns to the top visible row.
    if (dir === 0) {
      return {
        cursor: {
          ...cur,
          zone: "canvas",
          tx: x0 + canvasXForColumn(cur.button, world.viewCols, world.headerSize),
          ty: y0,
        },
        camX,
        camY,
      };
    }
    if (dir === 1 || dir === 3) {
      const d = dir === 1 ? -1 : 1;
      return { cursor: { ...cur, button: (cur.button + d + world.headerSize) % world.headerSize }, camX, camY };
    }
    return { cursor: cur, camX, camY };
  }

  if (cur.zone === "palette") {
    const explicitCols = world.paletteCols;
    const cols = explicitCols ?? PAL_COLS;
    let { slot } = cur;
    const col = slot % cols;
    const row = Math.floor(slot / cols);
    if (dir === 1) {
      if (explicitCols !== undefined && col > 0) {
        return { cursor: { ...cur, slot: slot - 1 }, camX, camY };
      }
      return { cursor: cur, camX, camY }; // palette is the leftmost zone
    }
    if (dir === 3) {
      if (explicitCols !== undefined && col + 1 < cols && slot + 1 < world.paletteSize) {
        return { cursor: { ...cur, slot: slot + 1 }, camX, camY };
      }
      return {
        cursor: { ...cur, zone: "canvas", tx: x0, ty: Math.min(world.mapH - 1, y0 + row) },
        camX,
        camY,
      };
    }
    if (dir === 0 || dir === 2) {
      const d = dir === 0 ? 1 : -1;
      const next = col + (row + d) * cols;
      if (next >= 0 && next < world.paletteSize) slot = next;
      return { cursor: { ...cur, slot }, camX, camY };
    }
    return { cursor: cur, camX, camY };
  }

  // canvas
  let { tx, ty } = cur;
  if (dir === 2 && ty === y0) {
    return {
      cursor: { ...cur, zone: "header", button: headerColumnForX(tx - x0, world.viewCols, world.headerSize) },
      camX,
      camY,
    };
  }
  if (dir === 1 && tx === x0) {
    const cols = world.paletteCols ?? PAL_COLS;
    return {
      cursor: { ...cur, zone: "palette", slot: Math.min(world.paletteSize - 1, paletteRowForY(ty, y0, world.viewRows) * cols) },
      camX,
      camY,
    };
  }
  if (dir === 0) {
    if (ty < visibleBottom) ty++;
    else if (y0 + world.viewRows < world.mapH) camY++;
  } else if (dir === 2) {
    if (ty > y0) ty--;
    else if (y0 > 0) {
      camY--;
      ty--;
    }
  } else if (dir === 1) {
    if (tx > x0) tx--;
    else if (x0 > 0) {
      camX--;
      tx--;
    }
  } else {
    if (tx < visibleRight) tx++;
    else if (x0 + world.viewCols < world.mapW) camX++;
  }
  return { cursor: { ...cur, tx, ty }, camX, camY };
}

/** Screen-space rect of the cursor for rendering the crosshair. Returns
 *  pixel coords for the three zones. */
export function cursorPixel(
  cur: Cursor,
  frame: { x: number; y: number },
  camX: number,
  camY: number,
  paletteOrigin: (slot: number) => { x: number; y: number },
  headerOrigin: (index: number) => { x: number; y: number; w: number; h: number },
): { x: number; y: number; w: number; h: number } {
  if (cur.zone === "canvas") {
    return { x: frame.x + (cur.tx - camX) * 16, y: frame.y + (cur.ty - camY) * 16, w: 16, h: 16 };
  }
  if (cur.zone === "palette") {
    const o = paletteOrigin(cur.slot);
    return { x: o.x - 1, y: o.y - 1, w: 14, h: 14 };
  }
  return headerOrigin(cur.button);
}
