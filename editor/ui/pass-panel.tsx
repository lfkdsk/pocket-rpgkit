// editor/ui/pass-panel.tsx — PASS mode tool panel: passage override
// brushes (pass/block/clear) and sheet dirEdges edge toggles. Replaces
// the tile palette while the editor is in PASS mode.

import { Text, View } from "@pocketjs/framework/components";
import { For } from "solid-js";
import { HEADER_H, PASS_TOOL_LABELS, passToolButtons } from "../engine/layout.ts";
import { fitEditorText } from "./text-fit.ts";

const INK = "#e6e9f0";
const DIM = "#9aa4b8";
const PANEL = "#1b2230";
const BUTTON = "#2c3a52";
const BUTTON_ON = "#3d506e";
const ACCENT = "#ffd24a";

export function PassPanel(props: {
  selected: string;
  cursorTool: number;
  panelH: number;
}): JSX.Element {
  return (
    <View
      class="absolute"
      style={{ posType: 1, insetL: 0, insetT: HEADER_H, width: 140, height: props.panelH, bgColor: PANEL, overflow: 1 }}
      debugName="editor-pass-tools"
    >
      <Text class="text-xs absolute" style={{ posType: 1, insetL: 6, insetT: 5, width: 128, textColor: ACCENT, height: 12, lineHeight: 12 }}>
        PASSAGE
      </Text>
      <Text class="text-xs absolute" style={{ posType: 1, insetL: 6, insetT: 19, width: 128, textColor: DIM, height: 12, lineHeight: 12 }}>
        CELL: PASS/BLOCK
      </Text>
      <For each={passToolButtons()}>
        {(button, index) => {
          const selected = () => props.selected === button.id;
          const cursor = () => props.cursorTool === index();
          return (
            <View
              class="absolute flex-row items-center justify-center"
              style={{
                posType: 1,
                insetL: button.x,
                insetT: button.y,
                width: button.w,
                height: button.h,
                bgColor: selected() || cursor() ? BUTTON_ON : BUTTON,
                borderWidth: cursor() ? 1 : 0,
                borderColor: ACCENT,
                opacity: 1,
              }}
              debugName={`editor-pass-${button.id}`}
            >
              <Text class="text-xs" style={{ width: Math.max(0, button.w - 6), textAlign: 1, textColor: selected() ? ACCENT : INK, height: 12, lineHeight: 12 }}>
                {fitEditorText(PASS_TOOL_LABELS[button.id], Math.max(0, button.w - 6))}
              </Text>
            </View>
          );
        }}
      </For>
    </View>
  );
}
