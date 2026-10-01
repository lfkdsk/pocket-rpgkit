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
