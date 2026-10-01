// PocketJS bundle fixture for end-to-end KM1 reducer and pixel checks.

import { batch, createSignal } from "solid-js";
import { mount } from "@pocketjs/framework";
import { View } from "@pocketjs/framework/components";
import { simulationHz } from "@pocketjs/framework/clock";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { createSession, startSession, stepSession, type SessionState } from "../../../src/engine/session.ts";
import { buildKm1Project } from "./project.ts";

export interface Km1MoveControlFixtureApi {
  state(): SessionState;
}

declare global {
  // eslint-disable-next-line no-var
  var __km1MoveControlFixture: Km1MoveControlFixtureApi | undefined;
}

const TILE = 16;
const colour = {
  field: "#111827",
  bounds: "#1f2937",
  blocked: "#ef4444",
  player: "#38bdf8",
  runner: "#22c55e",
  wanderer: "#e879f9",
  facing: "#fde047",
} as const;

function markerX(px: number, facing: number): number {
  if (facing === 1) return px;
  if (facing === 3) return px + 12;
  return px + 6;
}

function markerY(py: number, facing: number): number {
  if (facing === 2) return py;
  if (facing === 0) return py + 12;
  return py + 6;
}

function Km1MoveControlFixture() {
  const project = buildKm1Project();
  const session = createSession(project, simulationHz());
  let state = startSession(project, session);
  const [playerX, setPlayerX] = createSignal(state.move.px);
  const [playerY, setPlayerY] = createSignal(state.move.py);
  const [playerFacing, setPlayerFacing] = createSignal(state.move.facing);
  const [runnerX, setRunnerX] = createSignal(2 * TILE);
  const [runnerY, setRunnerY] = createSignal(6 * TILE);
  const [runnerFacing, setRunnerFacing] = createSignal(0);
  const [wanderX, setWanderX] = createSignal(8 * TILE);
  const [wanderY, setWanderY] = createSignal(4 * TILE);

  const publish = (): void => {
    const runner = state.chars.chars.runner;
    const wanderer = state.chars.chars.wanderer;
    batch(() => {
      setPlayerX(state.move.px);
      setPlayerY(state.move.py);
      setPlayerFacing(state.move.facing);
      setRunnerX(runner?.px ?? -TILE);
      setRunnerY(runner?.py ?? -TILE);
      setRunnerFacing(runner?.facing ?? 0);
      setWanderX(wanderer?.px ?? -TILE);
      setWanderY(wanderer?.py ?? -TILE);
    });
  };

  globalThis.__km1MoveControlFixture = { state: () => state };
  onFrame((buttons) => {
    state = stepSession(session, state, { buttons });
    publish();
  });

  return (
    <View class="w-full h-full overflow-hidden" style={{ bgColor: colour.field }} debugName="km1-field">
      <View
        class="absolute w-[48] h-[48]"
        style={{ posType: 1, insetL: 7 * TILE, insetT: 3 * TILE, bgColor: colour.bounds }}
        debugName="km1-wander-bounds"
      />
      <View
        class="absolute w-[16] h-[16]"
        style={{ posType: 1, insetL: 3 * TILE, insetT: 2 * TILE, bgColor: colour.blocked }}
        debugName="km1-player-blocker"
      />
      <View
        class="absolute w-[16] h-[16]"
        style={{ posType: 1, insetL: 3 * TILE, insetT: 6 * TILE, bgColor: colour.blocked }}
        debugName="km1-runner-blocker"
      />
      <View
        class="absolute w-[12] h-[12]"
        style={{ posType: 1, insetL: playerX() + 2, insetT: playerY() + 2, bgColor: colour.player }}
        debugName="km1-player"
      />
      <View
        class="absolute w-[4] h-[4]"
        style={{
          posType: 1,
          insetL: markerX(playerX(), playerFacing()),
          insetT: markerY(playerY(), playerFacing()),
          bgColor: colour.facing,
        }}
        debugName="km1-player-facing"
      />
      <View
        class="absolute w-[12] h-[12]"
        style={{ posType: 1, insetL: runnerX() + 2, insetT: runnerY() + 2, bgColor: colour.runner }}
        debugName="km1-runner"
      />
      <View
        class="absolute w-[4] h-[4]"
        style={{
          posType: 1,
          insetL: markerX(runnerX(), runnerFacing()),
          insetT: markerY(runnerY(), runnerFacing()),
          bgColor: colour.facing,
        }}
        debugName="km1-runner-facing"
      />
      <View
        class="absolute w-[12] h-[12]"
        style={{ posType: 1, insetL: wanderX() + 2, insetT: wanderY() + 2, bgColor: colour.wanderer }}
        debugName="km1-wanderer"
      />
    </View>
  );
}

mount(() => <Km1MoveControlFixture />);
