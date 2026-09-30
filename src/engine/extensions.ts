// src/engine/extensions.ts — game-owned, deterministic event extensions.
//
// The core deliberately knows nothing about a game's party, quest journal or
// other bespoke state. A game registers namespaced pure handlers and keeps
// that state in SessionState.ext. Handlers receive read-only built-in banks,
// a cloned JSON argument, and (for commands) a random() function backed by the
// session's saved mulberry32 cursor. Their only effects are returned data.

import { deepClone, keyedRecord } from "./clone.ts";
import type { JsonValue, VariableValue } from "./types.ts";

export interface ExtensionReadContext {
  readonly ext: JsonValue;
  readonly switches: Readonly<Record<string, boolean>>;
  readonly variables: Readonly<Record<string, VariableValue>>;
  readonly items: Readonly<Record<string, number>>;
  readonly gold: number;
}

export interface ExtensionCommandContext extends ExtensionReadContext {
  /** Draw from the session's saved mulberry32 cursor. Calling this is the
   * only supported source of entropy inside an extension handler. */
  random(): number;
}

export interface ExtensionCommandResult {
  /** Omit to retain the current extension state; null is a valid new state. */
  ext?: JsonValue;
  /** Atomic replacements in the built-in variable bank. */
  writes?: Readonly<Record<string, VariableValue>>;
  /** Atomic item-count replacements in the session backpack. A normalized
   *  count of zero removes the item. */
  items?: Readonly<Record<string, number>>;
  /** Atomic replacement for the session wallet. */
  gold?: number;
}

export type ExtensionCommandHandler = (
  context: ExtensionCommandContext,
  args: JsonValue,
) => ExtensionCommandResult | void;

export type ExtensionConditionHandler = (
  context: ExtensionReadContext,
  args: JsonValue,
) => boolean;

/** One live row returned by an extension-driven choice provider. `key`
 * identifies the logical row across refreshes; `data` is never interpreted
 * by the kit and is returned to the resolver on confirmation. */
export interface ExtensionChoiceOption {
  key: string;
  label: string;
  enabled?: boolean;
  data?: JsonValue;
}

export type ExtensionChoiceResult =
  | { kind: "select"; index: number; key: string; data: JsonValue }
  | { kind: "cancel" };

/** Pure dynamic-list provider plus an optional mutation callback. Options
 * deliberately receive no random source: merely keeping a modal open must
 * not advance the saved RNG cursor. */
export interface ExtensionChoiceHandler {
  options(
    context: ExtensionReadContext,
    args: JsonValue,
  ): readonly ExtensionChoiceOption[];
  resolve?(
    context: ExtensionCommandContext,
    args: JsonValue,
    result: ExtensionChoiceResult,
  ): ExtensionCommandResult | void;
}

export interface ExtensionCodec {
  /** Convert runtime JSON state to its save representation. */
  encode(value: JsonValue): JsonValue;
  /** Convert the saved representation back to runtime JSON state. */
  decode(value: JsonValue): JsonValue;
}

export type ExtensionValidator = (value: JsonValue) => boolean | string | void;

export interface ExtensionOptions {
  /** Fresh-session value. Defaults to null. */
  initial?: JsonValue;
  commands?: Readonly<Record<string, ExtensionCommandHandler>>;
  conditions?: Readonly<Record<string, ExtensionConditionHandler>>;
  choices?: Readonly<Record<string, ExtensionChoiceHandler>>;
  codec?: ExtensionCodec;
  validate?: ExtensionValidator;
  /** Editor/preview escape hatch. Unknown commands become no-ops and unknown
   * conditions are false. Production sessions reject them by default. */
  allowUnknown?: boolean;
}

/** Normalized immutable-by-convention registry retained outside reducer
 * state. It contains functions, so it must never enter a snapshot/hash. */
export interface ExtensionRuntime {
  readonly initial: JsonValue;
  readonly commands: Readonly<Record<string, ExtensionCommandHandler>>;
  readonly conditions: Readonly<Record<string, ExtensionConditionHandler>>;
  readonly choices: Readonly<Record<string, ExtensionChoiceHandler>>;
  readonly codec: ExtensionCodec | null;
  readonly validate: ExtensionValidator | null;
  readonly allowUnknown: boolean;
}

const CALL_RE = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/;

export function extensionCallNameValid(call: string): boolean {
  return CALL_RE.test(call);
}

/** Return a precise reason when a value is not lossless finite JSON. */
export function jsonValueProblem(value: unknown, path = "$", seen = new Set<object>()): string | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? null : `${path}: finite number required`;
  if (typeof value !== "object") return `${path}: JSON value required`;
  if (seen.has(value)) return `${path}: cyclic value is not JSON`;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const problem = jsonValueProblem(value[i], `${path}[${i}]`, seen);
      if (problem) return problem;
    }
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return `${path}: plain JSON object required`;
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const problem = jsonValueProblem((value as Record<string, unknown>)[key], `${path}.${key}`, seen);
      if (problem) return problem;
    }
  }
  seen.delete(value);
  return null;
}

export function assertJsonValue(value: unknown, label: string): asserts value is JsonValue {
  const problem = jsonValueProblem(value);
  if (problem) throw new Error(`${label}: ${problem}`);
}

function validateExtension(runtime: ExtensionRuntime, value: JsonValue, label: string): void {
  assertJsonValue(value, label);
  const verdict = runtime.validate?.(value);
  if (verdict === false) throw new Error(`${label}: extension validator rejected state`);
  if (typeof verdict === "string") throw new Error(`${label}: ${verdict}`);
}

export function createExtensionRuntime(options: ExtensionOptions = {}): ExtensionRuntime {
  const commands = keyedRecord(options.commands);
  const conditions = keyedRecord(options.conditions);
  const choices = keyedRecord(options.choices);
  for (const call of [...Object.keys(commands), ...Object.keys(conditions), ...Object.keys(choices)]) {
    if (!extensionCallNameValid(call)) {
      throw new Error(`extension call ${JSON.stringify(call)} must use a namespaced name such as "game.action"`);
    }
  }
  const initial = deepClone(options.initial ?? null);
  const runtime: ExtensionRuntime = {
    initial,
    commands,
    conditions,
    choices,
    codec: options.codec ?? null,
    validate: options.validate ?? null,
    allowUnknown: options.allowUnknown ?? false,
  };
  validateExtension(runtime, initial, "extension initial state");
  return runtime;
}

export function cloneExtension(runtime: ExtensionRuntime, value: JsonValue, label = "extension state"): JsonValue {
  validateExtension(runtime, value, label);
  return deepClone(value);
}

export function encodeExtension(runtime: ExtensionRuntime, value: JsonValue): JsonValue {
  validateExtension(runtime, value, "extension state");
  const encoded = runtime.codec ? runtime.codec.encode(deepClone(value)) : value;
  assertJsonValue(encoded, "extension codec encode");
  return deepClone(encoded);
}

export function decodeExtension(runtime: ExtensionRuntime, value: JsonValue): JsonValue {
  assertJsonValue(value, "saved extension state");
  const decoded = runtime.codec ? runtime.codec.decode(deepClone(value)) : value;
  assertJsonValue(decoded, "extension codec decode");
  validateExtension(runtime, decoded, "decoded extension state");
  return deepClone(decoded);
}
