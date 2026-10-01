// src/ui/index.ts — Solid presentation components. Every component is pure
// presentation driven by engine reducer state; the host app owns signals and
// side effects.

export { DialogBox, type DialogBoxProps } from "./DialogBox.tsx";
export { Panel, type PanelProps } from "./Panel.tsx";
export {
  DEFAULT_UI_THEME,
  resolveUiTheme,
  speakerLabel,
  splitSpeaker,
  type SpeakerSplit,
  type UiTheme,
} from "./theme.ts";
export { PlayerSprite, playerImageKey, type PlayerFrames, type PlayerSpriteProps } from "./PlayerSprite.tsx";
export { SaveMenu, type SlotInfo, type SaveMenuProps } from "./SaveMenu.tsx";
export { ChunkLayer, type ChunkLayerProps } from "./ChunkLayer.tsx";
export {
  StreamedChunkLayer,
  type StreamedChunkLayerProps,
  type StreamedChunkLayerStats,
} from "./StreamedChunkLayer.tsx";
export { AnimatedTiles, type AnimatedTilesProps, type AnimatedTilesStats } from "./AnimatedTiles.tsx";
export { MapAnimLayer, type MapAnimLayerProps, type MapAnimStats } from "./MapAnimLayer.tsx";
export {
  BalloonLayer,
  balloonFrameIndex,
  type BalloonAnchor,
  type BalloonLayerProps,
} from "./BalloonLayer.tsx";
export {
  ScreenEffectsLayer,
  ScreenFadeLayer,
  screenColorHex,
  type ScreenEffectsLayerProps,
} from "./ScreenEffectsLayer.tsx";
export {
  GameView,
  type ActorRenderStats,
  type ActorPoolStats,
  type BattleSceneComponent,
  type BattleSceneViewProps,
  type GameEffectsComponent,
  type GameEffectsProps,
  type GameViewProps,
  type SceneComponent,
} from "./GameView.tsx";
export { NameInputScene, type NameInputSceneProps } from "./name-input/NameInputScene.tsx";
export type {
  AnimatedTile,
  CharacterFrames,
  EagerMapLayerVariant,
  GameAssets,
  GameMapLayerAssets,
  GameScreenLayerAssets,
  GameVisualLayerAssets,
  MapLayerVariant,
  NpcArt,
  ScreenLayerVariant,
  StreamedGameAssets,
  StreamedMapLayerVariant,
} from "./game-assets.ts";
