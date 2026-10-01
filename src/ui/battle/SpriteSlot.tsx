// src/ui/battle/SpriteSlot.tsx — KB4: one battler image, positioned and
// perturbed entirely from state. Base position, the active SpriteEffect
// descriptor and `nowTick` are all props; this component only calls the
// pure math in effects.ts and paints the result, so it holds no clock and
// two renders of the same props are pixel-identical (the rewind/multi-Hz
// contract every KB4 piece keeps).

import { LazyImage, type RpgImageSource, type TileTextureCache } from "../LazyImage.tsx";
import { faintPose, flashOpacity, shakeOffsetX, type SpriteEffect } from "./effects.ts";

export interface SpriteSlotProps {
  /** Legacy eager image key, or an on-demand TILESET image descriptor. */
  src: RpgImageSource;
  /** Top-left of the slot at rest, before any effect offset. */
  x: number;
  y: number;
  width: number;
  height: number;
  effect: Readonly<SpriteEffect>;
  nowTick: number;
  /** Mirror horizontally (a "facing" battler drawn from a single sheet). */
  flip?: boolean;
  shakeAmplitude?: number;
  faintSink?: number;
  zIndex?: number;
  debugName?: string;
  /** Share one cache across a battle to deduplicate and LRU-retain frames. */
  cache?: TileTextureCache;
  /** Pass BattleSceneViewProps.active for kept-alive battle subtrees. */
  active?: boolean;
}

export function SpriteSlot(props: SpriteSlotProps) {
  const dx = () => shakeOffsetX(props.effect, props.nowTick, props.shakeAmplitude);
  const flash = () => flashOpacity(props.effect, props.nowTick);
  const faint = () => faintPose(props.effect, props.nowTick, props.faintSink);
  const opacity = () => flash() * faint().opacity;

  return (
    <LazyImage
      class="absolute"
      src={props.src}
      cache={props.cache}
      active={props.active}
      style={{
        posType: 1,
        insetL: props.x + dx(),
        insetT: props.y + faint().sinkY,
        width: props.width,
        height: props.height,
        opacity: opacity(),
        scaleX: props.flip ? -1 : 1,
        zIndex: props.zIndex ?? 0,
      }}
      debugName={props.debugName}
    />
  );
}
