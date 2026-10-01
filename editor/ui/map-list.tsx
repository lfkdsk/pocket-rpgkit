import { Index, createMemo } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import type { MapIndexEntry } from "../../src/engine/types.ts";
import {
  MAP_LIST_HEADER_H,
  MAP_LIST_PAD,
  MAP_LIST_ROW_H,
  mapListWindow,
} from "../engine/map-list.ts";
import { ACCENT, BUTTON, BUTTON_ON, DIM, GOOD, INK, PANEL } from "./panels.tsx";
import { fitEditorText } from "./text-fit.ts";

export interface MapListProps {
  entries: readonly MapIndexEntry[];
  active: number;
  cursor: number;
  loading: number | null;
  dirtyEntries: ReadonlySet<string>;
  scrollY: number;
  width: number;
  height: number;
}

/** A bounded-node map picker. `visible` is at most the viewport's row count
 * plus four overscan rows, whether the catalog contains 3 or 263 maps. */
export function MapList(props: MapListProps): JSX.Element {
  const windowed = createMemo(() => mapListWindow(props.entries.length, props.height, props.scrollY));
  const visible = createMemo(() => props.entries.slice(windowed().first, windowed().end));
  return (
    <View
      class="absolute"
      style={{
        posType: 1,
        insetL: 0,
        insetT: 0,
        width: props.width,
        height: props.height,
        bgColor: PANEL,
        overflow: 1,
      }}
      debugName="editor-map-list"
    >
      <Text
        class="absolute text-xs"
        style={{ posType: 1, insetL: MAP_LIST_PAD, insetT: 7, width: Math.max(0, props.width - MAP_LIST_PAD * 2), height: 12, lineHeight: 12, textColor: ACCENT }}
      >
        {fitEditorText(`MAPS ${props.entries.length}  (ENTER OPEN, ESC CLOSE)`, Math.max(0, props.width - MAP_LIST_PAD * 2))}
      </Text>
      <Index each={visible()}>
        {(entry, localIndex) => {
          const index = () => windowed().first + localIndex;
          const selected = () => index() === props.cursor;
          const active = () => index() === props.active;
          const loading = () => index() === props.loading;
          const dirty = () => props.dirtyEntries.has(entry().entry);
          return (
            <View
              class="absolute flex-row items-center"
              style={{
                posType: 1,
                insetL: MAP_LIST_PAD,
                insetT: MAP_LIST_HEADER_H + index() * MAP_LIST_ROW_H - windowed().scroll,
                width: Math.max(0, props.width - MAP_LIST_PAD * 2),
                height: MAP_LIST_ROW_H - 2,
                bgColor: selected() ? BUTTON_ON : BUTTON,
                borderWidth: selected() ? 1 : 0,
                borderColor: ACCENT,
              }}
              debugName={`editor-map-row-${index()}`}
            >
              <Text
                class="absolute text-xs"
                style={{
                  posType: 1,
                  insetL: 5,
                  insetT: 4,
                  width: Math.max(0, props.width - 22),
                  height: 12,
                  lineHeight: 12,
                  textColor: active() ? GOOD : loading() ? ACCENT : dirty() ? ACCENT : INK,
                }}
              >
                {fitEditorText(
                  `${active() ? ">" : " "}${dirty() ? "*" : " "} ${index() + 1}. ${entry().id}  ${entry().width}x${entry().height}${loading() ? "  LOADING" : ""}`,
                  Math.max(0, props.width - 22),
                )}
              </Text>
            </View>
          );
        }}
      </Index>
      {props.entries.length === 0 ? (
        <Text class="absolute text-xs" style={{ posType: 1, insetL: MAP_LIST_PAD, insetT: 36, textColor: DIM, height: 12, lineHeight: 12 }}>
          NO MAPS
        </Text>
      ) : null}
    </View>
  );
}
