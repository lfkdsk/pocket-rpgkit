// editor/ui/map-inspector.tsx — presentational map inspector: map
// properties (id/name/size/sheets) and map management (new/duplicate/
// delete). Pointer presses are handled by engine/map-layout.ts, the same
// split as the event inspector.

import { Text, View } from "@pocketjs/framework/components";
import { createMemo, For } from "solid-js";
import type { MapDef } from "../../src/engine/types.ts";
import {
  createMapInspectorLayout,
  formatMapInspectorReference,
  MAP_INSPECTOR_HEADER_H,
  mapInspectorActionKey,
  mapInspectorDeletePrompt,
  mapInspectorReferenceHeading,
  visibleMapReferenceRange,
  wrapMapInspectorNotice,
  type MapInspectorAction,
  type MapInspectorLayout,
  type MapInspectorReference,
} from "../engine/map-layout.ts";

const BG = "#10141d";
const HEADER = "#172033";
const CONTROL = "#2c3a52";
const ACCENT = "#ffd24a";
const INK = "#e6e9f0";
const DIM = "#9aa4b8";
const BAD = "#ff6b5e";

export interface MapInspectorProps {
  width: number;
  height: number;
  map: MapDef;
  /** Complete references shown after a delete was refused (empty = none). */
  references: readonly (string | MapInspectorReference)[];
  /** Zero-based reference page. Paging is controlled by the app so renderer
   *  and raw-pointer hit testing always consume the same state. */
  referencePage?: number;
  /** Persisted editor feedback that would otherwise be hidden while the map
   *  inspector replaces the canvas/status branch. */
  notice?: { kind: "info" | "good" | "bad"; text: string } | null;
  focus: MapInspectorAction | string | null;
  inputBuffer: string;
}

function compact(value: string, width: number): string {
  const max = Math.max(2, Math.floor((width - 8) / 6));
  return value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1))}…`;
}

function isFocused(focus: MapInspectorProps["focus"], action: MapInspectorAction): boolean {
  const key = typeof focus === "string" ? focus : mapInspectorActionKey(focus);
  return key !== "" && key === mapInspectorActionKey(action);
}

function fieldValue(map: MapDef, field: string): string {
  switch (field) {
    case "id": return map.id;
    case "name": return map.name;
    case "width": return String(map.width);
    case "height": return String(map.height);
    case "sheets": return (map.sheets ?? []).join(",");
    default: return "";
  }
}

function Control(props: {
  layout: MapInspectorLayout;
  control: MapInspectorLayout["fields"][number];
  value: string;
  focused: boolean;
  danger?: boolean;
}): JSX.Element {
  return (
    <View
      class="absolute flex-row items-center"
      style={{
        posType: 1,
        insetL: props.control.rect.x,
        insetT: props.control.rect.y,
        width: props.control.rect.w,
        height: props.control.rect.h,
        bgColor: props.danger ? "#3d2a33" : CONTROL,
        borderWidth: props.focused ? 1 : 0,
        borderColor: ACCENT,
        overflow: 1,
      }}
    >
      <Text
        class="text-xs absolute"
        style={{ posType: 1, insetL: 3, insetT: 3, height: 12, lineHeight: 12, textColor: DIM }}
      >
        {props.control.label}
      </Text>
      <Text
        class="text-xs absolute"
        style={{ posType: 1, insetL: 64, insetT: 3, height: 12, lineHeight: 12, textColor: INK }}
      >
        {compact(props.value, props.control.rect.w - 64)}
      </Text>
    </View>
  );
}

/** Complete map inspector view. Pure projection: all mutations and pointer
 *  dispatch live in the app/model. */
export function MapInspector(props: MapInspectorProps): JSX.Element {
  const formattedReferences = createMemo(() => props.references.map(formatMapInspectorReference));
  const layout = createMemo(() => createMapInspectorLayout({
    width: props.width,
    height: props.height,
    referenceCount: formattedReferences().length,
    referencePage: props.referencePage ?? 0,
    showNotice: Boolean(props.notice?.text),
  }));
  const visibleReferences = createMemo(() => {
    const range = visibleMapReferenceRange(layout());
    return formattedReferences().slice(range.start, range.end);
  });
  const noticeLines = createMemo(() =>
    wrapMapInspectorNotice(props.notice?.text ?? "", layout().noticeClip.w)
  );
  const focused = (action: MapInspectorAction) => isFocused(props.focus, action);
  const buffered = (action: MapInspectorAction, value: string) =>
    focused(action) ? `${props.inputBuffer}_` : value;

  return (
    <View
      class="w-full h-full overflow-hidden"
      style={{ bgColor: BG }}
      debugName="map-inspector"
    >
      <View
        class="absolute"
        style={{
          posType: 1,
          insetL: 0,
          insetT: 0,
          width: props.width,
          height: MAP_INSPECTOR_HEADER_H,
          bgColor: HEADER,
        }}
      />
      <Control
        layout={layout()}
        control={layout().close}
        value=""
        focused={focused(layout().close.action)}
      />
      <Text
        class="text-xs absolute"
        style={{ posType: 1, insetL: 58, insetT: 6, height: 12, lineHeight: 12, textColor: INK }}
        debugName="map-inspector-title"
      >
        {compact(`MAP ${props.map.id}`, props.width - 64)}
      </Text>

      <For each={layout().fields}>
        {(c) => c.action.kind === "field" ? (
          <Control
            layout={layout()}
            control={c}
            value={buffered(c.action, fieldValue(props.map, c.action.field))}
            focused={focused(c.action)}
          />
        ) : null}
      </For>

      <For each={layout().actions}>
        {(c) => c.action.kind === "action" ? (
          <Control
            layout={layout()}
            control={c}
            value=""
            focused={focused(c.action)}
            danger={c.action.action === "del"}
          />
        ) : null}
      </For>

      {formattedReferences().length > 0 ? (
        <View
          class="absolute"
          style={{
            posType: 1,
            insetL: layout().refsClip.x,
            insetT: layout().refsClip.y,
            width: layout().refsClip.w,
            height: layout().refsClip.h,
            overflow: 1,
          }}
          debugName="map-inspector-refs"
        >
          <Text
            class="text-xs absolute"
            style={{ posType: 1, insetL: 0, insetT: 0, height: 12, lineHeight: 12, textColor: BAD }}
          >
            {mapInspectorReferenceHeading(formattedReferences().length)}
          </Text>
          <Text
            class="text-xs absolute"
            style={{ posType: 1, insetL: 0, insetT: 14, height: 12, lineHeight: 12, textColor: BAD }}
            debugName="map-inspector-delete-confirm"
          >
            {mapInspectorDeletePrompt()}
          </Text>
          <For each={visibleReferences()}>
            {(ref, i) => (
              <Text
                class="text-xs absolute"
                style={{
                  posType: 1,
                  insetL: 0,
                  insetT: 28 + i() * 12,
                  height: 12,
                  lineHeight: 12,
                  textColor: DIM,
                }}
                debugName={`map-inspector-reference-${i()}`}
              >
                {compact(ref, layout().refsClip.w)}
              </Text>
            )}
          </For>
          {layout().referencePageCount > 1 ? (
            <Text
              class="text-xs absolute"
              style={{
                posType: 1,
                insetL: 108,
                insetT: layout().refsClip.h - 15,
                height: 12,
                lineHeight: 12,
                textColor: INK,
              }}
              debugName="map-inspector-reference-page"
            >
              {`PAGE ${layout().referencePage + 1}/${layout().referencePageCount}`}
            </Text>
          ) : null}
        </View>
      ) : null}

      <For each={layout().referencePager}>
        {(c) => (
          <Control
            layout={layout()}
            control={c}
            value=""
            focused={focused(c.action)}
          />
        )}
      </For>

      {props.notice?.text && layout().noticeClip.h > 0 ? (
        <View
          class="absolute"
          style={{
            posType: 1,
            insetL: layout().noticeClip.x,
            insetT: layout().noticeClip.y,
            width: layout().noticeClip.w,
            height: layout().noticeClip.h,
            bgColor: props.notice.kind === "bad" ? "#321f28" : HEADER,
            borderWidth: props.notice.kind === "bad" ? 1 : 0,
            borderColor: props.notice.kind === "bad" ? BAD : HEADER,
            overflow: 1,
          }}
          debugName="map-inspector-notice"
        >
          <For each={noticeLines()}>
            {(line, i) => (
              <Text
                class="text-xs absolute"
                style={{
                  posType: 1,
                  insetL: 3,
                  insetT: 3 + i() * 12,
                  height: 12,
                  lineHeight: 12,
                  textColor: props.notice!.kind === "bad" ? BAD : INK,
                }}
              >
                {line}
              </Text>
            )}
          </For>
        </View>
      ) : null}
    </View>
  );
}
