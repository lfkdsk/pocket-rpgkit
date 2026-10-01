// editor/ui/canvas.tsx — the map canvas: ground cell grid, the upper star
// layer, event markers, and the pointer hover / gamepad cursor rings on top.
// Cells are real
// Image nodes bound to the pak-baked 16x16 tile images
// (engine/tile-keys.ts); an empty src binds no texture and the core skips
// the node, so a void ground cell leaves the map fill visible.

import { createMemo, For, Index } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import type { Dir, MapDef, TileId } from "../../src/engine/types.ts";
import {
  type CanvasEvent,
  type EventDragPreview,
  visibleEventRect,
} from "../engine/event-canvas.ts";
import { TILE, mapOffset, type FrameGeom } from "../engine/layout.ts";
import type { DensePassage, DenseUpper } from "../engine/model.ts";
import type { ProposalEventPreview, ProposalMapPreview, ProposalTilePreview } from "../proposals/types.ts";
import { ACCENT, BAD, GOOD, INK, MARKER } from "./panels.tsx";

/** One-sided edge rules for one map cell (from its ground tile's sheet). */
export interface CellEdges {
  enter?: Dir[];
  exit?: Dir[];
}

export interface CanvasProps {
  map: MapDef;
  upper: DenseUpper;
  /** Per-cell passage overrides (null = none). */
  passage?: DensePassage | null;
  /** Resolve sheet-level dirEdges for one visible ground tile. */
  edgeForTile?: (tile: TileId) => CellEdges | null;
  camX: number;
  camY: number;
  /** Fitted window (tile count + screen rect). */
  cols: number;
  rows: number;
  frame: FrameGeom;
  /** Resolve a tile id to its baked pak image key ("" = none). */
  texKey: (tile: TileId) => string;
  /** Draw order is array order; omitted w/h keep the legacy 1x1 marker. */
  events: readonly CanvasEvent[];
  /** Event editing mode enables the selected marker treatment. */
  eventMode?: boolean;
  selectedEventId?: string | null;
  /** Temporary clamped origin for an event currently being dragged. */
  dragPreview?: EventDragPreview | null;
  proposalTiles?: readonly ProposalTilePreview[];
  proposalEvents?: readonly ProposalEventPreview[];
  proposalMaps?: readonly ProposalMapPreview[];
  /** Crosshair tile in world coords, or null when the pointer is elsewhere. */
  hover: { x: number; y: number } | null;
  cursorZone: "canvas" | "palette" | "header";
  cursor: { x: number; y: number };
}

/** A primitive list key keeps an unchanged marker node mounted. JSON also
 * avoids imposing delimiter restrictions on otherwise valid caller ids. */
const eventKey = (id: string, vx: number, vy: number, w: number, h: number): string =>
  JSON.stringify([id, vx, vy, w, h]);
function splitEventKey(key: string): { id: string; vx: number; vy: number; w: number; h: number } {
  const [id, vx, vy, w, h] = JSON.parse(key) as [string, number, number, number, number];
  return { id, vx, vy, w, h };
}

interface ArrowRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** true = enter rule (blue, points into the cell); false = exit (orange). */
  enter: boolean;
}

/** 4-rect triangle per edge rule. An `enter` rule blocks entering the cell
 *  FROM that side, so its arrow points INTO the cell; an `exit` rule blocks
 *  leaving, so its arrow points OUT. */
export function edgeArrowRects(edges: CellEdges | null): ArrowRect[] {
  if (!edges) return [];
  const rects: ArrowRect[] = [];
  const push = (dir: Dir, enter: boolean) => {
    if (dir === "left") {
      const rows: [number, number][] = enter
        ? [[0, 2], [0, 3], [0, 3], [0, 2]] // point right (into the cell)
        : [[2, 2], [1, 3], [1, 3], [2, 2]]; // point left (out)
      rows.forEach(([x, w], i) => rects.push({ x, y: 6 + i, w, h: 1, enter }));
    } else if (dir === "right") {
      const rows: [number, number][] = enter
        ? [[14, 2], [13, 3], [13, 3], [14, 2]] // point left (into)
        : [[12, 2], [12, 3], [12, 3], [12, 2]]; // point right (out)
      rows.forEach(([x, w], i) => rects.push({ x, y: 6 + i, w, h: 1, enter }));
    } else if (dir === "up") {
      const cols: [number, number][] = enter
        ? [[0, 2], [0, 3], [0, 3], [0, 2]] // point down (into)
        : [[2, 2], [1, 3], [1, 3], [2, 2]]; // point up (out)
      cols.forEach(([y, h], i) => rects.push({ x: 6 + i, y, w: 1, h, enter }));
    } else {
      const cols: [number, number][] = enter
        ? [[14, 2], [13, 3], [13, 3], [14, 2]] // point up (into)
        : [[12, 2], [12, 3], [12, 3], [12, 2]]; // point down (out)
      cols.forEach(([y, h], i) => rects.push({ x: 6 + i, y, w: 1, h, enter }));
    }
  };
  for (const dir of edges.enter ?? []) push(dir, true);
  for (const dir of edges.exit ?? []) push(dir, false);
  return rects;
}

export function Canvas(props: CanvasProps): JSX.Element {
  const previewMap = createMemo(() => (props.proposalMaps ?? []).find((map) => map.mapId === props.map.id));
  // Keep cropped live cells visible, while extending the review surface far
  // enough to show tiles/events authored in a proposed new row or column.
  const previewWidth = createMemo(() => Math.max(props.map.width, previewMap()?.width ?? props.map.width));
  const previewHeight = createMemo(() => Math.max(props.map.height, previewMap()?.height ?? props.map.height));
  // Dense fixed-size ground window: one tile id (or null) per screen cell,
  // row-major. <Index> keeps one Image per screen slot and its item signal
  // compares by value, so a repaint re-binds exactly the painted cell and a
  // pan re-binds only the slots whose tile changed.
  const groundTiles = createMemo<(TileId | null)[]>(() => {
    const out: (TileId | null)[] = [];
    const m = props.map;
    for (let vy = 0; vy < props.rows; vy++) {
      for (let vx = 0; vx < props.cols; vx++) {
        const wx = props.camX + vx;
        const wy = props.camY + vy;
        out.push(wx < m.width && wy < m.height ? (m.ground[wy * m.width + wx] ?? null) : null);
      }
    }
    return out;
  });

  // The star layer, windowed the same way: an empty slot binds no image
  // (the core skips it), so a repaint, a pan or a map switch re-binds only
  // the slots whose tile changed instead of remounting star cells.
  const upperTiles = createMemo<(TileId | null)[]>(() => {
    const out: (TileId | null)[] = [];
    const m = props.map;
    for (let vy = 0; vy < props.rows; vy++) {
      for (let vx = 0; vx < props.cols; vx++) {
        const wx = props.camX + vx;
        const wy = props.camY + vy;
        out.push(wx < m.width && wy < m.height ? (props.upper[wy * m.width + wx] ?? null) : null);
      }
    }
    return out;
  });

  const keyOf = (tile: TileId | null): string => (tile === null ? "" : props.texKey(tile));

  // Smaller-than-window maps center inside the frame (the runtime's
  // centerOffset/letterbox rule; engine/layout.mapOffset, floor split —
  // hitTest applies the same offset to pointer hits).
  const offX = createMemo(() => mapOffset(previewWidth(), props.cols) * TILE);
  const offY = createMemo(() => mapOffset(previewHeight(), props.rows) * TILE);

  const eventKeys = createMemo<string[]>(() => {
    const preview = props.dragPreview;
    const viewport = {
      camX: props.camX,
      camY: props.camY,
      cols: props.cols,
      rows: props.rows,
      width: props.map.width,
      height: props.map.height,
    };
    const keys: string[] = [];
    for (const event of props.events) {
      const drawn = preview?.id === event.id
        ? { ...event, x: preview.x, y: preview.y }
        : event;
      const rect = visibleEventRect(drawn, viewport);
      if (rect) keys.push(eventKey(rect.id, rect.vx, rect.vy, rect.w, rect.h));
    }
    return keys;
  });

  // Passage overrides + dirEdges for the visible window. Both are sparse;
  // the memo emits one entry per affected screen cell so the overlay mounts
  // a handful of nodes, not one per cell.
  const overlayCells = createMemo(() => {
    const out: { vx: number; vy: number; passage: "pass" | "block" | null; edges: CellEdges | null }[] = [];
    const m = props.map;
    const passage = props.passage;
    const edgeForTile = props.edgeForTile;
    for (let vy = 0; vy < props.rows; vy++) {
      for (let vx = 0; vx < props.cols; vx++) {
        const wx = props.camX + vx;
        const wy = props.camY + vy;
        if (wx >= m.width || wy >= m.height) continue;
        const index = wy * m.width + wx;
        const p = passage ? passage[index] ?? null : null;
        const e = edgeForTile ? edgeForTile(m.ground[index] ?? null) : null;
        if (p || e) out.push({ vx, vy, passage: p, edges: e });
      }
    }
    return out;
  });

  const proposalTiles = (layer: "ground" | "upper") => (props.proposalTiles ?? []).filter((tile) =>
    tile.mapId === props.map.id && tile.layer === layer &&
    tile.x >= 0 && tile.x < previewWidth() && tile.y >= 0 && tile.y < previewHeight() &&
    tile.x >= props.camX && tile.x < props.camX + props.cols &&
    tile.y >= props.camY && tile.y < props.camY + props.rows);
  const proposalEventRects = createMemo(() => {
    const viewport = {
      camX: props.camX, camY: props.camY, cols: props.cols, rows: props.rows,
      width: previewWidth(), height: previewHeight(),
    };
    return (props.proposalEvents ?? []).filter((event) => event.mapId === props.map.id).flatMap((event) => {
      const rect = visibleEventRect(event, viewport);
      return rect ? [{ ...rect, kind: event.kind }] : [];
    });
  });

  return (
    <View
      class="absolute"
      style={{
        posType: 1,
        insetL: props.frame.x,
        insetT: props.frame.y,
        width: props.frame.w,
        height: props.frame.h,
        bgColor: "#000000",
        borderWidth: 1,
        borderColor: "#3a4458",
        overflow: 1,
      }}
      debugName="editor-canvas-frame"
    >
      {/* The map rectangle: opaque dark indigo, so a smaller map's black
          frame margin is visibly distinct from its own fill. Every layer is
          its child, positioned in window-cell space, so a letterbox change
          (switching to a narrower map) moves one node instead of restyling
          every cell. */}
      <View
        class="absolute"
        style={{
          posType: 1,
          insetL: offX(),
          insetT: offY(),
          width: Math.min(previewWidth(), props.cols) * TILE,
          height: Math.min(previewHeight(), props.rows) * TILE,
          bgColor: "#14161e",
        }}
        debugName="editor-map"
      >
        <Index each={groundTiles()}>
          {(tile, i) => (
            <Image
              class="absolute"
              style={{
                posType: 1,
                insetL: (i % props.cols) * TILE,
                insetT: Math.floor(i / props.cols) * TILE,
                width: TILE,
                height: TILE,
              }}
              src={keyOf(tile())}
            />
          )}
        </Index>

        <For each={proposalTiles("ground")}>
          {(ghost) => ghost.tile === null ? (
            <View
              class="absolute"
              style={{ posType: 1, insetL: (ghost.x - props.camX) * TILE, insetT: (ghost.y - props.camY) * TILE, width: TILE, height: TILE, bgColor: BAD, opacity: 0.45, borderWidth: 1, borderColor: "#ffffff" }}
              debugName="editor-proposal-tile-ground"
            />
          ) : (
            <Image
              class="absolute"
              style={{ posType: 1, insetL: (ghost.x - props.camX) * TILE, insetT: (ghost.y - props.camY) * TILE, width: TILE, height: TILE, opacity: 0.55 }}
              src={keyOf(ghost.tile)}
              debugName="editor-proposal-tile-ground"
            />
          )}
        </For>

        <Index each={upperTiles()}>
          {(tile, i) => (
            <Image
              class="absolute"
              style={{
                posType: 1,
                insetL: (i % props.cols) * TILE,
                insetT: Math.floor(i / props.cols) * TILE,
                width: TILE,
                height: TILE,
              }}
              src={keyOf(tile())}
            />
          )}
        </Index>

        <For each={proposalTiles("upper")}>
          {(ghost) => ghost.tile === null ? (
            <View
              class="absolute"
              style={{ posType: 1, insetL: (ghost.x - props.camX) * TILE, insetT: (ghost.y - props.camY) * TILE, width: TILE, height: TILE, bgColor: BAD, opacity: 0.45, borderWidth: 1, borderColor: "#ffffff" }}
              debugName="editor-proposal-tile-upper"
            />
          ) : (
            <Image
              class="absolute"
              style={{ posType: 1, insetL: (ghost.x - props.camX) * TILE, insetT: (ghost.y - props.camY) * TILE, width: TILE, height: TILE, opacity: 0.55 }}
              src={keyOf(ghost.tile)}
              debugName="editor-proposal-tile-upper"
            />
          )}
        </For>

        {/* Event markers draw above both tile layers, translucent, so an event
            under an opaque star tile (meadow's flowerbed) stays visible and the
            tile art still shows through. Multi-cell footprints are clipped to
            both the map and the current camera window. */}
        <For each={eventKeys()}>
          {(key) => {
            const e = splitEventKey(key);
            const selected = () => props.eventMode === true && props.selectedEventId === e.id;
            return (
              <View
                class="absolute flex-row items-center justify-center"
                style={{
                  posType: 1,
                  insetL: e.vx * TILE,
                  insetT: e.vy * TILE,
                  width: e.w * TILE,
                  height: e.h * TILE,
                  bgColor: MARKER,
                  borderWidth: selected() ? 2 : 1,
                  borderColor: selected() ? "#ffffff" : "#ffd5e6",
                  opacity: selected() ? 0.92 : 0.7,
                }}
                debugName={`editor-event-${e.id}`}
              >
                <Text class="text-xs" style={{ textColor: INK, lineHeight: 10, height: 10 }}>
                  !
                </Text>
              </View>
            );
          }}
        </For>

        <For each={proposalEventRects()}>
          {(event) => {
            const color = event.kind === "added" ? GOOD : event.kind === "deleted" ? BAD : event.kind === "moved" ? "#60a5fa" : ACCENT;
            return (
              <View
                class="absolute"
                style={{
                  posType: 1,
                  insetL: event.vx * TILE,
                  insetT: event.vy * TILE,
                  width: event.w * TILE,
                  height: event.h * TILE,
                  bgColor: color,
                  borderWidth: 2,
                  borderColor: color,
                  opacity: 0.55,
                }}
                debugName={`editor-proposal-event-${event.kind}-${event.id}`}
              />
            );
          }}
        </For>

        {props.hover && (
          <View
            class="absolute"
            style={{
              posType: 1,
              insetL: (props.hover.x - props.camX) * TILE,
              insetT: (props.hover.y - props.camY) * TILE,
              width: TILE,
              height: TILE,
              borderWidth: 1,
              borderColor: "#5fd38a",
            }}
          />
        )}

        {/* Passage overrides + one-sided dirEdges. Passage is a small
            corner square (green pass / red block); each enter/exit edge is
            a 4-rect triangle on its edge, blue for enter (blocked entering
            from that side) and orange for exit (blocked leaving that way). */}
        <For each={overlayCells()}>
          {(cell) => (
            <View
              class="absolute"
              style={{
                posType: 1,
                insetL: cell.vx * TILE,
                insetT: cell.vy * TILE,
                width: TILE,
                height: TILE,
              }}
              debugName="editor-pass-overlay"
            >
              {cell.passage ? (
                <View
                  class="absolute"
                  style={{
                    posType: 1,
                    insetL: 10,
                    insetT: 10,
                    width: 5,
                    height: 5,
                    bgColor: cell.passage === "pass" ? "#5fd38a" : "#ff6b5e",
                    opacity: 0.9,
                  }}
                />
              ) : null}
              <For each={edgeArrowRects(cell.edges)}>
                {(arrow) => (
                  <View
                    class="absolute"
                    style={{
                      posType: 1,
                      insetL: arrow.x,
                      insetT: arrow.y,
                      width: arrow.w,
                      height: arrow.h,
                      bgColor: arrow.enter ? "#60a5fa" : "#f59e0b",
                    }}
                  />
                )}
              </For>
            </View>
          )}
        </For>

        {props.cursorZone === "canvas" && (
          <View
            class="absolute"
            style={{
              posType: 1,
              insetL: (props.cursor.x - props.camX) * TILE,
              insetT: (props.cursor.y - props.camY) * TILE,
              width: TILE,
              height: TILE,
              borderWidth: 1,
              borderColor: "#ffd24a",
            }}
            debugName="editor-cursor"
          />
        )}
      </View>
    </View>
  );
}
