import type { JSX } from "solid-js";
import type { AttractController } from "../engine/attract.ts";
import type { Session, SessionState } from "../engine/session.ts";
import type { ProjectSource } from "../engine/types.ts";
import type { UiTheme } from "./theme.ts";

/** Stable host surface available to an opt-in GameView demo runtime. */
export interface GameViewDemoHost {
  readonly project: ProjectSource;
  readonly session: Session;
  readonly attract: AttractController;
  readonly getState: () => SessionState;
}

export interface GameViewDemoStepResult {
  /** Skip the ordinary attract/session fold for this host frame. */
  readonly consumed: boolean;
  /** The runtime replaced attract.state; GameView must present it immediately. */
  readonly stateChanged?: boolean;
}

/** A demo runtime owns only demo transport/menu state; AttractController owns
 * the deterministic game timeline. A state-changing step must be consumed so
 * the freshly restored state is not folded again in the same host frame. */
export interface GameViewDemoRuntime {
  step(buttons: number, pressed: number): GameViewDemoStepResult;
  isOpen(): boolean;
  render(theme?: Partial<UiTheme>): JSX.Element;
}

/** Opt-in factory kept outside ui/demo so the base GameView never reaches a
 * demo implementation, even in PocketJS's type-import-following pass. */
export interface GameViewDemoConfig {
  create(host: GameViewDemoHost): GameViewDemoRuntime;
}

/** Live-session access for a game's own overlay (a save/load menu, a debug
 * panel). Unlike the demo host it creates no attract controller, so an
 * overlay leaves L rewind and idle attract off. */
export interface GameViewSessionHost {
  readonly project: ProjectSource;
  readonly session: Session;
  readonly getState: () => SessionState;
  /** Button mask folded into the reducer on the latest frame (the attract
   * tape's mask while a demo plays): the `held` of a save taken now. */
  readonly heldButtons: () => number;
  /** Replace the running session, presented on the next host frame without
   * folding a world tick (or immediately when called from `step`, which
   * must then report `stateChanged`). `held` seeds the previous button mask
   * under an attract tape; live play continues from the real buttons.
   * `loadSession` (engine/save-restore.ts) produces a valid state from a
   * save; `loadIntoView` (ui/session-saves.ts) does both in one call. */
  readonly replaceState: (next: SessionState, held?: number) => void;
}

/** Opt-in overlay runtime with live-session access. It shares the demo
 * runtime contract: a consumed step folds no reducer input. */
export interface GameViewOverlayConfig {
  create(host: GameViewSessionHost): GameViewDemoRuntime;
}
