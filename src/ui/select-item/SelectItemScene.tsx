// src/ui/select-item/SelectItemScene.tsx — built-in select-item UI.
//
// A centered panel lists the catalog items the reducer selected, with a
// cursor on the live row. Long names wrap (or marquee) and the list
// paginates by rows, reusing the kit's list-window helpers so nothing is
// cut. The component is pure presentation of the scene's JSON state; the
// marquee tick is the view's own useMarqueeTick, so a rewind or replay
// shows the same frame.

import { Text, View } from "@pocketjs/framework/components";
import { createMemo } from "solid-js";
import {
  SELECT_ITEM_SCENE_ID,
  type SelectItemState,
  type SelectItemType,
} from "../../engine/select-item.ts";
import type { JsonValue } from "../../engine/types.ts";
import { fitBounded, marqueeOffset, windowByRows } from "../list-window.ts";
import { slotMeasure } from "../text-measure.ts";
import { useMarqueeTick } from "../use-marquee-tick.ts";

const COLOURS = {
  backdrop: "#050914",
  panelBg: "#141c30",
  panelBorder: "#4a5f8f",
  title: "#ffe17a",
  rowBg: "#0b1626",
  rowText: "#ffffff",
  cursorBg: "#ffe17a",
  cursorText: "#0b1626",
  dim: "#8a9ab8",
};

const PANEL_WIDTH = 300;
const PANEL_PADDING = 12;
const TITLE_HEIGHT = 20;
const LINE_HEIGHT = 14;
const MAX_VISIBLE_ITEMS = 8;
const MAX_ROW_WRAP = 2;

/** Font slot of `text-sm` (14 px regular): index 1 of PocketJS's FONT_PX
 *  table (framework/compiler/tailwind.ts fontSlotFor). The rows render with
 *  `class="text-sm"`, so measurement MUST use the same slot or long names
 *  are underestimated and overflow the panel border. */
const TEXT_SM_SLOT = 1;

const TYPE_TITLES: Record<SelectItemType, string> = {
  regular: "Item",
  key: "Key Item",
  hiddenA: "Hidden A",
  hiddenB: "Hidden B",
};

export interface SelectItemSceneProps {
  state: JsonValue;
  width: number;
  height: number;
}

export function SelectItemScene(props: SelectItemSceneProps) {
  const st = (): SelectItemState => props.state as unknown as SelectItemState;
  const scale = (): number =>
    Math.max(1, Math.round(Math.min(props.width / 480, props.height / 272)));
  const measure = slotMeasure(TEXT_SM_SLOT);

  const items = (): SelectItemState["items"] => st().items;
  const index = (): number => st().index;
  const rowWidthPx = (): number => PANEL_WIDTH - PANEL_PADDING * 2;
  const rowCounts = (): number[] =>
    items().map((e) => fitBounded(e.name, rowWidthPx(), MAX_ROW_WRAP, measure).rows.length);
  /** The visible window and the total line height it occupies, so the panel
   *  grows to fit wrapped names instead of clipping them. */
  const view = (): { start: number; end: number; lines: number } => {
    const counts = rowCounts();
    const maxItems = Math.min(MAX_VISIBLE_ITEMS, items().length);
    const w = windowByRows(index(), counts, maxItems, maxItems * MAX_ROW_WRAP);
    let lines = 0;
    for (let i = w.start; i < w.end; i++) lines += counts[i]!;
    return { ...w, lines };
  };

  /** A row marquees only when its name is too long for the wrap budget. */
  const anyMarquee = createMemo(() =>
    items().some((e) => fitBounded(e.name, rowWidthPx(), MAX_ROW_WRAP, measure).kind === "marquee"),
  );
  const marqueeTick = useMarqueeTick(anyMarquee);

  const panelWidth = (): number => PANEL_WIDTH * scale();
  const panelX = (): number => Math.round((props.width - panelWidth()) / 2);
  const panelHeight = (): number =>
    (TITLE_HEIGHT + PANEL_PADDING * 2 + view().lines * LINE_HEIGHT) * scale();
  const panelY = (): number => Math.round((props.height - panelHeight()) / 2);

  const rows = (): { entry: SelectItemState["items"][number]; rowIndex: number }[] => {
    const w = view();
    const out: { entry: SelectItemState["items"][number]; rowIndex: number }[] = [];
    for (let i = w.start; i < w.end; i++) out.push({ entry: items()[i]!, rowIndex: i });
    return out;
  };

  /** The inset (px from panel top) of row `rowIndex`, accounting for the
   *  wrapped line counts of the rows above it in the visible window. */
  const rowInset = (rowIndex: number): number => {
    const counts = rowCounts();
    const w = view();
    let lines = 0;
    for (let i = w.start; i < rowIndex; i++) lines += counts[i]!;
    return PANEL_PADDING + TITLE_HEIGHT + lines * LINE_HEIGHT;
  };

  return (
    <View
      class="absolute"
      style={{
        posType: 1,
        insetL: 0,
        insetT: 0,
        width: props.width,
        height: props.height,
        bgColor: COLOURS.backdrop,
      }}
      debugName="rpgkit-select-item-scene"
    >
      <View
        class="absolute"
        style={{
          posType: 1,
          insetL: panelX(),
          insetT: panelY(),
          width: panelWidth(),
          height: panelHeight(),
          bgColor: COLOURS.panelBg,
          borderWidth: 2 * scale(),
          borderColor: COLOURS.panelBorder,
        }}
        debugName="rpgkit-select-item-panel"
      >
        <Text
          class="text-sm"
          style={{
            posType: 1,
            insetL: PANEL_PADDING * scale(),
            insetT: PANEL_PADDING * scale(),
            textColor: COLOURS.title,
            height: TITLE_HEIGHT * scale(),
            lineHeight: TITLE_HEIGHT * scale(),
          }}
          debugName="rpgkit-select-item-title"
        >
          {TYPE_TITLES[st().itemType] ?? "Item"}
        </Text>

        {rows().map(({ entry, rowIndex }) => {
          const selected = rowIndex === index();
          const cell = fitBounded(entry.name, rowWidthPx(), MAX_ROW_WRAP, measure);
          const offset = cell.kind === "marquee"
            ? marqueeOffset(cell.overflow, marqueeTick())
            : 0;
          const rowH = cell.rows.length * LINE_HEIGHT;
          return (
            <View
              class="absolute"
              style={{
                posType: 1,
                insetL: PANEL_PADDING * scale(),
                insetT: rowInset(rowIndex) * scale(),
                width: rowWidthPx() * scale(),
                height: rowH * scale(),
                bgColor: selected ? COLOURS.cursorBg : COLOURS.rowBg,
              }}
              debugName={`rpgkit-select-item-row-${rowIndex}`}
            >
              {cell.kind === "wrap" ? (
                cell.rows.map((line, li) => (
                  <Text
                    class="text-sm"
                    style={{
                      posType: 1,
                      insetL: 4 * scale(),
                      insetT: li * LINE_HEIGHT * scale(),
                      textColor: selected ? COLOURS.cursorText : COLOURS.rowText,
                      height: LINE_HEIGHT * scale(),
                      lineHeight: LINE_HEIGHT * scale(),
                    }}
                  >
                    {line}
                  </Text>
                ))
              ) : (
                <Text
                  class="text-sm"
                  style={{
                    posType: 1,
                    insetL: (4 - offset) * scale(),
                    insetT: 0,
                    textColor: selected ? COLOURS.cursorText : COLOURS.rowText,
                    height: LINE_HEIGHT * scale(),
                    lineHeight: LINE_HEIGHT * scale(),
                  }}
                >
                  {cell.rows[0]}
                </Text>
              )}
            </View>
          );
        })}

        {items().length === 0 ? (
          <Text
            class="text-sm"
            style={{
              posType: 1,
              insetL: PANEL_PADDING * scale(),
              insetT: (PANEL_PADDING + TITLE_HEIGHT) * scale(),
              textColor: COLOURS.dim,
              height: LINE_HEIGHT * scale(),
              lineHeight: LINE_HEIGHT * scale(),
            }}
            debugName="rpgkit-select-item-empty"
          >
            (none)
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export { SELECT_ITEM_SCENE_ID };
