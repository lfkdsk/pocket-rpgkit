// src/ui/battle/FrameStrip.tsx — KB4: a baked frame-strip animation player
// (a skill/impact effect authored as N separate pak images, e.g. a pak
// "frame strip"). The frame shown is `frameIndexAt(nowTick, ...)`
// (effects.ts) — a pure function of the caller's own reference-tick
// cursor — NOT a native auto-play sprite atlas: an atlas cycles off the
// host's vblank clock (see AnimatedTiles.tsx), which a save/rewind cannot
// carry, so a state-dependent effect must swap discrete image keys the
// same way PlayerSprite chooses a walk pose.

import { createMemo } from "solid-js";
import { LazyImage, type RpgImageSource, type TileTextureCache } from "../LazyImage.tsx";
import { frameIndexAt } from "./effects.ts";

export interface FrameStripProps {
  /** Baked frame image keys, in playback order. */
  frames: readonly RpgImageSource[];
  /** Reference ticks each frame holds. */
  frameTicks: number;
  startTick: number;
  nowTick: number;
  loop?: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex?: number;
  debugName?: string;
  cache?: TileTextureCache;
  active?: boolean;
}

export function FrameStrip(props: FrameStripProps) {
  const index = createMemo(() => props.frames.length <= 1 ? 0 :
    frameIndexAt(props.nowTick, props.startTick, props.frameTicks, props.frames.length, props.loop ?? false));
  const src = createMemo(() => props.frames[index()] ?? "");

  return (
    <LazyImage
      class="absolute"
      src={src()}
      cache={props.cache}
      active={props.active}
      style={{
        posType: 1,
        insetL: 0,
        insetT: 0,
        translateX: props.x,
        translateY: props.y,
        width: props.width,
        height: props.height,
        zIndex: props.zIndex ?? 0,
      }}
      debugName={props.debugName}
    />
  );
}
