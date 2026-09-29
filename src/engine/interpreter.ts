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
  type ExtensionCommandContext,
  type ExtensionReadContext,
  type ExtensionRuntime,
} from "./extensions.ts";
import { DEFAULT_PLAYER_NAME, substituteLines, substitutePlayerName } from "./player-name.ts";
import type {
  Command,
  CommonEvent,
  Condition,
  Dir,
  Facing,
  GameEvent,
  Item,
  JsonValue,
  MapDef,
  MoveRoute,
  Page,
  PageCondition,
  RouteTarget,
  ShopGood,
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
  /** Mulberry32 cursor. Part of the save snapshot (R2 §3.1). */
  rng: number;
}

export function createSwitchState(init?: Partial<SwitchState>): SwitchState {
  return {
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
}

function keyedValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

// --- conditions and page selection ------------------------------------------

export function evalCondition(
  c: Condition,
  s: SwitchState,
  eventKey: string,
  facing?: Facing,
  extension?: ExtensionScope,
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
): boolean {
  for (const c of clauses) {
    if (!evalCondition(c, s, eventKey, facing, extension)) return false;
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
  if (c.all && !allClausesHold(c.all, s, eventKey, facing, extension)) return false;
  return true;
}

export function pageConditionHolds(
  p: Page,
  s: SwitchState,
  eventKey: string,
  facing?: Facing,
  extension?: ExtensionScope,
): boolean {
  return conditionHolds(p.condition, s, eventKey, facing, extension);
}

/** Highest-index page whose condition holds (R2 §2); null when none do.
 *  Callers must supply `facing` when an event can use a facing condition. */
export function activePage(
  ev: GameEvent,
  s: SwitchState,
  mapId: string,
  facing?: Facing,
  extension?: ExtensionScope,
): { page: Page; index: number } | null {
  const index = activeIndexAt(ev, s, eventKey(mapId, ev.id), facing, extension);
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
): number {
  for (let i = ev.pages.length - 1; i >= 0; i--) {
    if (pageConditionHolds(ev.pages[i]!, s, key, facing, extension)) return i;
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
  | { op: "place"; target: "this" | { event: string }; x: number; y: number; dir: Dir | null }
  | {
      op: "transfer";
      map: TransferMap;
      x: TransferCoordinate;
      y: TransferCoordinate;
      dir: TransferDirection;
      fadeFrames: number;
    }
  | { op: "moveRoute"; target: RouteTarget; wait: boolean; route: MoveRoute }
  | { op: "common"; id: string }
  | { op: "shop"; id: string; goods: readonly ShopGood[]; sell: boolean; sellList: "disable" | "hide" }
  | { op: "ext"; call: string; args: JsonValue }
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
        case "common":
          emit({ op: "common", id: c.id });
          break;
        case "shop":
          emit({ op: "shop", id: c.id, goods: c.goods, sell: c.sell ?? true, sellList: c.sellList ?? "disable" });
          break;
        case "ext":
          emit({ op: "ext", call: c.call, args: deepClone(c.args) });
          break;
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
      a.options.some((opt, i) => opt !== b.options[i])
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

/** Battle Processing request published on the tick that parks its fiber. */
export interface PendingBattle {
  fiber: string;
  setup: JsonValue;
}

/** A `place` command published on THIS step. The session
 *  relocates the matching CharState after the fold; the durable position
 *  also lands in InterpState.placements so a later-created character (a
 *  page that only becomes active afterwards) spawns at the new cell. */
export interface PendingPlacement {
  eventId: string;
  x: number;
  y: number;
  /** Facing to show after the move, or keep the current one. */
  dir: Dir | null;
}

interface Fiber {
  key: string;
  pageIndex: number;
  parallel: boolean;
  stack: { prog: Prog; pc: number }[];
  mode: "run" | "text" | "choices" | "shop" | "wait" | "external";
  /** Frame on which the current wait/text started. */
  since: number;
  erase: boolean;
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
  /** Sound cues emitted on this frame; the host drains them after step. */
  cues: SoundCue[];
  pendingTransfer: PendingTransfer | null;
  /** Move routes published on THIS step, in command order. A fiber can
   *  publish more than one before it parks (a fire-and-forget player turn
   *  immediately followed by a waited self-route); the session drains all. */
  pendingMoveRoutes: PendingMoveRoute[];
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

export function createWorld(
  map: MapDef,
  common: CommonEvent[] = [],
  hz: number = TICK_HZ,
  options: WorldOptions = {},
): World {
  const commonPrograms = new Map<string, Prog>();
  for (const event of common) commonPrograms.set(event.id, compile(event.commands, hz));
  const pagePrograms = new Map<string, readonly Prog[]>();
  for (const event of map.events ?? []) {
    pagePrograms.set(eventKey(map.id, event.id), event.pages.map((page) => compile(page.commands, hz)));
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
    items: itemsById,
    inventory: resolvedInventory,
    messageBlocksPlayer: options.messageBlocksPlayer === true,
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
  return { ...m, options: [...m.options] };
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
  });
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
  };
  SHARED_RECORDS.set(sw, new Set<SwitchRecord>(["switches", "self", "items", "variables", "shopStock"]));
  return copyInterp(s0, sw);
}

function copyInterp(s0: InterpState, sw: SwitchState): InterpState {
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
    cues: s0.cues.map((cue) => ({ ...cue })),
    pendingTransfer: s0.pendingTransfer ? { ...s0.pendingTransfer } : null,
    pendingMoveRoutes: s0.pendingMoveRoutes.map((r) => ({
      ...r,
      route: cloneMoveRoute(r.route),
    })),
    pendingBattles: s0.pendingBattles.map((request) => ({
      fiber: request.fiber,
      setup: deepClone(request.setup),
    })),
    pendingPlacements: s0.pendingPlacements.map((p) => ({ ...p })),
    abortedRoutes: [...s0.abortedRoutes],
  };
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
): void {
  for (const key of Object.keys(s.parallels)) {
    const f = s.parallels[key]!;
    const ev = worldEventById(w, key.slice(w.map.id.length + 1));
    const active = ev && !s.erased[key] ? activePage(ev, s.sw, w.map.id, facing, extension) : null;
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
    const active = activePage(ev, s.sw, w.map.id, input.facing, extension);
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
  sw: SwitchState,
  eventKey: string,
): ShopRow[] {
  if (stage === "buy") {
    const maxPerItem = w.inventory?.maxPerItem ?? SHOP_ITEM_CAP;
    const maxKinds = w.inventory?.maxKinds;
    const heldKinds = maxKinds !== undefined ? kindsHeld(sw.items) : 0;
    const rows: ShopRow[] = [];
    for (const g of ins.goods) {
      if (g.condition && !conditionHolds(g.condition, sw, eventKey)) continue;
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
  let cursor = s.sw.rng;
  const context: ExtensionCommandContext = {
    ext: deepClone(extension.ext),
    switches: s.sw.switches,
    variables: s.sw.variables,
    items: s.sw.items,
    gold: s.sw.gold,
    random: () => {
      const draw = rngNext(cursor);
      cursor = draw.next;
      return draw.value;
    },
  };
  const result = handler(context, deepClone(args));
  s.sw.rng = cursor;
  if (result === undefined) return;
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(`extension command ${JSON.stringify(call)} must return an object or undefined`);
  }
  let nextExt = extension.ext;
  if (Object.prototype.hasOwnProperty.call(result, "ext")) {
    assertJsonValue(result.ext, `extension command ${JSON.stringify(call)} result.ext`);
    nextExt = cloneExtension(extension.runtime, result.ext, `extension command ${JSON.stringify(call)} result.ext`);
  }
  const writes: [string, VariableValue][] = [];
  if (result.writes !== undefined) {
    if (result.writes === null || typeof result.writes !== "object" || Array.isArray(result.writes)) {
      throw new Error(`extension command ${JSON.stringify(call)} result.writes must be a record`);
    }
    for (const id of Object.keys(result.writes)) {
      const value = result.writes[id];
      if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) {
        throw new Error(`extension command ${JSON.stringify(call)} write ${JSON.stringify(id)} must be a string or finite number`);
      }
      writes.push([id, value]);
    }
  }
  let itemReplacements: Record<string, number> | undefined;
  if (result.items !== undefined) {
    if (result.items === null || typeof result.items !== "object" || Array.isArray(result.items)) {
      throw new Error(`extension command ${JSON.stringify(call)} result.items must be a record`);
    }
    itemReplacements = keyedRecord();
    for (const id of Object.keys(result.items)) {
      const value = result.items[id];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`extension command ${JSON.stringify(call)} item ${JSON.stringify(id)} must be a finite number`);
      }
      itemReplacements[id] = value;
    }
  }
  let gold: number | undefined;
  if (result.gold !== undefined) {
    if (typeof result.gold !== "number" || !Number.isFinite(result.gold)) {
      throw new Error(`extension command ${JSON.stringify(call)} result.gold must be a finite number`);
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
  for (const [id, value] of writes) {
    // B1 (fix 3): an ext command's numeric write shares the same
    // finite-safe-integer normalizer as every other variable write.
    s.sw.variables[id] = typeof value === "number" ? clampFiniteVar(value) : value;
  }
  if (items !== undefined) s.sw.items = items;
  if (gold !== undefined) s.sw.gold = gold;
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
      let rows = shopRows(stage, ins, w, s.sw, f.key);
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
            s.sw.items[row.item] = clampFiniteVar((s.sw.items[row.item] ?? 0) + 1);
            if (row.stock !== null) {
              s.sw.shopStock[shopStockKey(ins.id, row.item)] = clampFiniteVar(row.stock - 1);
            }
          }
        } else if (row.kind === "item" && stage === "sell") {
          // B4: an unsellable row (dimmed, still navigable under
          // sellList:"disable") cannot be confirmed sold.
          if (row.sellable) {
            s.sw.items[row.item] = clampFiniteVar(Math.max(0, row.owned - 1));
            s.sw.gold = clampFiniteVar(s.sw.gold + row.price);
            const good = ins.goods.find((g) => g.item === row.item && g.stock !== undefined);
            if (good) {
              const key = shopStockKey(ins.id, row.item);
              const current = keyedValue(s.sw.shopStock, key) ?? good.stock!;
              s.sw.shopStock[key] = clampFiniteVar(current + 1);
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
        rows = shopRows(stage, ins, w, s.sw, f.key);
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
        top.pc = evalCondition(ins.cond, s.sw, f.key, input.facing, extension) ? top.pc + 1 : ins.onFalse;
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
      case "place": {
        const eventId = ins.target === "this" ? f.key.split("/").pop()! : ins.target.event;
        const p = { x: ins.x, y: ins.y, dir: ins.dir };
        s.placements[eventId] = p;
        s.pendingPlacements.push({ eventId, ...p });
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
      case "shop": {
        // Same single-slot rule as text/choices.
        if (s.modal) return;
        f.mode = "shop";
        const rows = shopRows("buy", ins, w, s.sw, f.key);
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

  cancelStaleParallels(s, w, input.facing, extension);
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
