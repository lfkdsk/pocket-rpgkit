import { mount } from "@pocketjs/framework";
import { GameView, type StreamedChunkLayerStats } from "../../../src/ui/index.ts";
import { GAME_ASSETS } from "./assets-game.ts";
import { STREAMED_KV1_PROJECT, STREAMED_PROJECT } from "./fixture-data.ts";

export interface StreamedFixtureStats {
  ground?: StreamedChunkLayerStats;
  upper?: StreamedChunkLayerStats;
}

declare global {
  // eslint-disable-next-line no-var
  var __streamedFixtureStats: StreamedFixtureStats | undefined;
  // eslint-disable-next-line no-var
  var __streamedLoadBudget: number | undefined;
  // eslint-disable-next-line no-var
  var __streamedKv1: boolean | undefined;
}

const stats: StreamedFixtureStats = {};
globalThis.__streamedFixtureStats = stats;
if (globalThis.__streamedLoadBudget !== undefined) {
  GAME_ASSETS.stream!.loadBudget = globalThis.__streamedLoadBudget;
}
globalThis.__streamedLoadBudget = undefined;
const project = globalThis.__streamedKv1 === true ? STREAMED_KV1_PROJECT : STREAMED_PROJECT;
globalThis.__streamedKv1 = undefined;

mount(() => (
  <GameView
    project={project}
    assets={GAME_ASSETS}
    onStreamStats={(layer, value) => {
      stats[layer] = value;
    }}
  />
));
