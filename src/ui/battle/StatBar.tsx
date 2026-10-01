// src/ui/battle/StatBar.tsx — KB4: an HP/XP bar. The fill width is a pure
// function of the `current`/`max` props (typically computed by the caller
// from a Tween via effects.ts's tweenAt against its own reference-tick
// cursor), so replaying the same state at any tick, Hz, or after an
// L-rewind paints the same width.

import { Text, View } from "@pocketjs/framework/components";
import { createMemo } from "solid-js";
import { resolveUiTheme, type UiTheme } from "../theme.ts";
import { barFillWidth } from "./effects.ts";

export interface StatBarProps {
  /** Current value, already the tweened point-in-time number (not clamped
   *  by this component: a caller mid-tween may pass a fractional value). */
  current: number;
  max: number;
  width: number;
  height?: number;
  /** Fill colour; defaults to the theme's accent. */
  fill?: string;
  /** Track (empty) colour; defaults to the theme's border. */
  track?: string;
  theme?: Partial<UiTheme>;
  /** "137 / 220" readout to the bar's right. Omit for a bare bar. */
  showNumbers?: boolean;
  /** Fixed readout cell for paint-only number changes in a reserved HUD area. */
  numbersWidth?: number;
  debugName?: string;
}

const BAR_HEIGHT = 6;

export function StatBar(props: StatBarProps) {
  const theme = createMemo(() => resolveUiTheme(props.theme));
  const height = () => props.height ?? BAR_HEIGHT;
  const fillScale = createMemo(() => props.width > 0
    ? barFillWidth(props.current, props.max, props.width) / props.width
    : 0);

  return (
    <View class="flex-row items-center" debugName={props.debugName}>
      <View
        class="flex-row"
        style={{ width: props.width, height: height(), bgColor: props.track ?? theme().border }}
        debugName={props.debugName ? `${props.debugName}-track` : undefined}
      >
        <View
          style={{
            width: props.width,
            height: height(),
            bgColor: props.fill ?? theme().accent,
            scaleX: fillScale(),
            originX: -0.5,
          }}
          debugName={props.debugName ? `${props.debugName}-fill` : undefined}
        />
      </View>
      {props.showNumbers ? (
        <Text
          class="text-xs"
          style={{
            textColor: theme().ink,
            lineHeight: 14,
            height: 14,
            insetL: 6,
            ...(props.numbersWidth === undefined ? {} : { width: props.numbersWidth }),
          }}
          debugName={props.debugName ? `${props.debugName}-numbers` : undefined}
        >
          {`${Math.max(0, Math.round(props.current))} / ${Math.round(props.max)}`}
        </Text>
      ) : null}
    </View>
  );
}
