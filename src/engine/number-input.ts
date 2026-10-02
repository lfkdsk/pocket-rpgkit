// src/engine/number-input.ts — the built-in RPG Maker number-input scene.
//
// An event opens the scene with `{ variable, digits }`. The current numeric
// variable value is clamped to the representable unsigned range, then edited
// one decimal digit at a time. Confirm commits the number; cancel is consumed
// without closing the scene, matching RPG Maker's Window_NumberInput.
//
// Pure reducer: the number, selected digit and held-key repeat bookkeeping all
// live in JSON state, so replay and rewind reproduce the same interaction.

import { deepClone } from "./clone.ts";
import type { ExtensionReadContext } from "./extensions.ts";
import type { SceneCompletion, SceneRules, SceneStart } from "./scene.ts";
import type { JsonValue } from "./types.ts";

export const NUMBER_INPUT_SCENE_ID = "rpgkit.numberInput";

/** Held-key repeat on the fixed 60 Hz reference clock: first repeat after
 *  0.5 seconds, then every 0.1 seconds. */
const REPEAT_DELAY = 30;
const REPEAT_RATE = 6;
const DEFAULT_DIGITS = 1;
const MAX_DIGITS = 8;

const DIR_UP = 0x0010;
const DIR_RIGHT = 0x0020;
const DIR_DOWN = 0x0040;
const DIR_LEFT = 0x0080;

export interface NumberInputArgs {
  /** Variable id whose numeric value is edited and replaced on confirm. */
  variable: string;
  /** Decimal digit count. Runtime normalization clamps this to 1..8. */
  digits: number;
}

export interface NumberInputState {
  variable: string;
  digits: number;
  /** Integer in the inclusive range 0..10^digits-1. */
  value: number;
  /** Selected digit, from most significant (0) to least significant. */
  cursor: number;
  phase: "edit" | "done";
  /** Held-direction repeat bookkeeping: BTN direction bit + ticks held. */
  holdDir: number;
  holdTicks: number;
  ext: JsonValue;
}

function record(value: JsonValue): Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}

function clampDigits(value: JsonValue): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return DEFAULT_DIGITS;
  return Math.min(MAX_DIGITS, Math.max(1, value));
}

function initialValue(value: unknown, digits: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const max = 10 ** digits - 1;
  return Math.min(max, Math.max(0, Math.floor(value)));
}

function stateOf(value: JsonValue): NumberInputState {
  return value as unknown as NumberInputState;
}

function moveCursor(state: NumberInputState, delta: number): void {
  state.cursor = (state.cursor + delta + state.digits) % state.digits;
}

function changeDigit(state: NumberInputState, delta: -1 | 1): void {
  const place = 10 ** (state.digits - state.cursor - 1);
  const digit = Math.floor(state.value / place) % 10;
  const next = (digit + delta + 10) % 10;
  state.value += (next - digit) * place;
}

function applyDirection(state: NumberInputState, direction: number): void {
  if (direction === DIR_UP) changeDigit(state, 1);
  else if (direction === DIR_DOWN) changeDigit(state, -1);
  else if (direction === DIR_LEFT) moveCursor(state, -1);
  else if (direction === DIR_RIGHT) moveCursor(state, 1);
}

/** Zero-padded decimal text for presentation. It always contains exactly
 *  `state.digits` characters. */
export function numberInputText(state: Readonly<NumberInputState>): string {
  return String(state.value).padStart(state.digits, "0");
}

/** Register under NUMBER_INPUT_SCENE_ID in createSession's `scenes` map. */
export const numberInputRules: SceneRules = {
  start(ext, rawArgs, _seed, ctx): SceneStart | null {
    const args = record(rawArgs);
    const variable = typeof args.variable === "string" && args.variable.length > 0
      ? args.variable
      : null;
    // `variable` is the required destination. A malformed direct scene call
    // is skipped instead of opening an editor that cannot commit anywhere.
    if (variable === null) return null;
    const digits = clampDigits(args.digits);
    const state: NumberInputState = {
      variable,
      digits,
      value: initialValue(ctx.variables[variable], digits),
      cursor: 0,
      phase: "edit",
      holdDir: 0,
      holdTicks: 0,
      ext: deepClone(ext),
    };
    return { ext: deepClone(ext), state: state as unknown as JsonValue };
  },

  step(rawState, input, ticks): JsonValue {
    const state = stateOf(rawState);
    if (state.phase !== "edit") return rawState;
    const buttons = input.buttons >>> 0;

    const edgeDir = input.upEdge ? DIR_UP
      : input.downEdge ? DIR_DOWN
        : input.leftEdge ? DIR_LEFT
          : input.rightEdge ? DIR_RIGHT
            : 0;
    if (edgeDir !== 0) {
      applyDirection(state, edgeDir);
      state.holdDir = edgeDir;
      state.holdTicks = 0;
    } else if (state.holdDir !== 0 && (buttons & state.holdDir) !== 0) {
      state.holdTicks += ticks;
      // A low-rate host frame may cross several repeat periods. Fold every
      // due move and retain the residual phase so 60/30/20/4 Hz agree.
      while (state.holdTicks >= REPEAT_DELAY) {
        applyDirection(state, state.holdDir);
        state.holdTicks -= REPEAT_RATE;
      }
    } else {
      state.holdDir = 0;
      state.holdTicks = 0;
    }

    // RPG Maker's number window has no cancel path. A cancel edge is simply
    // consumed by the scene host; only confirmation completes it.
    if (input.confirmEdge === true) state.phase = "done";
    return rawState;
  },

  done(rawState): SceneCompletion | null {
    const state = stateOf(rawState);
    if (state.phase !== "done") return null;
    return { ext: state.ext, writes: { [state.variable]: state.value } };
  },
};
