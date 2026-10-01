// src/ui/battle/index.ts — KB4 battle UI kit: state-driven, rewindable
// presentation components for a game's BattleSceneComponent (GameView's
// `battleScene` prop, engine/battle.ts). Every export here is a pure
// function of its props; none holds a clock, a signal not derived from
// props, or any reference to SessionState beyond what the caller passes
// in. A game that never registers a `battle`/`battleScene` pair never
// imports this module, so it never reaches that game's bundle.

export {
  barFillWidth,
  faintPose,
  flashOpacity,
  frameIndexAt,
  NO_EFFECT,
  progress,
  shakeOffsetX,
  tweenAt,
  windowDone,
  type EffectKind,
  type FaintPose,
  type SpriteEffect,
  type Tween,
} from "./effects.ts";
export { StatBar, type StatBarProps } from "./StatBar.tsx";
export { CommandGrid, type CommandCell, type CommandGridProps } from "./CommandGrid.tsx";
export { ListMenu, type ListMenuRow, type ListMenuProps } from "./ListMenu.tsx";
export { MessageBand, type MessageBandProps } from "./MessageBand.tsx";
export { SpriteSlot, type SpriteSlotProps } from "./SpriteSlot.tsx";
export { FrameStrip, type FrameStripProps } from "./FrameStrip.tsx";
export { createBattleImageCache } from "./image-cache.ts";
export {
  LazyImage,
  TileTextureCache,
  type LazyImageProps,
  type RpgImageSource,
  type TileImageSource,
  type TileTextureCacheOptions,
  type TileTextureCacheStats,
} from "../LazyImage.tsx";
