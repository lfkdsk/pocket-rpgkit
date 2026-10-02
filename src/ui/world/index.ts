// Separate opt-in entry. Deliberately not re-exported as runtime values from
// ../index.ts, so ordinary GameView bundles cannot reach connected-world code.
export { createWorldRenderer } from "./renderer.tsx";
export { createWorldHandoffResolver } from "../../engine/world-handoff.ts";
export {
  WorldStreamedTerrain,
  type WorldStreamedTerrainBand,
  type WorldStreamedTerrainBandSource,
  type WorldStreamedTerrainProps,
  type WorldStreamedTerrainStats,
} from "../WorldStreamedTerrain.tsx";
export { WorldAnimatedTiles, type WorldAnimatedTilesProps } from "../WorldAnimatedTiles.tsx";
export type {
  GameViewWorldBand,
  GameViewWorldBandSource,
  GameViewWorldConfig,
  GameViewWorldFactoryHost,
  GameViewWorldFrame,
  GameViewWorldRenderProps,
  GameViewWorldRuntime,
  GameViewWorldViewport,
} from "../world-contract.ts";
