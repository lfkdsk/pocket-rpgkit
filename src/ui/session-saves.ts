// src/ui/session-saves.ts — save and load the session a GameView is running.
//
// A game's overlay (GameViewProps.overlay) receives a GameViewSessionHost.
// These helpers pair it with the engine's structured save/load: a load
// decodes and validates the save, rebuilds reducer state for its map and
// only then replaces the running session, so a refused save leaves the game
// untouched. Neither path starts an attract controller, so live play keeps
// L rewind off.

import type { SaveSnapshot } from "../engine/save.ts";
import {
  loadSession,
  saveSession,
  type SessionLoadResult,
  type SessionSaveResult,
} from "../engine/save-restore.ts";
import type { GameViewSessionHost } from "./demo-contract.ts";

/** Snapshot the running session, or `not-safe-point` when this frame is not
 * a save point. Encode the snapshot with encodeEnvelope / encodeSaveCode. */
export function saveFromView(host: GameViewSessionHost): SessionSaveResult {
  return saveSession(host.session, host.getState(), host.heldButtons());
}

/** Load a snapshot, envelope text or save code into the running view. On
 * failure the running session is untouched and `error.code` says why. */
export function loadIntoView(host: GameViewSessionHost, input: SaveSnapshot | string): SessionLoadResult {
  const result = loadSession(host.session, input);
  if (result.ok) host.replaceState(result.state, result.held);
  return result;
}
