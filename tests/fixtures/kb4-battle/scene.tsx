// tests/fixtures/kb4-battle/scene.tsx — a BattleSceneComponent built
// entirely from the KB4 primitives (src/ui/battle/): two SpriteSlots, two
// StatBars, a CommandGrid, a ListMenu for the skill submenu and a
// MessageBand for the beat text. It reads only `props.state` (the
// GameView `battleScene` contract, ui/GameView.tsx's BattleSceneViewProps)
// plus the live logical resolution — no signal here is seeded from
// anything but that JSON, so it satisfies the same "read-only reducer
// state" rule GameView's own comment documents for a game-owned scene.

import { Show } from "solid-js";
import { View } from "@pocketjs/framework/components";
import type { BattleSceneViewProps } from "../../../src/ui/GameView.tsx";
import {
  CommandGrid,
  FrameStrip,
  createBattleImageCache,
  ListMenu,
  MessageBand,
  StatBar,
  SpriteSlot,
  tweenAt,
  type CommandCell,
} from "../../../src/ui/battle/index.ts";
import {
  demoState,
  enemyEffect,
  enemyHpTween,
  messageRevealed,
  playerEffect,
  playerHpTween,
  SKILLS,
} from "./rules.ts";
import { KB4_ART } from "./assets-game.ts";

const SPRITE_SIZE = 64;
const FRAME_STRIP_FRAMES = [KB4_ART.player, KB4_ART.enemy] as const;

interface Kb4BattleSceneProps extends BattleSceneViewProps {
  /** Opt-in rendered probe for FrameStrip's transform and image updates. */
  frameStrip?: boolean;
}

export function Kb4BattleScene(props: Kb4BattleSceneProps) {
  const imageCache = createBattleImageCache(() => props.active, { maxEntries: 4 });
  const state = () => demoState(props.state);
  const nowTick = () => state().nowTick;
  const playerHp = () => tweenAt(playerHpTween(state()), nowTick());
  const enemyHp = () => tweenAt(enemyHpTween(state()), nowTick());
  const showCommand = () => state().phase === "command";
  const showSkills = () => state().phase === "skills";
  const message = () => state().message;

  const cells = (): readonly [CommandCell, CommandCell, CommandCell, CommandCell] => [
    { label: "Fight" },
    { label: "Skill" },
    { label: "Guard" },
    { label: "Run" },
  ];

  return (
    <View
      class="absolute"
      style={{ posType: 1, insetL: 0, insetT: 0, width: props.width, height: props.height, bgColor: "#101820" }}
      debugName="kb4-battle-scene"
    >
      <SpriteSlot
        src={KB4_ART.enemy}
        cache={imageCache}
        active={props.active}
        x={props.width - SPRITE_SIZE - 24}
        y={24}
        width={SPRITE_SIZE}
        height={SPRITE_SIZE}
        effect={enemyEffect(state())}
        nowTick={nowTick()}
        debugName="kb4-battle-enemy-sprite"
      />
      <View
        class="absolute"
        style={{ posType: 1, insetL: props.width - SPRITE_SIZE - 24, insetT: 12, width: SPRITE_SIZE }}
        debugName="kb4-battle-enemy-hud"
      >
        <StatBar
          current={enemyHp()}
          max={state().enemy.maxHp}
          width={SPRITE_SIZE}
          fill="#5fd66a"
          debugName="kb4-battle-enemy-hp"
        />
      </View>

      <SpriteSlot
        src={KB4_ART.player}
        cache={imageCache}
        active={props.active}
        x={24}
        y={props.height - SPRITE_SIZE - 72}
        width={SPRITE_SIZE}
        height={SPRITE_SIZE}
        effect={playerEffect(state())}
        nowTick={nowTick()}
        flip
        debugName="kb4-battle-player-sprite"
      />
      <View
        class="absolute"
        style={{ posType: 1, insetL: 24, insetT: props.height - SPRITE_SIZE - 88, width: SPRITE_SIZE }}
        debugName="kb4-battle-player-hud"
      >
        <StatBar
          current={playerHp()}
          max={state().player.maxHp}
          width={SPRITE_SIZE}
          showNumbers
          debugName="kb4-battle-player-hp"
        />
      </View>

      <Show when={props.frameStrip}>
        <FrameStrip
          frames={FRAME_STRIP_FRAMES}
          cache={imageCache}
          active={props.active}
          frameTicks={4}
          startTick={0}
          nowTick={nowTick()}
          loop
          x={201}
          y={73}
          width={32}
          height={32}
          debugName="kb4-battle-frame-strip"
        />
      </Show>

      <Show when={message().length > 0}>
        <MessageBand
          lines={message().split("\n")}
          revealed={messageRevealed(state())}
          legend="OK"
          width={props.width - 16}
          style={{ insetL: 8, insetB: 8 }}
          debugName="kb4-battle-message"
        />
      </Show>

      <Show when={showCommand()}>
        <CommandGrid
          cells={cells()}
          index={state().commandIndex}
          style={{ insetR: 8, insetB: 8 }}
          debugName="kb4-battle-commands"
        />
      </Show>

      <Show when={showSkills()}>
        <ListMenu
          title="Skills"
          rows={SKILLS.map((s) => ({ label: s.name, disabled: s.disabled, detail: `pow ${s.power}` }))}
          index={state().skillIndex}
          width={180}
          style={{ insetR: 8, insetB: 8 }}
          debugName="kb4-battle-skills"
        />
      </Show>
    </View>
  );
}
