// src/ui/name-input/NameInputScene.tsx — the built-in name-input scene UI.
//
// Renders the JSON state of src/engine/name-input.ts's SceneRules: a titled
// edit box (buffer plus underscore padding), the charset grid and the
// BACK/OK/CANCEL actions, with a solid cursor cell. Pure presentation:
// every pixel is a function of `state` and the live logical resolution, so
// replay and rewind reproduce the same screen. The layout scales by an
// integer factor (1× at 480×272, 2× at 960×544); text uses the framework's
// fixed size classes, matching the framework OSK convention.

import { Text, View } from "@pocketjs/framework/components";
import type { JsonValue } from "../../engine/types.ts";
import {
  nameInputCharAt,
  type NameInputState,
} from "../../engine/name-input.ts";

const ACTION_LABELS = ["<", "OK", "X"] as const;

const COLOURS = {
  panelBg: "#141c30",
  panelBorder: "#4a5f8f",
  title: "#ffe17a",
  editBg: "#0b1626",
  editBorder: "#3a4a6a",
  buffer: "#ffffff",
  padding: "#3a4a6a",
  cell: "#c8d4f0",
  cursorBg: "#ffe17a",
  cursorText: "#0b1626",
};

export interface NameInputSceneProps {
  state: JsonValue;
  width: number;
  height: number;
}

export function NameInputScene(props: NameInputSceneProps) {
  const st = (): NameInputState => props.state as unknown as NameInputState;
  const s = (): number =>
    Math.max(1, Math.round(Math.min(props.width / 480, props.height / 272)));

  const panel = () => ({
    x: 20 * s(),
    y: 10 * s(),
    w: 440 * s(),
    h: 252 * s(),
  });
  const edit = () => ({ x: 32 * s(), y: 38 * s(), w: 416 * s(), h: 30 * s() });
  const grid = () => ({ x: 40 * s(), y: 80 * s(), cellW: 40 * s(), cellH: 20 * s() });
  const charW = (): number => 16 * s();

  const entryLabel = (index: number): string => {
    const state = st();
    if (index < state.charset.length) return nameInputCharAt(state, index);
    return ACTION_LABELS[index - state.charset.length] ?? "";
  };

  const cellStyle = (index: number) => {
    const state = st();
    const g = grid();
    const p = panel();
    const row = Math.floor(index / state.columns);
    const col = index % state.columns;
    const cursor = index === state.cursor;
    return {
      posType: 1,
      insetL: g.x - p.x + col * g.cellW,
      insetT: g.y - p.y + row * g.cellH,
      width: g.cellW,
      height: g.cellH,
      ...(cursor ? { bgColor: COLOURS.cursorBg } : {}),
    } as Record<string, number | string>;
  };

  const cellTextStyle = (index: number) => {
    const cursor = index === st().cursor;
    return {
      textColor: cursor ? COLOURS.cursorText : COLOURS.cell,
      height: 20 * s(),
      lineHeight: 20 * s(),
    } as Record<string, number | string>;
  };

  const entries = (): number[] => {
    const state = st();
    return Array.from({ length: state.charset.length + ACTION_LABELS.length }, (_, i) => i);
  };

  return (
    <View
      class="absolute"
      style={{ posType: 1, insetL: 0, insetT: 0, width: props.width, height: props.height }}
      debugName="rpgkit-name-input-scene"
    >
      <View
        class="absolute"
        style={{
          posType: 1,
          insetL: panel().x,
          insetT: panel().y,
          width: panel().w,
          height: panel().h,
          bgColor: COLOURS.panelBg,
          borderWidth: 2 * s(),
          borderColor: COLOURS.panelBorder,
        }}
        debugName="rpgkit-name-input-panel"
      >
        <Text
          class="text-sm"
          style={{
            posType: 1,
            insetL: 12 * s(),
            insetT: 6 * s(),
            textColor: COLOURS.title,
            height: 18 * s(),
            lineHeight: 18 * s(),
          }}
        >
          {st().title}
        </Text>

        <View
          class="absolute"
          style={{
            posType: 1,
            insetL: edit().x - panel().x,
            insetT: edit().y - panel().y,
            width: edit().w,
            height: edit().h,
            bgColor: COLOURS.editBg,
            borderWidth: s(),
            borderColor: COLOURS.editBorder,
          }}
          debugName="rpgkit-name-input-editbox"
        >
          <Text
            class="text-sm"
            style={{
              posType: 1,
              insetL: 8 * s(),
              insetT: 5 * s(),
              textColor: COLOURS.buffer,
              height: 20 * s(),
              lineHeight: 20 * s(),
            }}
          >
            {st().buffer}
          </Text>
          <Text
            class="text-sm"
            style={{
              posType: 1,
              insetL: 8 * s() + st().buffer.length * charW(),
              insetT: 5 * s(),
              textColor: COLOURS.padding,
              height: 20 * s(),
              lineHeight: 20 * s(),
            }}
          >
            {"_".repeat(Math.max(0, st().maxLength - st().buffer.length))}
          </Text>
        </View>

        {entries().map((index) => (
          <View
            class="absolute items-center justify-center"
            style={cellStyle(index)}
            debugName={`rpgkit-name-input-cell-${index}`}
          >
            <Text class="text-sm" style={cellTextStyle(index)}>
              {entryLabel(index)}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}
