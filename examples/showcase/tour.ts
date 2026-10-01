// Deterministic attract-tour recorder. It drives the same session reducer as
// the shipped game, visits every room, and returns through every room's
// exit. gen-assets.ts freezes the resulting 60 Hz masks as RLE data.

import { BTN } from "../../vendor/pocketjs/contracts/spec/spec.ts";
import {
  createSession,
  startSession,
  stepSession,
  type SessionOptions,
  type SessionState,
} from "../../src/engine/session.ts";
import type { Project } from "../../src/engine/types.ts";
import { tapeRunsFromMasks } from "../../src/engine/tape.ts";
import { SHOWCASE_HALLS } from "./showcase-data.ts";
import { HALL_EXIT, hallDoorPosition } from "./hall-kit.ts";

export interface ShowcaseTour {
  masks: number[];
  runs: [number, number][];
  visits: string[];
  final: SessionState;
}

const DOORS = SHOWCASE_HALLS.map((hall, index) => ({
  id: hall.id,
  ...hallDoorPosition(index, SHOWCASE_HALLS.length),
}));

/** Record against the 60 Hz reference timeline used by AttractController. */
export function recordShowcaseTour(
  project: Project,
  options: SessionOptions,
): ShowcaseTour {
  const session = createSession(project, 60, options);
  let state = startSession(project, session);
  const masks: number[] = [];
  const visits: string[] = [];

  const frame = (buttons = 0): void => {
    state = stepSession(session, state, { buttons });
    masks.push(buttons);
    if (state.interp.error) throw new Error(`showcase tour: ${state.interp.error.message}`);
  };
  const settle = (mapId: string): void => {
    for (let i = 0; i < 240; i++) {
      if (state.mapId === mapId && state.interp.main === null && state.fade === null && !state.move.moving) return;
      frame(0);
    }
    throw new Error(`showcase tour: ${mapId} did not settle`);
  };
  const moveAxis = (axis: "x" | "y", target: number, expectedMap: string): void => {
    for (let i = 0; i < 800; i++) {
      if (state.mapId !== expectedMap) return;
      const current = axis === "x" ? state.move.tx : state.move.ty;
      if (!state.move.moving && current === target) {
        frame(0);
        return;
      }
      const button = axis === "x"
        ? target > current ? BTN.RIGHT : BTN.LEFT
        : target > current ? BTN.DOWN : BTN.UP;
      frame(button);
    }
    throw new Error(
      `showcase tour: never reached ${axis}=${target} on ${expectedMap}; ` +
      `stopped at ${state.mapId}@${state.move.tx},${state.move.ty}`,
    );
  };
  const walkTo = (mapId: string, x: number, y: number): void => {
    // Horizontal first keeps the lobby route away from the central guide.
    moveAxis("x", x, mapId);
    if (state.mapId === mapId) moveAxis("y", y, mapId);
  };

  frame(0);
  for (const door of DOORS) {
    settle("showcase-lobby");
    walkTo("showcase-lobby", door.x, door.y);
    settle(door.id);
    visits.push(state.mapId);
    // Hall entry is beside the return doorway at the lower-left desk.
    walkTo(door.id, HALL_EXIT.x, HALL_EXIT.y);
    settle("showcase-lobby");
  }
  // A short final hold lets the tour badge and last fade read clearly.
  for (let i = 0; i < 120; i++) frame(0);
  return { masks, runs: tapeRunsFromMasks(masks), visits, final: state };
}
