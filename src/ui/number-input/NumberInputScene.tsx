// src/ui/number-input/NumberInputScene.tsx — built-in number-input UI.
//
// Each decimal digit is rendered in its own fixed-width cell. This avoids
// relying on clipping or shortening one combined string, so the full 1..8
// digit value remains visible at every supported integer viewport scale.

import { Text, View } from "@pocketjs/framework/components";
import {
  numberInputText,
  type NumberInputState,
} from "../../engine/number-input.ts";
import type { JsonValue } from "../../engine/types.ts";

const COLOURS = {
  backdrop: "#050914",
  panelBg: "#141c30",
  panelBorder: "#4a5f8f",
  title: "#ffe17a",
  cellBg: "#0b1626",
  cellBorder: "#3a4a6a",
  digit: "#ffffff",
  cursorBg: "#ffe17a",
  cursorText: "#0b1626",
};

const PANEL_HEIGHT = 112;
const DIGIT_WIDTH = 40;
const DIGIT_HEIGHT = 42;
const PANEL_PADDING = 20;

export interface NumberInputSceneProps {
  state: JsonValue;
  width: number;
  height: number;
}

export function NumberInputScene(props: NumberInputSceneProps) {
  const st = (): NumberInputState => props.state as unknown as NumberInputState;
  const scale = (): number =>
    Math.max(1, Math.round(Math.min(props.width / 480, props.height / 272)));
  const panelWidth = (): number =>
    Math.max(160, st().digits * DIGIT_WIDTH + PANEL_PADDING * 2) * scale();
  const panelX = (): number => Math.round((props.width - panelWidth()) / 2);
  const panelY = (): number => Math.round((props.height - PANEL_HEIGHT * scale()) / 2);
  const digitX = (): number => Math.round((panelWidth() - st().digits * DIGIT_WIDTH * scale()) / 2);
  const text = (): string => numberInputText(st());
  const indices = (): number[] => Array.from({ length: st().digits }, (_, i) => i);

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
      debugName="rpgkit-number-input-scene"
    >
      <View
        class="absolute"
        style={{
          posType: 1,
          insetL: panelX(),
          insetT: panelY(),
          width: panelWidth(),
          height: PANEL_HEIGHT * scale(),
          bgColor: COLOURS.panelBg,
          borderWidth: 2 * scale(),
          borderColor: COLOURS.panelBorder,
        }}
        debugName="rpgkit-number-input-panel"
      >
        <Text
          class="text-sm"
          style={{
            posType: 1,
            insetL: 12 * scale(),
            insetT: 8 * scale(),
            textColor: COLOURS.title,
            height: 18 * scale(),
            lineHeight: 18 * scale(),
          }}
          debugName="rpgkit-number-input-title"
        >
          Number
        </Text>

        {indices().map((index) => {
          const selected = (): boolean => index === st().cursor;
          return (
            <View
              class="absolute items-center justify-center"
              style={{
                posType: 1,
                insetL: digitX() + index * DIGIT_WIDTH * scale(),
                insetT: 42 * scale(),
                width: DIGIT_WIDTH * scale(),
                height: DIGIT_HEIGHT * scale(),
                bgColor: selected() ? COLOURS.cursorBg : COLOURS.cellBg,
                borderWidth: scale(),
                borderColor: selected() ? COLOURS.cursorBg : COLOURS.cellBorder,
              }}
              debugName={`rpgkit-number-input-digit-${index}`}
            >
              <Text
                class="text-sm"
                style={{
                  textColor: selected() ? COLOURS.cursorText : COLOURS.digit,
                  height: 24 * scale(),
                  lineHeight: 24 * scale(),
                }}
              >
                {text()[index]}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}
