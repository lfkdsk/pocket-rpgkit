// Read-only battle presentation for showcase hall 6. The pure reducer lives
// in showcase-battle-rules.ts so build-time tools can use it without JSX.

import { Image, Text, View } from "@pocketjs/framework/components";
import type { BattleSceneViewProps } from "../../src/ui/GameView.tsx";
import {
  CommandGrid,
  MessageBand,
  NO_EFFECT,
  SpriteSlot,
  StatBar,
  type CommandCell,
  type SpriteEffect,
} from "../../src/ui/battle/index.ts";
import { SHOWCASE_ART } from "./assets-game.ts";
import {
  showcaseBattleState,
  type ShowcaseBattleState,
} from "./showcase-battle-rules.ts";

const COMMANDS: readonly [CommandCell, CommandCell, CommandCell, CommandCell] = [
  { label: "Strike" },
  { label: "Yield" },
  { label: "Guard" },
  { label: "Run" },
];

function revealed(state: Readonly<ShowcaseBattleState>): number {
  return Math.max(0, Math.min(state.message.length, state.nowTick - state.messageStart));
}

function enemyEffect(state: Readonly<ShowcaseBattleState>): Readonly<SpriteEffect> {
  if (state.enemyHp === 0) return { kind: "faint", startTick: state.messageStart, duration: 24 };
  if (state.phase === "message" && state.pending === null) {
    return { kind: "shake", startTick: state.messageStart, duration: 18 };
  }
  return NO_EFFECT;
}

function playerEffect(state: Readonly<ShowcaseBattleState>): Readonly<SpriteEffect> {
  if (state.playerHp === 0) return { kind: "faint", startTick: state.messageStart, duration: 24 };
  if (state.phase === "message" && state.pending === null) {
    return { kind: "flash", startTick: state.messageStart + 6, duration: 12 };
  }
  return NO_EFFECT;
}

export function ShowcaseBattleScene(props: BattleSceneViewProps) {
  const state = () => showcaseBattleState(props.state);
  return (
    <View
      class="absolute"
      style={{ posType: 1, insetL: 0, insetT: 0, width: props.width, height: props.height, bgColor: "#101827" }}
      debugName="showcase-battle-scene"
    >
      <Image
        src={SHOWCASE_ART.battleBackground}
        class="absolute w-full h-full"
        style={{ posType: 1, insetL: 0, insetT: 0, opacity: 0.72 }}
        debugName="showcase-battle-background"
      />
      <Text
        class="text-lg"
        style={{ posType: 1, insetL: 18, insetT: 14, textColor: "#ffe97a", height: 24, lineHeight: 24 }}
      >
        TUXEMON TRAINING ARENA
      </Text>

      <SpriteSlot
        src={SHOWCASE_ART.battleEnemy}
        x={props.width - 98}
        y={44}
        width={64}
        height={64}
        effect={enemyEffect(state())}
        nowTick={state().nowTick}
        debugName="showcase-battle-enemy"
      />

      <View class="absolute flex-col" style={{ posType: 1, insetL: props.width - 190, insetT: 112, width: 170 }}>
        <Text class="text-sm" style={{ textColor: "#dce8ff", height: 18, lineHeight: 18 }}>WILD BAMBOON</Text>
        <StatBar current={state().enemyHp} max={state().enemyMaxHp} width={150} fill="#ef6a78" showNumbers />
      </View>

      <SpriteSlot
        src={SHOWCASE_ART.battlePlayer}
        x={28}
        y={props.height - 170}
        width={64}
        height={64}
        effect={playerEffect(state())}
        nowTick={state().nowTick}
        flip
        debugName="showcase-battle-player"
      />

      <View class="absolute flex-col" style={{ posType: 1, insetL: 20, insetT: props.height - 103, width: 190 }}>
        <Text class="text-sm" style={{ textColor: "#dce8ff", height: 18, lineHeight: 18 }}>BIGFIN</Text>
        <StatBar current={state().playerHp} max={state().playerMaxHp} width={150} fill="#63d39a" showNumbers />
      </View>

      {state().phase === "command" ? (
        <CommandGrid
          cells={COMMANDS}
          index={state().commandIndex}
          style={{ insetR: 8, insetB: 8 }}
          debugName="showcase-battle-commands"
        />
      ) : state().phase === "message" ? (
        <MessageBand
          lines={state().message.split("\n")}
          revealed={revealed(state())}
          legend="OK"
          width={props.width - 16}
          style={{ insetL: 8, insetB: 8 }}
          debugName="showcase-battle-message"
        />
      ) : null}
    </View>
  );
}
