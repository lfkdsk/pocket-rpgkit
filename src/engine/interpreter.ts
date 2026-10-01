// src/engine/interpreter.ts — P1③ event interpreter.
//
// A pure fold over (state, input) per docs/SIMULATION.md: no wall clock, no
// Math.random (the RNG cursor lives in state), no host imports. The host
// calls stepInterp once per virtual frame with pressed-edge intents and the
// player cell; the reducer owns page selection, trigger arbitration, the
// command stack, the typewriter clock and every gameplay value.
//
// Fibers
//   main       — at most one action / playerTouch / AUTORUN fiber. While it
//                runs the game is "busy" (P1② freezes player movement, the
//                UI freezes its camera) and no new blocking trigger starts.
//   parallels  — PARALLEL pages run concurrently in their own fibers, in
//                ascending event-key order so each frame is deterministic.
//                Under Project.system.messageBlocksPlayer a box a parallel
//                opens holds the player too (messageHoldsPlayer).
//
// A fiber runs a compiled linear program (compile()): `if/else` becomes
// IF + JMP, a chosen choices branch or a common event pushes another program
// on the frame stack. Suspending commands (text/choices/wait) pin the pc
// until later-frame input releases them; transfer/moveRoute park the fiber
// in "external" mode and publish a pending request P1④ completes with
// continueExternal(). Parallel and autorun fibers restart one frame after
// they finish (MV semantics): the victory autorun ends its loop by flipping
// its self switch, which changes its active page.

import { deepClone, keyedRecord } from "./clone.ts";
import {
  assertJsonValue,
  cloneExtension,
  createExtensionRuntime,
  type ExtensionChoiceResult,
  type ExtensionCommandContext,
  type ExtensionCommandResult,
  type ExtensionReadContext,
  type ExtensionRuntime,
} from "./extensions.ts";
import { DEFAULT_PLAYER_NAME, substituteLines, substitutePlayerName } from "./player-name.ts";
import {
  cloneMoveControlState,
  type MoveControlState,
} from "./move-control.ts";
import type {
  AnimationDef,
  Command,
  CommonEvent,
  Condition,
  Dir,
  ExtensionChoiceWrite,
  Facing,
  GameEvent,
  Item,
  JsonValue,
  MapDef,
  MoveControl,
  MoveRoute,
  Page,
  PageCondition,
  RouteTarget,
  ShopGood,
  TilePropertyOverride,
  TransferCoordinate,
  TransferDirection,
  TransferMap,
  VariableRef,
  VariableValue,
} from "./types.ts";

export const TICK_HZ = 60;

/** Maximum number of interpreter steps shared by every fiber in one
 *  stepInterp call. Forward-only local bytecode can still exceed a frame's
 *  work bound, and common events can recurse across programs. This runtime
 *  budget is therefore the termination backstop; serialized-program checks
 *  only reject malformed control flow earlier. Exceeding the budget records
 *  a fatal state instead of throwing or hanging the host frame loop. */
export const RUNAWAY_STEP_LIMIT = 10000;
/** Maximum number of nested choice/common program frames. This bounds a
 * wait-interleaved recursive common event across host frames as well as an
 * in-frame recursion before it reaches the step budget. */
export const MAX_FIBER_STACK_DEPTH = 100;

// --- virtual time -----------------------------------------------------------

export function secondsToFrames(seconds: number, hz = TICK_HZ): number {
  return Math.max(0, Math.round(seconds * hz));
}

/** Characters revealed by frame `frame` (frames since revealStart) for a
 *  line of `len` chars at `cps` chars per virtual second. Fractional chars
 *  per frame accumulate, so authored cps is hz-portable: the same virtual
 *  instant reveals the same text at 60/30/10/2 Hz (R2 acceptance table). */
export function revealedChars(len: number, cps: number, frame: number, hz = TICK_HZ): number {
  if (frame <= 0) return 0;
  const cpf = cps / hz;
  return Math.max(0, Math.min(len, Math.floor(cpf * frame)));
}

// --- seeded RNG: mulberry32, cursor is a serializable state field -----------

export function rngNext(rngState: number): { value: number; next: number } {
  let a = rngState >>> 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, next: a >>> 0 };
}

export function randInt(rngState: number, min: number, max: number): { value: number; next: number } {
  const r = rngNext(rngState);
  return { value: min + Math.floor(r.value * (max - min + 1)), next: r.next };
}

// --- switch state (the saveable game values) --------------------------------

export type SelfKey = "A" | "B" | "C" | "D";

/** Sparse player appearance state. Missing keys retain the baked defaults,
 * which keeps projects that never use the command byte-for-byte unchanged. */
export interface PlayerAppearanceState {
  defaultSprite?: string;
  sprite?: string;
  opacity?: number;
  visible?: boolean;
}

/** One event override, pinned to the page on which it was issued. */
export interface EventAppearanceState {
  pageIndex: number;
  sprite?: string;
  opacity?: number;
  visible?: boolean;
}

/** Authored page appearance supplied to condition evaluation by Session. */
export interface EventPageAppearance {
  pageIndex: number;
  sprite: string | null;
}

/** Per-visit visual layer selection. Missing fields mean asset defaults. */
export interface LayerState {
  visible?: boolean;
  variant?: string;
}

export interface EffectiveAppearance {
  sprite: string | null;
  opacity: number;
  visible: boolean;
}

export interface SwitchState {
  switches: Record<string, boolean>;
  /** `${mapId}/${eventId}` -> held self switch (undefined = none). R2 v1
   *  models one held key per event; the sample game uses only A. */
  self: Record<string, SelfKey | undefined>;
  items: Record<string, number>;
  /** Event variables are numeric for the built-in arithmetic commands, but
   *  an extension may also write a string (VariableValue). */
  variables: Record<string, VariableValue>;
  /** T2-10/B1: per-shop finite stock, key `${shopId}:${itemId}` -> units
   *  remaining. A row without a live entry here uses its authored
   *  ShopGood.stock starting value; a good with no authored stock never
   *  gets an entry (unlimited). Buying decrements it; selling an item back
   *  at a shop that lists that item (with a stock figure) increments it. */
  shopStock: Record<string, number>;
  gold: number;
  /** The player's name, substituted for the {name} text token. Part of the
   *  save snapshot; a fresh session seeds it from Project.playerName. */
  playerName: string;
  /** Project-wide player walking appearance. Absent is the baked player
   *  art at full opacity. `defaultSprite` is the reset baseline while
   *  `sprite` is the current MV-style Change Image override. */
  playerAppearance?: PlayerAppearanceState;
  /** Mulberry32 cursor. Part of the save snapshot (R2 §3.1). */
  rng: number;
}

export function createSwitchState(init?: Partial<SwitchState>): SwitchState {
  const state: SwitchState = {
    switches: keyedRecord(init?.switches),
    self: keyedRecord(init?.self),
    // B1 (fix 3): this public constructor is also the state a
    // fresh session and a restored save both start from (createInterpState,
    // save-restore.ts's restoreSessionSnapshot), so every numeric bank is
    // normalized through the same clampFiniteVar every runtime write uses —
    // a hand-built init (or a legacy save) cannot smuggle a non-safe-integer
    // value past construction/restore the way runtime writes already can't.
    items: clampVarRecord(init?.items),
    variables: clampVariableRecord(init?.variables),
    shopStock: clampVarRecord(init?.shopStock, true),
    gold: clampFiniteVar(init?.gold ?? 0),
    playerName: init?.playerName ?? DEFAULT_PLAYER_NAME,
    rng: init?.rng ?? 0x12345678,
  };
  if (init?.playerAppearance) state.playerAppearance = { ...init.playerAppearance };
  return state;
}

function keyedValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function hasOwn(record: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** Effective player appearance. A null sprite means the manifest's baked
 * player frames, rather than an invisible character. */
export function effectivePlayerAppearance(s: SwitchState): EffectiveAppearance {
  const a = s.playerAppearance;
  return {
    sprite: a?.sprite ?? a?.defaultSprite ?? null,
    opacity: a?.opacity ?? 255,
    visible: a?.visible ?? true,
  };
}

/** Effective event appearance for a known active page. An override is
 * ignored as soon as its issuing page is no longer active. */
export function effectiveEventAppearance(
  page: EventPageAppearance,
  override?: Readonly<EventAppearanceState>,
): EffectiveAppearance {
  const current = override?.pageIndex === page.pageIndex ? override : undefined;
  const sprite = current?.sprite ?? page.sprite;
  return {
    sprite,
    opacity: current?.opacity ?? 255,
    visible: sprite !== null && (current?.visible ?? true),
  };
}

function targetEventId(target: Exclude<RouteTarget, "player">, eventKey: string): string {
  if (target !== "this") return target.event;
  const slash = eventKey.indexOf("/");
  return slash < 0 ? eventKey : eventKey.slice(slash + 1);
}

function dirMask(dirs: readonly Dir[]): number {
  const bits: Record<Dir, number> = { down: 1, left: 2, up: 4, right: 8 };
  let mask = 0;
  for (const dir of dirs) mask |= bits[dir];
  return mask;
}

function tileOverrideFieldMatches(
  override: Readonly<TilePropertyOverride> | undefined,
  field: keyof TilePropertyOverride,
  expected: TilePropertyOverride[typeof field] | null | undefined,
): boolean {
  if (expected === undefined) return true;
  if (expected === null) return override === undefined || !hasOwn(override, field);
  if (!override || !hasOwn(override, field)) return false;
  const actual = override[field];
  if (Array.isArray(expected)) return Array.isArray(actual) && dirMask(actual) === dirMask(expected);
  return actual === expected;
}

// --- conditions and page selection ------------------------------------------

/** Runtime facts supplied alongside the saveable switch bank when a
 * condition is evaluated. They are derived from the current reducer state
 * and deliberately never serialized. */
export interface ConditionContext {
  worldIdle: boolean;
  /** Current page index and authored sprite for each live map event. */
  eventPages?: Readonly<Record<string, EventPageAppearance>>;
  /** Per-visit overrides are separate so an event page switch can discard
   *  them without changing authored data. */
  eventAppearances?: Readonly<Record<string, EventAppearanceState>>;
  tileProperties?: Readonly<Record<string, TilePropertyOverride>>;
  mapWidth?: number;
  mapHeight?: number;
}

export function evalCondition(
  c: Condition,
  s: SwitchState,
  eventKey: string,
  facing?: Facing,
  extension?: ExtensionScope,
  context?: ConditionContext,
): boolean {
  switch (c.kind) {
    case "switch":
      return (keyedValue(s.switches, c.id) ?? false) === (c.value ?? true);
    case "variable": {
      const v = keyedValue(s.variables, c.id) ?? 0;
      if (typeof v !== "number") return false;
      switch (c.op) {
        case ">=": return v >= c.value;
        case "<=": return v <= c.value;
        case "==": return v === c.value;
        case "!=": return v !== c.value;
      }
      return false;
    }
    case "selfSwitch":
      return (keyedValue(s.self, eventKey) === c.key) === (c.value ?? true);
    case "item":
      return (keyedValue(s.items, c.id) ?? 0) >= c.count;
    case "gold":
      return s.gold >= c.amount;
    case "facing":
      // A facing condition needs a live player direction. Callers that do
      // not have one cannot prove the condition and therefore fail it.
      return facing !== undefined && facing === FACING_OF_DIR[c.dir];
    case "appearance": {
      if (c.target === "player") return effectivePlayerAppearance(s).sprite === c.sprite;
      const id = targetEventId(c.target, eventKey);
      const page = context?.eventPages ? keyedValue(context.eventPages, id) : undefined;
      if (!page) return false;
      const override = context?.eventAppearances
        ? keyedValue(context.eventAppearances, id)
        : undefined;
      return effectiveEventAppearance(page, override).sprite === c.sprite;
    }
    case "tileProperty": {
      if (!Number.isInteger(c.x) || !Number.isInteger(c.y) || c.x < 0 || c.y < 0 ||
          context?.mapWidth === undefined || context.mapHeight === undefined ||
          c.x >= context.mapWidth || c.y >= context.mapHeight) return false;
      const index = String(c.y * context.mapWidth + c.x);
      const override = context.tileProperties ? keyedValue(context.tileProperties, index) : undefined;
      return tileOverrideFieldMatches(override, "passage", c.passage) &&
        tileOverrideFieldMatches(override, "enter", c.enter) &&
        tileOverrideFieldMatches(override, "exit", c.exit);
    }
    case "worldIdle": {
      // Like facing, a low-level caller without the live runtime context
      // cannot prove this derived condition. Negation applies after that
      // conservative false result.
      const idle = context?.worldIdle ?? false;
      return c.negate === true ? !idle : idle;
    }
    case "ext": {
      // Map acquisition validates registration. Missing handlers and
      // non-boolean results are game-programming contract violations, not
      // authored value failures, so these assertions intentionally throw.
      const handler = extension?.runtime.conditions[c.call];
      if (!handler) {
        if (extension?.runtime.allowUnknown) return false;
        throw new Error(`extension condition ${JSON.stringify(c.call)} is not registered`);
      }
      const context: ExtensionReadContext = {
        ext: deepClone(extension.ext),
        switches: s.switches,
        variables: s.variables,
        items: s.items,
        gold: s.gold,
      };
      const result = handler(context, deepClone(c.args));
      if (typeof result !== "boolean") {
        throw new Error(`extension condition ${JSON.stringify(c.call)} must return a boolean`);
      }
      return result;
    }
  }
}

/** Condition-only view of the game extension registry plus live state. */
export interface ExtensionScope {
  runtime: ExtensionRuntime;
  ext: JsonValue;
}

const FACING_OF_DIR: Record<Dir, Facing> = { down: 0, left: 1, up: 2, right: 3 };

/** True when every clause of a `condition.all` list holds. */
function allClausesHold(
  clauses: Condition[],
  s: SwitchState,
  eventKey: string,
  facing?: Facing,
  extension?: ExtensionScope,
  context?: ConditionContext,
): boolean {
  for (const c of clauses) {
    if (!evalCondition(c, s, eventKey, facing, extension, context)) return false;
  }
  return true;
}

/** A page whose `all` list contains a facing clause: such a playerTouch
 *  page re-fires when the player turns in place. */
export function pageReadsFacing(p: Page): boolean {
  return p.condition?.all?.some((c) => c.kind === "facing") ?? false;
}

/** Does a PageCondition hold? Shared by page selection and a shop
 *  ShopGood.condition row gate (T2-10/B1), which reuses this exact clause
 *  shape instead of a Tuxemon-specific mechanism. */
export function conditionHolds(
  c: PageCondition | undefined,
  s: SwitchState,
  eventKey: string,
  facing?: Facing,
  extension?: ExtensionScope,
  context?: ConditionContext,
): boolean {
  if (!c) return true;
  if (c.switch !== undefined && !(keyedValue(s.switches, c.switch) ?? false)) return false;
  if (c.selfSwitch !== undefined && keyedValue(s.self, eventKey) !== c.selfSwitch) return false;
  if (c.variable) {
    const v = keyedValue(s.variables, c.variable.id) ?? 0;
    if (typeof v !== "number") return false;
    const { op, value } = c.variable;
    if (op === ">=" && !(v >= value)) return false;
    if (op === "<=" && !(v <= value)) return false;
    if (op === "==" && !(v === value)) return false;
    if (op === "!=" && !(v !== value)) return false;
  }
  if (c.item !== undefined && (keyedValue(s.items, c.item) ?? 0) < 1) return false;
  if (c.all && !allClausesHold(c.all, s, eventKey, facing, extension, context)) return false;
  return true;
}

export function pageConditionHolds(
  p: Page,
  s: SwitchState,
  eventKey: string,
  facing?: Facing,
  extension?: ExtensionScope,
  context?: ConditionContext,
): boolean {
  return conditionHolds(p.condition, s, eventKey, facing, extension, context);
}

/** Highest-index page whose condition holds (R2 §2); null when none do.
 *  Callers must supply `facing` when an event can use a facing condition. */
export function activePage(
  ev: GameEvent,
  s: SwitchState,
  mapId: string,
  facing?: Facing,
  extension?: ExtensionScope,
  context?: ConditionContext,
): { page: Page; index: number } | null {
  const index = activeIndexAt(ev, s, eventKey(mapId, ev.id), facing, extension, context);
  return index < 0 ? null : { page: ev.pages[index]!, index };
}

/** activePage's page index for a caller that already holds the event key;
 *  -1 when no page condition holds. */
export function activeIndexAt(
  ev: GameEvent,
  s: SwitchState,
  key: string,
  facing?: Facing,
  extension?: ExtensionScope,
  context?: ConditionContext,
): number {
  for (let i = ev.pages.length - 1; i >= 0; i--) {
    if (pageConditionHolds(ev.pages[i]!, s, key, facing, extension, context)) return i;
  }
  return -1;
}

export function eventKey(mapId: string, eventId: string): string {
  return `${mapId}/${eventId}`;
}

/** Explicit UTF-16 code-unit ordering for event ids. String.localeCompare is
 *  host-locale dependent: Bun and the desktop QuickJS guest order "-" (U+002D)
 *  and "_" (U+005F) differently, so the same JSON picked a different event on
 *  the two hosts (review C12). Trigger arbitration must depend only on the
 *  authored id bytes, never on the host's collation tables. */
export function eventIdLess(a: string, b: string): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca !== cb) return ca < cb;
  }
  return a.length < b.length;
}

// --- compiled programs -------------------------------------------------------

export type Instr =
  | { op: "text"; lines: string[]; cps: number }
  | {
      op: "choices";
      prompt: string;
      texts: string[];
      branches: Prog[];
      cancel: Prog | null;
    }
  | { op: "switch"; id: string; value: boolean }
  | {
      op: "variable";
      id: string;
      set:
        | { op: "set" | "add" | "sub"; value: number }
        | { op: "random"; min: number; max: number }
        | { op: "copy" | "add" | "sub" | "mul" | "div" | "mod"; from: string };
    }
  | { op: "selfSwitch"; key: SelfKey; value: boolean }
  | { op: "if"; cond: Condition; onFalse: number }
  | { op: "jmp"; to: number }
  | { op: "wait"; frames: number }
  | { op: "gold"; set: "add" | "sub"; amount: number }
  | { op: "item"; item: string; set: "add" | "sub"; count: number }
  | { op: "se"; name: string; volume: number; pitch: number }
  | { op: "erase" }
  | { op: "exit" }
  | { op: "lockInput" }
  | { op: "unlockInput" }
  | { op: "place"; target: RouteTarget; x: number; y: number; dir: Dir | null }
  | {
      op: "transfer";
      map: TransferMap;
      x: TransferCoordinate;
      y: TransferCoordinate;
      dir: TransferDirection;
      fadeFrames: number;
    }
  | { op: "moveRoute"; target: RouteTarget; wait: boolean; route: MoveRoute }
  | { op: "moveControl"; target: RouteTarget; control: MoveControl }
  | {
      op: "appearance";
      target: RouteTarget;
      sprite?: string | null;
      opacity?: number | null;
      visible?: boolean | null;
      saveDefault: boolean;
    }
  | { op: "layer"; layer: string; visible?: boolean | null; variant?: string | null }
  | {
      op: "tileProperty";
      x: number;
      y: number;
      passage?: "pass" | "block" | null;
      enter?: Dir[] | null;
      exit?: Dir[] | null;
    }
  | { op: "common"; id: string }
  | { op: "shop"; id: string; goods: readonly ShopGood[]; sell: boolean; sellList: "disable" | "hide" }
  | {
      op: "mapAnim";
      id: string;
      anim: string;
      /** Null when the instance follows `target`. */
      x: number | null;
      y: number | null;
      target: "player" | { event: string } | null;
      /** With a target: true keeps painting on the character's live pixel
       *  position; false snapshots the character's tile at execution and
       *  pins the instance there (Tuxemon play_map_animation parity). */
      follow: boolean;
      layer: "below" | "above";
      /** Null: use the compiled def's default. */
      loop: boolean | null;
      wait: boolean;
    }
  | { op: "stopAnim"; id: string | null; anim: string | null }
  | { op: "ext"; call: string; args: JsonValue }
  | {
      op: "extChoice";
      call: string;
      args: JsonValue;
      prompt: string;
      cancel: boolean;
      write: Readonly<ExtensionChoiceWrite> | null;
    }
  | {
      op: "battle";
      setup: JsonValue;
      onWin: Prog | null;
      onLose: Prog | null;
      onEscape: Prog | null;
    };

export type Prog = Instr[];

const DEFAULT_CPS = 30;

export function compile(cmds: readonly Command[], hz: number = TICK_HZ): Prog {
  const out: Prog = [];
  const emit = (ins: Instr): number => {
    out.push(ins);
    return out.length - 1;
  };
  const walk = (list: readonly Command[]): void => {
    for (const c of list) {
      switch (c.op) {
        case "text":
          emit({ op: "text", lines: c.lines, cps: c.cps ?? DEFAULT_CPS });
          break;
        case "choices":
          emit({
            op: "choices",
            prompt: c.prompt,
            texts: c.options.map((o) => o.text),
            branches: c.options.map((o) => compile(o.commands, hz)),
            cancel: c.cancel ? compile(c.cancel.commands, hz) : null,
          });
          break;
        case "switch":
          emit({ op: "switch", id: c.id, value: c.value });
          break;
        case "variable":
          emit({ op: "variable", id: c.id, set: c.set });
          break;
        case "selfSwitch":
          emit({ op: "selfSwitch", key: c.key, value: c.value });
          break;
        case "if": {
          const at = out.length;
          emit({ op: "if", cond: c.if, onFalse: -1 });
          walk(c.then);
          const jmpAt = emit({ op: "jmp", to: -1 });
          const elseAt = out.length;
          if (c.else) walk(c.else);
          const endAt = out.length;
          (out[at] as Extract<Instr, { op: "if" }>).onFalse = elseAt;
          (out[jmpAt] as Extract<Instr, { op: "jmp" }>).to = endAt;
          break;
        }
        case "wait":
          emit({ op: "wait", frames: secondsToFrames(c.seconds, hz) });
          break;
        case "gold":
          emit({ op: "gold", set: c.set, amount: c.amount });
          break;
        case "item":
          emit({ op: "item", item: c.item, set: c.set, count: c.count });
          break;
        case "se":
          emit({ op: "se", name: c.name, volume: c.volume ?? 80, pitch: c.pitch ?? 100 });
          break;
        case "erase":
          emit({ op: "erase" });
          break;
        case "exit":
          emit({ op: "exit" });
          break;
        case "lockInput":
          emit({ op: "lockInput" });
          break;
        case "unlockInput":
          emit({ op: "unlockInput" });
          break;
        case "place":
          emit({
            op: "place",
            target: c.target,
            x: c.x,
            y: c.y,
            dir: c.dir ?? null,
          });
          break;
        case "transfer":
          emit({
            op: "transfer",
            map: c.map,
            x: c.x,
            y: c.y,
            dir: c.dir ?? "keep",
            fadeFrames: secondsToFrames(c.fade ?? 0, hz),
          });
          break;
        case "moveRoute":
          emit({ op: "moveRoute", target: c.target, wait: c.wait ?? true, route: c.route });
          break;
        case "moveControl":
          emit({ op: "moveControl", target: c.target, control: c.control });
          break;
        case "appearance":
          emit({
            op: "appearance",
            target: c.target,
            ...(c.sprite === undefined ? {} : { sprite: c.sprite }),
            ...(c.opacity === undefined ? {} : { opacity: c.opacity }),
            ...(c.visible === undefined ? {} : { visible: c.visible }),
            saveDefault: c.saveDefault ?? false,
          });
          break;
        case "layer":
          emit({
            op: "layer",
            layer: c.layer,
            ...(c.visible === undefined ? {} : { visible: c.visible }),
            ...(c.variant === undefined ? {} : { variant: c.variant }),
          });
          break;
        case "tileProperty":
          emit({
            op: "tileProperty",
            x: c.x,
            y: c.y,
            ...(c.passage === undefined ? {} : { passage: c.passage }),
            ...(c.enter === undefined ? {} : { enter: c.enter === null ? null : [...c.enter] }),
            ...(c.exit === undefined ? {} : { exit: c.exit === null ? null : [...c.exit] }),
          });
          break;
        case "common":
          emit({ op: "common", id: c.id });
          break;
        case "shop":
          emit({ op: "shop", id: c.id, goods: c.goods, sell: c.sell ?? true, sellList: c.sellList ?? "disable" });
          break;
        case "mapAnim":
          emit({
            op: "mapAnim",
            id: c.id,
            anim: c.anim,
            x: c.x ?? null,
            y: c.y ?? null,
            target: c.target ?? null,
            follow: c.follow ?? true,
            layer: c.layer ?? "above",
            loop: c.loop ?? null,
            wait: c.wait ?? false,
          });
          break;
        case "stopAnim":
          emit({ op: "stopAnim", id: c.id ?? null, anim: c.anim ?? null });
          break;
        case "ext":
          emit({ op: "ext", call: c.call, args: deepClone(c.args) });
          break;
        case "extChoice": {
          const write = c.write ? { ...c.write } : null;
          if (write) {
            const targets = Object.values(write);
            if (targets.some((target) => typeof target !== "string" || target.length === 0)) {
              throw new Error("extChoice write destinations must be non-empty variable ids");
            }
            if (new Set(targets).size !== targets.length) {
              throw new Error("extChoice write destinations must be distinct");
            }
          }
          emit({
            op: "extChoice",
            call: c.call,
            args: deepClone(c.args),
            prompt: c.prompt,
            cancel: c.cancel ?? false,
            write,
          });
          break;
        }
        case "battle":
          emit({
            op: "battle",
            setup: deepClone(c.setup),
            onWin: c.onWin ? compile(c.onWin, hz) : null,
            onLose: c.onLose ? compile(c.onLose, hz) : null,
            onEscape: c.onEscape ? compile(c.onEscape, hz) : null,
          });
          break;
      }
    }
  };
  walk(cmds);
  return out;
}

// --- runtime state -----------------------------------------------------------

export interface Cell {
  x: number;
  y: number;
}

export interface InterpInput {
  /** Pressed-edge intents for THIS frame (the host computes the edges). */
  confirmEdge?: boolean;
  cancelEdge?: boolean;
  upEdge?: boolean;
  downEdge?: boolean;
  /** Player cell this frame and last frame (playerTouch fires on entry). */
  playerCell: Cell;
  prevCell: Cell;
  /** 0 down, 1 left, 2 up, 3 right — action triggers fire one tile ahead. */
  facing: Facing;
  /** Facing at the START of this frame, before the mover turned. A
   *  difference from `facing` is a turn-in-place edge, which re-fires a
   *  facing-reading playerTouch page. Defaults to `facing`. */
  prevFacing?: Facing;
  /** Live cells of map characters this frame (P1④ NPC motion); event id ->
   *  cell. Events absent from the record stand on their authored x/y. */
  eventCells?: Record<string, Cell>;
  /** Live cells of every event with a live character this frame (event id ->
   *  cell), built by the session only when World.needsMapAnimTarget. A
   *  mapAnim `{event}` target resolves here and nowhere else: an event
   *  absent from the record (erased, page inactive, never spawned) has no
   *  live character, so the command plays nothing (Tuxemon get_npc parity)
   *  instead of falling back to the authored x/y. */
  liveEventCells?: Record<string, Cell>;
  /** Active page/sprite snapshot used by appearance conditions. The
   * interpreter overlays its live command state, so a following `if` sees
   * an appearance command issued earlier in the same reference tick. */
  eventPages?: Record<string, EventPageAppearance>;
  /** Session/host state that lives outside InterpState but participates in
   *  the derived worldIdle condition. Low-level interpreter users may omit
   *  it when they have no scene, fade, player route, or menu. */
  worldIdleBlockers?: WorldIdleBlockers;
}

export interface TextModal {
  kind: "text";
  fiber: string;
  lines: string[];
  /** Joined text length (the UI renders lines joined with "\n"). */
  total: number;
  revealed: number;
  /** True once the typewriter has caught up; confirm then closes the box. */
  complete: boolean;
}

export interface ChoiceModal {
  kind: "choices";
  fiber: string;
  prompt: string;
  options: string[];
  /** Present only for extChoice. Stable logical ids preserve the cursor when
   * the extension reorders or replaces its live rows. */
  keys?: string[];
  /** Present only for extChoice. False rows remain navigable but inert. */
  enabled?: boolean[];
  index: number;
  cancellable: boolean;
}

/** One row of a shop box. "item" rows sell/buy `item`; the others are
 *  control rows with no goods behind them. In the "buy" stage rows are
 *  goods followed by an optional "sell" row and a trailing "leave" row;
 *  in the "sell" stage rows are the player's own sellable stock followed
 *  by a trailing "back" row. Rebuilt fresh every step the modal is open
 *  (live gold/stock), so modalChanged compares content, not identity. */
export type ShopRow =
  | {
      kind: "item";
      item: string;
      price: number;
      owned: number;
      canAfford: boolean;
      atCap: boolean;
      /** Buy-stage: remaining shop stock for this good, or null when it
       *  has no configured stock (unlimited). Always null on a sell-stage
       *  row. Zero folds into `atCap` (out of stock also disables the
       *  row). */
      stock: number | null;
      /** Sell-stage: whether the player may confirm selling this row
       *  (B4); an unsellable row still lists (dimmed) unless the shop's
       *  `sellList` is "hide". Always true on a buy-stage row. */
      sellable: boolean;
    }
  | { kind: "sell" | "leave" | "back" };

export interface ShopModal {
  kind: "shop";
  fiber: string;
  gold: number;
  sell: boolean;
  stage: "buy" | "sell";
  index: number;
  rows: readonly ShopRow[];
}

export type Modal = TextModal | ChoiceModal | ShopModal;

/** Backpack stack cap a shop purchase refuses to exceed (T2-10; matches the
 *  `item` command's authored count range). */
export const SHOP_ITEM_CAP = 99;

/** Did the VISIBLE modal identity/content change between two reducer
 *  frames? The UI repaints the message layer only when this is true, so a
 *  parked typewriter emits zero ops on idle frames. Comparing only kind and
 *  fiber is not enough: two consecutive Show Choices run on the SAME fiber
 *  (a nested choice opens right after its parent is picked), and the second
 *  box has a different prompt, options and cancel permission. Those fields
 *  must be part of the identity or Solid keeps the previous box on screen
 *  and useActions never binds the newly-authored back action (review C07). */
export function modalChanged(a: Modal | null, b: Modal | null): boolean {
  if (a === b) return false;
  if (a === null || b === null) return true;
  if (a.kind !== b.kind || a.fiber !== b.fiber) return true;
  if (a.kind === "text" && b.kind === "text") {
    return (
      a.revealed !== b.revealed ||
      a.complete !== b.complete ||
      a.lines.length !== b.lines.length ||
      a.lines.some((line, i) => line !== b.lines[i])
    );
  }
  if (a.kind === "choices" && b.kind === "choices") {
    return (
      a.index !== b.index ||
      a.prompt !== b.prompt ||
      a.cancellable !== b.cancellable ||
      a.options.length !== b.options.length ||
      a.options.some((opt, i) => opt !== b.options[i]) ||
      (a.keys === undefined) !== (b.keys === undefined) ||
      (a.enabled === undefined) !== (b.enabled === undefined) ||
      (a.keys?.some((key, i) => key !== b.keys?.[i]) ?? false) ||
      (a.enabled?.some((enabled, i) => enabled !== b.enabled?.[i]) ?? false)
    );
  }
  if (a.kind === "shop" && b.kind === "shop") {
    return (
      a.gold !== b.gold ||
      a.sell !== b.sell ||
      a.stage !== b.stage ||
      a.index !== b.index ||
      a.rows.length !== b.rows.length ||
      a.rows.some((row, i) => !shopRowEquals(row, b.rows[i]!))
    );
  }
  return false;
}

function shopRowEquals(a: ShopRow, b: ShopRow): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind !== "item" || b.kind !== "item") return true;
  return (
    a.item === b.item &&
    a.price === b.price &&
    a.owned === b.owned &&
    a.canAfford === b.canAfford &&
    a.atCap === b.atCap &&
    a.stock === b.stock &&
    a.sellable === b.sellable
  );
}

export interface SoundCue {
  name: string;
  volume: number;
  pitch: number;
}

/** P1④ consumes these: the fiber is parked in "external" mode until
 *  continueExternal() is called. P1③ publishes the payload only. */
export interface PendingTransfer {
  fiber: string;
  map: string;
  x: number;
  y: number;
  dir: Dir | "keep";
  fadeFrames: number;
}
export interface PendingMoveRoute {
  fiber: string;
  /** "player" drives the mover; {event} is the ALREADY-RESOLVED map event
   *  id ("this" resolves to the running fiber's own event). */
  target: "player" | { event: string };
  eventId: string;
  route: MoveRoute;
  /** true: the fiber parked in "external" mode and the session resumes it
   *  when the route lands; false: fire-and-forget, the fiber already
   *  advanced past the command. */
  wait: boolean;
}

export interface PendingMoveControl {
  fiber: string;
  target: "player" | { event: string };
  eventId: string;
  control: MoveControl;
}

export type PendingMoveOperation = PendingMoveRoute | PendingMoveControl;

/** Battle Processing request published on the tick that parks its fiber. */
export interface PendingBattle {
  fiber: string;
  setup: JsonValue;
}

/** A `place` command published on THIS step. The session
 *  relocates the matching CharState after the fold; the durable position
 *  also lands in InterpState.placements so a later-created character (a
 *  page that only becomes active afterwards) spawns at the new cell. */
export type PendingPlacement = {
  /** Existing event placement spelling is retained for old reducer traces. */
  eventId: string;
  x: number;
  y: number;
  dir: Dir | null;
} | {
  target: "player";
  x: number;
  y: number;
  dir: Dir | null;
};

interface Fiber {
  key: string;
  pageIndex: number;
  parallel: boolean;
  stack: { prog: Prog; pc: number }[];
  mode: "run" | "text" | "choices" | "shop" | "wait" | "animWait" | "external";
  /** Frame on which the current wait/text started. */
  since: number;
  erase: boolean;
}

/** A live map animation instance (InterpState.anims). The list changes
 *  only when a mapAnim/stopAnim command runs or the map is entered (the
 *  interpreter rebuilds on entry, so animations never survive a transfer,
 *  matching Tuxemon's per-map AnimationManager). During playback the
 *  reducer does no per-frame work: the UI derives the frame from `start`
 *  and the compiled timing (animFrameIndex), so playback is identical
 *  under rewind and after a save/load. */
export interface MapAnimInstance {
  /** Author-owned instance id, unique among live instances. stopAnim and
   *  a same-id replay reference it. */
  id: string;
  /** AnimationDef id. */
  anim: string;
  /** Reference tick (interp frame) on which the instance starts playing. */
  start: number;
  /** Fixed tile position (target === null). For a following instance this
   *  is the target's last live cell: it is written at creation and refreshed
   *  every tick the target character is live, so when the target leaves the
   *  map the renderer pins the animation to the cell it last occupied
   *  rather than the creation cell. */
  x: number;
  y: number;
  /** When set, the instance keeps painting on this character's live tile.
   *  "player" is always live; an event target is live only while its
   *  character is on the map (see x/y for the pin on departure). */
  target: "player" | { event: string } | null;
  layer: "below" | "above";
  loop: boolean;
}

/** An AnimationDef compiled for a World's hz: cumulative tick counts per
 *  frame, so frame selection is integer math on the reference clock. */
export interface CompiledAnim {
  /** Number of frames. */
  frames: number;
  /** Cumulative tick at which each frame ends (length = frames). */
  steps: readonly number[];
  /** Ticks for one full playthrough (steps[frames-1]). */
  total: number;
  /** Default loop flag from the def. */
  loop: boolean;
}

/** Compile an AnimationDef's authored seconds into reference ticks. The
 *  frame order is the authored `frames` list, else 0..count-1. */
export function compileAnim(def: AnimationDef, hz: number = TICK_HZ): CompiledAnim {
  const order = def.frames ?? (def.count !== undefined ? Array.from({ length: def.count }, (_, i) => i) : null);
  if (order === null || order.length === 0) {
    throw new Error(`animation ${def.id}: frames or count must name at least one frame`);
  }
  const per = secondsToFrames(def.frameDuration, hz);
  if (per <= 0) {
    throw new Error(`animation ${def.id}: frameDuration must be positive at ${hz} Hz`);
  }
  const steps: number[] = [];
  let acc = 0;
  for (let i = 0; i < order.length; i++) {
    acc += per;
    steps.push(acc);
  }
  return { frames: order.length, steps, total: acc, loop: def.loop === true };
}

/** The frame index an instance shows on reference tick `frame`, or -1 when
 *  a non-looping instance has finished. Pure: same (instance, frame) always
 *  selects the same frame. */
export function animFrameIndex(compiled: CompiledAnim, instance: MapAnimInstance, frame: number): number {
  const elapsed = frame - instance.start;
  if (elapsed < 0) return 0;
  const t = instance.loop ? elapsed % compiled.total : elapsed;
  if (!instance.loop && elapsed >= compiled.total) return -1;
  for (let i = 0; i < compiled.frames; i++) {
    if (t < compiled.steps[i]!) return i;
  }
  return compiled.frames - 1;
}

export interface World {
  hz: number;
  map: MapDef;
  /** Programs are compiled once for this immutable project's id/content. */
  commonPrograms: ReadonlyMap<string, Prog>;
  pagePrograms: ReadonlyMap<string, readonly Prog[]>;
  /** Event order and spatial candidates are compiled once with the world.
   *  Trigger scans then inspect only the current/faced cells plus events
   *  whose autorun/parallel pages or live positions require a dynamic scan. */
  eventsById?: ReadonlyMap<string, GameEvent>;
  cellEvents?: ReadonlyMap<number, readonly GameEvent[]>;
  alwaysScanEvents?: readonly GameEvent[];
  /** The map's events with their eventKey in authored order, and each
   * event id's positions in that list, for per-tick page synchronization.
   * This index assumes map.events is immutable; callers that replace or
   * mutate that array must rebuild the World so the cache is invalidated. */
  keyedEvents?: readonly KeyedEvent[];
  slotsById?: ReadonlyMap<string, readonly number[]>;
  /** Precomputed feature gates for condition context that otherwise needs
   * per-tick event-page records or tile metadata. */
  needsEventPages?: boolean;
  needsTilePropertyContext?: boolean;
  /** True when a page default or route control step needs the KM1 movement
   * path before a standalone moveControl command has created sparse state. */
  needsMovementControlPath?: boolean;
  /** True when a compiled program contains a mapAnim with an event target:
   *  the session then builds InterpInput.liveEventCells so the command can
   *  resolve the target's live character. Zero cost when unused. */
  needsMapAnimTarget?: boolean;
  /** Project item catalog (id -> Item), for a shop's price fallback
   *  (goods entries without their own `price` use the item's own) and its
   *  sell price fallback (floor(item.price / 2) when a shop has no
   *  ShopGood.sellPrice override for the item). */
  items?: ReadonlyMap<string, Item>;
  /** Resolved backpack cap tunables (T2-10/B1, Project.system.inventory).
   *  maxPerItem defaults to SHOP_ITEM_CAP; maxKinds undefined means no cap
   *  on distinct item ids. */
  inventory?: { maxPerItem: number; maxKinds?: number };
  /** Project.system.messageBlocksPlayer: an open box of any fiber holds
   *  the player (messageHoldsPlayer). */
  messageBlocksPlayer?: boolean;
  /** Project animation catalog (AnimationDef id -> compiled timing), for
   *  mapAnim commands and the UI's frame selection. */
  anims: ReadonlyMap<string, CompiledAnim>;
  /** Pure game handlers, retained with the compiled world and never saved. */
  extensions: ExtensionRuntime;
}

/** Options a World is compiled with: Project.system flags, the item
 *  catalog/inventory caps a shop needs, and the session's registered
 *  extension handlers. */
export interface WorldOptions {
  messageBlocksPlayer?: boolean;
  extensions?: ExtensionRuntime;
  items?: readonly Item[];
  inventory?: { maxPerItem?: number; maxKinds?: number };
  animations?: readonly AnimationDef[];
}

export interface KeyedEvent {
  ev: GameEvent;
  key: string;
  /** Position in World.keyedEvents. */
  index: number;
}

/** A world's keyed events and per-id positions, built on the spot for a
 *  World made without createWorld. */
export function keyedEventsOf(w: World): {
  events: readonly KeyedEvent[];
  slotsById: ReadonlyMap<string, readonly number[]>;
} {
  if (w.keyedEvents && w.slotsById) return { events: w.keyedEvents, slotsById: w.slotsById };
  return indexEvents(w.map);
}

function indexEvents(map: MapDef): { events: KeyedEvent[]; slotsById: Map<string, number[]> } {
  const events: KeyedEvent[] = [];
  const slotsById = new Map<string, number[]>();
  for (const ev of map.events ?? []) {
    const index = events.length;
    events.push({ ev, key: eventKey(map.id, ev.id), index });
    const slots = slotsById.get(ev.id);
    if (slots) slots.push(index);
    else slotsById.set(ev.id, [index]);
  }
  return { events, slotsById };
}

export interface InterpError {
  /** `runaway` is an engine execution bound; `content` is an authored
   * command whose live operands cannot be executed safely. */
  kind: "runaway" | "content";
  message: string;
}

export interface InterpState {
  frame: number;
  sw: SwitchState;
  main: Fiber | null;
  parallels: Record<string, Fiber>;
  modal: Modal | null;
  /** Erased event keys, for the rest of this map visit. */
  erased: Record<string, true>;
  /** playerTouch latches: set on entry, cleared once the player leaves. */
  touched: Record<string, true>;
  /** Cross-event input lock. While true the mover ignores the
   *  d-pad and action presses start no event; autorun/parallel still fold.
   *  Per map visit (the interpreter rebuilds on entry). */
  inputLocked: boolean;
  /** Durable per-visit event position overrides from `place`
   *  commands: event id -> tile + facing. syncPages spawns a later-created
   *  character here instead of the authored x/y. Cleared on map entry. */
  placements: Record<string, { x: number; y: number; dir: Dir | null }>;
  /** Page/map-scoped movement overrides. Unlike routes and interpolation,
   *  these character settings are durable and included in v1 saves. The
   *  field is allocated lazily so an old project that never uses a control
   *  retains its byte-for-byte reducer/save shape. */
  moveControls?: MoveControlState;
  /** Live map animation instances (mapAnim/stopAnim). Per map visit: the
   *  interpreter rebuilds on entry, so a transfer clears them. The list
   *  changes only on a start/stop command; playback itself is frame-derived
   *  (animFrameIndex), so a save mid-animation restores pixel-identical.
   *  Omitted when empty so a project without animations keeps byte-identical
   *  state (and saves) against older builds. */
  anims?: MapAnimInstance[];
  /** MV Change Image-style event overrides for this map visit. Each entry
   * is tied to its issuing page and is discarded on the next page change. */
  eventAppearances?: Record<string, EventAppearanceState>;
  /** Named visual-layer changes for this map visit. */
  layers?: Record<string, LayerState>;
  /** Row-major cell index -> runtime passage/edge replacement. */
  tileProperties?: Record<string, TilePropertyOverride>;
  /** Sound cues emitted on this frame; the host drains them after step. */
  cues: SoundCue[];
  pendingTransfer: PendingTransfer | null;
  /** Move routes published on THIS step, in command order. A fiber can
   *  publish more than one before it parks (a fire-and-forget player turn
   *  immediately followed by a waited self-route); the session drains all. */
  pendingMoveRoutes: PendingMoveOperation[];
  /** Battle requests waiting for the scene host, in deterministic fiber
   *  order. Unlike the other pending fields this queue survives interpreter
   *  steps until the session consumes each request. */
  pendingBattles: PendingBattle[];
  /** `place` requests published on THIS step, in command order. */
  pendingPlacements: PendingPlacement[];
  /** Keys of PARALLEL fibers canceled on THIS step because their page
   *  stopped being the active page (condition failed, a higher page took
   *  over, or the event was erased). A key parked in "external" mode names
   *  a route the session must abort: a waited player route is dropped, and
   *  the event-side route is torn down by the character page sync. */
  abortedRoutes: string[];
  /** Fatal interpreter error (review 1274 B1 backstop). Absent on a
   *  healthy state (the key is not serialized, so legal save bytes are
   *  unchanged). Once set, stepInterp freezes every fiber in place: the
   *  host frame loop keeps returning instead of throwing frame after
   *  frame, and the UI shows the message. A save carrying this field is
   *  refused by the decoder (save-validate.ts). */
  error?: InterpError;
}

export function createInterpState(sw: SwitchState = createSwitchState()): InterpState {
  const safeSwitches = createSwitchState(sw);
  return {
    frame: 0,
    sw: safeSwitches,
    main: null,
    parallels: keyedRecord(),
    modal: null,
    erased: keyedRecord(),
    touched: keyedRecord(),
    inputLocked: false,
    placements: keyedRecord(),
    cues: [],
    pendingTransfer: null,
    pendingMoveRoutes: [],
    pendingBattles: [],
    pendingPlacements: [],
    abortedRoutes: [],
  };
}

/** Non-interpreter reasons the player is not in the freely controllable map
 * state. These facts belong to session orchestration or a host-owned menu,
 * so they are sampled for condition evaluation rather than added to saves. */
export interface WorldIdleBlockers {
  sceneActive?: boolean;
  fadeActive?: boolean;
  playerRouteActive?: boolean;
  playerWanderActive?: boolean;
  menuOpen?: boolean;
}

/** Pure, point-in-time world-idle predicate. Parallel fibers do not make the
 * world busy by themselves: only the blocking main fiber does. Pending
 * player routes/transfers/battles count immediately, so a later fiber in the
 * same tick observes work an earlier fiber just published. */
export function isWorldIdle(
  s: InterpState,
  blockers: Readonly<WorldIdleBlockers> = {},
): boolean {
  return (
    s.main === null &&
    s.inputLocked === false &&
    s.modal === null &&
    s.error === undefined &&
    s.pendingTransfer === null &&
    !s.pendingMoveRoutes.some((request) => request.target === "player") &&
    s.pendingBattles.length === 0 &&
    blockers.sceneActive !== true &&
    blockers.fadeActive !== true &&
    blockers.playerRouteActive !== true &&
    blockers.playerWanderActive !== true &&
    blockers.menuOpen !== true
  );
}

function liveConditionContext(
  s: InterpState,
  w: World,
  blockers: Readonly<WorldIdleBlockers> | undefined,
  eventPages?: Readonly<Record<string, EventPageAppearance>>,
): ConditionContext {
  const context: ConditionContext = { worldIdle: isWorldIdle(s, blockers) };
  if (eventPages) {
    context.eventPages = eventPages;
    context.eventAppearances = s.eventAppearances;
  }
  if (w.needsTilePropertyContext) {
    context.tileProperties = s.tileProperties;
    context.mapWidth = w.map.width;
    context.mapHeight = w.map.height;
  }
  return context;
}

const CONTEXT_EVENT_PAGES = 1;
const CONTEXT_TILE_PROPERTIES = 2;
const CONTEXT_MAP_ANIM_TARGET = 4;

function conditionContextFlags(condition: Condition): number {
  if (condition.kind === "appearance" && condition.target !== "player") {
    return CONTEXT_EVENT_PAGES;
  }
  return condition.kind === "tileProperty" ? CONTEXT_TILE_PROPERTIES : 0;
}

function pageConditionContextFlags(condition: PageCondition | undefined): number {
  let flags = 0;
  for (const clause of condition?.all ?? []) flags |= conditionContextFlags(clause);
  return flags;
}

function programContextFlags(program: readonly Instr[]): number {
  let flags = 0;
  for (const instruction of program) {
    if (instruction.op === "appearance" && typeof instruction.target === "object") {
      flags |= CONTEXT_EVENT_PAGES;
    } else if (instruction.op === "if") {
      flags |= conditionContextFlags(instruction.cond);
    } else if (instruction.op === "shop") {
      for (const good of instruction.goods) flags |= pageConditionContextFlags(good.condition);
    } else if (instruction.op === "choices") {
      for (const branch of instruction.branches) flags |= programContextFlags(branch);
      if (instruction.cancel) flags |= programContextFlags(instruction.cancel);
    } else if (instruction.op === "battle") {
      if (instruction.onWin) flags |= programContextFlags(instruction.onWin);
      if (instruction.onLose) flags |= programContextFlags(instruction.onLose);
      if (instruction.onEscape) flags |= programContextFlags(instruction.onEscape);
    } else if (
      instruction.op === "mapAnim" &&
      // A fixed-coordinate mapAnim compiles to `target: null` (the command
      // carries x/y instead). typeof null === "object", so the null check is
      // required: only a `{event}` target needs the live-character set.
      instruction.target !== null &&
      typeof instruction.target === "object"
    ) {
      flags |= CONTEXT_MAP_ANIM_TARGET;
    }
  }
  return flags;
}

function routeUsesMovementControl(route: MoveRoute): boolean {
  return route.steps.some((step) => typeof step === "object" && "control" in step);
}

function programNeedsMovementControlPath(program: readonly Instr[]): boolean {
  for (const instruction of program) {
    if (instruction.op === "moveRoute" && routeUsesMovementControl(instruction.route)) return true;
    if (instruction.op === "choices") {
      if (instruction.branches.some(programNeedsMovementControlPath)) return true;
      if (instruction.cancel && programNeedsMovementControlPath(instruction.cancel)) return true;
    } else if (instruction.op === "battle") {
      if (instruction.onWin && programNeedsMovementControlPath(instruction.onWin)) return true;
      if (instruction.onLose && programNeedsMovementControlPath(instruction.onLose)) return true;
      if (instruction.onEscape && programNeedsMovementControlPath(instruction.onEscape)) return true;
    }
  }
  return false;
}

export function createWorld(
  map: MapDef,
  common: CommonEvent[] = [],
  hz: number = TICK_HZ,
  options: WorldOptions = {},
): World {
  const commonPrograms = new Map<string, Prog>();
  let contextFlags = 0;
  let needsMovementControlPath = false;
  for (const event of common) {
    const program = compile(event.commands, hz);
    commonPrograms.set(event.id, program);
    contextFlags |= programContextFlags(program);
    needsMovementControlPath ||= programNeedsMovementControlPath(program);
  }
  const pagePrograms = new Map<string, readonly Prog[]>();
  for (const event of map.events ?? []) {
    const programs = event.pages.map((page) => compile(page.commands, hz));
    pagePrograms.set(eventKey(map.id, event.id), programs);
    for (let index = 0; index < event.pages.length; index++) {
      const page = event.pages[index]!;
      contextFlags |= pageConditionContextFlags(page.condition);
      contextFlags |= programContextFlags(programs[index]!);
      needsMovementControlPath ||=
        page.moveSpeed !== undefined || page.moveFrequency !== undefined ||
        page.directionFix !== undefined || page.through !== undefined ||
        page.facingMode !== undefined ||
        (page.moveRoute !== undefined && routeUsesMovementControl(page.moveRoute)) ||
        programNeedsMovementControlPath(programs[index]!);
    }
  }
  const orderedEvents = [...(map.events ?? [])]
    .sort((a, b) => (eventIdLess(a.id, b.id) ? -1 : a.id === b.id ? 0 : 1));
  const eventsById = new Map(orderedEvents.map((ev) => [ev.id, ev]));
  const cellEvents = new Map<number, GameEvent[]>();
  const alwaysScanEvents: GameEvent[] = [];
  for (const ev of orderedEvents) {
    if (ev.pages.some((page) => page.trigger === "autorun" || page.trigger === "parallel")) {
      alwaysScanEvents.push(ev);
    }
    const w = ev.w ?? 1;
    const h = ev.h ?? 1;
    const x0 = Math.max(0, ev.x);
    const y0 = Math.max(0, ev.y);
    const x1 = Math.min(map.width, ev.x + w);
    const y1 = Math.min(map.height, ev.y + h);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const cell = y * map.width + x;
        const events = cellEvents.get(cell);
        if (events) events.push(ev);
        else cellEvents.set(cell, [ev]);
      }
    }
  }
  const items = options.items ?? [];
  const itemsById = items.length > 0 ? new Map(items.map((it) => [it.id, it])) : undefined;
  const resolvedInventory = {
    maxPerItem: options.inventory?.maxPerItem ?? SHOP_ITEM_CAP,
    maxKinds: options.inventory?.maxKinds,
  };
  const animsById = new Map((options.animations ?? []).map((def) => [def.id, compileAnim(def, hz)]));
  const keyed = indexEvents(map);
  return {
    hz,
    map,
    commonPrograms,
    pagePrograms,
    eventsById,
    cellEvents,
    alwaysScanEvents,
    keyedEvents: keyed.events,
    slotsById: keyed.slotsById,
    needsEventPages: (contextFlags & CONTEXT_EVENT_PAGES) !== 0,
    needsTilePropertyContext: (contextFlags & CONTEXT_TILE_PROPERTIES) !== 0,
    needsMovementControlPath,
    needsMapAnimTarget: (contextFlags & CONTEXT_MAP_ANIM_TARGET) !== 0,
    items: itemsById,
    inventory: resolvedInventory,
    messageBlocksPlayer: options.messageBlocksPlayer === true,
    anims: animsById,
    extensions: options.extensions ?? createExtensionRuntime(),
  };
}

/** True while the blocking interpreter owns the session: player movement
 *  and free-scroll input freeze (a text/choices/wait/autorun fiber). */
export function isBusy(_s: InterpState): boolean {
  return _s.main !== null;
}

/** True while an open text or choices box holds the player: the project
 *  set system.messageBlocksPlayer and a box is open, whichever fiber owns
 *  it — a PARALLEL page's included. The mover then ignores the d-pad and
 *  no action / playerTouch page starts, so the confirm that advances the
 *  box never also starts the faced event; autorun and parallel pages keep
 *  running. Without the option only a blocking fiber (isBusy) or a
 *  choices box holds the player (v1). */
export function messageHoldsPlayer(w: World, s: InterpState): boolean {
  return w.messageBlocksPlayer === true && s.modal !== null;
}

/** Deep-copy interpreter state without host built-ins. The desktop guest
 *  runs on QuickJS, which has no structuredClone global; compiled programs
 *  are immutable and shared, only the per-fiber pc cursor is copied. */
export function cloneModal(m: Modal | null): Modal | null {
  if (m === null) return null;
  if (m.kind === "text") return { ...m, lines: [...m.lines] };
  if (m.kind === "shop") return { ...m, rows: m.rows.map((row) => ({ ...row })) };
  return {
    ...m,
    options: [...m.options],
    ...(m.keys ? { keys: [...m.keys] } : {}),
    ...(m.enabled ? { enabled: [...m.enabled] } : {}),
  };
}

function cloneMoveRoute(route: MoveRoute): MoveRoute {
  return { ...route, steps: [...route.steps] };
}

function clonePlacements(
  src: Readonly<Record<string, { x: number; y: number; dir: Dir | null }>>,
): Record<string, { x: number; y: number; dir: Dir | null }> {
  const out = keyedRecord<{ x: number; y: number; dir: Dir | null }>();
  for (const key of Object.keys(src)) out[key] = { ...src[key]! };
  return out;
}

function cloneFiber(f: Fiber): Fiber {
  return {
    key: f.key,
    pageIndex: f.pageIndex,
    parallel: f.parallel,
    stack: f.stack.map((frame) => ({ prog: frame.prog, pc: frame.pc })),
    mode: f.mode,
    since: f.since,
    erase: f.erase,
  };
}

type SwitchRecord = "switches" | "self" | "items" | "variables" | "shopStock";

/** Switch-bank records a shareInterp copy still shares with its source.
 *  A record is copied on its first write (ownRecord), so a bank no command
 *  wrote keeps its record identities from state to state, and a record a
 *  state was returned with is never written again. */
const SHARED_RECORDS = new WeakMap<SwitchState, Set<SwitchRecord>>();

/** The switch-bank record `k` of `sw`, copied first if a shareInterp copy
 *  still shares it. Every write to a record of a working copy goes through
 *  here. */
export function ownRecord<K extends SwitchRecord>(sw: SwitchState, k: K): SwitchState[K] {
  const shared = SHARED_RECORDS.get(sw);
  if (shared?.delete(k)) sw[k] = keyedRecord(sw[k] as Record<string, unknown>) as SwitchState[K];
  return sw[k];
}

/** Deep-copy interpreter state for a snapshot or a non-in-place fold. The
 *  switch bank is field-for-field copied; compiled programs and the anims
 *  list are shared (anims is copy-on-write: mapAnim/stopAnim take a private
 *  copy before mutating, so a shared list is never written). */
export function cloneInterp(s0: InterpState): InterpState {
  return copyInterp(s0, {
    switches: keyedRecord(s0.sw.switches),
    self: keyedRecord(s0.sw.self),
    items: keyedRecord(s0.sw.items),
    variables: keyedRecord(s0.sw.variables),
    shopStock: keyedRecord(s0.sw.shopStock),
    gold: s0.sw.gold,
    playerName: s0.sw.playerName ?? DEFAULT_PLAYER_NAME,
    rng: s0.sw.rng,
    ...(s0.sw.playerAppearance ? { playerAppearance: { ...s0.sw.playerAppearance } } : {}),
  }, false);
}

/** cloneInterp for stepSession's private working copy: the switch-bank
 *  records stay shared with `s0` until a write goes through ownRecord.
 *  Callers must not write the records directly. */
export function shareInterp(s0: InterpState): InterpState {
  const sw: SwitchState = {
    switches: s0.sw.switches,
    self: s0.sw.self,
    items: s0.sw.items,
    variables: s0.sw.variables,
    shopStock: s0.sw.shopStock,
    gold: s0.sw.gold,
    playerName: s0.sw.playerName ?? DEFAULT_PLAYER_NAME,
    rng: s0.sw.rng,
    ...(s0.sw.playerAppearance ? { playerAppearance: { ...s0.sw.playerAppearance } } : {}),
  };
  SHARED_RECORDS.set(sw, new Set<SwitchRecord>(["switches", "self", "items", "variables", "shopStock"]));
  return copyInterp(s0, sw, true);
}

function cloneTileProperties(
  source: Readonly<Record<string, TilePropertyOverride>>,
): Record<string, TilePropertyOverride> {
  const out = keyedRecord<TilePropertyOverride>();
  for (const [index, tile] of Object.entries(source)) {
    out[index] = {
      ...tile,
      ...(tile.enter ? { enter: [...tile.enter] } : {}),
      ...(tile.exit ? { exit: [...tile.exit] } : {}),
    };
  }
  return out;
}

function copyInterp(s0: InterpState, sw: SwitchState, shareTileProperties: boolean): InterpState {
  const main = s0.main ? cloneFiber(s0.main) : null;
  const parallels = keyedRecord<Fiber>();
  for (const key of Object.keys(s0.parallels)) parallels[key] = cloneFiber(s0.parallels[key]!);
  const s: InterpState = {
    frame: s0.frame,
    // `sw` is either a field-for-field deep bank copy (cloneInterp) or a
    // record-sharing COW bank (shareInterp). Neither path normalizes values:
    // live content errors must remain observable until an explicit save or
    // restore boundary validates them.
    sw,
    main,
    parallels,
    modal: cloneModal(s0.modal),
    erased: keyedRecord(s0.erased),
    touched: keyedRecord(s0.touched),
    inputLocked: s0.inputLocked,
    placements: clonePlacements(s0.placements),
    // The anims list is mutated only by mapAnim/stopAnim (which copy it
    // first via writableAnims), so a working copy shares the source array:
    // steady-state playback costs no per-frame clone.
    anims: s0.anims,
    ...(s0.eventAppearances ? {
      eventAppearances: Object.fromEntries(
        Object.entries(s0.eventAppearances).map(([id, appearance]) => [id, { ...appearance }]),
      ),
    } : {}),
    ...(s0.layers ? {
      layers: Object.fromEntries(
        Object.entries(s0.layers).map(([id, layer]) => [id, { ...layer }]),
      ),
    } : {}),
    ...(s0.tileProperties ? {
      tileProperties: shareTileProperties ? s0.tileProperties : cloneTileProperties(s0.tileProperties),
    } : {}),
    cues: s0.cues.map((cue) => ({ ...cue })),
    pendingTransfer: s0.pendingTransfer ? { ...s0.pendingTransfer } : null,
    pendingMoveRoutes: s0.pendingMoveRoutes.map((r) => "control" in r
      ? { ...r, control: deepClone(r.control) as MoveControl }
      : { ...r, route: cloneMoveRoute(r.route) }),
    pendingBattles: s0.pendingBattles.map((request) => ({
      fiber: request.fiber,
      setup: deepClone(request.setup),
    })),
    pendingPlacements: s0.pendingPlacements.map((p) => ({ ...p })),
    abortedRoutes: [...s0.abortedRoutes],
  };
  if (s0.moveControls) s.moveControls = cloneMoveControlState(s0.moveControls);
  if (s0.error) s.error = { ...s0.error };
  return s;
}


// --- trigger arbitration ------------------------------------------------------

const FRONT: Record<Facing, [number, number]> = {
  0: [0, 1], // down
  1: [-1, 0], // left
  2: [0, -1], // up
  3: [1, 0], // right
};

/** The live top-left of an event's area rectangle: its moving character
 *  cell, else a durable `place` override, else the authored (x,y). */
function eventOrigin(ev: GameEvent, s: InterpState, input: InterpInput): Cell {
  return (
    (input.eventCells ? keyedValue(input.eventCells, ev.id) : undefined) ??
    keyedValue(s.placements, ev.id) ??
    { x: ev.x, y: ev.y }
  );
}

/** Drop finished one-shot instances so the list cannot grow without bound
 *  across a long map visit. Called only from mapAnim/stopAnim, never per
 *  frame: playback itself stays allocation-free. A looping instance is
 *  never pruned. */
/** A writable anims list for a mutating command. copyInterp shares the
 *  source array (steady-state playback clones nothing), so the first
 *  mutation of a step takes a private copy; an empty list is created on
 *  demand. The copy is shallow — instances are replaced, never mutated. */
function writableAnims(s: InterpState): MapAnimInstance[] {
  if (s.anims === undefined) {
    s.anims = [];
    return s.anims;
  }
  s.anims = [...s.anims];
  return s.anims;
}

function pruneMapAnims(s: InterpState, w: World): void {
  const anims = s.anims;
  if (!anims || anims.length === 0) return;
  const isDead = (a: MapAnimInstance): boolean => {
    const compiled = w.anims.get(a.anim);
    return !!compiled && !a.loop && s.frame - a.start >= compiled.total;
  };
  let firstDead = -1;
  for (let i = 0; i < anims.length; i++) {
    if (isDead(anims[i]!)) { firstDead = i; break; }
  }
  if (firstDead < 0) return; // nothing to prune; keep the shared array
  const kept = anims.slice(0, firstDead);
  for (let i = firstDead + 1; i < anims.length; i++) {
    const a = anims[i]!;
    if (!isDead(a)) kept.push(a);
  }
  s.anims = kept.length === 0 ? undefined : kept;
}

/** Refresh every event-following instance's anchor to its target's live
 *  cell. The renderer paints a following instance on the character's live
 *  pixel while it is on the map, and falls back to the instance's x/y once
 *  the character leaves (erased / page off). Without this refresh that
 *  fallback is the creation cell, so an animation bound at (5,6) would jump
 *  back to (5,6) after the character walked to (7,1) and vanished. The
 *  session only builds `liveEventCells` for worlds with the mapAnim-target
 *  capability, so this whole path is skipped (zero cost) when no event
 *  target is authored. The array is copied only when an anchor actually
 *  moves, so a stationary target allocates nothing. */
function syncFollowAnchors(s: InterpState, input: InterpInput): void {
  const cells = input.liveEventCells;
  if (!cells) return;
  const anims = s.anims;
  if (!anims || anims.length === 0) return;
  let firstMoved = -1;
  for (let i = 0; i < anims.length; i++) {
    const a = anims[i]!;
    if (a.target === null || a.target === "player") continue;
    const cell = keyedValue(cells, a.target.event);
    if (cell && (a.x !== cell.x || a.y !== cell.y)) { firstMoved = i; break; }
  }
  if (firstMoved < 0) return; // every follower is stationary or targetless
  const writable = writableAnims(s);
  for (let i = firstMoved; i < writable.length; i++) {
    const a = writable[i]!;
    if (a.target === null || a.target === "player") continue;
    const cell = keyedValue(cells, a.target.event);
    if (cell && (a.x !== cell.x || a.y !== cell.y)) {
      writable[i] = { ...a, x: cell.x, y: cell.y };
    }
  }
}

interface Rect {
  x0: number;
  y0: number;
  x1: number; // inclusive
  y1: number; // inclusive
}

/** An event's w×h area. Defaults to 1×1. A zero-width or
 *  zero-height area contains no cell: Tuxemon's boundary.py treats such a
 *  box as never matching, so the event can never touch/action-fire. */
function eventRect(ev: GameEvent, origin: Cell): Rect | null {
  const w = ev.w ?? 1;
  const h = ev.h ?? 1;
  if (w < 1 || h < 1) return null;
  return { x0: origin.x, y0: origin.y, x1: origin.x + w - 1, y1: origin.y + h - 1 };
}

function cellInRect(c: Cell, r: Rect): boolean {
  return c.x >= r.x0 && c.x <= r.x1 && c.y >= r.y0 && c.y <= r.y1;
}

function indexedEventsAt(w: World, cell: Cell): readonly GameEvent[] {
  if (cell.x < 0 || cell.y < 0 || cell.x >= w.map.width || cell.y >= w.map.height) return [];
  return w.cellEvents?.get(cell.y * w.map.width + cell.x) ?? [];
}

function worldEventById(w: World, id: string): GameEvent | undefined {
  return w.eventsById?.get(id) ?? (w.map.events ?? []).find((ev) => ev.id === id);
}

/** Events that can react this frame, in deterministic event-id order.
 *  Authored areas come from the per-cell index. Autorun/parallel pages are
 *  always eligible, while placed or moving events are added dynamically
 *  because their live rectangle no longer matches the authored index. */
function triggerCandidates(s: InterpState, w: World, input: InterpInput): GameEvent[] {
  // Keep structural compatibility for callers that construct a World
  // directly instead of using createWorld(): without an index, conservatively
  // scan every event in the same deterministic order as the original fold.
  if (!w.eventsById || !w.cellEvents || !w.alwaysScanEvents) {
    return [...(w.map.events ?? [])]
      .sort((a, b) => (eventIdLess(a.id, b.id) ? -1 : a.id === b.id ? 0 : 1));
  }
  const byId = new Map<string, GameEvent>();
  const add = (events: readonly GameEvent[]): void => {
    for (const ev of events) byId.set(ev.id, ev);
  };
  add(w.alwaysScanEvents);
  add(indexedEventsAt(w, input.playerCell));
  const [fx, fy] = FRONT[input.facing];
  add(indexedEventsAt(w, { x: input.playerCell.x + fx, y: input.playerCell.y + fy }));
  for (const id of Object.keys(s.placements)) {
    const ev = w.eventsById.get(id);
    if (ev) byId.set(id, ev);
  }
  if (input.eventCells) {
    for (const id of Object.keys(input.eventCells)) {
      const ev = w.eventsById.get(id);
      const cell = input.eventCells[id]!;
      if (ev && (cell.x !== ev.x || cell.y !== ev.y)) byId.set(id, ev);
    }
  }
  return [...byId.values()]
    .sort((a, b) => (eventIdLess(a.id, b.id) ? -1 : a.id === b.id ? 0 : 1));
}

function startFiber(
  s: InterpState,
  key: string,
  pageIndex: number,
  parallel: boolean,
  prog: Prog,
): Fiber {
  return {
    key,
    pageIndex,
    parallel,
    stack: [{ prog, pc: 0 }],
    mode: "run",
    since: s.frame,
    erase: false,
  };
}

/** Page-scoped parallel lifecycle: a parallel fiber belongs to the page
 *  that started it. When that page stops being active before the fiber
 *  finishes — its condition fails, a higher-index page takes over, or the
 *  event is erased — the fiber is canceled on the next frame. It does not
 *  run to completion: a `wait` past the cancellation frame never applies.
 *  A canceled fiber parked on an external route reports its key so the
 *  session can abort the matching player/event move route. */
function cancelStaleParallels(
  s: InterpState,
  w: World,
  facing: Facing,
  extension: ExtensionScope,
  input: InterpInput,
): void {
  for (const key of Object.keys(s.parallels)) {
    const f = s.parallels[key]!;
    const ev = worldEventById(w, key.slice(w.map.id.length + 1));
    const active = ev && !s.erased[key]
      ? activePage(ev, s.sw, w.map.id, facing, extension,
          liveConditionContext(s, w, input.worldIdleBlockers, input.eventPages))
      : null;
    // Same page still active: keep running. A page change (index differs)
    // cancels; scanTriggers restarts a fiber for the new page on this step.
    if (active && active.index === f.pageIndex) continue;
    if (f.mode === "external") s.abortedRoutes.push(f.key);
    if (s.modal?.fiber === f.key) s.modal = null;
    delete s.parallels[key];
  }
}

function scanTriggers(s: InterpState, w: World, input: InterpInput, extension: ExtensionScope): void {
  const rectOf = (ev: GameEvent): Rect | null => eventRect(ev, eventOrigin(ev, s, input));
  const moved = input.prevCell.x !== input.playerCell.x || input.prevCell.y !== input.playerCell.y;
  const prevFacing = input.prevFacing ?? input.facing;
  const turned = prevFacing !== input.facing;
  // Sampled once, before any fiber folds this step: the box that is open
  // when the confirm edge arrives is the one the press belongs to.
  const held = messageHoldsPlayer(w, s);
  // Release touch latches. A latch only blocks a re-fire while the player
  // stands on the SAME cell: stepping to another cell releases it even when
  // that cell is still inside the area (every step into an area cell
  // is a fresh entry), and walking off releases it outright.
  for (const key of Object.keys(s.touched)) {
    const ev = worldEventById(w, key.slice(w.map.id.length + 1));
    if (!ev) {
      delete s.touched[key];
      continue;
    }
    const r = rectOf(ev);
    if (moved || !r || !cellInRect(input.playerCell, r)) delete s.touched[key];
  }
  // Ascending event-id order so parallel starts and the blocking-fiber
  // choice are deterministic across frames. The order is explicit UTF-16
  // code units (eventIdLess), never localeCompare, whose collation differs
  // between the Bun and QuickJS hosts (review C12).
  for (const ev of triggerCandidates(s, w, input)) {
    const key = eventKey(w.map.id, ev.id);
    if (s.erased[key]) continue;
    // Page selection sees the live player facing, so a `facing` clause
    // gates the page by direction.
    const active = activePage(
      ev,
      s.sw,
      w.map.id,
      input.facing,
      extension,
      liveConditionContext(s, w, input.worldIdleBlockers, input.eventPages),
    );
    if (!active) continue;
    const { page, index } = active;
    // A page with no commands has no fiber: an opened gate's touch page and
    // a victory event's spent parallel page are inert markers, not
    // per-frame start/finish spin.
    if (page.commands.length === 0) continue;
    if (page.trigger === "parallel") {
      if (!keyedValue(s.parallels, key)) {
        s.parallels[key] = startFiber(s, key, index, true, w.pagePrograms.get(key)![index]!);
      }
      continue;
    }
    if (s.main) continue; // one blocking fiber at a time
    if (page.trigger === "autorun") {
      s.main = startFiber(s, key, index, false, w.pagePrograms.get(key)![index]!);
    } else if (page.trigger === "action") {
      // While the cross-event input lock is held, confirm presses
      // start no event (the cutscene owns control); autorun/parallel above
      // still run. A box holding the player owns the press the same way.
      if (s.inputLocked || held || !input.confirmEdge) continue;
      // MV parity: action button starts the event one tile in FRONT of the
      // player (NPCs block the tile; below-character signs are faced, not
      // stood on) OR sharing the player's cell (a plate the player walked
      // onto). With an area either tile may lie anywhere in the
      // w×h rect, so a multi-cell counter is confirmable from any edge.
      const r = rectOf(ev);
      if (!r) continue;
      const [fx, fy] = FRONT[input.facing];
      const front = { x: input.playerCell.x + fx, y: input.playerCell.y + fy };
      if (cellInRect(front, r) || cellInRect(input.playerCell, r)) {
        s.main = startFiber(s, key, index, false, w.pagePrograms.get(key)![index]!);
      }
    } else if (page.trigger === "playerTouch") {
      if (held) continue;
      const r = rectOf(ev);
      if (!r || !cellInRect(input.playerCell, r)) continue;
      // Entry/step edge: moved onto an unlatched area cell.
      const stepEdge = moved && !s.touched[key];
      // Turn edge: a page whose condition reads facing re-fires when
      // the player turns in place to the direction the page now requires.
      const turnEdge = turned && !moved && pageReadsFacing(page);
      if (stepEdge || turnEdge) {
        s.touched[key] = true;
        s.main = startFiber(s, key, index, false, w.pagePrograms.get(key)![index]!);
      }
    }
  }
}

// --- fiber execution -----------------------------------------------------------

type InstantInstr = Extract<
  Instr,
  | { op: "switch" }
  | { op: "variable" }
  | { op: "selfSwitch" }
  | { op: "gold" }
  | { op: "item" }
  | { op: "se" }
>;

/** T2-16/B3: the single normalizer for every numeric value that lands in
 *  saveable state — variables, gold, item/shopStock counts, and the
 *  project's initial gold. Every one of those writes must round-trip
 *  through save.ts's finite-number check, so every one of them clamps
 *  through here rather than doing raw arithmetic: a non-integer result (a
 *  floor-division quotient) rounds down (MV's Game_Variables.setValue and
 *  Tuxemon's `//` both floor; -7/2 = -4, not the -3 Math.trunc gives), and
 *  anything outside the safe range clamps to its boundary instead of
 *  drifting into Infinity/NaN: an unclamped 1e308*1e308 (or a shop selling
 *  at an authored sellPrice: 1e308 — schema only requires "integer", not a
 *  bounded one) overflows the double range to Infinity, which
 *  JSON.stringify turns into null and save-validate.ts then refuses to
 *  load. NaN cannot arise from a clamped operand under the ops below
 *  (div/mod-by-zero leave the variable unchanged rather than computing);
 *  the fallback is defensive. B1 (fix 3) extends this to every
 *  construction/restore entry point — `createSwitchState` (used directly by
 *  `createInterpState` and by save-restore.ts's `restoreSessionSnapshot`) —
 *  via `clampVarRecord`/`clampVariableRecord`, and to the ext/battle write
 *  points below, so a hand-built init, a restored save or an ext
 *  command/battle completion cannot smuggle a non-safe-integer value past
 *  those. `cloneInterp` itself stays a plain copy: it also runs on every
 *  live step, where a content-error check must still see an out-of-range
 *  value a bug introduced mid-frame instead of having it floored away. */
const MAX_SAFE_VAR = Number.MAX_SAFE_INTEGER;
export function clampFiniteVar(n: number): number {
  if (Number.isNaN(n)) return 0;
  const floored = Math.floor(n);
  if (floored > MAX_SAFE_VAR) return MAX_SAFE_VAR;
  if (floored < -MAX_SAFE_VAR) return -MAX_SAFE_VAR;
  return floored;
}

/** Apply an extension/battle item patch without mutating the live backpack.
 * Counts replace rather than add: finite values are floored, clamped to
 * [0, maxPerItem], and zero deletes the id. Existing positive kinds keep
 * their slots. Once removals have freed slots, previously unheld positive
 * ids are admitted in lexical id order until maxKinds; the rest are
 * deterministically discarded. */
export function replaceItemCounts(
  current: Readonly<Record<string, number>>,
  replacements: Readonly<Record<string, number>>,
  inventory?: Readonly<{ maxPerItem?: number; maxKinds?: number }>,
): Record<string, number> {
  const next = keyedRecord(current);
  const normalized = keyedRecord<number>();
  const ids = Object.keys(replacements).sort();
  const maxPerItem = inventory?.maxPerItem ?? SHOP_ITEM_CAP;

  for (const id of ids) {
    normalized[id] = Math.min(maxPerItem, Math.max(0, clampFiniteVar(replacements[id]!)));
    delete next[id];
  }

  const newKinds: string[] = [];
  for (const id of ids) {
    const count = normalized[id]!;
    if (count === 0) continue;
    if ((current[id] ?? 0) > 0) next[id] = count;
    else newKinds.push(id);
  }

  let heldKinds = kindsHeld(next);
  for (const id of newKinds) {
    if (inventory?.maxKinds !== undefined && heldKinds >= inventory.maxKinds) continue;
    next[id] = normalized[id]!;
    heldKinds++;
  }
  return next;
}

/** clampFiniteVar over every value of a numeric bank (items/shopStock).
 *  `nonNegative` additionally floors at 0, for shopStock's non-negative
 *  invariant. Used by createSwitchState, which construction, restore and
 *  the save boundary (save.ts normalizeInterp) all go through, so they
 *  share the normalizer every runtime write uses. cloneInterp, the
 *  per-frame copy, deliberately copies the banks verbatim. */
function clampVarRecord(
  src: Readonly<Record<string, number>> | undefined,
  nonNegative = false,
): Record<string, number> {
  const out = keyedRecord(src);
  for (const key of Object.keys(out)) {
    const clamped = clampFiniteVar(out[key]!);
    out[key] = nonNegative ? Math.max(0, clamped) : clamped;
  }
  return out;
}

/** Same normalization for the variables bank, which may also hold strings
 *  (VariableValue): a string entry passes through unchanged. */
function clampVariableRecord(
  src: Readonly<Record<string, VariableValue>> | undefined,
): Record<string, VariableValue> {
  const out = keyedRecord(src);
  for (const key of Object.keys(out)) {
    const v = out[key]!;
    if (typeof v === "number") out[key] = clampFiniteVar(v);
  }
  return out;
}

function runInstant(s: InterpState, f: Fiber, ins: InstantInstr): void {
  switch (ins.op) {
    case "switch":
      ownRecord(s.sw, "switches")[ins.id] = ins.value;
      break;
    case "variable": {
      const variables = ownRecord(s.sw, "variables");
      if (ins.set.op === "random") {
        const r = randInt(s.sw.rng, ins.set.min, ins.set.max);
        variables[ins.id] = clampFiniteVar(r.value);
        s.sw.rng = r.next;
      } else if ("from" in ins.set) {
        // T2-16: the operand is another variable's live value (target OP
        // source); div/mod by a source reading 0 leave the variable
        // unchanged (Tuxemon's safe_floordiv returns the left operand)
        // instead of writing 0 or a non-finite result. "copy" alone may
        // move a string source value across (VariableValue, an extension
        // write); the arithmetic ops treat a non-number source/target as 0.
        const op = ins.set.op;
        if (op === "copy") {
          const b = variables[ins.set.from] ?? 0;
          variables[ins.id] = typeof b === "number" ? clampFiniteVar(b) : b;
        } else {
          const held = variables[ins.id];
          const a = typeof held === "number" ? held : 0;
          const source = variables[ins.set.from];
          const b = typeof source === "number" ? source : 0;
          variables[ins.id] = clampFiniteVar(
            op === "add" ? a + b
            : op === "sub" ? a - b
            : op === "mul" ? a * b
            : op === "div" ? (b === 0 ? a : Math.floor(a / b))
            : b === 0 ? a : a % b, // mod
          );
        }
      } else {
        const held = variables[ins.id];
        const cur = typeof held === "number" ? held : 0;
        variables[ins.id] = clampFiniteVar(
          ins.set.op === "set" ? ins.set.value
          : ins.set.op === "add" ? cur + ins.set.value
          : cur - ins.set.value,
        );
      }
      break;
    }
    case "selfSwitch":
      ownRecord(s.sw, "self")[f.key] = ins.value ? ins.key : undefined;
      break;
    case "gold":
      s.sw.gold = clampFiniteVar(s.sw.gold + (ins.set === "add" ? ins.amount : -ins.amount));
      break;
    case "item": {
      const items = ownRecord(s.sw, "items");
      items[ins.item] = clampFiniteVar(
        (items[ins.item] ?? 0) + (ins.set === "add" ? ins.count : -ins.count),
      );
      break;
    }
    case "se":
      s.cues.push({ name: ins.name, volume: ins.volume, pitch: ins.pitch });
      break;
  }
}

function finishFiber(s: InterpState, f: Fiber): void {
  if (f.erase) s.erased[f.key] = true;
  if (s.modal?.fiber === f.key) s.modal = null;
  if (f.parallel) delete s.parallels[f.key];
  else if (s.main?.key === f.key) s.main = null;
}

/** goods.price overrides the shop's asking price; otherwise it falls back
 *  to the item's own catalog price (0 when the item is absent/priceless). */
function resolveGoodsPrice(good: ShopGood, items: World["items"]): number {
  if (good.price !== undefined) return good.price;
  return items?.get(good.item)?.price ?? 0;
}

/** T2-10/B1: SwitchState.shopStock key for one shop's tracking of one
 *  item's remaining units. */
function shopStockKey(shopId: string, item: string): string {
  return `${shopId}:${item}`;
}

/** Live remaining stock for a goods row, or null when it has no authored
 *  `stock` (unlimited). Falls back to the authored starting value until a
 *  buy/sell at this shop first writes a live counter. */
function goodsStock(good: ShopGood, shopId: string, sw: SwitchState): number | null {
  if (good.stock === undefined) return null;
  const live = keyedValue(sw.shopStock, shopStockKey(shopId, good.item));
  return live !== undefined ? live : good.stock;
}

/** Number of DISTINCT item ids currently held (count > 0), for the
 *  Project.system.inventory.maxKinds cap. */
function kindsHeld(items: Readonly<Record<string, number>>): number {
  let n = 0;
  for (const id of Object.keys(items)) if ((items[id] ?? 0) > 0) n++;
  return n;
}

/** Rows for the shop box's active stage, rebuilt fresh from live
 *  gold/stock/backpack every step the modal is open. "buy": goods in
 *  authored order (a ShopGood.condition that fails hides its row
 *  entirely), then an optional "sell" row, then "leave". "sell": every
 *  item the player holds (id order, deterministic) — an unsellable one
 *  omitted when `sellList` is "hide", else listed with sellable:false —
 *  then "back". Never empty: a control row is always present, so the
 *  cursor always has something to land on. */
function shopRows(
  stage: "buy" | "sell",
  ins: Extract<Instr, { op: "shop" }>,
  w: World,
  state: InterpState,
  eventKey: string,
  extension: ExtensionScope,
  input: InterpInput,
): ShopRow[] {
  const sw = state.sw;
  if (stage === "buy") {
    const maxPerItem = w.inventory?.maxPerItem ?? SHOP_ITEM_CAP;
    const maxKinds = w.inventory?.maxKinds;
    const heldKinds = maxKinds !== undefined ? kindsHeld(sw.items) : 0;
    const rows: ShopRow[] = [];
    for (const g of ins.goods) {
      if (g.condition && !conditionHolds(
        g.condition,
        sw,
        eventKey,
        undefined,
        extension,
        liveConditionContext(state, w, input.worldIdleBlockers, input.eventPages),
      )) continue;
      const price = resolveGoodsPrice(g, w.items);
      const owned = keyedValue(sw.items, g.item) ?? 0;
      const stock = goodsStock(g, ins.id, sw);
      const wouldExceedKinds = owned === 0 && maxKinds !== undefined && heldKinds >= maxKinds;
      const outOfStock = stock !== null && stock <= 0;
      rows.push({
        kind: "item", item: g.item, price, owned,
        canAfford: sw.gold >= price,
        atCap: owned >= maxPerItem || wouldExceedKinds || outOfStock,
        stock,
        sellable: true,
      });
    }
    if (ins.sell) rows.push({ kind: "sell" });
    rows.push({ kind: "leave" });
    return rows;
  }
  const goodsByItem = new Map(ins.goods.map((g) => [g.item, g] as const));
  const rows: ShopRow[] = [];
  for (const id of Object.keys(sw.items).sort()) {
    const owned = sw.items[id] ?? 0;
    if (owned <= 0) continue;
    const item = w.items?.get(id);
    const good = goodsByItem.get(id);
    const base = item?.price ?? 0;
    const price = good?.sellPrice ?? Math.floor(base / 2);
    // B4: sellable defaults to true whenever the effective price is > 0,
    // but an explicit Item.sellable:false always wins, and a 0 effective
    // price is never sellable regardless of the flag.
    const sellable = (item?.sellable ?? true) && price > 0;
    if (!sellable && ins.sellList === "hide") continue;
    rows.push({ kind: "item", item: id, price, owned, canAfford: true, atCap: false, stock: null, sellable });
  }
  rows.push({ kind: "back" });
  return rows;
}

interface StepBudget {
  remaining: number;
}

interface MutableExtensionScope extends ExtensionScope {
  ext: JsonValue;
}

function extensionReadContext(
  s: InterpState,
  extension: ExtensionScope,
): ExtensionReadContext {
  return {
    ext: deepClone(extension.ext),
    switches: s.sw.switches,
    variables: s.sw.variables,
    items: s.sw.items,
    gold: s.sw.gold,
  };
}

/** Validate every mutation before publishing any of it. `directWrites` are
 * extChoice's authored result sinks; overlapping resolver writes are a
 * contract error rather than a hidden last-writer rule. */
function applyExtensionResult(
  s: InterpState,
  w: World,
  extension: MutableExtensionScope,
  label: string,
  rawResult: unknown,
  directWrites: readonly (readonly [string, VariableValue])[] = [],
): void {
  if (rawResult !== undefined && (
    rawResult === null || typeof rawResult !== "object" || Array.isArray(rawResult)
  )) {
    throw new Error(`${label} must return an object or undefined`);
  }
  const result = rawResult as ExtensionCommandResult | undefined;
  let nextExt = extension.ext;
  if (result && Object.prototype.hasOwnProperty.call(result, "ext")) {
    assertJsonValue(result.ext, `${label} result.ext`);
    nextExt = cloneExtension(extension.runtime, result.ext!, `${label} result.ext`);
  }
  const writes: [string, VariableValue][] = [];
  const writeIds = new Set<string>();
  if (result?.writes !== undefined) {
    if (result.writes === null || typeof result.writes !== "object" || Array.isArray(result.writes)) {
      throw new Error(`${label} result.writes must be a record`);
    }
    for (const id of Object.keys(result.writes)) {
      const value = result.writes[id];
      if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) {
        throw new Error(`${label} write ${JSON.stringify(id)} must be a string or finite number`);
      }
      writes.push([id, value]);
      writeIds.add(id);
    }
  }
  for (const [id, value] of directWrites) {
    if (writeIds.has(id)) {
      throw new Error(`${label} result.writes conflicts with extChoice write target ${JSON.stringify(id)}`);
    }
    writeIds.add(id);
    writes.push([id, value]);
  }
  let itemReplacements: Record<string, number> | undefined;
  if (result?.items !== undefined) {
    if (result.items === null || typeof result.items !== "object" || Array.isArray(result.items)) {
      throw new Error(`${label} result.items must be a record`);
    }
    itemReplacements = keyedRecord();
    for (const id of Object.keys(result.items)) {
      const value = result.items[id];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${label} item ${JSON.stringify(id)} must be a finite number`);
      }
      itemReplacements[id] = value;
    }
  }
  let gold: number | undefined;
  if (result?.gold !== undefined) {
    if (typeof result.gold !== "number" || !Number.isFinite(result.gold)) {
      throw new Error(`${label} result.gold must be a finite number`);
    }
    gold = Math.max(0, clampFiniteVar(result.gold));
  }

  // Validate and normalize every returned bank before publishing any of
  // them. The next instruction/condition therefore observes one atomic
  // ext/variable/item/gold replacement.
  const items = itemReplacements === undefined
    ? undefined
    : replaceItemCounts(s.sw.items, itemReplacements, w.inventory);
  extension.ext = nextExt;
  const variables = writes.length > 0 ? ownRecord(s.sw, "variables") : null;
  for (const [id, value] of writes) {
    // B1 (fix 3): an ext command's numeric write shares the same
    // finite-safe-integer normalizer as every other variable write.
    variables![id] = typeof value === "number" ? clampFiniteVar(value) : value;
  }
  if (items !== undefined) s.sw.items = items;
  if (gold !== undefined) s.sw.gold = gold;
}

function runExtensionMutation(
  s: InterpState,
  w: World,
  extension: MutableExtensionScope,
  label: string,
  invoke: (context: ExtensionCommandContext) => ExtensionCommandResult | void,
  directWrites: readonly (readonly [string, VariableValue])[] = [],
): void {
  let cursor = s.sw.rng;
  const context: ExtensionCommandContext = {
    ...extensionReadContext(s, extension),
    random: () => {
      const draw = rngNext(cursor);
      cursor = draw.next;
      return draw.value;
    },
  };
  const result = invoke(context);
  s.sw.rng = cursor;
  applyExtensionResult(s, w, extension, label, result, directWrites);
}

function runExtensionCommand(
  s: InterpState,
  w: World,
  extension: MutableExtensionScope,
  call: string,
  args: JsonValue,
): void {
  // Registration is validated when each map is acquired. A missing handler
  // or malformed handler result therefore violates the game-programming
  // contract, rather than being an authored event/variable failure; these
  // assertions intentionally throw instead of becoming content errors.
  const handler = extension.runtime.commands[call];
  if (!handler) {
    if (extension.runtime.allowUnknown) return;
    throw new Error(`extension command ${JSON.stringify(call)} is not registered`);
  }
  runExtensionMutation(
    s,
    w,
    extension,
    `extension command ${JSON.stringify(call)}`,
    (context) => handler(context, deepClone(args)),
  );
}

interface ResolvedExtensionChoiceOption {
  key: string;
  label: string;
  enabled: boolean;
  data: JsonValue;
}

/** Recompute and validate an extChoice list from the current reducer state.
 * null is the preview-only unknown-call sentinel; [] is a valid cancellable
 * list. */
function extensionChoiceOptions(
  s: InterpState,
  extension: MutableExtensionScope,
  ins: Extract<Instr, { op: "extChoice" }>,
): ResolvedExtensionChoiceOption[] | null {
  const handler = extension.runtime.choices[ins.call];
  if (!handler) {
    if (extension.runtime.allowUnknown) return null;
    throw new Error(`extension choice ${JSON.stringify(ins.call)} is not registered`);
  }
  const raw = handler.options(extensionReadContext(s, extension), deepClone(ins.args));
  if (!Array.isArray(raw)) {
    throw new Error(`extension choice ${JSON.stringify(ins.call)} options must return an array`);
  }
  const seen = new Set<string>();
  const options: ResolvedExtensionChoiceOption[] = [];
  for (let index = 0; index < raw.length; index++) {
    const option = raw[index];
    const at = `extension choice ${JSON.stringify(ins.call)} option ${index}`;
    if (option === null || typeof option !== "object" || Array.isArray(option)) {
      throw new Error(`${at} must be an object`);
    }
    if (typeof option.key !== "string" || option.key.length === 0) {
      throw new Error(`${at}.key must be a non-empty string`);
    }
    if (seen.has(option.key)) {
      throw new Error(`extension choice ${JSON.stringify(ins.call)} option key ${JSON.stringify(option.key)} is duplicated`);
    }
    seen.add(option.key);
    if (typeof option.label !== "string" || option.label.length === 0) {
      throw new Error(`${at}.label must be a non-empty string`);
    }
    if (option.enabled !== undefined && typeof option.enabled !== "boolean") {
      throw new Error(`${at}.enabled must be a boolean`);
    }
    const data = option.data ?? null;
    assertJsonValue(data, `${at}.data`);
    options.push({
      key: option.key,
      label: option.label,
      enabled: option.enabled ?? true,
      data: deepClone(data),
    });
  }
  if (!ins.cancel && !options.some((option) => option.enabled)) {
    throw new Error(`extension choice ${JSON.stringify(ins.call)} must provide an enabled option when cancel is false`);
  }
  return options;
}

function extensionChoiceDirectWrites(
  write: Readonly<ExtensionChoiceWrite> | null,
  result: ExtensionChoiceResult,
): [string, VariableValue][] {
  if (!write) return [];
  const values = result.kind === "select"
    ? { index: result.index, key: result.key, cancelled: 0 }
    : { index: -1, key: "", cancelled: 1 };
  const writes: [string, VariableValue][] = [];
  const seen = new Set<string>();
  for (const field of ["index", "key", "cancelled"] as const) {
    const id = write[field];
    if (id === undefined) continue;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`extChoice write.${field} must be a non-empty variable id`);
    }
    if (seen.has(id)) throw new Error("extChoice write destinations must be distinct");
    seen.add(id);
    writes.push([id, values[field]]);
  }
  return writes;
}

function resolveExtensionChoice(
  s: InterpState,
  w: World,
  extension: MutableExtensionScope,
  ins: Extract<Instr, { op: "extChoice" }>,
  result: ExtensionChoiceResult,
): void {
  const handler = extension.runtime.choices[ins.call];
  if (!handler) {
    if (extension.runtime.allowUnknown) return;
    throw new Error(`extension choice ${JSON.stringify(ins.call)} is not registered`);
  }
  const directWrites = extensionChoiceDirectWrites(ins.write, result);
  const label = `extension choice ${JSON.stringify(ins.call)} resolver`;
  if (handler.resolve) {
    runExtensionMutation(
      s,
      w,
      extension,
      label,
      (context) => handler.resolve!(context, deepClone(ins.args), deepClone(result)),
      directWrites,
    );
  } else {
    applyExtensionResult(s, w, extension, label, undefined, directWrites);
  }
}

function variableRef(value: unknown): value is VariableRef {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    typeof (value as VariableRef).variable === "string";
}

function resolveTransfer(
  s: InterpState,
  ins: Extract<Instr, { op: "transfer" }>,
  fiber: string,
): Omit<PendingTransfer, "fiber"> | null {
  const map = variableRef(ins.map) ? s.sw.variables[ins.map.variable] : ins.map;
  const x = variableRef(ins.x) ? s.sw.variables[ins.x.variable] : ins.x;
  const y = variableRef(ins.y) ? s.sw.variables[ins.y.variable] : ins.y;
  const dir = variableRef(ins.dir) ? s.sw.variables[ins.dir.variable] : ins.dir;
  if (typeof map !== "string" || map.length === 0) {
    s.error = {
      kind: "content",
      message: `transfer in ${fiber}: map variable must hold a non-empty string`,
    };
    return null;
  }
  if (typeof x !== "number" || !Number.isInteger(x) || x < 0 ||
      typeof y !== "number" || !Number.isInteger(y) || y < 0) {
    s.error = {
      kind: "content",
      message: `transfer in ${fiber}: coordinate variables must hold non-negative integers`,
    };
    return null;
  }
  if (dir !== "keep" && dir !== "down" && dir !== "left" && dir !== "right" && dir !== "up") {
    s.error = {
      kind: "content",
      message: `transfer in ${fiber}: direction variable must hold down|left|right|up|keep`,
    };
    return null;
  }
  return { map, x, y, dir, fadeFrames: ins.fadeFrames };
}

function emptyRecord(record: object): boolean {
  return Object.keys(record).length === 0;
}

function applyAppearanceCommand(
  s: InterpState,
  w: World,
  f: Fiber,
  input: InterpInput,
  ins: Extract<Instr, { op: "appearance" }>,
): void {
  if (ins.opacity !== undefined && ins.opacity !== null &&
      (!Number.isInteger(ins.opacity) || ins.opacity < 0 || ins.opacity > 255)) {
    s.error = { kind: "content", message: `appearance in ${f.key}: opacity must be an integer from 0 to 255` };
    return;
  }

  if (ins.target === "player") {
    if (ins.saveDefault && ins.sprite === undefined) {
      s.error = { kind: "content", message: `appearance in ${f.key}: saveDefault requires sprite` };
      return;
    }
    const next: PlayerAppearanceState = { ...(s.sw.playerAppearance ?? {}) };
    if (ins.saveDefault) {
      if (ins.sprite === null) delete next.defaultSprite;
      else next.defaultSprite = ins.sprite!;
      delete next.sprite;
    } else if (ins.sprite !== undefined) {
      if (ins.sprite === null) delete next.sprite;
      else next.sprite = ins.sprite;
    }
    if (ins.opacity !== undefined) {
      if (ins.opacity === null || ins.opacity === 255) delete next.opacity;
      else next.opacity = ins.opacity;
    }
    if (ins.visible !== undefined) {
      if (ins.visible === null) delete next.visible;
      else next.visible = ins.visible;
    }
    if (emptyRecord(next)) delete s.sw.playerAppearance;
    else s.sw.playerAppearance = next;
    return;
  }

  if (ins.saveDefault) {
    s.error = { kind: "content", message: `appearance in ${f.key}: saveDefault is only valid for player` };
    return;
  }
  const eventId = targetEventId(ins.target, f.key);
  const event = worldEventById(w, eventId);
  if (!event) {
    s.error = { kind: "content", message: `appearance in ${f.key}: event ${JSON.stringify(eventId)} does not exist` };
    return;
  }
  const pageIndex = ins.target === "this"
    ? f.pageIndex
    : input.eventPages?.[eventId]?.pageIndex;
  if (pageIndex === undefined || pageIndex < 0) {
    s.error = { kind: "content", message: `appearance in ${f.key}: event ${JSON.stringify(eventId)} has no active page` };
    return;
  }
  const current = s.eventAppearances?.[eventId];
  const next: EventAppearanceState = current?.pageIndex === pageIndex
    ? { ...current }
    : { pageIndex };
  if (ins.sprite !== undefined) {
    if (ins.sprite === null) delete next.sprite;
    else next.sprite = ins.sprite;
  }
  if (ins.opacity !== undefined) {
    if (ins.opacity === null || ins.opacity === 255) delete next.opacity;
    else next.opacity = ins.opacity;
  }
  if (ins.visible !== undefined) {
    if (ins.visible === null) delete next.visible;
    else next.visible = ins.visible;
  }
  if (Object.keys(next).length === 1) {
    if (s.eventAppearances) {
      delete s.eventAppearances[eventId];
      if (emptyRecord(s.eventAppearances)) delete s.eventAppearances;
    }
  } else {
    if (!s.eventAppearances) s.eventAppearances = keyedRecord();
    s.eventAppearances[eventId] = next;
  }
}

function applyLayerCommand(s: InterpState, ins: Extract<Instr, { op: "layer" }>): void {
  const next: LayerState = { ...(s.layers?.[ins.layer] ?? {}) };
  if (ins.visible !== undefined) {
    if (ins.visible === null) delete next.visible;
    else next.visible = ins.visible;
  }
  if (ins.variant !== undefined) {
    if (ins.variant === null) delete next.variant;
    else next.variant = ins.variant;
  }
  if (emptyRecord(next)) {
    if (s.layers) {
      delete s.layers[ins.layer];
      if (emptyRecord(s.layers)) delete s.layers;
    }
  } else {
    if (!s.layers) s.layers = keyedRecord();
    s.layers[ins.layer] = next;
  }
}

function applyTilePropertyCommand(
  s: InterpState,
  w: World,
  f: Fiber,
  ins: Extract<Instr, { op: "tileProperty" }>,
): void {
  if (!Number.isInteger(ins.x) || !Number.isInteger(ins.y) || ins.x < 0 || ins.y < 0 ||
      ins.x >= w.map.width || ins.y >= w.map.height) {
    s.error = {
      kind: "content",
      message: `tileProperty in ${f.key}: (${ins.x},${ins.y}) outside ${w.map.id} (${w.map.width}x${w.map.height})`,
    };
    return;
  }
  const key = String(ins.y * w.map.width + ins.x);
  const record = s.tileProperties ? cloneTileProperties(s.tileProperties) : keyedRecord<TilePropertyOverride>();
  const next: TilePropertyOverride = { ...(record[key] ?? {}) };
  if (ins.passage !== undefined) {
    if (ins.passage === null) delete next.passage;
    else next.passage = ins.passage;
  }
  if (ins.enter !== undefined) {
    if (ins.enter === null) delete next.enter;
    else next.enter = [...ins.enter];
  }
  if (ins.exit !== undefined) {
    if (ins.exit === null) delete next.exit;
    else next.exit = [...ins.exit];
  }
  if (emptyRecord(next)) {
    delete record[key];
    if (emptyRecord(record)) delete s.tileProperties;
    else s.tileProperties = record;
  } else {
    record[key] = next;
    s.tileProperties = record;
  }
}

/** Drop event visual overrides whose issuing page is no longer active.
 * Session calls this immediately after page reconciliation. */
export function clearStaleEventAppearances(
  s: InterpState,
  pages: Readonly<Record<string, EventPageAppearance>>,
): void {
  if (!s.eventAppearances) return;
  for (const id of Object.keys(s.eventAppearances)) {
    if (pages[id]?.pageIndex !== s.eventAppearances[id]!.pageIndex) delete s.eventAppearances[id];
  }
  if (emptyRecord(s.eventAppearances)) delete s.eventAppearances;
}

function runFiber(
  s: InterpState,
  w: World,
  f: Fiber,
  input: InterpInput,
  budget: StepBudget,
  extension: MutableExtensionScope,
): void {
  // Resolve already-suspending commands first; on resume the fiber falls
  // through into the run loop so the instant commands after a wait/text/
  // choice apply on the same frame the player released them.
  if (f.mode === "wait") {
    const top = f.stack[0]!;
    const ins = top.prog[top.pc]! as Extract<Instr, { op: "wait" }>;
    if (s.frame - f.since >= ins.frames) {
      f.mode = "run";
      top.pc++;
    } else return;
  }
  if (f.mode === "animWait") {
    const top = f.stack[0]!;
    const ins = top.prog[top.pc]! as Extract<Instr, { op: "mapAnim" }>;
    const compiled = w.anims.get(ins.anim);
    const live = (s.anims ?? []).find((a) => a.id === ins.id);
    // The wait ends when the instance stops (stopAnim/transfer/prune) or its
    // animation leaves the catalog. A one-shot additionally ends after one
    // playthrough; a looping instance keeps playing until stopAnim ends it —
    // MV's "Wait for Completion" on a looping animation blocks until the
    // animation is stopped, never after a single cycle.
    if (!compiled || !live || (!live.loop && s.frame - f.since >= compiled.total)) {
      f.mode = "run";
      top.pc++;
    } else return;
  }
  if (f.mode === "text") {
    const top = f.stack[0]!;
    const ins = top.prog[top.pc]!;
    if (ins.op === "text") {
      if (s.modal && s.modal.fiber !== f.key) return; // another fiber's box
      // The slot became free while this fiber parked waiting for it: the
      // reveal clock starts on the install frame, not the wait frame, or a
      // queued parallel line would dump its whole text at once (review C09).
      if (!s.modal) f.since = s.frame;
      const shownLines = substituteLines(ins.lines, s.sw.playerName ?? DEFAULT_PLAYER_NAME);
      const joined = shownLines.join("\n");
      // Once a confirm has skipped the typewriter (or it finished naturally)
      // the box stays full: elapsed-time reveal must not shrink it again.
      const wasComplete = s.modal?.kind === "text" && s.modal.complete;
      const timed = wasComplete ? joined.length : revealedChars(joined.length, ins.cps, s.frame - f.since, w.hz);
      if (input.confirmEdge && timed >= joined.length) {
        s.modal = null;
        f.mode = "run";
        top.pc++;
      } else {
        const complete = input.confirmEdge || timed >= joined.length;
        s.modal = {
          kind: "text",
          fiber: f.key,
          lines: shownLines,
          total: joined.length,
          revealed: complete ? joined.length : timed,
          complete,
        };
        return;
      }
    } else {
      f.mode = "run"; // modal slot was busy last frame; retry
    }
  }
  if (f.mode === "choices") {
    const top = f.stack[0]!;
    const ins = top.prog[top.pc]!;
    if (ins.op === "choices") {
      if (s.modal && s.modal.fiber !== f.key) return;
      // First frame after opening installs the modal; later frames keep the
      // player's cursor index.
      if (!s.modal || s.modal.kind !== "choices") {
        const name = s.sw.playerName ?? DEFAULT_PLAYER_NAME;
        s.modal = {
          kind: "choices",
          fiber: f.key,
          prompt: substitutePlayerName(ins.prompt, name),
          options: ins.texts.map((text) => substitutePlayerName(text, name)),
          index: 0,
          cancellable: ins.cancel !== null,
        };
      }
      const modal = s.modal as ChoiceModal;
      if (input.upEdge) modal.index = (modal.index + ins.texts.length - 1) % ins.texts.length;
      if (input.downEdge) modal.index = (modal.index + 1) % ins.texts.length;
      let branch: Prog | null = null;
      if (input.confirmEdge) branch = ins.branches[modal.index]!;
      else if (input.cancelEdge && ins.cancel) branch = ins.cancel;
      if (branch) {
        if (f.stack.length >= MAX_FIBER_STACK_DEPTH) {
          s.error = { kind: "runaway", message: `interpreter: stack depth exceeded in ${f.key}` };
          return;
        }
        s.modal = null;
        top.pc++; // past CHOICES in the parent
        f.stack.unshift({ prog: branch, pc: 0 });
        f.mode = "run"; // fall through: run the branch this frame
      } else {
        return;
      }
    } else if (ins.op === "extChoice") {
      if (s.modal && s.modal.fiber !== f.key) return;
      const options = extensionChoiceOptions(s, extension, ins);
      if (options === null) {
        // Preview-only allowUnknown mirrors an unknown ext command no-op.
        s.modal = null;
        f.mode = "run";
        top.pc++;
      } else {
        const previous = s.modal?.kind === "choices" ? s.modal : null;
        const previousKeys = previous?.keys;
        const previousKey = previous ? previousKeys?.[previous.index] : undefined;
        let index = options.length === 0
          ? 0
          : Math.min(previous?.index ?? 0, options.length - 1);
        let displaced = previous === null || previousKeys === undefined;
        if (previousKey !== undefined) {
          const same = options.findIndex((option) => option.key === previousKey);
          if (same >= 0) index = same;
          else displaced = true;
        } else if (previousKeys && options.length > 0) {
          // The previous list was empty. Show the newly arrived first row for
          // one frame before accepting confirm on an item the player has not
          // yet seen.
          displaced = true;
        }
        if (!displaced && options.length > 0) {
          if (input.upEdge) index = (index + options.length - 1) % options.length;
          if (input.downEdge) index = (index + 1) % options.length;
        }
        s.modal = {
          kind: "choices",
          fiber: f.key,
          prompt: substitutePlayerName(ins.prompt, s.sw.playerName ?? DEFAULT_PLAYER_NAME),
          options: options.map((option) => option.label),
          keys: options.map((option) => option.key),
          enabled: options.map((option) => option.enabled),
          index,
          cancellable: ins.cancel,
        };
        let result: ExtensionChoiceResult | null = null;
        if (input.confirmEdge && !displaced && options[index]?.enabled) {
          const option = options[index]!;
          result = {
            kind: "select",
            index,
            key: option.key,
            data: deepClone(option.data),
          };
        } else if (input.cancelEdge && ins.cancel) {
          result = { kind: "cancel" };
        }
        if (result) {
          resolveExtensionChoice(s, w, extension, ins, result);
          s.modal = null;
          f.mode = "run";
          top.pc++;
          // Continue into the run loop: result state is visible to the next
          // instruction on this same reference tick.
        } else {
          return;
        }
      }
    } else {
      f.mode = "run";
    }
  }
  if (f.mode === "shop") {
    const top = f.stack[0]!;
    const ins = top.prog[top.pc]!;
    if (ins.op === "shop") {
      if (s.modal && s.modal.fiber !== f.key) return; // another fiber's box
      const prev = s.modal && s.modal.kind === "shop" ? s.modal : null;
      let stage: "buy" | "sell" = prev?.stage ?? "buy";
      let index = prev?.index ?? 0;
      let rows = shopRows(stage, ins, w, s, f.key, extension, input);
      if (rows.length > 0) {
        if (input.upEdge) index = (index + rows.length - 1) % rows.length;
        if (input.downEdge) index = (index + 1) % rows.length;
      }
      let leave = false;
      const row = rows[index];
      if (input.confirmEdge && row) {
        if (row.kind === "item" && stage === "buy") {
          if (row.canAfford && !row.atCap) {
            s.sw.gold = clampFiniteVar(s.sw.gold - row.price);
            const items = ownRecord(s.sw, "items");
            items[row.item] = clampFiniteVar((items[row.item] ?? 0) + 1);
            if (row.stock !== null) {
              ownRecord(s.sw, "shopStock")[shopStockKey(ins.id, row.item)] = clampFiniteVar(row.stock - 1);
            }
          }
        } else if (row.kind === "item" && stage === "sell") {
          // B4: an unsellable row (dimmed, still navigable under
          // sellList:"disable") cannot be confirmed sold.
          if (row.sellable) {
            ownRecord(s.sw, "items")[row.item] = clampFiniteVar(Math.max(0, row.owned - 1));
            s.sw.gold = clampFiniteVar(s.sw.gold + row.price);
            const good = ins.goods.find((g) => g.item === row.item && g.stock !== undefined);
            if (good) {
              const key = shopStockKey(ins.id, row.item);
              const current = keyedValue(s.sw.shopStock, key) ?? good.stock!;
              ownRecord(s.sw, "shopStock")[key] = clampFiniteVar(current + 1);
            }
          }
        } else if (row.kind === "sell") {
          stage = "sell";
          index = 0;
        } else if (row.kind === "leave") {
          leave = true;
        } else if (row.kind === "back") {
          stage = "buy";
          index = 0;
        }
      } else if (input.cancelEdge) {
        if (stage === "sell") {
          stage = "buy";
          index = 0;
        } else {
          leave = true;
        }
      }
      if (leave) {
        s.modal = null;
        f.mode = "run";
        top.pc++;
        // fall through into the run loop below: the shop closes and the
        // fiber continues past it on the SAME frame (text/choices parity).
      } else {
        rows = shopRows(stage, ins, w, s, f.key, extension, input);
        index = rows.length > 0 ? Math.min(index, rows.length - 1) : 0;
        s.modal = { kind: "shop", fiber: f.key, gold: s.sw.gold, sell: ins.sell, stage, index, rows };
        return;
      }
    } else {
      f.mode = "run"; // modal slot was busy last frame; retry
    }
  }

  while (f.mode === "run") {
    if (budget.remaining-- <= 0) {
      // Backstop (reviews 1274 B1 and 1401 B1): all fibers draw from one
      // step budget. This bounds aggregate parallel work as well as a long
      // forward program or recursive common-event stack.
      s.error = { kind: "runaway", message: `interpreter: runaway program in ${f.key}` };
      return;
    }
    const top = f.stack[0]!;
    if (top.pc >= top.prog.length) {
      f.stack.shift();
      if (f.stack.length === 0) {
        finishFiber(s, f);
        return;
      }
      continue;
    }
    const ins = top.prog[top.pc]!;
    switch (ins.op) {
      case "if":
        top.pc = evalCondition(
          ins.cond,
          s.sw,
          f.key,
          input.facing,
          extension,
          liveConditionContext(s, w, input.worldIdleBlockers, input.eventPages),
        ) ? top.pc + 1 : ins.onFalse;
        break;
      case "jmp":
        top.pc = ins.to;
        break;
      case "switch":
      case "variable":
      case "selfSwitch":
      case "gold":
      case "item":
      case "se":
        runInstant(s, f, ins);
        top.pc++;
        break;
      case "lockInput":
        s.inputLocked = true;
        top.pc++;
        break;
      case "unlockInput":
        s.inputLocked = false;
        top.pc++;
        break;
      case "appearance":
        applyAppearanceCommand(s, w, f, input, ins);
        if (s.error) return;
        top.pc++;
        break;
      case "layer":
        applyLayerCommand(s, ins);
        top.pc++;
        break;
      case "tileProperty":
        applyTilePropertyCommand(s, w, f, ins);
        if (s.error) return;
        top.pc++;
        break;
      case "place": {
        const p = { x: ins.x, y: ins.y, dir: ins.dir };
        if (ins.target === "player") {
          s.pendingPlacements.push({ target: "player", ...p });
        } else {
          const eventId = ins.target === "this" ? f.key.split("/").pop()! : ins.target.event;
          s.placements[eventId] = p;
          s.pendingPlacements.push({ eventId, ...p });
        }
        top.pc++;
        break;
      }
      case "mapAnim": {
        const compiled = w.anims.get(ins.anim);
        if (!compiled) {
          s.error = { kind: "content", message: `mapAnim in ${f.key}: unknown animation ${ins.anim}` };
          return;
        }
        pruneMapAnims(s, w);
        let x = ins.x;
        let y = ins.y;
        // The instance follows the target by default. follow:false snapshots
        // the character's tile at execution and pins the instance there
        // (Tuxemon play_map_animation reads character.tile_pos once and
        // stores the coordinates, never a live reference).
        let target = ins.target;
        if (ins.target !== null) {
          if (ins.target === "player") {
            x = input.playerCell.x;
            y = input.playerCell.y;
          } else {
            // An event target resolves from the live character set only
            // (Tuxemon get_npc looks up _on_map): an erased, inactive, or
            // never-spawned event has no live character, so play nothing
            // rather than ghost the animation at the authored x/y.
            const cell = input.liveEventCells ? keyedValue(input.liveEventCells, ins.target.event) : undefined;
            if (!cell) {
              s.error = {
                kind: "content",
                message: `mapAnim in ${f.key}: target event ${ins.target.event} has no live character on this map`,
              };
              return;
            }
            x = cell.x;
            y = cell.y;
          }
          if (!ins.follow) target = null;
        } else if (
          x === null || y === null ||
          !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0
        ) {
          s.error = {
            kind: "content",
            message: `mapAnim in ${f.key}: x/y must be non-negative integers when target is absent`,
          };
          return;
        }
        const loop = ins.loop ?? compiled.loop;
        // A same-id replay replaces the live instance (deterministic restart).
        const anims = writableAnims(s);
        let kept = 0;
        for (let i = 0; i < anims.length; i++) {
          const a = anims[i]!;
          if (a.id !== ins.id) anims[kept++] = a;
        }
        anims.length = kept;
        anims.push({
          id: ins.id,
          anim: ins.anim,
          start: s.frame,
          x,
          y,
          target,
          layer: ins.layer,
          loop,
        });
        if (ins.wait) {
          f.mode = "animWait";
          f.since = s.frame;
          return;
        }
        top.pc++;
        break;
      }
      case "stopAnim": {
        pruneMapAnims(s, w);
        const anims = s.anims;
        if (anims) {
          const writable = writableAnims(s);
          let kept = 0;
          for (let i = 0; i < writable.length; i++) {
            const a = writable[i]!;
            const drop = ins.id !== null
              ? a.id === ins.id
              : ins.anim !== null
                ? a.anim === ins.anim
                : true;
            if (!drop) writable[kept++] = a;
          }
          writable.length = kept;
          if (kept === 0) s.anims = undefined;
        }
        top.pc++;
        break;
      }
      case "erase":
        f.erase = true;
        finishFiber(s, f);
        return;
      case "exit":
        finishFiber(s, f);
        return;
      case "wait":
        if (ins.frames <= 0) {
          top.pc++;
          break;
        }
        f.mode = "wait";
        f.since = s.frame;
        return;
      case "text":
        // The modal slot is a single shared resource: a PARALLEL line must
        // wait behind an open main-fiber dialog instead of overwriting it
        // (review C09). Stay in "run" mode and retry next frame without
        // advancing the pc or starting the reveal clock.
        if (s.modal) return;
        f.mode = "text";
        f.since = s.frame;
        const firstLines = substituteLines(ins.lines, s.sw.playerName ?? DEFAULT_PLAYER_NAME);
        s.modal = {
          kind: "text",
          fiber: f.key,
          lines: firstLines,
          total: firstLines.join("\n").length,
          revealed: 0,
          complete: false,
        };
        return;
      case "choices":
        // Same single-slot rule for the choices box.
        if (s.modal) return;
        f.mode = "choices";
        s.modal = {
          kind: "choices",
          fiber: f.key,
          prompt: substitutePlayerName(ins.prompt, s.sw.playerName ?? DEFAULT_PLAYER_NAME),
          options: ins.texts.map((text) => substitutePlayerName(text, s.sw.playerName ?? DEFAULT_PLAYER_NAME)),
          index: 0,
          cancellable: ins.cancel !== null,
        };
        return;
      case "extChoice": {
        // Same single modal slot and fiber mode as authored choices. The
        // provider runs only after the slot is acquired, so a queued parallel
        // choice cannot observe time or state from a frame it was not shown.
        if (s.modal) return;
        const options = extensionChoiceOptions(s, extension, ins);
        if (options === null) {
          top.pc++;
          break;
        }
        f.mode = "choices";
        s.modal = {
          kind: "choices",
          fiber: f.key,
          prompt: substitutePlayerName(ins.prompt, s.sw.playerName ?? DEFAULT_PLAYER_NAME),
          options: options.map((option) => option.label),
          keys: options.map((option) => option.key),
          enabled: options.map((option) => option.enabled),
          index: 0,
          cancellable: ins.cancel,
        };
        return;
      }
      case "shop": {
        // Same single-slot rule as text/choices.
        if (s.modal) return;
        f.mode = "shop";
        const rows = shopRows("buy", ins, w, s, f.key, extension, input);
        s.modal = { kind: "shop", fiber: f.key, gold: s.sw.gold, sell: ins.sell, stage: "buy", index: 0, rows };
        return;
      }
      case "transfer": {
        const transfer = resolveTransfer(s, ins, f.key);
        if (transfer === null) return;
        f.mode = "external";
        s.pendingTransfer = {
          fiber: f.key,
          ...transfer,
        };
        return;
      }
      case "moveRoute": {
        // Resolve "this" to the running fiber's own event id at publish
        // time; the session then only distinguishes the player from a map
        // event (routes may target any event).
        const ownEventId = f.key.split("/").pop()!;
        const target: "player" | { event: string } =
          ins.target === "player" ? "player"
          : ins.target === "this" ? { event: ownEventId }
          : ins.target;
        const eventId = target === "player" ? ownEventId : target.event;
        if (!ins.wait) {
          // Fire-and-forget route: P1④ walks it, this fiber continues now.
          s.pendingMoveRoutes.push({
            fiber: f.key,
            target,
            eventId,
            route: ins.route,
            wait: false,
          });
          top.pc++;
          break;
        }
        f.mode = "external";
        s.pendingMoveRoutes.push({
          fiber: f.key,
          target,
          eventId,
          route: ins.route,
          wait: true,
        });
        return;
      }
      case "moveControl": {
        const ownEventId = f.key.split("/").pop()!;
        const target: "player" | { event: string } =
          ins.target === "player" ? "player"
          : ins.target === "this" ? { event: ownEventId }
          : ins.target;
        s.pendingMoveRoutes.push({
          fiber: f.key,
          target,
          eventId: target === "player" ? ownEventId : target.event,
          control: ins.control,
        });
        top.pc++;
        break;
      }
      case "common": {
        const prog = w.commonPrograms.get(ins.id);
        if (!prog) {
          top.pc++; // unknown common event: no-op (MV logs and skips)
          break;
        }
        if (f.stack.length >= MAX_FIBER_STACK_DEPTH) {
          s.error = { kind: "runaway", message: `interpreter: stack depth exceeded in ${f.key}` };
          return;
        }
        top.pc++;
        f.stack.unshift({ prog, pc: 0 });
        break;
      }
      case "ext":
        runExtensionCommand(s, w, extension, ins.call, ins.args);
        top.pc++;
        break;
      case "battle":
        f.mode = "external";
        s.pendingBattles.push({ fiber: f.key, setup: deepClone(ins.setup) });
        return;
    }
  }
}

export interface InterpStepResult {
  interp: InterpState;
  ext: JsonValue;
}

/** One virtual frame with the game-owned extension slot. Both returned
 * values are new JSON state; neither input is mutated. */
export function stepInterpWithExtensions(
  w: World,
  s0: InterpState,
  input: InterpInput,
  ext0: JsonValue,
): InterpStepResult {
  const s = cloneInterp(s0);
  const ext = stepInterpWithExtensionsInPlace(
    w,
    s,
    input,
    cloneExtension(w.extensions, ext0),
  );
  return { interp: s, ext };
}

/** Extension-aware interpreter fold on a working copy the caller owns.
 * The returned extension value replaces the caller's owned ext slot. */
export function stepInterpWithExtensionsInPlace(
  w: World,
  s: InterpState,
  input: InterpInput,
  ext0: JsonValue,
): JsonValue {
  const extension: MutableExtensionScope = { runtime: w.extensions, ext: ext0 };
  // A fatalized state is frozen: no triggers scan, no fiber advances. The
  // frame clock still ticks so render/host code keeps its cadence, but the
  // cyclic program can never consume another step (review 1274 B1).
  if (s.error) {
    s.frame++;
    s.cues = [];
    return extension.ext;
  }
  s.frame++;
  s.cues = [];
  // Transfer/route/place requests live only on the step that issued them:
  // P1④ reads them off that step, performs the work, then resumes the fiber.
  // Battle requests are different: they remain FIFO-queued until the scene
  // host can consume them without overwriting another parked fiber.
  s.pendingTransfer = null;
  s.pendingMoveRoutes = [];
  s.pendingPlacements = [];
  s.abortedRoutes = [];

  cancelStaleParallels(s, w, input.facing, extension, input);
  scanTriggers(s, w, input, extension);
  const budget: StepBudget = { remaining: RUNAWAY_STEP_LIMIT };
  const queuedBattleCount = s.pendingBattles.length;

  // Parallels first (ascending key), then the blocking fiber, so a parallel
  // can never observe a value the main fiber sets later in the same frame.
  // Battle requests are the one exception to the resulting publication
  // order: collect this tick's parallel requests, run main, then append the
  // new requests main-first behind every request already in the FIFO.
  for (const key of Object.keys(s.parallels).sort()) {
    runFiber(s, w, s.parallels[key]!, input, budget, extension);
    if (s.error) break;
  }
  const parallelBattles = s.pendingBattles.splice(queuedBattleCount);
  if (!s.error && s.main) runFiber(s, w, s.main, input, budget, extension);
  const mainBattles = s.pendingBattles.splice(queuedBattleCount);
  s.pendingBattles.push(...mainBattles, ...parallelBattles);
  // Refresh following instances' anchors from this tick's live-character
  // snapshot so a target that walks away and then leaves the map pins the
  // animation to its last live cell (see syncFollowAnchors). A fatalized
  // state returned above is frozen and never reaches here.
  if (!s.error) syncFollowAnchors(s, input);
  return extension.ext;
}

/** stepInterp on a working copy the caller owns (stepSession's per-frame
 * copy): advances `s` itself instead of copying it again. */
export function stepInterpInPlace(w: World, s: InterpState, input: InterpInput): void {
  stepInterpWithExtensionsInPlace(w, s, input, w.extensions.initial);
}

/** Backwards-compatible interpreter-only fold. Projects using extension
 * state should use Session/stepSession, which carries the ext result. */
export function stepInterp(w: World, s0: InterpState, input: InterpInput): InterpState {
  return stepInterpWithExtensions(w, s0, input, w.extensions.initial).interp;
}

/** P1④ entry point: resume a fiber parked on transfer/moveRoute after the
 *  external work (map swap, route walk) has completed. */
export function continueExternal(s0: InterpState, fiberKey: string): InterpState {
  const s = cloneInterp(s0);
  const resume = (f: Fiber | null): void => {
    if (!f || f.key !== fiberKey || f.mode !== "external") return;
    f.stack[0]!.pc++;
    f.mode = "run";
  };
  resume(s.main);
  for (const f of Object.values(s.parallels)) resume(f);
  return s;
}

/** Resume a Battle Processing instruction and push the result branch. A
 * completion transfer is appended to that branch, so authored result
 * commands run on the originating map before the map interpreter is rebuilt
 * at the transfer boundary. `draw` has no MV branch and simply continues. */
export function continueBattle(
  s0: InterpState,
  fiberKey: string,
  result: "win" | "lose" | "escape" | "draw",
  transfer: Omit<PendingTransfer, "fiber"> | null = null,
): InterpState {
  const s = cloneInterp(s0);
  const resume = (f: Fiber | null): void => {
    if (!f || f.key !== fiberKey || f.mode !== "external") return;
    const top = f.stack[0];
    const ins = top?.prog[top.pc];
    if (!top || ins?.op !== "battle") return;
    const branch =
      result === "win" ? ins.onWin
      : result === "lose" ? ins.onLose
      : result === "escape" ? ins.onEscape
      : null;
    const continuation: Prog = branch ? [...branch] : [];
    if (transfer) {
      continuation.push({
        op: "transfer",
        map: transfer.map,
        x: transfer.x,
        y: transfer.y,
        dir: transfer.dir,
        fadeFrames: transfer.fadeFrames,
      });
    }
    top.pc++;
    f.mode = "run";
    if (continuation.length > 0) {
      if (f.stack.length >= MAX_FIBER_STACK_DEPTH) {
        s.error = { kind: "runaway", message: `interpreter: stack depth exceeded in ${f.key}` };
        return;
      }
      f.stack.unshift({ prog: continuation, pc: 0 });
    }
  };
  resume(s.main);
  for (const f of Object.values(s.parallels)) resume(f);
  return s;
}

/** True when the fiber is parked in "external" mode (a wait:true route or
 *  a transfer): the session completes the work before resuming it. A
 *  wait:false moveRoute publishes the same payload but the fiber already
 *  advanced, so the session treats the route as fire-and-forget. */
export function fiberIsExternal(s: InterpState, fiberKey: string): boolean {
  if (s.main?.key === fiberKey) return s.main.mode === "external";
  return Object.values(s.parallels).some((f) => f.key === fiberKey && f.mode === "external");
}
