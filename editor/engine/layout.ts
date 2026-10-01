// editor/engine/layout.ts — fixed editor geometry and pure
// pointer hit-testing. The canvas is a 20x14-tile window (320x224) centered
// in the area right of the 140px palette panel; maps larger than the window
// pan a tile camera, smaller maps letterbox inside it. All numbers are
// constants so the sim tests and the host receive identical coordinates.

import { TILE } from "../../src/engine/tiles.ts";

export { TILE };
export const HEADER_H = 20;
export const STATUS_H = 18;
export const BANNER_H = 34; // gamepad-mode strip (two absolute 12px rows)
export const PAL_W = 140;
export const VIEW_COLS = 20; // largest cell window
export const VIEW_ROWS = 14;
export const MIN_VIEW_ROWS = 10;
export const FRAME_W = VIEW_COLS * TILE; // 320
export const FRAME_H = VIEW_ROWS * TILE; // 224

export interface FrameGeom {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ViewFit {
  cols: number;
  rows: number;
  frame: FrameGeom;
}

/** Fitted cell window + frame rect for a live viewport. A small window
 *  (the 480x272 golden with the banner up) shrinks the ROW count rather
 *  than overlapping the chrome; the default desktop window gets 20x14. */
export function fittedView(vpW: number, vpH: number, banner: boolean): ViewFit {
  const areaX = PAL_W;
  const top = HEADER_H + (banner ? BANNER_H : 0);
  const areaW = Math.max(0, vpW - areaX);
  const areaH = Math.max(0, vpH - top - STATUS_H);
  const cols = Math.max(8, Math.min(VIEW_COLS, Math.floor(areaW / TILE)));
  const rows = Math.max(MIN_VIEW_ROWS, Math.min(VIEW_ROWS, Math.floor(areaH / TILE)));
  const w = cols * TILE;
  const h = rows * TILE;
  return {
    cols,
    rows,
    frame: {
      x: areaX + Math.floor((areaW - w) / 2),
      y: top + Math.floor((areaH - h) / 2),
      w,
      h,
    },
  };
}

/** Back-compat for callers/tests that only need the frame rect at the
 *  maximum window. */
export function canvasFrame(vpW: number, vpH: number, banner: boolean): FrameGeom {
  return fittedView(vpW, vpH, banner).frame;
}

// Palette: eraser swatch first, then the sheet's cells in index order.
export const PAL_COLS = 8;
export const PAL_PITCH = 13; // 12px thumbnail + 1px gutter
export const PAL_THUMB = 12;
export const PAL_PAD = 3;
export const PAL_GRID_TOP = 33;
export const ERASER_INDEX = 0;
export const PAL_KEY_ERASER = "__eraser__";

export const EVENT_TOOL_IDS = ["new", "edit", "copy", "delete"] as const;
export type EventTool = (typeof EVENT_TOOL_IDS)[number];
export const EVENT_TOOL_COLS = 1;

/** Passage-mode tools. The first three paint the map's passage overrides;
 *  the rest toggle one-sided dirEdges on the SHEET of the painted cell's
 *  ground tile (the in- and out- tools edit enter/exit lists; clr-edge
 *  drops the cell's entry). */
export const PASS_TOOL_IDS = [
  "pass", "block", "clear", "clr-edge",
  "in-down", "out-down",
  "in-left", "out-left",
  "in-right", "out-right",
  "in-up", "out-up",
] as const;
export type PassTool = (typeof PASS_TOOL_IDS)[number];
export const PASS_TOOL_COLS = 2;

export const PASS_TOOL_LABELS: Record<PassTool, string> = {
  "pass": "PASS",
  "block": "BLOCK",
  "clear": "CLEAR",
  "clr-edge": "CLR-EDGE",
  "in-down": "IN-DN",
  "out-down": "OUT-DN",
  "in-left": "IN-LT",
  "out-left": "OUT-LT",
  "in-right": "IN-RT",
  "out-right": "OUT-RT",
  "in-up": "IN-UP",
  "out-up": "OUT-UP",
};

/** Passage tools replace the tile palette in PASS mode: a 2-column grid.
 *  Coordinates are panel-relative (the panel starts at HEADER_H), matching
 *  PalettePanel/EventPanel convention. */
export function passToolButtons(): { id: PassTool; x: number; y: number; w: number; h: number }[] {
  return PASS_TOOL_IDS.map((id, index) => ({
    id,
    x: 6 + (index % PASS_TOOL_COLS) * 67,
    y: 33 + Math.floor(index / PASS_TOOL_COLS) * 27,
    w: 63,
    h: 24,
  }));
}

export function hitPassTool(x: number, y: number): PassTool | null {
  for (const button of passToolButtons()) {
    if (inside(x, y, button)) return button.id;
  }
  return null;
}

/** Event-mode tools replace the tile palette. Coordinates are local to that
 * panel (whose screen top is HEADER_H), matching PalettePanel's convention. */
export function eventToolButtons(): { id: EventTool; x: number; y: number; w: number; h: number }[] {
  return EVENT_TOOL_IDS.map((id, index) => ({ id, x: 6, y: 62 + index * 27, w: PAL_W - 12, h: 22 }));
}

export function hitEventTool(x: number, y: number): EventTool | null {
  for (const button of eventToolButtons()) {
    if (inside(x, y, button)) return button.id;
  }
  return null;
}

export type Layer = "ground" | "upper";

// Header buttons (y 2..18).
export interface ButtonGeom extends FrameGeom {
  id: "layer" | "doc" | "mapprev" | "mapnext" | "map" | "proposals" | "play" | "state" | "undo" | "redo" | "save";
}

export function headerButtons(vpW: number): ButtonGeom[] {
  const y = 2;
  const h = HEADER_H - 4;
  const mk = (id: ButtonGeom["id"], x: number, w: number): ButtonGeom => ({ id, x, y, w, h });
  const save = mk("save", vpW - 4 - 52, 52);
  const redo = mk("redo", save.x - 4 - 44, 44);
  const undo = mk("undo", redo.x - 4 - 44, 44);
  // At the 400px minimum viewport the three review/play controls collapse to
  // compact labels, while wider windows retain the original descriptive
  // widths. Keep four pixels between controls and the right-aligned edit row.
  const toolsX = 188;
  const toolsWidth = Math.max(48, undo.x - 4 - toolsX - 8);
  const proposalWidth = Math.min(56, Math.max(20, toolsWidth - 28));
  const playWidth = Math.min(44, Math.max(20, toolsWidth - proposalWidth - 8));
  const stateWidth = Math.min(88, Math.max(8, toolsWidth - proposalWidth - playWidth));
  const playX = toolsX + proposalWidth + 4;
  const stateX = playX + playWidth + 4;
  return [
    mk("layer", 4, 44),
    mk("doc", 52, 36),
    mk("mapprev", 92, 20),
    mk("mapnext", 116, 20),
    mk("map", 140, 44),
    mk("proposals", toolsX, proposalWidth),
    mk("play", playX, playWidth),
    mk("state", stateX, stateWidth),
    undo,
    redo,
    save,
  ];
}

export type Hit =
  | { kind: "button"; id: ButtonGeom["id"] }
  | { kind: "palette"; slot: number }
  | { kind: "cell"; tx: number; ty: number }
  | null;

/** Palette slot rect origin (slot 0 is the eraser). */
export function paletteSlotOrigin(slot: number): { x: number; y: number } {
  const col = slot % PAL_COLS;
  const row = Math.floor(slot / PAL_COLS);
  return {
    x: PAL_PAD + col * PAL_PITCH,
    y: PAL_GRID_TOP + row * PAL_PITCH,
  };
}

function inside(x: number, y: number, r: FrameGeom): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

/** Hit-test a pointer press in logical px. `frame` is the fitted canvas
 *  rect from fittedView(); `camX/camY` the first world tile at its
 *  top-left; `palScrollY` the palette's scrolled-away pixel height; `map`
 *  the current map's size in tiles. Pure — the UI forwards mouse lines and
 *  its own camera/scroll state.
 *
 *  A map smaller than the window is drawn centered (mapOffset), so with
 *  `map` given the hit shifts by that offset and the letterbox margins are
 *  not cells: without it a click on a 20x12 map in a 14-row window would
 *  land one row below the cell under the pointer. */
export function hitTest(
  x: number,
  y: number,
  vpW: number,
  vpH: number,
  frame: FrameGeom,
  camX: number,
  camY: number,
  paletteSize: number,
  palScrollY: number,
  map?: { w: number; h: number },
): Hit {
  if (y < HEADER_H) {
    for (const b of headerButtons(vpW)) {
      if (inside(x, y, b)) return { kind: "button", id: b.id };
    }
    return null;
  }
  if (x < PAL_W && y < vpH - STATUS_H && y >= HEADER_H) {
    // Coordinates here are panel-relative (the panel starts at HEADER_H).
    const py = y - HEADER_H;
    const col = Math.floor((x - PAL_PAD) / PAL_PITCH);
    const row = Math.floor((py - PAL_GRID_TOP + palScrollY) / PAL_PITCH);
    if (col >= 0 && col < PAL_COLS && row >= 0) {
      const slot = row * PAL_COLS + col;
      if (slot < paletteSize) {
        const o = paletteSlotOrigin(slot);
        // Hits count only over the thumbnail box, not the 1px gutter.
        if (x < o.x + PAL_THUMB && py < o.y - palScrollY + PAL_THUMB) {
          return { kind: "palette", slot };
        }
      }
    }
    return null;
  }
  if (inside(x, y, frame)) {
    const offX = map ? mapOffset(map.w, Math.floor(frame.w / TILE)) * TILE : 0;
    const offY = map ? mapOffset(map.h, Math.floor(frame.h / TILE)) * TILE : 0;
    const lx = x - frame.x - offX;
    const ly = y - frame.y - offY;
    if (lx < 0 || ly < 0) return null;
    const tx = camX + Math.floor(lx / TILE);
    const ty = camY + Math.floor(ly / TILE);
    if (map && (tx >= map.w || ty >= map.h)) return null;
    return { kind: "cell", tx, ty };
  }
  return null;
}

/** Clamp a camera origin so the window stays on the map; when the map is
 *  smaller than the window the origin is 0 and the letterbox owns the gap. */
export function clampCam(pos: number, mapSpan: number, viewSpan: number): number {
  const max = Math.max(0, mapSpan - viewSpan);
  return Math.max(0, Math.min(max, pos));
}

/** Pixel offset of the map inside the frame: non-zero only when the map is
 *  smaller than the window (centered, like the runtime letterbox). */
export function mapOffset(mapSpan: number, viewSpan: number): number {
  return mapSpan < viewSpan ? Math.floor((viewSpan - mapSpan) / 2) : 0;
}
