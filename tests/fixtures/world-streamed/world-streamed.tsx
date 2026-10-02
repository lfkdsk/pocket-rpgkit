import { mount } from "@pocketjs/framework";
import {
  GameView,
  type AnimatedTilesStats,
} from "../../../src/ui/index.ts";
import {
  createWorldRenderer,
  WorldStreamedTerrain,
  type WorldStreamedTerrainStats,
} from "../../../src/ui/world/index.ts";
import type { WorldComponent } from "../../../src/engine/types.ts";
import { GAME_ASSETS } from "./assets-game.ts";
import { WORLD_STREAMED_PROJECT } from "./fixture-data.ts";

export interface WorldStreamedFixtureStats {
  ground?: WorldStreamedTerrainStats;
  upper?: WorldStreamedTerrainStats;
  below?: AnimatedTilesStats;
  above?: AnimatedTilesStats;
}

declare global {
  // eslint-disable-next-line no-var
  var __worldStreamedCamera: { x: number; y: number } | undefined;
  // eslint-disable-next-line no-var
  var __worldStreamedStats: WorldStreamedFixtureStats | undefined;
  // eslint-disable-next-line no-var
  var __worldStreamedPreFrameCleanupReads: number | undefined;
}

// Regression probe: disposing the terrain subtree before its first frame must
// not re-read a parent accessor that has already become invalid.
let cleanupComponent: WorldComponent | undefined = WORLD_STREAMED_PROJECT.worldLayout!.components[0]!;
let cleanupReads = 0;
const disposeCleanupProbe = mount(() => (
  <WorldStreamedTerrain
    activeMapId={() => "a-northwest"}
    component={() => {
      cleanupReads++;
      return cleanupComponent!;
    }}
    visiblePlacements={() => []}
    camera={() => ({ x: 0, y: 0 })}
    viewport={() => ({ w: 480, h: 272 })}
    chunkPx={256}
    active={() => false}
    ground={{ refs: () => ({}), columns: () => ({}) }}
    upper={{ refs: () => ({}), columns: () => ({}) }}
    onStats={() => {}}
  />
));
cleanupComponent = undefined;
disposeCleanupProbe();
globalThis.__worldStreamedPreFrameCleanupReads = cleanupReads;

const stats: WorldStreamedFixtureStats = {};
globalThis.__worldStreamedStats = stats;

mount(() => (
  <GameView
    project={WORLD_STREAMED_PROJECT}
    assets={GAME_ASSETS}
    world={createWorldRenderer()}
    debugWorldCamera={() => globalThis.__worldStreamedCamera}
    onStreamStats={(layer, value) => { stats[layer] = value as WorldStreamedTerrainStats; }}
    onAnimatedStats={(layer, value) => { stats[layer] = value; }}
  />
));
