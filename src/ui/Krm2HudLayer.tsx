// src/ui/Krm2HudLayer.tsx — transient KRM2 HUD presentation.
//
// Timer and map-name lifetime live entirely in reducer state. This component
// only formats that state and therefore remains deterministic under replay,
// restore and rewind.

import { createMemo, type Accessor } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import type { TimerState } from "../engine/interpreter.ts";
import type { MapNameBannerState, ScreenEffectsState } from "../engine/screen.ts";
import { wrapLabel } from "./list-window.ts";
import { slotMeasure } from "./text-measure.ts";
import { mapNameBannerOpacity, timerHudText } from "./krm2-ui.ts";

export { mapNameBannerOpacity, timerHudText } from "./krm2-ui.ts";

const TEXT_SM_SLOT = 1;
const ROW_HEIGHT = 18;

export interface Krm2HudLayerProps {
  screen: Accessor<ScreenEffectsState | undefined>;
  timer: Accessor<TimerState | undefined>;
  width: Accessor<number>;
  height: Accessor<number>;
}

export function Krm2HudLayer(props: Krm2HudLayerProps) {
  const timer = (): TimerState | undefined => props.timer();
  const timerText = createMemo(() => timerHudText(timer()));
  const timerWidth = createMemo(() => Math.ceil(slotMeasure(TEXT_SM_SLOT)(timerText())) + 16);
  const banner = (): MapNameBannerState | undefined => props.screen()?.mapNameBanner;
  const bannerWidth = (): number => Math.max(1, Math.min(360, props.width() - 24));
  const bannerLines = createMemo(() => {
    const value = banner();
    return value ? wrapLabel(value.text, Math.max(1, bannerWidth() - 16), slotMeasure(TEXT_SM_SLOT)) : [];
  });

  return (
    <>
      <View
        class="absolute"
        style={{
          posType: 1,
          insetT: 8,
          insetR: 8,
          width: timerWidth(),
          height: 24,
          bgColor: "#0b1626",
          opacity: 0.88,
          borderWidth: 1,
          borderColor: "#4a5f8f",
          display: timer() ? 0 : 1,
        }}
        debugName="rpgkit-timer-hud"
      >
        <Text
          class="text-sm"
          style={{
            posType: 1,
            insetL: 8,
            insetT: 3,
            textColor: "#ffffff",
            height: ROW_HEIGHT,
            lineHeight: ROW_HEIGHT,
          }}
          debugName="rpgkit-timer-text"
        >
          {timerText()}
        </Text>
      </View>

      <View
        class="absolute"
        style={{
          posType: 1,
          insetL: Math.round((props.width() - bannerWidth()) / 2),
          insetT: 40,
          width: bannerWidth(),
          height: Math.max(1, bannerLines().length) * ROW_HEIGHT + 12,
          bgColor: "#0b1626",
          opacity: banner() ? 0.9 * mapNameBannerOpacity(banner()!) : 0,
          borderWidth: 1,
          borderColor: "#4a5f8f",
          display: banner() ? 0 : 1,
        }}
        debugName="rpgkit-map-name-banner"
      >
        {bannerLines().map((line, index) => (
          <Text
            class="text-sm"
            style={{
              posType: 1,
              insetL: 8,
              insetT: 6 + index * ROW_HEIGHT,
              textColor: "#ffffff",
              height: ROW_HEIGHT,
              lineHeight: ROW_HEIGHT,
            }}
            debugName={`rpgkit-map-name-line-${index}`}
          >
            {line}
          </Text>
        ))}
      </View>
    </>
  );
}
