import { mount } from "@pocketjs/framework";
import { Text, View } from "@pocketjs/framework/components";
import {
  GameView,
  type BattleSceneViewProps,
  type StreamedChunkLayerStats,
} from "../../../src/ui/index.ts";
import { GAME_ASSETS } from "./assets-game.ts";
import { toyBattleRules } from "../toy-battle.ts";
import { STREAMED_BATTLE_PROJECT, STREAMED_KV1_PROJECT, STREAMED_PROJECT } from "./fixture-data.ts";

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
  // eslint-disable-next-line no-var
  var __streamedBattle: boolean | undefined;
}

const stats: StreamedFixtureStats = {};
globalThis.__streamedFixtureStats = stats;
if (globalThis.__streamedLoadBudget !== undefined) {
  GAME_ASSETS.stream!.loadBudget = globalThis.__streamedLoadBudget;
}
globalThis.__streamedLoadBudget = undefined;
const battle = globalThis.__streamedBattle === true;
const project = battle
  ? STREAMED_BATTLE_PROJECT
  : globalThis.__streamedKv1 === true
    ? STREAMED_KV1_PROJECT
    : STREAMED_PROJECT;
globalThis.__streamedKv1 = undefined;
globalThis.__streamedBattle = undefined;

function StreamBattleScene(props: BattleSceneViewProps) {
  return (
    <View
      class="absolute flex-col items-center justify-center"
      style={{ width: props.width, height: props.height, bgColor: "#39164f" }}
      debugName="stream-battle-scene"
    >
      <Text>STREAM BATTLE</Text>
    </View>
  );
}

mount(() => (
  <GameView
    project={project}
    assets={GAME_ASSETS}
    battle={battle ? toyBattleRules : undefined}
    battleScene={battle ? StreamBattleScene : undefined}
    onStreamStats={(layer, value) => {
      stats[layer] = value;
    }}
  />
));
