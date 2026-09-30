// editor/ui/canvas.tsx — the map canvas: ground cell grid, the upper star
// layer, event markers, and the pointer hover / gamepad cursor rings on top.
// Cells are real
// Image nodes bound to the pak-baked 16x16 tile images
// (engine/tile-keys.ts); an empty src binds no texture and the core skips
// the node, so a void ground cell leaves the map fill visible.

import { createMemo, For, Index } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import type { MapDef, TileId } from "../../src/engine/types.ts";
import {
  type CanvasEvent,
  type EventDragPreview,
  visibleEventRect,
} from "../engine/event-canvas.ts";
import { TILE, mapOffset, type FrameGeom } from "../engine/layout.ts";
import type { DenseUpper } from "../engine/model.ts";
import { INK, MARKER } from "./panels.tsx";

export interface CanvasProps {
  map: MapDef;
  upper: DenseUpper;
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

export function Canvas(props: CanvasProps): JSX.Element {
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
  const offX = createMemo(() => mapOffset(props.map.width, props.cols) * TILE);
  const offY = createMemo(() => mapOffset(props.map.height, props.rows) * TILE);

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
          width: Math.min(props.map.width, props.cols) * TILE,
          height: Math.min(props.map.height, props.rows) * TILE,
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
