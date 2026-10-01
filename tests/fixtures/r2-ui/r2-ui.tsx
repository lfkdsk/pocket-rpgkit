import { mount } from "@pocketjs/framework";
import { Text, View } from "@pocketjs/framework/components";
import {
  GameView,
  type AnimatedTilesStats,
  type BattleSceneViewProps,
} from "../../../src/ui/index.ts";
import type { Project } from "../../../src/engine/types.ts";
import { toyBattleRules, toyState } from "../toy-battle.ts";
import { GAME_ASSETS } from "./assets-game.ts";
import { KV1_UI_PROJECT, R2_UI_PROJECT } from "./fixture-data.ts";

export interface R2UiStats {
  below?: AnimatedTilesStats;
  above?: AnimatedTilesStats;
}

declare global {
  // eslint-disable-next-line no-var
  var __r2UiStats: R2UiStats | undefined;
  // eslint-disable-next-line no-var
  var __r2Battle: boolean | undefined;
  // eslint-disable-next-line no-var
  var __r2BattleModal: boolean | undefined;
  // eslint-disable-next-line no-var
  var __r2TransparentBattle: boolean | undefined;
  // eslint-disable-next-line no-var
  var __r2BattleDelay: number | undefined;
  // eslint-disable-next-line no-var
  var __r2StaticBattle: boolean | undefined;
  // eslint-disable-next-line no-var
  var __r2FatalTransfer: boolean | undefined;
  // eslint-disable-next-line no-var
  var __r2Kv1: boolean | undefined;
  // eslint-disable-next-line no-var
  var __r2Rewind: boolean | undefined;
}

const stats: R2UiStats = {};
globalThis.__r2UiStats = stats;
const battleModalFixture = globalThis.__r2BattleModal === true;
const transparentBattleFixture = globalThis.__r2TransparentBattle === true;
const battleFixture = globalThis.__r2Battle === true || battleModalFixture;
const fatalTransferFixture = globalThis.__r2FatalTransfer === true;
// KB6 bench: keep the world steady-mounted for this many seconds before the
// autorun battle opens, so the entry frame is measured against a warm world.
const battleDelay = Math.max(0, globalThis.__r2BattleDelay ?? 0);
const staticBattleFixture = globalThis.__r2StaticBattle === true;
const kv1Fixture = globalThis.__r2Kv1 === true;
const rewindFixture = globalThis.__r2Rewind === true;
globalThis.__r2Battle = undefined;
globalThis.__r2BattleModal = undefined;
globalThis.__r2TransparentBattle = undefined;
globalThis.__r2BattleDelay = undefined;
globalThis.__r2StaticBattle = undefined;
globalThis.__r2FatalTransfer = undefined;
globalThis.__r2Kv1 = undefined;
globalThis.__r2Rewind = undefined;

const project: Project = kv1Fixture
  ? KV1_UI_PROJECT
  : battleFixture
  ? {
      ...R2_UI_PROJECT,
      maps: R2_UI_PROJECT.maps.map((map, index) => index === 0
        ? {
            ...map,
            events: [
              ...(battleModalFixture ? [{
                id: "battle-modal-fixture",
                x: 2,
                y: 2,
                pages: [{
                  trigger: "parallel" as const,
                  commands: [{
                    op: "choices" as const,
                    prompt: "PARKED MAP CHOICE",
                    options: [
                      { text: "Wait here", commands: [] },
                      { text: "Keep waiting", commands: [] },
                    ],
                  }],
                }],
              }] : []),
              {
              id: "battle-scene-fixture",
              x: 1,
              y: 1,
              pages: [
                {
                  trigger: "autorun" as const,
                  commands: [
                    ...(battleDelay > 0 ? [{ op: "wait" as const, seconds: battleDelay }] : []),
                    {
                      op: "battle" as const,
                      setup: { enemyHp: 1 },
                      onWin: [{ op: "switch" as const, id: "battle-ui-won", value: true }],
                    }, { op: "switch" as const, id: "battle-ui-done", value: true }],
                },
                {
                  condition: { switch: "battle-ui-done" },
                  trigger: "action" as const,
                  commands: [],
                },
              ],
              },
              ...(staticBattleFixture ? [] : map.events ?? []),
            ],
          }
        : map),
    }
  : fatalTransferFixture
    ? {
        ...R2_UI_PROJECT,
        maps: R2_UI_PROJECT.maps.map((map, index) => index === 0
          ? {
              ...map,
              events: [{
                id: "fatal-transfer",
                x: 1,
                y: 1,
                pages: [{
                  trigger: "autorun" as const,
                  commands: [{
                    op: "transfer" as const,
                    map: { variable: "missing.map" },
                    x: 1,
                    y: 1,
                  }],
                }],
              }, ...(map.events ?? [])],
            }
          : map),
      }
  : R2_UI_PROJECT;

function ToyBattleScene(props: BattleSceneViewProps) {
  const state = () => toyState(props.state);
  return (
    <View
      class="absolute flex-col items-center justify-center"
      style={{
        posType: 1,
        insetL: 0,
        insetT: 0,
        width: props.width,
        height: props.height,
        bgColor: "#39164f",
        ...(transparentBattleFixture ? { opacity: 0.6 } : {}),
      }}
      debugName="toy-battle-scene"
    >
      <Text class="text-xl" style={{ textColor: "#ffffff", height: 28, lineHeight: 28 }}>
        TOY BATTLE
      </Text>
      <Text class="text-sm" style={{ textColor: "#ffe17a", height: 20, lineHeight: 20 }}>
        {`HP ${state().playerHp} - ${state().enemyHp}`}
      </Text>
      <Text class="text-xs" style={{ textColor: "#9ddcff", height: 16, lineHeight: 16 }}>
        {`${props.width}x${props.height}`}
      </Text>
    </View>
  );
}

mount(() => (
  <GameView
    project={project}
    assets={GAME_ASSETS}
    battle={toyBattleRules}
    battleScene={ToyBattleScene}
    attractTape={rewindFixture ? [] : undefined}
    onAnimatedStats={(layer, value) => {
      stats[layer] = value;
    }}
  />
));
