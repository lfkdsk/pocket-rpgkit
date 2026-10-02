import type { JSX } from "solid-js";
import type { AttractController, AttractRewindOptions } from "../engine/attract.ts";
import type { Session, SessionState } from "../engine/session.ts";
import type { ProjectSource } from "../engine/types.ts";
import type { UiTheme } from "./theme.ts";
import type { UiTextOverrides } from "../engine/ui-text.ts";

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
  /** `uiText` is the game's replacements of the kit's words (project
   *  `uiText` under GameView's prop); undefined when there are none. */
  render(theme?: Partial<UiTheme>, uiText?: UiTextOverrides): JSX.Element;
}

/** Opt-in factory kept outside ui/demo so the base GameView never reaches a
 * demo implementation, even in PocketJS's type-import-following pass. */
export interface GameViewDemoConfig {
  create(host: GameViewDemoHost): GameViewDemoRuntime;
  /** Rewind history limits for the attract controller GameView creates. */
  readonly rewind?: AttractRewindOptions;
}

/** The rewind knobs GameView forwards to its AttractController, picked
 *  field-by-field. A hand-built GameViewDemoConfig is only type-checked, so
 *  spreading it directly would let an extra `hz`, `maps` or `immutableState`
 *  key overwrite the trusted host options; this pick keeps the forwarding to
 *  exactly the four documented fields. */
export function attractRewindOptions(
  rewind: AttractRewindOptions | undefined,
): AttractRewindOptions | undefined {
  if (!rewind) return undefined;
  const out: AttractRewindOptions = {};
  if (rewind.rewindSeconds !== undefined) out.rewindSeconds = rewind.rewindSeconds;
  if (rewind.keyframeIntervalFrames !== undefined) out.keyframeIntervalFrames = rewind.keyframeIntervalFrames;
  if (rewind.keyframeMaxBytes !== undefined) out.keyframeMaxBytes = rewind.keyframeMaxBytes;
  if (rewind.keyframeMaxCount !== undefined) out.keyframeMaxCount = rewind.keyframeMaxCount;
  return out;
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
