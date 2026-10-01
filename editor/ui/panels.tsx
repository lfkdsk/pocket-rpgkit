// editor/ui/panels.tsx — presentational pieces: header buttons, the
// no-companion banner and the tile palette strip. All chrome here is REAL
// pixels (filled rects + text), never an invisible hot zone.

import { Image, Text, View } from "@pocketjs/framework/components";
import { createMemo, For, Index } from "solid-js";
import {
  BANNER_H,
  HEADER_H,
  PAL_COLS,
  PAL_GRID_TOP,
  PAL_PAD,
  PAL_PITCH,
  PAL_THUMB,
  PAL_W,
  eventToolButtons,
} from "../engine/layout.ts";
import { fitEditorText } from "./text-fit.ts";

export const INK = "#e6e9f0";
export const DIM = "#9aa4b8";
export const PANEL = "#1b2230";
export const BUTTON = "#2c3a52";
export const BUTTON_ON = "#3d506e";
export const ACCENT = "#ffd24a";
export const BAD = "#ff6b5e";
export const GOOD = "#5fd38a";
/** Event marker fill (drawn at 70% opacity over the tile layers). */
export const MARKER = "#d82f6a";

export function HeaderButton(props: {
  label: string;
  x: number;
  w: number;
  focus: boolean;
  enabled: boolean;
}): JSX.Element {
  return (
    <View
      class="absolute flex-row items-center justify-center"
      style={{
        posType: 1,
        insetL: props.x,
        insetT: 2,
        width: props.w,
        height: HEADER_H - 4,
        bgColor: props.focus ? BUTTON_ON : BUTTON,
        borderWidth: props.focus ? 1 : 0,
        borderColor: ACCENT,
        opacity: props.enabled ? 1 : 0.4,
        overflow: 1,
      }}
      debugName={`editor-header-${props.label}`}
    >
      <Text
        class="text-xs"
        style={{ width: Math.max(0, props.w - 8), textAlign: 1, textColor: props.enabled ? INK : DIM, lineHeight: 12, height: 12 }}
      >
        {fitEditorText(props.label, Math.max(0, props.w - 8))}
      </Text>
    </View>
  );
}

export interface PaletteThumb {
  slot: number;
  tileKey: string | null; // null = eraser
  src: string; // "" for the eraser
  label: string;
}

export function PalettePanel(props: {
  thumbs: PaletteThumb[];
  selectedSlot: number;
  /** Gamepad cursor slot while the cursor is in the palette, else -1. */
  cursorSlot: number;
  scrollY: number;
  panelH: number;
}): JSX.Element {
  // Mount only the rows the scissor window can show (plus one row above and
  // below). Row positions stay absolute in the full-strip space. <Index>
  // keeps one node per visible slot, so switching to a map with another
  // sheet re-binds image sources instead of remounting the strip. Props are
  // read only inside the memo and JSX: a component body runs once, so a
  // plain const here would freeze the first map's palette, its scroll
  // offset and the selection ring.
  const visible = createMemo(() => {
    const rowsTotal = Math.ceil(props.thumbs.length / PAL_COLS);
    const firstRow = Math.max(0, Math.floor(props.scrollY / PAL_PITCH) - 1);
    const lastRow = Math.min(
      rowsTotal - 1,
      Math.ceil((props.scrollY + props.panelH - PAL_GRID_TOP) / PAL_PITCH) + 1,
    );
    return props.thumbs.slice(firstRow * PAL_COLS, (lastRow + 1) * PAL_COLS);
  });
  return (
    <View
      class="absolute"
      style={{ posType: 1, insetL: 0, insetT: HEADER_H, width: PAL_W, height: props.panelH, bgColor: PANEL, overflow: 1 }}
      debugName="editor-palette"
    >
      <Text
        class="absolute text-xs"
        style={{ posType: 1, insetL: PAL_PAD, insetT: 4, width: PAL_W - PAL_PAD * 2, textColor: DIM, lineHeight: 12, height: 12 }}
      >
        TILES (0=ERASE)
      </Text>
      <Index each={visible()}>
        {(thumb) => (
          <View
            class="absolute flex-row items-center justify-center"
            style={{
              posType: 1,
              insetL: PAL_PAD + (thumb().slot % PAL_COLS) * PAL_PITCH,
              insetT: PAL_GRID_TOP + Math.floor(thumb().slot / PAL_COLS) * PAL_PITCH - props.scrollY,
              width: PAL_PITCH,
              height: PAL_PITCH,
              bgColor: thumb().tileKey === null ? "#3a2530" : "#10131b",
              borderWidth: thumb().slot === props.selectedSlot || thumb().slot === props.cursorSlot ? 1 : 0,
              borderColor: thumb().slot === props.cursorSlot ? GOOD : ACCENT,
            }}
            debugName={`editor-pal-${thumb().slot}`}
          >
            {thumb().tileKey === null ? (
              <Text class="text-xs" style={{ textColor: BAD, lineHeight: 10, height: 10 }}>
                X
              </Text>
            ) : (
              <Image
                class="absolute"
                src={thumb().src}
                style={{ posType: 1, insetL: 0, insetT: 0, width: PAL_THUMB, height: PAL_THUMB }}
              />
            )}
          </View>
        )}
      </Index>
    </View>
  );
}

export function EventPanel(props: {
  selected: { id: string; name?: string; x: number; y: number; w?: number; h?: number } | null;
  cursorTool: number;
  panelH: number;
}): JSX.Element {
  const labels = { new: "NEW", edit: "EDIT", copy: "COPY", delete: "DELETE" } as const;
  return (
    <View
      class="absolute"
      style={{ posType: 1, insetL: 0, insetT: HEADER_H, width: PAL_W, height: props.panelH, bgColor: PANEL, overflow: 1 }}
      debugName="editor-event-tools"
    >
      <Text class="text-xs absolute" style={{ posType: 1, insetL: 6, insetT: 5, width: PAL_W - 12, textColor: ACCENT, height: 12, lineHeight: 12 }}>
        EVENTS
      </Text>
      <Text class="text-xs absolute" style={{ posType: 1, insetL: 6, insetT: 22, width: PAL_W - 12, textColor: INK, height: 12, lineHeight: 12 }}>
        {fitEditorText(props.selected ? props.selected.id : "NO SELECTION", PAL_W - 12)}
      </Text>
      <Text class="text-xs absolute" style={{ posType: 1, insetL: 6, insetT: 39, width: PAL_W - 12, textColor: DIM, height: 12, lineHeight: 12 }}>
        {fitEditorText(props.selected ? `${props.selected.x},${props.selected.y}  ${props.selected.w ?? 1}x${props.selected.h ?? 1}` : "CLICK MAP, THEN NEW", PAL_W - 12)}
      </Text>
      <For each={eventToolButtons()}>
        {(button, index) => {
          const enabled = () => button.id === "new" || props.selected !== null;
          return (
            <View
              class="absolute flex-row items-center justify-center"
              style={{
                posType: 1,
                insetL: button.x,
                insetT: button.y,
                width: button.w,
                height: button.h,
                bgColor: props.cursorTool === index() ? BUTTON_ON : BUTTON,
                borderWidth: props.cursorTool === index() ? 1 : 0,
                borderColor: ACCENT,
                opacity: enabled() ? 1 : 0.4,
              }}
              debugName={`editor-event-tool-${button.id}`}
            >
              <Text class="text-xs" style={{ width: Math.max(0, button.w - 6), textAlign: 1, textColor: enabled() ? INK : DIM, height: 12, lineHeight: 12 }}>
                {fitEditorText(labels[button.id], Math.max(0, button.w - 6))}
              </Text>
            </View>
          );
        }}
      </For>
      <Text class="text-xs absolute" style={{ posType: 1, insetL: 6, insetT: 176, width: PAL_W - 12, textColor: DIM, height: 24, lineHeight: 11 }}>
        DRAG TO MOVE{"\n"}MODE BUTTON: TILES
      </Text>
    </View>
  );
}

export function Banner(props: { width: number }): JSX.Element {
  // Gamepad-mode strip: visible whenever no companion channel is present.
  // Three short rows preserve every binding at the 400 px web minimum.
  return (
    <View
      class="absolute flex-col"
      style={{
        posType: 1,
        insetL: PAL_W,
        insetT: HEADER_H,
        width: props.width,
        height: BANNER_H,
        bgColor: "#3a2a10",
        overflow: 1,
      }}
      debugName="editor-no-svc-banner"
    >
      <Text class="text-xs absolute" style={{ posType: 1, insetL: 4, insetT: 1, width: Math.max(0, props.width - 8), textColor: ACCENT, lineHeight: 10, height: 10 }}>
        GAMEPAD MODE · DPAD MOVE
      </Text>
      <Text class="text-xs absolute" style={{ posType: 1, insetL: 4, insetT: 14, width: Math.max(0, props.width - 8), textColor: ACCENT, lineHeight: 10, height: 10 }}>
        O PAINT · X ERASE · SEL LAYER
      </Text>
      <Text class="text-xs absolute" style={{ posType: 1, insetL: 4, insetT: 27, width: Math.max(0, props.width - 8), textColor: ACCENT, lineHeight: 10, height: 10 }}>
        L/R MAP · START SAVE
      </Text>
    </View>
  );
}
