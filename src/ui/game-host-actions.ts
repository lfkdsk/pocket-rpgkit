// Host-owned lifecycle effects requested by event commands. Kept separate
// from optional KRM2 presentation so every GameView can deliver menu/save/
// title requests without importing numbered-picture or HUD code.

import type { HostAction } from "../engine/interpreter.ts";
import type { GameViewSessionHost } from "./demo-contract.ts";

/** Each callback receives the same session facade used by opt-in overlays. */
export interface GameViewHostCallbacks {
  menu?: (host: GameViewSessionHost) => void;
  save?: (host: GameViewSessionHost) => void;
  gameOver?: (host: GameViewSessionHost) => void;
  title?: (host: GameViewSessionHost) => void;
}

/** Dispatch one reducer frame's requests in authored order, including
 * repeated actions. Omitted callbacks are deterministic no-ops. */
export function dispatchGameViewHostActions(
  actions: readonly HostAction[] | undefined,
  callbacks: Readonly<GameViewHostCallbacks> | undefined,
  host: GameViewSessionHost,
): void {
  if (!callbacks) return;
  for (const action of actions ?? []) callbacks[action]?.(host);
}
