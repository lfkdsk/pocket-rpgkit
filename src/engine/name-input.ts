// src/engine/name-input.ts — the built-in name-input scene.
//
// A generic, MV-style "Name Input Processing" scene the game registers like
// battle rules: an event opens it with `{ op: "scene", id: NAME_INPUT_SCENE_ID,
// args: {...} }`, the player edits a buffer on a charset grid, and the result
// writes a variable or the player name. It is a deliberately generic
// simplification, not a byte-for-byte port of either RPG Maker MV or Tuxemon:
//
// - Cancel closes the scene and runs onCancel (MV's Name Input maps the back
//   key to delete-char and restores the entry default on an empty confirm;
//   neither is implemented here). `swallowCancel: true` instead swallows the
//   cancel key, matching Tuxemon's InputMenu opened with escape_key_exits=False
//   (rename_player/rename_monster).
// - The buffer prefills from the live variable/player-name value, or from
//   `default`. Tuxemon's player rename starts empty and its monster rename
//   starts from the translated species name; adapters pass `default` to match.
// - `maxLength` clamps to 1..24 (Tuxemon uses 15 via char_limit). An empty
//   commit is refused unless `allowEmpty` is set with a variable target.
// - Held-key repeat is 30/6 reference ticks (0.50 s / 0.10 s); Tuxemon uses
//   0.50 s / 0.08 s. The schedule is on the reference clock, so the cursor is
//   identical at 60/30/20/4 Hz for the same virtual time.
//
// Pure reducer: every visual fact (buffer, cursor, charset, held-key
// repeat) lives in the JSON state, so replay/rewind reproduce the same
// screen.

import { deepClone } from "./clone.ts";
import type { ExtensionReadContext } from "./extensions.ts";
import type { SceneCompletion, SceneRules, SceneStart } from "./scene.ts";
import type { JsonValue } from "./types.ts";

export const NAME_INPUT_SCENE_ID = "rpgkit.nameInput";

/** Held-key repeat: after REPEAT_DELAY reference ticks, the cursor moves
 *  every REPEAT_RATE ticks while a direction stays held. */
const REPEAT_DELAY = 30;
const REPEAT_RATE = 6;

const DEFAULT_MAX_LENGTH = 8;
const DEFAULT_COLUMNS = 10;
const DEFAULT_TITLE = "Name";
/** 67 chars + BACK/OK/CANCEL = 70 entries = a neat 7×10 grid. */
const DEFAULT_CHARSET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'-.!?";

const ACTION_COUNT = 3;
/** Action entries follow the charset: BACK, OK, CANCEL. */
export const NAME_INPUT_ACTION_BACK = 0;
export const NAME_INPUT_ACTION_OK = 1;
export const NAME_INPUT_ACTION_CANCEL = 2;

export interface NameInputArgs {
  /** Variable id to write the committed name to. Omitted → write the
   *  player name (sw.playerName, the {name} text token). */
  variable?: string;
  /** Buffer capacity. Default 8 (MV); clamped to 1..24 (the save-validated
   *  player-name range; Tuxemon uses 15). */
  maxLength?: number;
  /** Initial buffer. Overrides the live prefill (the variable's current
   *  string value, or the current player name). Truncated to maxLength. */
  default?: string;
  /** Caption above the edit box. Default "Name". */
  title?: string;
  /** Flat single-character table. Defaults to A-Z a-z 0-9 '-.!? (67 chars). */
  charset?: string[];
  /** Grid columns. Default 10. */
  columns?: number;
  /** Allow committing an empty buffer. Only meaningful with `variable`;
   *  a player name must stay non-empty (saves require 1..24 chars). */
  allowEmpty?: boolean;
  /** Swallow the cancel key (physical cancel and the grid CANCEL action)
   *  instead of closing the scene, matching Tuxemon's InputMenu opened with
   *  escape_key_exits=False (rename_player/rename_monster). Default false:
   *  cancel closes the scene and runs onCancel. */
  swallowCancel?: boolean;
}

export interface NameInputState {
  buffer: string;
  /** Index into entries: [0, charset.length) chars, then BACK/OK/CANCEL. */
  cursor: number;
  charset: string[];
  columns: number;
  rows: number;
  maxLength: number;
  title: string;
  variable: string | null;
  allowEmpty: boolean;
  phase: "edit" | "done";
  cancelled: boolean;
  swallowCancel: boolean;
  /** Held-direction repeat bookkeeping: BTN direction bit + ticks held. */
  holdDir: number;
  holdTicks: number;
  lastButtons: number;
  ext: JsonValue;
}

function record(value: JsonValue): Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}

function normalizeCharset(value: JsonValue): string[] {
  if (Array.isArray(value)) {
    // Keep only printable single code units: every non-printable code point
    // is dropped, not just C0/C1 and DEL — format characters (zero-width,
    // BOM), line/paragraph separators, private-use, unassigned and surrogate
    // code units would all render an invisible or line-breaking grid cell
    // (Tuxemon renders NUL as a disabled cell, never a writable char), so a
    // custom charset cannot smuggle one into the buffer or the grid.
    const chars = value.filter((c): c is string =>
      typeof c === "string" && c.length === 1 && isPrintableChar(c));
    if (chars.length > 0) return chars;
  }
  return DEFAULT_CHARSET.split("");
}

// A single UTF-16 code unit is printable only when its code point is outside
// Unicode's C* categories (Cc controls, Cf format, Cs surrogates, Co private
// use, Cn unassigned) and not a line (Zl) or paragraph (Zp) separator. Space
// separators (Zs, e.g. U+0020 and U+00A0) render a visible cell and stay.
const NON_PRINTABLE_CODEUNIT = /[\p{C}\p{Zl}\p{Zp}]/u;

function isPrintableChar(c: string): boolean {
  return !NON_PRINTABLE_CODEUNIT.test(c);
}

/** Clamp an integer argument into [min, max]; a non-integer or a non-number
 *  falls back to `fallback`. Unlike a membership test, an out-of-range
 *  integer clamps to the nearest bound (25 -> 24, 0 -> 1). */
function clampArgInt(value: JsonValue, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function clampInt(value: JsonValue, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

function prefill(args: Record<string, JsonValue>, ctx: ExtensionReadContext, maxLength: number): string {
  const source = typeof args.default === "string"
    ? args.default
    : typeof args.variable === "string"
      ? ctx.variables[args.variable]
      : ctx.playerName;
  const text = typeof source === "string" ? source : "";
  return text.slice(0, maxLength);
}

function stateOf(value: JsonValue): NameInputState {
  return value as unknown as NameInputState;
}

function moveCursor(state: NameInputState, delta: number): void {
  const total = state.charset.length + ACTION_COUNT;
  state.cursor = (state.cursor + delta + total) % total;
}

/** The built-in name-input SceneRules. Register it as
 *  `{ [NAME_INPUT_SCENE_ID]: nameInputRules }` in createSession's `scenes`
 *  and `NameInputScene` in GameView's `sceneViews`. */
export const nameInputRules: SceneRules = {
  start(ext, rawArgs, _seed, ctx): SceneStart {
    const args = record(rawArgs);
    const maxLength = clampArgInt(args.maxLength, 1, 24, DEFAULT_MAX_LENGTH);
    const columns = clampInt(args.columns, 1, 20, DEFAULT_COLUMNS);
    const charset = normalizeCharset(args.charset);
    const variable = typeof args.variable === "string" && args.variable.length > 0
      ? args.variable
      : null;
    const state: NameInputState = {
      buffer: prefill(args, ctx, maxLength),
      cursor: 0,
      charset,
      columns,
      rows: Math.ceil((charset.length + ACTION_COUNT) / columns),
      maxLength,
      title: typeof args.title === "string" && args.title.length > 0 ? args.title : DEFAULT_TITLE,
      variable,
      allowEmpty: args.allowEmpty === true,
      swallowCancel: args.swallowCancel === true,
      phase: "edit",
      cancelled: false,
      holdDir: 0,
      holdTicks: 0,
      lastButtons: 0,
      ext: deepClone(ext),
    };
    return { ext: deepClone(ext), state: state as unknown as JsonValue };
  },

  step(rawState, input, ticks): JsonValue {
    const state = stateOf(rawState);
    if (state.phase !== "edit") return rawState;
    const buttons = input.buttons >>> 0;
    state.lastButtons = buttons;

    if (input.cancelEdge === true) {
      // swallowCancel (Tuxemon escape_key_exits=False): the cancel key is
      // consumed but does not close the scene.
      if (!state.swallowCancel) {
        state.phase = "done";
        state.cancelled = true;
      }
      return rawState;
    }

    // Edge navigation (one move per press). Direction bits match the
    // pocket button contract (UP 0x10, RIGHT 0x20, DOWN 0x40, LEFT 0x80).
    const dirDelta = (dir: number): number =>
      dir === 0x0010 ? -state.columns
        : dir === 0x0040 ? state.columns
          : dir === 0x0080 ? -1
            : 1;
    const edgeDir = input.upEdge ? 0x0010
      : input.downEdge ? 0x0040
      : input.leftEdge ? 0x0080
      : input.rightEdge ? 0x0020
      : 0;
    if (edgeDir !== 0) {
      moveCursor(state, dirDelta(edgeDir));
      state.holdDir = edgeDir;
      state.holdTicks = 0;
    } else if (state.holdDir !== 0 && (buttons & state.holdDir) !== 0) {
      // Held-direction repeat on the fixed reference clock, so the repeat
      // schedule is identical at 60/30/20/4 Hz. A low-rate frame carries
      // many ticks and can cross several repeat periods: fold every repeat
      // that fell due inside the consumed ticks, keeping the residual so
      // the next repeat stays 6 ticks away at every host rate.
      state.holdTicks += ticks;
      while (state.holdTicks >= REPEAT_DELAY) {
        moveCursor(state, dirDelta(state.holdDir));
        state.holdTicks -= REPEAT_RATE;
      }
    } else {
      state.holdDir = 0;
      state.holdTicks = 0;
    }

    if (input.confirmEdge !== true) return rawState;
    if (state.cursor < state.charset.length) {
      if (state.buffer.length < state.maxLength) {
        state.buffer += state.charset[state.cursor]!;
      }
      return rawState;
    }
    const action = state.cursor - state.charset.length;
    if (action === NAME_INPUT_ACTION_BACK) {
      state.buffer = state.buffer.slice(0, -1);
    } else if (action === NAME_INPUT_ACTION_OK) {
      if (state.buffer.length > 0 || (state.allowEmpty && state.variable !== null)) {
        state.phase = "done";
      }
    } else if (action === NAME_INPUT_ACTION_CANCEL) {
      if (!state.swallowCancel) {
        state.phase = "done";
        state.cancelled = true;
      }
    }
    return rawState;
  },

  done(rawState): SceneCompletion | null {
    const state = stateOf(rawState);
    if (state.phase !== "done") return null;
    if (state.cancelled) return { cancelled: true, ext: state.ext };
    return state.variable !== null
      ? { ext: state.ext, writes: { [state.variable]: state.buffer } }
      : { ext: state.ext, playerName: state.buffer };
  },
};

/** The charset char at a state cursor, or "" for an action entry. The UI
 *  uses this to label grid cells. */
export function nameInputCharAt(state: Readonly<NameInputState>, index: number): string {
  return index >= 0 && index < state.charset.length ? state.charset[index]! : "";
}
