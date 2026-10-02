// tests/fixtures/rmi-play/placeholder-scene.tsx — full-screen view of the
// placeholder battle (placeholder-battle.ts): the troop name and the
// outcome rows, drawn only from the reducer state.

import { For } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import type { BattleSceneViewProps } from "../../../src/ui/GameView.tsx";
import { placeholderState } from "./placeholder-battle.ts";

const LABELS: Record<string, string> = { win: "Win", escape: "Escape", lose: "Lose", draw: "Draw" };

export function PlaceholderBattleScene(props: BattleSceneViewProps) {
  const state = () => placeholderState(props.state);
  return (
    <View
      class="absolute flex-col items-center justify-center"
      style={{ posType: 1, insetL: 0, insetT: 0, width: props.width, height: props.height, bgColor: "#1b1430" }}
      debugName="rmi-battle"
    >
      <Text class="text-xs" style={{ textColor: "#f0d080", lineHeight: 16, height: 16 }} debugName="rmi-battle-title">
        Battle placeholder
      </Text>
      <Text class="text-xs" style={{ textColor: "#ffffff", lineHeight: 16, height: 16 }} debugName="rmi-battle-name">
        {`A battle against ${state().name} would happen here.`}
      </Text>
      <View class="flex-col" style={{ height: 8 }} />
      <For each={state().options}>
        {(option, i) => (
          <Text
            class="text-xs"
            style={{ textColor: i() === state().index ? "#ffe060" : "#9aa0b8", lineHeight: 16, height: 16 }}
            debugName={`rmi-battle-row-${i()}`}
          >
            {`${i() === state().index ? "> " : "  "}${LABELS[option] ?? option}`}
          </Text>
        )}
      </For>
    </View>
  );
}
