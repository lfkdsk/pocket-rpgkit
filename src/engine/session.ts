// src/engine/session.ts — P1④ multi-map session.
//
// One pure fold over the whole project on the fixed MOTION_HZ reference
// (motion-clock.ts, 60 ticks per virtual second):
//
//   mover (movement.ts) ─▶ characters (chars.ts) ─▶ interpreter
//
// stepSession is called once per HOST virtual frame but advances
// MOTION_HZ/simulationHz reference ticks per call (two at 30 Hz, three at
// 20 Hz, fifteen at 4 Hz). Motion, waits, the typewriter and fades are then
// functions of virtual time and agree at every host rate. Input edges are
// one host frame wide and reach only the first reference tick of a batch.
//
// plus the two P1④ mechanics:
//
//   transfer    — swap the current map. Matches MV map-load semantics:
//                 the map interpreter is rebuilt fresh and every map
//                 character returns to its authored cell, while the
//                 project values (switches, items, variables, gold, RNG
//                 cursor) survive. Same-map transfers reset the same way;
//                 the parking fiber ends at the transfer (every authored
//                 transfer is the terminal command of its page). With
//                 fade>0 the swap happens behind a black overlay:
//                 fade-out half, swap on the first fully-black reference
//                 tick, fade-in half.
//   moveRoute   — a command-published route installs on its character
//                 (chars.ts). A wait:true fiber parks in the interpreter's
//                 "external" mode until the route lands, then the session
//                 resumes it with continueExternal. Page switches abort
//                 the route and resume the waiter on the same tick.
//
// No host imports, no wall clock, no Math.random (docs/SIMULATION.md).

import { deepClone, keyedRecord } from "./clone.ts";
import { startupProfileMark } from "../startup-profile.ts";

import {
  activePage,
  clearStaleEventAppearances,
  clampFiniteVar,
  continueBattle,
  continueExternal,
  createInterpState,
  createWorld,
  fiberIsExternal,
  isBusy,
  isWorldIdle,
  keyedEventsOf,
  messageHoldsPlayer,
  ownRecord,
  randInt,
  replaceItemCounts,
  rngNext,
  secondsToFrames,
  shareInterp,
  stepInterpWithExtensionsInPlace,
  type ExtensionScope,
  type ConditionContext,
  type EventPageAppearance,
  type InterpInput,
  type InterpState,
  type PendingBattle,
  type SwitchState,
  type WorldIdleBlockers,
  type WorldOptions,
} from "./interpreter.ts";
import {
  assertJsonValue,
  cloneExtension,
  createExtensionRuntime,
  extensionCallNameValid,
  type ExtensionOptions,
  type ExtensionRuntime,
} from "./extensions.ts";
import {
  cloneScene,
  type BattleInput,
  type BattleRules,
  type SceneSlot,
} from "./battle.ts";
import {
  createChars,
  installRoute,
  placeChar,
  shareChars,
  stopCharRoute,
  stepCharsInPlace,
  stepCharsInPlaceLegacy,
  syncPagesInPlace,
  BFS_CELLS_PER_TICK,
  DEFAULT_PATH_RETRIES,
  PATH_REPLAN_TICKS,
  type CharsState,
  type MotionType,
  type PathPlan,
} from "./chars.ts";
import {
  approachSide,
  approachStand,
  advancePathSearch,
  clonePathSearch,
  createPathSearch,
  facingToward,
} from "./pathfind.ts";
import {
  activeStepConfig,
  dirFromButtons,
  initialMovement,
  stepFrames,
  stepMovement,
  stepMovementLegacy,
  stepPixels,
  type MovementConfig,
  type MovementState,
} from "./movement.ts";
import {
  applyMoveControl,
  canFace,
  createMoveControlState,
  DEFAULT_MOVE_SETTINGS,
  frequencyDelay,
  inMapBounds,
  inWanderBounds,
  movementConfigFor,
  resolveMoveSettings,
  resumeMoveRoute,
  type EventMoveOverride,
  type MoveOverride,
  type MoveControlState,
  type ResolvedMoveSettings,
} from "./move-control.ts";
import { MOTION_HZ, motionTicksPerFrame } from "./motion-clock.ts";
import { BTN_BITS } from "./camera.ts";
import type { Dir4, PassageTable } from "./passability.ts";
import { buildPassage, canStepFrom, stampBlockedCells, withTilePropertyOverrides } from "./passability.ts";
import {
  MAP_SCHEMA_HASH,
  isProjectShell,
  resolveMapManifestHash,
  validateMapIndex,
  type MapContentIdentity,
} from "./map-repository.ts";
import type {
  CommonEvent,
  Dir,
  Facing,
  MapDef,
  MapIndexEntry,
  MapRepository,
  MoveControl,
  MoveStep,
  ProjectSource,
  Command,
  Condition,
  JsonValue,
  Sheet,
} from "./types.ts";

const DX = [0, -1, 0, 1] as const;
const DY = [1, 0, -1, 0] as const;
const DIR_INDEX: Record<Dir, Facing> = { down: 0, left: 1, up: 2, right: 3 };

export interface FadeState {
  phase: "out" | "in";
  /** Frames until the next fade boundary (swap at end of out; clear at
   *  end of in). */
  left: number;
  /** Frames for one half-ramp. */
  half: number;
}

interface PlayerRoute {
  steps: readonly MoveStep[];
  pc: number;
  repeat: boolean;
  skippable: boolean;
  waiter: string | null;
  /** 0 idle at boundary; 1..stepFrames while stepping; negative counts a
   *  pending wait (-ticks..-1), all in MOTION_HZ reference ticks. */
  phase: number;
  dir: Dir4;
  /** The route installed while the mover was mid-step. It takes over on
   *  the next reference tick: the inherited interpolation snaps back to its
   *  origin boundary before the first route command, so a command face
   *  cannot redirect the committed step into an unchecked cell. */
  takeOver: boolean;
  /** Expansion state for the current pathTo/approach step. */
  plan: PathPlan | null;
  /** Remaining replans for the current path step; survives plan rebuilds. */
  pathRetriesLeft: number | null;
}

export interface SessionState {
  frame: number;
  mapId: string;
  sw: SwitchState;
  move: MovementState;
  chars: CharsState;
  interp: InterpState;
  fade: FadeState | null;
  playerRoute: PlayerRoute | null;
  /** Opaque game-owned JSON. Every fold clones and validates it through the
   * registered extension runtime; saves/checksums include it. */
  ext: JsonValue;
  /** Active full-screen scene. null is the backwards-compatible default. */
  scene: SceneSlot | null;
}

function sessionWorldIdleBlockers(
  state: SessionState,
  menuOpen = false,
): WorldIdleBlockers {
  const blockers: WorldIdleBlockers = {
    sceneActive: state.scene !== null,
    fadeActive: state.fade !== null,
    playerRouteActive: state.playerRoute !== null,
    menuOpen,
  };
  // `stop` is route-only: a still-configured runtime wander remains an
  // idle blocker until a motion-mode control changes it to static/page.
  // Keep the legacy object shape when no player wander override exists.
  if (state.interp.moveControls?.player.moveType === "random") {
    blockers.playerWanderActive = true;
  }
  return blockers;
}

/** Public session-level view of the derived `worldIdle` condition. Save-menu
 * state is host-owned rather than serialized, so a host querying while its
 * menu is open supplies `menuOpen=true`; a normal reducer tick omits it. */
export function isSessionWorldIdle(state: SessionState, menuOpen = false): boolean {
  return isWorldIdle(state.interp, sessionWorldIdleBlockers(state, menuOpen));
}

export interface SessionInput extends BattleInput {}

interface SessionMapPreparation {
  id: string;
  map?: MapDef;
  world?: ReturnType<typeof createWorld>;
  table?: PassageTable;
}

export interface Session {
  cfg: MovementConfig;
  /** Host virtual frames per second. */
  hz: number;
  /** Fixed-rate reference ticks folded per host frame (MOTION_HZ / hz). */
  ticksPerFrame: number;
  /** Derived, mutable compile cache. It is deliberately outside
   * SessionState, snapshots and reducer hashes. Inline projects retain all
   * maps; sharded projects retain only the deterministic keep set. */
  maps: Map<string, MapDef>;
  worlds: Map<string, ReturnType<typeof createWorld>>;
  tables: Map<string, PassageTable>;
  /** Derived runtime views, keyed by the immutable tile override record.
   * Never serialized; a rewind/restore with another record identity recooks
   * before collision or pathfinding reads it. */
  runtimeTables: Map<string, {
    base: PassageTable;
    overrides: NonNullable<InterpState["tileProperties"]>;
    table: PassageTable;
  }>;
  /** Metadata for every sharded map without retaining any MapDef payload. */
  mapIndex: ReadonlyMap<string, MapIndexEntry> | null;
  /** Content identity copied into save envelopes for sharded projects. */
  content: MapContentIdentity | null;
  repository: MapRepository | null;
  /** Partially prepared transfer target. Derived only: never serialized or
   * exposed to event logic. */
  preparingMap: SessionMapPreparation | null;
  sheets: ReadonlyMap<string, Sheet>;
  commonEvents: CommonEvent[];
  /** Project.system options, the item catalog/inventory caps (T2-10/B1)
   * and the extension registry every compiled world (eager, on demand or
   * staged) is built with. */
  worldOptions: WorldOptions;
  /** Function registry/codec lives outside reducer state. */
  extensions: ExtensionRuntime;
  battle: BattleRules | null;
  /** Scene policy is immutable host configuration, never reducer state. */
  sceneOptions: Required<SceneOptions>;
}

export interface SceneOptions {
  /** Advance map pages, characters and interpreter fibers while a full-screen
   * scene is active. Defaults to false, matching RPG Maker/Tuxemon battles. */
  worldContinues?: boolean;
}

export interface SessionOptions {
  maps?: MapRepository;
  /** Recompute and verify a ProjectShell's declared mapManifestHash. Splitter
   * output in a trusted app package uses the declared build identity directly
   * by default; shells without one are always hashed. */
  verifyMapManifest?: boolean;
  extensions?: ExtensionOptions;
  battle?: BattleRules;
  scene?: SceneOptions;
}

function visitCondition(c: Condition, found: Set<string>): void {
  if (c.kind === "ext") found.add(`condition ${c.call}`);
}

function visitCommands(commands: readonly Command[], found: Set<string>): void {
  for (const command of commands) {
    if (command.op === "ext") found.add(`command ${command.call}`);
    if (command.op === "extChoice") found.add(`choice ${command.call}`);
    if (command.op === "if") {
      visitCondition(command.if, found);
      visitCommands(command.then, found);
      if (command.else) visitCommands(command.else, found);
    } else if (command.op === "choices") {
      for (const option of command.options) visitCommands(option.commands, found);
      if (command.cancel) visitCommands(command.cancel.commands, found);
    } else if (command.op === "battle") {
      if (command.onWin) visitCommands(command.onWin, found);
      if (command.onLose) visitCommands(command.onLose, found);
      if (command.onEscape) visitCommands(command.onEscape, found);
    }
  }
}

function commandsUseBattle(commands: readonly Command[]): boolean {
  for (const command of commands) {
    if (command.op === "battle") return true;
    if (command.op === "if" && (
      commandsUseBattle(command.then) || commandsUseBattle(command.else ?? [])
    )) return true;
    if (command.op === "choices" && (
      command.options.some((option) => commandsUseBattle(option.commands)) ||
      commandsUseBattle(command.cancel?.commands ?? [])
    )) return true;
  }
  return false;
}

function mapUsesBattle(map: MapDef): boolean {
  return (map.events ?? []).some((event) =>
    event.pages.some((page) => commandsUseBattle(page.commands))
  );
}

function assertBattleRegistered(rules: BattleRules | null, used: boolean): void {
  if (used && rules === null) {
    throw new Error("createSession: project uses battle commands but no BattleRules were registered");
  }
}

function mapExtensionCalls(map: MapDef): Set<string> {
  const found = new Set<string>();
  for (const event of map.events ?? []) {
    for (const page of event.pages) {
      for (const condition of page.condition?.all ?? []) visitCondition(condition, found);
      visitCommands(page.commands, found);
    }
  }
  return found;
}

function commonExtensionCalls(events: readonly CommonEvent[]): Set<string> {
  const found = new Set<string>();
  for (const event of events) visitCommands(event.commands, found);
  return found;
}

function assertRegisteredExtensions(runtime: ExtensionRuntime, found: ReadonlySet<string>): void {
  if (runtime.allowUnknown) return;
  const missing: string[] = [];
  for (const entry of found) {
    const space = entry.indexOf(" ");
    const kind = entry.slice(0, space);
    const call = entry.slice(space + 1);
    if (!extensionCallNameValid(call)) {
      missing.push(`${kind} ${call} (invalid namespaced call)`);
    } else if (
      kind === "command" ? !runtime.commands[call]
      : kind === "choice" ? !runtime.choices[call]
      : !runtime.conditions[call]
    ) {
      missing.push(entry);
    }
  }
  if (missing.length > 0) {
    missing.sort();
    throw new Error(`createSession: unregistered extension calls: ${missing.join(", ")}`);
  }
}

/** Acquire, validate and compile one map into the derived session cache. */
export function acquireSessionMap(sess: Session, id: string): MapDef {
  const hit = sess.maps.get(id);
  if (hit) {
    if (sess.preparingMap?.id === id) sess.preparingMap = null;
    return hit;
  }
  startupProfileMark("map-acquire:start");
  const expected = sess.mapIndex?.get(id);
  const repository = sess.repository;
  if (!expected || !repository) throw new Error(`session: unknown map ${id}`);
  const actual = repository.meta(id);
  if (!actual || actual.id !== expected.id || actual.width !== expected.width ||
    actual.height !== expected.height || actual.entry !== expected.entry ||
    actual.sha256 !== expected.sha256) {
    throw new Error(`map repository: manifest metadata mismatch for ${id}`);
  }
  const prepared = sess.preparingMap?.id === id ? sess.preparingMap : null;
  if (prepared?.map && prepared.world && prepared.table) {
    sess.maps.set(id, prepared.map);
    sess.worlds.set(id, prepared.world);
    sess.tables.set(id, prepared.table);
    sess.runtimeTables.delete(id);
    sess.preparingMap = null;
    return prepared.map;
  }
  const map = repository.acquire(id);
  startupProfileMark("map-acquire:decoded");
  if (map.id !== expected.id || map.width !== expected.width || map.height !== expected.height) {
    throw new Error(`map repository: payload metadata mismatch for ${id}`);
  }
  assertRegisteredExtensions(sess.extensions, mapExtensionCalls(map));
  assertBattleRegistered(sess.battle, mapUsesBattle(map));
  startupProfileMark("map-acquire:validated");
  // Compile into locals first. A throw leaves the live cache and simulation
  // untouched, which is what an async caller needs before retrying a frame.
  const world = createWorld(map, sess.commonEvents, MOTION_HZ, sess.worldOptions);
  startupProfileMark("map-acquire:world");
  const table = buildPassage(map, sess.sheets);
  startupProfileMark("map-acquire:passage");
  sess.maps.set(id, map);
  sess.worlds.set(id, world);
  sess.tables.set(id, table);
  sess.runtimeTables.delete(id);
  if (sess.preparingMap?.id === id) sess.preparingMap = null;
  startupProfileMark("map-acquire:end");
  return map;
}

/** Perform at most one fixed preparation unit for a synchronous repository:
 * repository parse, repository validation, then world + passage compilation.
 * Completed data remains derived and unpublished until acquireSessionMap at
 * the original transfer boundary. */
export function prepareSessionMapStep(sess: Session, id: string): boolean {
  if (sess.maps.has(id)) return true;
  const expected = sess.mapIndex?.get(id);
  const repository = sess.repository;
  if (!expected || !repository) throw new Error(`session: unknown map ${id}`);
  const actual = repository.meta(id);
  if (!actual || actual.id !== expected.id || actual.width !== expected.width ||
    actual.height !== expected.height || actual.entry !== expected.entry ||
    actual.sha256 !== expected.sha256) {
    throw new Error(`map repository: manifest metadata mismatch for ${id}`);
  }
  if (!repository.acquireStep) return false;
  if (sess.preparingMap?.id !== id) sess.preparingMap = { id };
  const preparation = sess.preparingMap;
  if (!preparation.map) {
    const map = repository.acquireStep(id);
    if (map) {
      if (map.id !== expected.id || map.width !== expected.width || map.height !== expected.height) {
        throw new Error(`map repository: payload metadata mismatch for ${id}`);
      }
      assertRegisteredExtensions(sess.extensions, mapExtensionCalls(map));
      assertBattleRegistered(sess.battle, mapUsesBattle(map));
      preparation.map = map;
    }
    return false;
  }
  if (!preparation.world || !preparation.table) {
    const world = createWorld(preparation.map, sess.commonEvents, MOTION_HZ, sess.worldOptions);
    const table = buildPassage(preparation.map, sess.sheets);
    preparation.world = world;
    preparation.table = table;
  }
  return true;
}

/** Prepare web-backed bytes (when supported) and compile them outside the
 * reducer. The caller then retries the exact state/input pair that met a
 * MapNotReadyError; no logical tick is consumed while this promise waits. */
export async function prepareSessionMap(sess: Session, id: string): Promise<void> {
  if (sess.maps.has(id)) return;
  if (!sess.repository || !sess.mapIndex?.has(id)) {
    throw new Error(`session: unknown map ${id}`);
  }
  await sess.repository.prepare?.(id);
  acquireSessionMap(sess, id);
}

/** Deterministic cache policy for sharded projects: retain exactly the given
 * ids, in caller-provided order. Inline projects keep their eager cache. */
export function releaseSessionMapsExcept(sess: Session, ids: readonly string[]): void {
  if (!sess.repository) return;
  const keep = new Set(ids);
  for (const id of [...sess.maps.keys()]) if (!keep.has(id)) sess.maps.delete(id);
  for (const id of [...sess.worlds.keys()]) if (!keep.has(id)) sess.worlds.delete(id);
  for (const id of [...sess.tables.keys()]) if (!keep.has(id)) sess.tables.delete(id);
  for (const id of [...sess.runtimeTables.keys()]) if (!keep.has(id)) sess.runtimeTables.delete(id);
  if (sess.preparingMap && !keep.has(sess.preparingMap.id)) sess.preparingMap = null;
  sess.repository.releaseExcept(ids);
}

export function createSession(
  project: ProjectSource,
  hz: number = MOTION_HZ,
  optionsOrMaps?: SessionOptions | MapRepository,
): Session {
  startupProfileMark("session-create:start");
  // v1.3 compatibility: the original third parameter was a bare repository.
  const options: SessionOptions = optionsOrMaps &&
    typeof (optionsOrMaps as MapRepository).acquire === "function" &&
    typeof (optionsOrMaps as MapRepository).meta === "function"
    ? { maps: optionsOrMaps as MapRepository }
    : (optionsOrMaps as SessionOptions | undefined) ?? {};
  const maps = options.maps;
  const extensions = createExtensionRuntime(options.extensions);
  const sheets = new Map<string, Sheet>(project.sheets.map((s) => [s.id, s]));
  const commonEvents = [...(project.commonEvents ?? [])];
  const worldOptions: WorldOptions = {
    messageBlocksPlayer: project.system?.messageBlocksPlayer === true,
    extensions,
    items: project.items,
    inventory: project.system?.inventory,
    animations: project.animations,
  };
  assertRegisteredExtensions(extensions, commonExtensionCalls(commonEvents));
  assertBattleRegistered(options.battle ?? null, commonEvents.some((event) => commandsUseBattle(event.commands)));
  startupProfileMark("session-create:registrations");
  if (isProjectShell(project)) {
    if (!maps) throw new Error("map repository: ProjectShell requires a MapRepository");
    const index = validateMapIndex(project.mapIndex);
    startupProfileMark("session-create:index-validated");
    const manifest = resolveMapManifestHash(project, options.verifyMapManifest === true);
    startupProfileMark("session-create:manifest-resolved");
    if (project.mapSchemaHash !== undefined && project.mapSchemaHash !== MAP_SCHEMA_HASH) {
      throw new Error("map repository: shell schema hash mismatch");
    }
    if (!index.has(project.start.map)) {
      throw new Error(`map repository: start map ${project.start.map} is absent from mapIndex`);
    }
    const session: Session = {
      cfg: { tile: project.tileSize, speed: 2 },
      hz,
      ticksPerFrame: motionTicksPerFrame(hz),
      maps: new Map(),
      worlds: new Map(),
      tables: new Map(),
      runtimeTables: new Map(),
      mapIndex: index,
      content: { manifest, schema: MAP_SCHEMA_HASH },
      repository: maps,
      preparingMap: null,
      sheets,
      commonEvents,
      worldOptions,
      extensions,
      battle: options.battle ?? null,
      sceneOptions: { worldContinues: options.scene?.worldContinues === true },
    };
    acquireSessionMap(session, project.start.map);
    releaseSessionMapsExcept(session, [project.start.map]);
    startupProfileMark("session-create:end");
    return session;
  }
  for (const map of project.maps) {
    assertRegisteredExtensions(extensions, mapExtensionCalls(map));
    assertBattleRegistered(options.battle ?? null, mapUsesBattle(map));
  }
  const inlineMaps = new Map<string, MapDef>(project.maps.map((m) => [m.id, m]));
  // Interpreter worlds compile at the FIXED motion reference: waits, text
  // reveal and fade frames are counted in reference ticks, and stepSession
  // folds MOTION_HZ/hz of them per host frame. Authored time then means the
  // same virtual time at every host rate.
  const worlds = new Map(
    project.maps.map((m) => [m.id, createWorld(m, commonEvents, MOTION_HZ, worldOptions)]),
  );
  const tables = new Map(project.maps.map((m) => [m.id, buildPassage(m, sheets)]));
  startupProfileMark("session-create:end");
  return {
    cfg: { tile: project.tileSize, speed: 2 },
    hz,
    ticksPerFrame: motionTicksPerFrame(hz),
    maps: inlineMaps,
    worlds,
    tables,
    runtimeTables: new Map(),
    mapIndex: null,
    content: null,
    repository: null,
    preparingMap: null,
    sheets,
    commonEvents,
    worldOptions,
    extensions,
    battle: options.battle ?? null,
    sceneOptions: { worldContinues: options.scene?.worldContinues === true },
  };
}

export function startSession(
  project: ProjectSource,
  session: Session,
  sw0?: SwitchState,
  ext0?: JsonValue,
): SessionState {
  startupProfileMark("session-start:start");
  const start = project.start;
  acquireSessionMap(session, start.map);
  releaseSessionMapsExcept(session, [start.map]);
  if (sw0) {
    const interp = createInterpState(sw0);
    clearLocalBank(interp.sw);
    const state: SessionState = {
      frame: 0,
      mapId: start.map,
      sw: interp.sw,
      move: initialMovement(start.x, start.y, DIR_INDEX[start.dir], session.cfg),
      chars: createChars(),
      interp,
      fade: null,
      playerRoute: null,
      ext: cloneExtension(session.extensions, ext0 === undefined ? session.extensions.initial : ext0),
      scene: null,
    };
    startupProfileMark("session-start:end");
    return state;
  }
  // Fresh playthrough: seed the project's starting gold (the remaining
  // switch/item/variable banks begin empty) and the configurable default
  // player name (substituted for the {name} text token).
  const interp = createInterpState();
  interp.sw.gold = clampFiniteVar(project.initialGold ?? 0);
  if (project.playerName) interp.sw.playerName = project.playerName;
  const state: SessionState = {
    frame: 0,
    mapId: start.map,
    sw: interp.sw,
    move: initialMovement(start.x, start.y, DIR_INDEX[start.dir], session.cfg),
    chars: createChars(),
    interp,
    fade: null,
    playerRoute: null,
    ext: cloneExtension(session.extensions, ext0 === undefined ? session.extensions.initial : ext0),
    scene: null,
  };
  startupProfileMark("session-start:end");
  return state;
}

/** Drop per-visit switch/variable ids. Any switch or variable
 *  whose id starts with `local.` lives for one map visit: it is cleared on
 *  every map entry, so a guard like `local.npc.guard == 0` re-runs after a
 *  transfer away and back. Mutates the shared project-wide bank in place
 *  (the map interpreter rebuild shares this object). */
function clearLocalBank(sw: SwitchState): void {
  for (const id of Object.keys(sw.switches)) {
    if (id.startsWith("local.")) delete ownRecord(sw, "switches")[id];
  }
  for (const id of Object.keys(sw.variables)) {
    if (id.startsWith("local.")) delete ownRecord(sw, "variables")[id];
  }
}

/** Spawn per-entry state for a map: fresh interpreter (MV rebuilds the map
 *  interpreter on load) and characters at their authored cells, with the
 *  project-wide switch bank shared (minus the per-visit `local.` ids). */
function enterMap(
  s: SessionState,
  mapId: string,
  x: number,
  y: number,
  facing: Facing,
  cfg: MovementConfig,
): void {
  clearLocalBank(s.sw);
  s.mapId = mapId;
  s.move = initialMovement(x, y, facing, cfg);
  s.chars = createChars();
  s.interp = createInterpState(s.sw);
  s.sw = s.interp.sw;
  s.playerRoute = null;
}

/** The effective terrain for this exact reducer branch. The authored table
 * remains immutable; a changed/rewound override record gets its own derived
 * typed arrays, while ordinary projects return the base table by identity. */
export function sessionPassageTable(sess: Session, s: SessionState): PassageTable {
  const base = sess.tables.get(s.mapId)!;
  const overrides = s.interp.tileProperties;
  if (!overrides || Object.keys(overrides).length === 0) return base;
  const cached = sess.runtimeTables.get(s.mapId);
  if (cached?.base === base && cached.overrides === overrides) return cached.table;
  const table = withTilePropertyOverrides(base, overrides);
  sess.runtimeTables.set(s.mapId, { base, overrides, table });
  return table;
}

function eventPagesOf(map: MapDef, chars: CharsState): Record<string, EventPageAppearance> {
  const out = keyedRecord<EventPageAppearance>();
  for (const ev of map.events ?? []) {
    const pageIndex = chars.chars[ev.id]?.pageIndex;
    if (pageIndex === undefined || !ev.pages[pageIndex]) continue;
    out[ev.id] = { pageIndex, sprite: ev.pages[pageIndex]!.sprite ?? null };
  }
  return out;
}

function sessionConditionContext(
  world: ReturnType<typeof createWorld>,
  s: SessionState,
  eventPages: Readonly<Record<string, EventPageAppearance>> | undefined,
): ConditionContext {
  const context: ConditionContext = { worldIdle: isSessionWorldIdle(s) };
  if (eventPages) {
    context.eventPages = eventPages;
    context.eventAppearances = s.interp.eventAppearances;
  }
  if (world.needsTilePropertyContext) {
    context.tileProperties = s.interp.tileProperties;
    context.mapWidth = world.map.width;
    context.mapHeight = world.map.height;
  }
  return context;
}

/** The baked map table plus blocking-character bodies, held as a sparse
 *  set of occupied row-major cells. A body
 *  blocks regardless of the terrain opinion under it: a map.passage
 *  "pass" override reopens terrain (a gate through a fence), it never
 *  lets the mover walk through a blocks:true character standing there. */
export function tableWithBodies(
  base: PassageTable,
  chars: CharsState,
  settings?: Readonly<Record<string, ResolvedMoveSettings>>,
): PassageTable {
  if (settings === undefined) return tableWithBodiesLegacy(base, chars);
  const cells: number[] = [];
  const add = (x: number, y: number): void => {
    if (x >= 0 && y >= 0 && x < base.width && y < base.height) {
      cells.push(y * base.width + x);
    }
  };
  for (const ch of Object.values(chars.chars)) {
    if (!ch.blocks || settings?.[ch.id]?.through === true) continue;
    add(ch.tx, ch.ty);
    if (ch.moving) add(ch.tx + DX[ch.stepDir], ch.ty + DY[ch.stepDir]);
  }
  return stampBlockedCells(base, cells);
}

/** Original body-overlay loop for worlds without KM1 settings. */
function tableWithBodiesLegacy(base: PassageTable, chars: CharsState): PassageTable {
  const cells: number[] = [];
  const add = (x: number, y: number): void => {
    if (x >= 0 && y >= 0 && x < base.width && y < base.height) {
      cells.push(y * base.width + x);
    }
  };
  for (const ch of Object.values(chars.chars)) {
    if (!ch.blocks) continue;
    add(ch.tx, ch.ty);
    if (ch.moving) add(ch.tx + DX[ch.stepDir], ch.ty + DY[ch.stepDir]);
  }
  return stampBlockedCells(base, cells);
}

function motionOf(
  map: MapDef,
  sw: SwitchState,
  facing: Facing,
  extension: ExtensionScope,
  conditionContext?: ConditionContext,
): Record<string, MotionType> {
  const out = keyedRecord<MotionType>();
  for (const ev of map.events ?? []) {
    const active = activePage(ev, sw, map.id, facing, extension, conditionContext);
    if (active) out[ev.id] = active.page.moveType ?? "static";
  }
  return out;
}

function moveSettingsOf(
  map: MapDef,
  sw: SwitchState,
  facing: Facing,
  extension: ExtensionScope,
  overrides: Readonly<Record<string, EventMoveOverride>> | undefined,
  conditionContext?: ConditionContext,
): Record<string, ResolvedMoveSettings> {
  const out = keyedRecord<ResolvedMoveSettings>();
  for (const ev of map.events ?? []) {
    const active = activePage(ev, sw, map.id, facing, extension, conditionContext);
    if (!active) continue;
    const override = overrides?.[ev.id];
    out[ev.id] = resolveMoveSettings(
      active.page,
      override?.pageIndex === active.index ? override : undefined,
    );
  }
  return out;
}

/** Resolve settings from the page indexes syncPagesInPlace just committed,
 * avoiding a second activePage evaluation over the whole map. */
function moveSettingsFromSyncedChars(
  map: MapDef,
  chars: CharsState,
  overrides: Readonly<Record<string, EventMoveOverride>> | undefined,
): Record<string, ResolvedMoveSettings> {
  const out = keyedRecord<ResolvedMoveSettings>();
  for (const ev of map.events ?? []) {
    const pageIndex = chars.chars[ev.id]?.pageIndex;
    if (pageIndex === undefined) continue;
    const page = ev.pages[pageIndex];
    if (!page) continue;
    const override = overrides?.[ev.id];
    out[ev.id] = resolveMoveSettings(
      page,
      override?.pageIndex === pageIndex ? override : undefined,
    );
  }
  return out;
}

/** Drop stale overrides only after page sync has materialized the active
 *  page. A restored save begins with no CharState; its matching page-tagged
 *  override therefore survives the first reconciliation. */
function pruneEventMoveControls(s: SessionState): void {
  const controls = s.interp.moveControls;
  if (!controls) return;
  for (const id of Object.keys(controls.events)) {
    const ch = s.chars.chars[id];
    if (!ch || ch.pageIndex !== controls.events[id]!.pageIndex) {
      delete controls.events[id];
    }
  }
}

function ensureMoveControls(s: SessionState): MoveControlState {
  if (!s.interp.moveControls) s.interp.moveControls = createMoveControlState();
  return s.interp.moveControls;
}

const BUTTON_FOR_DIR = [BTN_BITS.DOWN, BTN_BITS.LEFT, BTN_BITS.UP, BTN_BITS.RIGHT] as const;

function stepPlayerWander(
  s: SessionState,
  base: PassageTable,
  cfg: MovementConfig,
  settings: ResolvedMoveSettings,
  eventSettings: Readonly<Record<string, ResolvedMoveSettings>>,
): void {
  const override = ensureMoveControls(s).player;
  const moveCfg = movementConfigFor(cfg, settings);
  const table = tableWithBodies(base, s.chars, eventSettings);
  if (s.move.moving) {
    Object.assign(s.move, stepMovement(s.move, 0, table, moveCfg, {
      through: settings.through,
      faceMovement: canFace(settings, false),
    }));
    return;
  }
  if ((override.cooldown ?? 0) > 0) {
    override.cooldown = override.cooldown! - 1;
    return;
  }
  const exits: Dir4[] = [];
  for (const dir of [0, 1, 2, 3] as const) {
    const tx = s.move.tx + DX[dir];
    const ty = s.move.ty + DY[dir];
    if (!inWanderBounds(settings.bounds, tx, ty)) continue;
    const open = settings.through
      ? inMapBounds(base.width, base.height, tx, ty)
      : canStepFrom(table, s.move.tx, s.move.ty, dir);
    if (open) exits.push(dir);
  }
  override.cooldown = frequencyDelay(settings.frequency);
  if (exits.length === 0) return;
  const roll = randInt(s.sw.rng, 0, exits.length - 1);
  s.sw.rng = roll.next;
  Object.assign(s.move, stepMovement(s.move, BUTTON_FOR_DIR[exits[roll.value]!]!, table, moveCfg, {
    through: settings.through,
    faceMovement: canFace(settings, false),
  }));
}

function eventIdOf(key: string, mapId: string): string {
  const prefix = `${mapId}/`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

function eventMoveOverride(s: SessionState, eventId: string): EventMoveOverride | null {
  const ch = s.chars.chars[eventId];
  if (!ch) return null;
  const controls = ensureMoveControls(s);
  let override = controls.events[eventId];
  if (!override || override.pageIndex !== ch.pageIndex) {
    override = { pageIndex: ch.pageIndex };
    controls.events[eventId] = override;
  }
  return override;
}

function stopPlayerRoute(s: SessionState): void {
  const route = s.playerRoute;
  if (route && route.phase > 0) {
    // Player routes keep interpolation phase on the route. Hand the
    // committed step back to the ordinary mover so stop finishes this tile
    // without a pixel jump, just like the NPC route path.
    s.move.phase = route.phase;
    s.move.stepDir = route.dir;
    s.move.moving = true;
  }
  if (route?.waiter) s.interp = continueExternal(s.interp, route.waiter);
  s.playerRoute = null;
  s.move.walking = false;
}

/** Apply one command/route control at the session boundary. Missing map
 *  events are a no-op, matching moveRoute target resolution. */
function applyTargetMoveControl(
  s: SessionState,
  target: "player" | { event: string },
  control: MoveControl,
): void {
  if (target === "player") {
    applyMoveControl(ensureMoveControls(s).player, control);
    if (control.kind === "stop") stopPlayerRoute(s);
    return;
  }
  const override = eventMoveOverride(s, target.event);
  if (!override) return;
  applyMoveControl(override, control);
  if (control.kind !== "stop") return;
  const stopped = stopCharRoute(s.chars, target.event);
  s.chars = stopped.state;
  if (stopped.displacedWaiter) {
    s.interp = continueExternal(s.interp, stopped.displacedWaiter);
  }
}

/** Opacity the UI overlay shows on the current fade frame: 1 fully black. */
export function fadeOpacity(fade: FadeState | null): number {
  if (!fade) return 0;
  return fade.phase === "out" ? 1 - fade.left / fade.half : fade.left / fade.half;
}

const NO_MAP_INPUT: SessionInput = {
  buttons: 0,
  confirmEdge: false,
  cancelEdge: false,
  upEdge: false,
  downEdge: false,
};

function battleInput(input: SessionInput): Readonly<BattleInput> {
  return {
    buttons: input.buttons >>> 0,
    confirmEdge: input.confirmEdge === true,
    cancelEdge: input.cancelEdge === true,
    upEdge: input.upEdge === true,
    downEdge: input.downEdge === true,
  };
}

/** Consume one queued Battle Processing request. One draw
 * from the session cursor derives an isolated u32 seed even when start()
 * declines the encounter; no game rule may read wall time or global RNG.
 * The caller guarantees there is no active scene; violating that invariant
 * is an engine programming error, never a project-content path. A malformed
 * BattleRules.start return is likewise a registered game-code contract
 * violation and intentionally throws. */
function startBattleScene(sess: Session, s: SessionState, request: PendingBattle): boolean {
  if (s.scene !== null) {
    throw new Error("battle queue invariant: cannot start while a scene is active");
  }
  const rules = sess.battle;
  if (!rules) throw new Error("battle queue invariant: no BattleRules registered");
  const draw = rngNext(s.interp.sw.rng);
  s.interp.sw.rng = draw.next;
  s.sw = s.interp.sw;
  const seed = Math.floor(draw.value * 4294967296) >>> 0;
  const startExt = cloneExtension(sess.extensions, s.ext);
  const started = rules.start(
    startExt,
    deepClone(request.setup),
    seed,
    {
      ext: cloneExtension(sess.extensions, s.ext),
      switches: keyedRecord(s.interp.sw.switches),
      variables: keyedRecord(s.interp.sw.variables),
      items: keyedRecord(s.interp.sw.items),
      gold: s.interp.sw.gold,
    },
  );
  if (started === null) {
    s.interp = continueExternal(s.interp, request.fiber);
    s.sw = s.interp.sw;
    return false;
  }
  if (typeof started !== "object" || Array.isArray(started)) {
    throw new Error("battle start: BattleStart object or null required");
  }
  assertJsonValue(started.state, "battle start state");
  s.ext = cloneExtension(sess.extensions, started.ext, "battle start extension state");
  s.scene = {
    kind: "battle",
    fiber: request.fiber,
    state: deepClone(started.state),
    pausedTicks: 0,
  };
  return true;
}

/** Start queued requests only while the scene slot is free. Null encounters
 * resume immediately and do not delay the next request; a real scene leaves
 * the remaining FIFO intact for a later reference tick. A canceled parallel
 * has no fiber to resume, so its stale request is discarded as content data
 * rather than ever reaching the rules callback. */
function startNextBattleScene(sess: Session, s: SessionState): void {
  while (s.scene === null && s.interp.pendingBattles.length > 0) {
    const request = s.interp.pendingBattles.shift()!;
    if (!fiberIsExternal(s.interp, request.fiber)) continue;
    if (startBattleScene(sess, s, request)) return;
  }
}

/** Advance only the interpreter's absolute reference clock. The elapsed
 * pause is retained on the scene and applied to relative fiber clocks on
 * completion, leaving the fibers themselves byte-stable while frozen. */
function tickFrozenWorld(s: SessionState): void {
  s.interp.frame++;
  if (s.scene) s.scene.pausedTicks++;
  s.interp.cues = [];
  s.interp.pendingMoveRoutes = [];
  s.interp.pendingPlacements = [];
  s.interp.abortedRoutes = [];
}

function completionTransfer(value: unknown): Omit<import("./interpreter.ts").PendingTransfer, "fiber"> | null {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("battle completion transfer must be an object");
  }
  const transfer = value as Record<string, unknown>;
  if (typeof transfer.map !== "string" || transfer.map.length === 0) {
    throw new Error("battle completion transfer.map must be a non-empty string");
  }
  if (!Number.isInteger(transfer.x) || (transfer.x as number) < 0 ||
    !Number.isInteger(transfer.y) || (transfer.y as number) < 0) {
    throw new Error("battle completion transfer coordinates must be non-negative integers");
  }
  const dir = transfer.dir ?? "keep";
  if (dir !== "keep" && dir !== "down" && dir !== "left" && dir !== "up" && dir !== "right") {
    throw new Error("battle completion transfer.dir is invalid");
  }
  const fade = transfer.fade ?? 0;
  if (typeof fade !== "number" || !Number.isFinite(fade) || fade < 0) {
    throw new Error("battle completion transfer.fade must be a non-negative finite number");
  }
  return {
    map: transfer.map,
    x: transfer.x as number,
    y: transfer.y as number,
    dir,
    fadeFrames: secondsToFrames(fade, MOTION_HZ),
  };
}

/** Advance the game-owned battle reducer once for this host frame, then
 * atomically commit a terminal result. Result commands run before an optional
 * completion transfer; continueBattle installs both on the parked fiber.
 * Invalid step/done return shapes are registered BattleRules programming
 * errors and intentionally throw; authored event operands never reach these
 * assertions. */
function advanceBattleScene(
  sess: Session,
  s: SessionState,
  input: Readonly<BattleInput>,
  ticks: number,
): void {
  const scene = s.scene;
  const rules = sess.battle;
  if (!scene || !rules) return;
  if (ticks > 0) {
    const stepped = rules.step(deepClone(scene.state), input, ticks);
    assertJsonValue(stepped, "battle step state");
    scene.state = deepClone(stepped);
  }
  const completion = rules.done(deepClone(scene.state));
  if (completion === null) return;
  if (typeof completion !== "object" || Array.isArray(completion)) {
    throw new Error("battle done: BattleCompletion object or null required");
  }
  if (
    completion.result !== "win" && completion.result !== "lose" &&
    completion.result !== "escape" && completion.result !== "draw"
  ) {
    throw new Error("battle done: result must be win, lose, escape, or draw");
  }
  const nextExt = cloneExtension(sess.extensions, completion.ext, "battle completion extension state");
  const writes: [string, string | number][] = [];
  const switches: [string, boolean][] = [];
  if (completion.writes !== undefined) {
    if (completion.writes === null || typeof completion.writes !== "object" || Array.isArray(completion.writes)) {
      throw new Error("battle completion writes must be a record");
    }
    for (const id of Object.keys(completion.writes)) {
      const value = completion.writes[id];
      if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) {
        throw new Error(`battle completion write ${JSON.stringify(id)} must be a string or finite number`);
      }
      writes.push([id, value]);
    }
  }
  if (completion.switches !== undefined) {
    if (completion.switches === null || typeof completion.switches !== "object" || Array.isArray(completion.switches)) {
      throw new Error("battle completion switches must be a record");
    }
    for (const id of Object.keys(completion.switches)) {
      const value = completion.switches[id];
      if (typeof value !== "boolean") {
        throw new Error(`battle completion switch ${JSON.stringify(id)} must be a boolean`);
      }
      switches.push([id, value]);
    }
  }
  let itemReplacements: Record<string, number> | undefined;
  if (completion.items !== undefined) {
    if (completion.items === null || typeof completion.items !== "object" || Array.isArray(completion.items)) {
      throw new Error("battle completion items must be a record");
    }
    itemReplacements = keyedRecord();
    for (const id of Object.keys(completion.items)) {
      const value = completion.items[id];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`battle completion item ${JSON.stringify(id)} must be a finite number`);
      }
      itemReplacements[id] = value;
    }
  }
  let gold: number | undefined;
  if (completion.gold !== undefined) {
    if (typeof completion.gold !== "number" || !Number.isFinite(completion.gold)) {
      throw new Error("battle completion gold must be a finite number");
    }
    gold = Math.max(0, clampFiniteVar(completion.gold));
  }
  const transfer = completionTransfer(completion.transfer);
  const items = itemReplacements === undefined
    ? undefined
    : replaceItemCounts(s.interp.sw.items, itemReplacements, sess.worldOptions.inventory);

  s.ext = nextExt;
  // B1 (fix 3): a battle completion's numeric write shares
  // the interpreter's finite-safe-integer normalizer, same as an ext
  // command's writes and every authored variable/gold/item command.
  const variables = writes.length > 0 ? ownRecord(s.interp.sw, "variables") : null;
  for (const [id, value] of writes) {
    variables![id] = typeof value === "number" ? clampFiniteVar(value) : value;
  }
  const switchBank = switches.length > 0 ? ownRecord(s.interp.sw, "switches") : null;
  for (const [id, value] of switches) switchBank![id] = value;
  if (items !== undefined) s.interp.sw.items = items;
  if (gold !== undefined) s.interp.sw.gold = gold;
  if (scene.pausedTicks > 0) {
    const shift = (fiber: SessionState["interp"]["main"]): void => {
      if (
        fiber?.mode === "wait" ||
        fiber?.mode === "text" ||
        fiber?.mode === "animWait"
      ) {
        fiber.since += scene.pausedTicks;
      }
    };
    shift(s.interp.main);
    for (const fiber of Object.values(s.interp.parallels)) shift(fiber);
    // Map animation clocks are absolute (instance.start against interp.frame).
    // A default-frozen scene advances the reference clock but not the world,
    // so without this shift a hidden animation would burn frames (and a
    // looping one could finish) behind the battle. Shift every live start by
    // the paused duration so playback resumes from the same visual frame.
    // The array is copy-on-write (shared with the previous state), so the
    // shift writes a fresh array of fresh instances. An explicit
    // worldContinues scene never freezes the world and needs no shift.
    const anims = s.interp.anims;
    if (anims !== undefined) {
      s.interp.anims = anims.map((a) => ({ ...a, start: a.start + scene.pausedTicks }));
    }
  }
  s.interp = continueBattle(s.interp, scene.fiber, completion.result, transfer);
  s.sw = s.interp.sw;
  s.scene = null;
}

/** One host virtual frame. The fold runs on the fixed MOTION_HZ reference:
 *  every host frame folds MOTION_HZ/hz reference ticks — two at 30 Hz,
 *  three at 20 Hz, fifteen at 4 Hz. Motion, waits, text and fades are
 *  therefore functions of virtual time and agree at every host rate. Input
 *  edges are one host frame wide and are delivered only on the FIRST
 *  reference tick of a batch; the remaining ticks reuse the held button
 *  mask with no edges. Pure: returns a NEW SessionState. */
export function stepSession(
  sess: Session,
  s0: SessionState,
  input: SessionInput,
): SessionState {
  // One working copy per frame. The reference ticks below advance it in
  // place; characters and switch records stay shared with s0 until written.
  const interp = shareInterp(s0.interp);
  const s: SessionState = {
    frame: s0.frame,
    mapId: s0.mapId,
    sw: interp.sw,
    move: { ...s0.move },
    chars: shareChars(s0.chars),
    interp,
    fade: s0.fade ? { ...s0.fade } : null,
    playerRoute: s0.playerRoute
      ? {
          ...s0.playerRoute,
          steps: [...s0.playerRoute.steps],
          plan: s0.playerRoute.plan
            ? {
                ...s0.playerRoute.plan,
                dirs: [...s0.playerRoute.plan.dirs],
                search: clonePathSearch(s0.playerRoute.plan.search),
                approach: s0.playerRoute.plan.approach
                  ? { ...s0.playerRoute.plan.approach }
                  : null,
              }
            : null,
        }
      : null,
    ext: cloneExtension(sess.extensions, s0.ext),
    scene: cloneScene(s0.scene),
  };
  s.frame++;
  const ticks = sess.ticksPerFrame;
  const sceneAtFrameStart = s.scene !== null;
  let sceneStartedAt = sceneAtFrameStart ? 0 : -1;

  let prevCell = { x: s.move.tx, y: s.move.ty };
  for (let tick = 0; tick < ticks; tick++) {
    const tickInput: SessionInput = s.scene
      ? NO_MAP_INPUT
      : tick === 0
        ? input
        : { buttons: input.buttons, confirmEdge: false, cancelEdge: false, upEdge: false, downEdge: false };
    const hadScene = s.scene !== null;
    const nextCell = stepReferenceTick(sess, s, tickInput, prevCell);
    prevCell = nextCell;
    if (!hadScene && s.scene !== null && sceneStartedAt < 0) sceneStartedAt = tick + 1;
    // A fatalized interpreter freezes the playfield for the rest of the
    // batch (review 1274 B1): reference clock keeps advancing, the fold
    // does not.
    if (s.interp.error) break;
  }
  if (s.scene) {
    const sceneTicks = sceneAtFrameStart ? ticks : Math.max(0, ticks - sceneStartedAt);
    advanceBattleScene(
      sess,
      s,
      sceneAtFrameStart ? battleInput(input) : battleInput(NO_MAP_INPUT),
      sceneTicks,
    );
  }
  return s;
}

/** Advance the session one MOTION_HZ reference tick, mutating the working
 *  clone `s`. Returns the player cell the next tick sees as prevCell. */
function stepReferenceTick(
  sess: Session,
  s: SessionState,
  input: SessionInput,
  prevCellIn: { x: number; y: number },
): { x: number; y: number } {
  const map = sess.maps.get(s.mapId)!;

  // A completion is observed after the previous host frame's reference-tick
  // batch. Its successor therefore starts on this next reference tick, never
  // recursively on the completion frame.
  if (s.scene === null && s.interp.pendingBattles.length > 0) {
    startNextBattleScene(sess, s);
  }

  // Full-screen scenes own the reference clock by default. Games that need
  // background simulation must opt in explicitly; their newly published
  // battle requests remain queued until the active scene completes.
  if (s.scene !== null && !sess.sceneOptions.worldContinues) {
    tickFrozenWorld(s);
    return { x: s.move.tx, y: s.move.ty };
  }

  // -- fade: gameplay and input freeze while the overlay moves -----------
  if (s.fade) {
    if (s.fade.phase === "out") {
      const transfer = s.interp.pendingTransfer;
      if (transfer) prepareSessionMapStep(sess, transfer.map);
    }
    s.fade.left--;
    if (s.fade.left > 0) return { x: s.move.tx, y: s.move.ty };
    if (s.fade.phase === "out") {
      const t = s.interp.pendingTransfer;
      if (t) applyTransfer(sess, s, t.map, t.x, t.y, t.dir);
      s.fade = { phase: "in", left: s.fade.half, half: s.fade.half };
      return { x: s.move.tx, y: s.move.ty };
    }
    s.fade = null;
    return { x: s.move.tx, y: s.move.ty };
  }

  // A fatal interpreter error freezes the playfield (review 1274 B1): the
  // clock advances but no mover, character, or interpreter fold runs, so a
  // cyclic program cannot consume steps or keep throwing tick after tick.
  if (s.interp.error) return { x: s.move.tx, y: s.move.ty };

  // 1. Reconcile NPC pages. A page switch (or an event that went away)
  //    aborts any forced route parked on it; resume the waiter so the
  //    external fiber cannot deadlock.
  const erased = s.interp.erased;
  const world = sess.worlds.get(s.mapId)!;
  const needsMovementControlPath =
    world.needsMovementControlPath === true || s.interp.moveControls !== undefined;
  const extension: ExtensionScope = { runtime: sess.extensions, ext: s.ext };
  const needsEventPages = world.needsEventPages === true || s.interp.eventAppearances !== undefined;
  const previousEventPages = needsEventPages ? eventPagesOf(map, s.chars) : undefined;
  let conditionContext = sessionConditionContext(world, s, previousEventPages);
  const syncFacing = s.move.facing;
  const syncMotion = keyedRecord<MotionType>();
  const keyed = keyedEventsOf(world);
  const synced = syncPagesInPlace(
    s.chars,
    keyed.events,
    keyed.slotsById,
    s.sw,
    sess.cfg,
    (key) => Object.prototype.hasOwnProperty.call(erased, key),
    s.interp.placements,
    syncFacing,
    extension,
    syncMotion,
    true,
    conditionContext,
    s.interp.eventAppearances,
  );
  const eventPages = needsEventPages ? eventPagesOf(map, s.chars) : undefined;
  if (eventPages && s.interp.eventAppearances) clearStaleEventAppearances(s.interp, eventPages);
  conditionContext = sessionConditionContext(world, s, eventPages);
  for (const waiter of synced.abortedWaiters) {
    s.interp = continueExternal(s.interp, waiter);
  }
  const passage = sessionPassageTable(sess, s);

  // 2. Mover — frozen while a blocking fiber runs, the player's own forced
  //    route is driving, a choices box (including one owned by a PARALLEL
  //    page) is open capturing the d-pad, or the cross-event input lock is
  //    held. A parallel TEXT line does not freeze the world
  //    (review C10) unless the project opts in with
  //    system.messageBlocksPlayer: then any open box holds the player.
  const prevFacing = s.move.facing;
  const busy = isBusy(s.interp);
  const capturesDpad = s.interp.modal?.kind === "choices" || s.interp.modal?.kind === "shop";
  const held = messageHoldsPlayer(world, s.interp);
  let finishedWaiters: string[];
  let playerRouteSettings = DEFAULT_MOVE_SETTINGS as ResolvedMoveSettings;
  let playerRouteEventSettings: Readonly<Record<string, ResolvedMoveSettings>> | undefined;
  if (!needsMovementControlPath) {
    if (!busy && !capturesDpad && !held && s.playerRoute === null && !s.interp.inputLocked) {
      // stepMovement consults the table only for a held direction.
      const table = dirFromButtons(input.buttons) === null
        ? passage
        : tableWithBodiesLegacy(passage, s.chars);
      Object.assign(s.move, stepMovementLegacy(s.move, input.buttons, table, sess.cfg));
    }
    const playerPlace = {
      tx: s.move.tx,
      ty: s.move.ty,
      destX: s.move.moving ? s.move.tx + DX[s.move.stepDir] : s.move.tx,
      destY: s.move.moving ? s.move.ty + DY[s.move.stepDir] : s.move.ty,
    };
    const locked = new Set<string>();
    if (s.interp.main) locked.add(eventIdOf(s.interp.main.key, s.mapId));
    finishedWaiters = stepCharsInPlaceLegacy(
      s.chars,
      passage,
      playerPlace,
      sess.cfg,
      locked,
      s.move.facing === syncFacing
        ? syncMotion
        : motionOf(map, s.sw, s.move.facing, extension, conditionContext),
    );
  } else {
    // continueExternal may have replaced the interpreter clone. Refresh the
    // aliases before movement reads/writes runtime overrides and saved RNG.
    s.sw = s.interp.sw;
    pruneEventMoveControls(s);
    let eventSettings = moveSettingsFromSyncedChars(
      map,
      s.chars,
      s.interp.moveControls?.events,
    );
    const playerSettings = s.interp.moveControls?.player
      ? resolveMoveSettings(null, s.interp.moveControls.player)
      : DEFAULT_MOVE_SETTINGS as ResolvedMoveSettings;
    playerRouteSettings = playerSettings;

    if (!busy && !capturesDpad && !held && s.playerRoute === null && !s.interp.inputLocked) {
      if (playerSettings.runtimeWander) {
        if (s.interp.modal === null) {
          stepPlayerWander(s, passage, sess.cfg, playerSettings, eventSettings);
        }
      } else {
        const table = dirFromButtons(input.buttons) === null
          ? passage
          : tableWithBodies(passage, s.chars, eventSettings);
        Object.assign(s.move, stepMovement(
          s.move,
          input.buttons,
          table,
          movementConfigFor(sess.cfg, playerSettings),
          {
            through: playerSettings.through,
            faceMovement: canFace(playerSettings, false),
          },
        ));
      }
    }

    const playerPlace = {
      tx: s.move.tx,
      ty: s.move.ty,
      destX: s.move.moving ? s.move.tx + DX[s.move.stepDir] : s.move.tx,
      destY: s.move.moving ? s.move.ty + DY[s.move.stepDir] : s.move.ty,
      through: playerSettings.through,
    };
    const locked = new Set<string>();
    if (s.interp.main) locked.add(eventIdOf(s.interp.main.key, s.mapId));
    if (s.move.facing !== syncFacing) {
      eventSettings = moveSettingsOf(
        map,
        s.sw,
        s.move.facing,
        extension,
        s.interp.moveControls?.events,
        conditionContext,
      );
    }
    finishedWaiters = stepCharsInPlace(
      s.chars,
      passage,
      playerPlace,
      sess.cfg,
      locked,
      s.move.facing === syncFacing
        ? syncMotion
        : motionOf(map, s.sw, s.move.facing, extension, conditionContext),
      {
        settings: eventSettings,
        applyControl: (eventId, control) => {
          const override = eventMoveOverride(s, eventId);
          if (override) applyMoveControl(override, control);
        },
        runtimeRng: s.sw,
        modalOpen: s.interp.modal !== null,
      },
    );
    playerRouteEventSettings = eventSettings;
    s.sw = s.interp.sw;
  }
  for (const waiter of finishedWaiters) {
    s.interp = continueExternal(s.interp, waiter);
  }
  s.sw = s.interp.sw;
  if (s.playerRoute) {
    stepPlayerRoute(s, sess, playerRouteSettings, playerRouteEventSettings);
  }

  // 4. Interpreter — only displaced NPC cells need to supplement the
  // world's authored spatial index. Static characters resolve from the
  // indexed event origin without growing the per-frame record. A world
  // with event-targeted mapAnim additionally gets every live character's
  // cell so the command resolves the target without an authored fallback.
  const eventCells = keyedRecord<{ x: number; y: number }>();
  const liveEventCells = world.needsMapAnimTarget ? keyedRecord<{ x: number; y: number }>() : undefined;
  for (const ev of map.events ?? []) {
    const ch = s.chars.chars[ev.id];
    if (ch && (ch.tx !== ev.x || ch.ty !== ev.y)) eventCells[ev.id] = { x: ch.tx, y: ch.ty };
    if (liveEventCells && ch) liveEventCells[ev.id] = { x: ch.tx, y: ch.ty };
  }
  const interpInput: InterpInput = {
    confirmEdge: input.confirmEdge,
    cancelEdge: input.cancelEdge,
    upEdge: input.upEdge,
    downEdge: input.downEdge,
    playerCell: { x: s.move.tx, y: s.move.ty },
    prevCell: prevCellIn,
    facing: s.move.facing,
    prevFacing,
    eventCells,
    ...(liveEventCells ? { liveEventCells } : {}),
    eventPages,
    worldIdleBlockers: sessionWorldIdleBlockers(s),
  };
  s.ext = stepInterpWithExtensionsInPlace(
    world,
    s.interp,
    interpInput,
    s.ext,
  );
  // continueExternal above may have replaced s.interp with a copy whose
  // switch bank is a new object; re-alias the session's top-level bank to it
  // so the values chars/motion read next tick are the ones commands just
  // wrote.
  s.sw = s.interp.sw;
  const transfer = s.interp.pendingTransfer;
  if (transfer && !transferMapKnown(sess, transfer.map)) {
    s.interp.pendingTransfer = null;
    s.interp.error = {
      kind: "content",
      message: `transfer in ${transfer.fiber}: unknown map ${JSON.stringify(transfer.map)}`,
    };
    return { x: s.move.tx, y: s.move.ty };
  }

  // A page-scoped parallel canceled this tick may have owned a waited
  // player route: drop it without resuming the dead waiter. The event-side
  // half is torn down by syncPages (the character's page went away).
  if (s.playerRoute && s.playerRoute.waiter && s.interp.abortedRoutes.includes(s.playerRoute.waiter)) {
    s.playerRoute = null;
    s.move.walking = false;
  }

  // 5. Consume published external requests. Routes drain in command order
  //    so the fire-and-forget player turn installs before the waited
  //    self-route parks the fiber.
  for (const req of s.interp.pendingMoveRoutes) {
    if ("control" in req) {
      applyTargetMoveControl(s, req.target, req.control);
      continue;
    }
    if (req.target === "player") {
      // A route replacing one still running releases the parked waiter
      // instead of orphaning it, and takes over at a tile boundary: a
      // command face must not inherit the mover's committed interpolation
      // and redirect it into a cell the new direction never checked.
      if (s.playerRoute?.waiter) {
        s.interp = continueExternal(s.interp, s.playerRoute.waiter);
      }
      if (s.interp.moveControls) resumeMoveRoute(s.interp.moveControls.player);
      s.playerRoute = {
        steps: req.route.steps,
        pc: 0,
        repeat: req.route.repeat,
        skippable: req.route.skippable,
        waiter: req.wait ? req.fiber : null,
        phase: 0,
        dir: s.move.facing,
        takeOver: s.move.moving,
        plan: null,
        pathRetriesLeft: null,
      };
    } else {
      // A route to an event with no live character (no active page, or it
      // was erased) cannot run: resume a waiting caller immediately rather
      // than park its external fiber forever (MV: a Set Movement Route on
      // an absent map event is a no-op).
      if (!s.chars.chars[req.eventId]) {
        if (req.wait) s.interp = continueExternal(s.interp, req.fiber);
        continue;
      }
      const override = s.interp.moveControls?.events[req.eventId];
      if (override) resumeMoveRoute(override);
      const installed = installRoute(
        s.chars,
        req.eventId,
        req.route,
        req.wait ? req.fiber : null,
        sess.cfg,
      );
      s.chars = installed.state;
      if (installed.displacedWaiter) {
        s.interp = continueExternal(s.interp, installed.displacedWaiter);
      }
    }
  }
  // 5b. `place` requests: relocate the live character now; the
  //     durable placement record the interpreter already holds makes a
  //     later-created character spawn at the new tile on the next sync.
  for (const p of s.interp.pendingPlacements) {
    if ("target" in p) {
      if (!inMapBounds(map.width, map.height, p.x, p.y)) continue;
      stopPlayerRoute(s);
      const facing = p.dir === null ? s.move.facing : DIR_INDEX[p.dir];
      s.move = initialMovement(p.x, p.y, facing, sess.cfg);
      continue;
    }
    if (!inMapBounds(map.width, map.height, p.x, p.y)) continue;
    const placed = placeChar(s.chars, p.eventId, p.x, p.y, p.dir, sess.cfg);
    s.chars = placed.state;
    if (placed.displacedWaiter) {
      s.interp = continueExternal(s.interp, placed.displacedWaiter);
    }
  }
  s.sw = s.interp.sw;
  if (s.scene === null && s.interp.pendingBattles.length > 0) {
    startNextBattleScene(sess, s);
  }
  if (s.interp.pendingTransfer) {
    const t = s.interp.pendingTransfer;
    if (t.fadeFrames > 0) {
      const half = Math.max(1, Math.round(t.fadeFrames / 2));
      s.fade = { phase: "out", left: half, half };
    } else {
      applyTransfer(sess, s, t.map, t.x, t.y, t.dir);
    }
  }
  return { x: s.move.tx, y: s.move.ty };
}

function applyTransfer(
  sess: Session,
  s: SessionState,
  mapId: string,
  x: number,
  y: number,
  dir: Dir | "keep",
): void {
  acquireSessionMap(sess, mapId);
  const facing: Facing = dir === "keep" ? s.move.facing : DIR_INDEX[dir];
  enterMap(s, mapId, x, y, facing, sess.cfg);
  releaseSessionMapsExcept(sess, [mapId]);
}

/** A transfer destination authored as a live variable cannot be checked at
 * project-load time. Treat a missing id as a content error on the reducer
 * state; repository integrity/load failures for a known id still throw at
 * acquireSessionMap because they are deployment/configuration failures. */
function transferMapKnown(sess: Session, mapId: string): boolean {
  return sess.maps.has(mapId) || (sess.mapIndex?.has(mapId) ?? false);
}

// ---------------------------------------------------------------------------
// Player forced route (moveRoute target:"player")
//
// Reuses the mover's interpolation (stepPixels, stepFrames): a route step
// commits one 8-reference-tick tile step. Faces apply on the boundary tick;
// waits park for one step's worth of ticks; a blocked non-skippable move is
// retried on the next tick. A repeat:false route resumes its waiter on the
// landing tick of the last step.
// ---------------------------------------------------------------------------

/** The string-verb move steps the FACE/MOVE lookup tables cover; object
 *  path steps are handled separately. */
type VerbMoveStep = Extract<MoveStep, string>;
const FACE: Partial<Record<VerbMoveStep, Dir4>> = {
  faceDown: 0,
  faceLeft: 1,
  faceUp: 2,
  faceRight: 3,
};
const MOVE: Partial<Record<VerbMoveStep, Dir4>> = {
  moveDown: 0,
  moveLeft: 1,
  moveUp: 2,
  moveRight: 3,
};

function endPlayerRoute(s: SessionState): void {
  if (s.playerRoute!.waiter) s.interp = continueExternal(s.interp, s.playerRoute!.waiter);
  s.playerRoute = null;
  s.move.walking = false;
}

/** Snap a half-walked tile step back to its origin boundary. A route
 *  installed mid-step takes over on the boundary: the committed
 *  interpolation belonged to the mover's (or the old route's) direction,
 *  and carrying it onto the route's facing would enter a cell the new
 *  direction never checked. */
function cancelCommittedStep(m: MovementState, cfg: MovementConfig): void {
  if (!m.moving) return;
  m.phase = 0;
  m.moving = false;
  m.walking = false;
  m.px = m.tx * cfg.tile;
  m.py = m.ty * cfg.tile;
}

function stepPlayerRoute(
  s: SessionState,
  sess: Session,
  settings: ResolvedMoveSettings,
  eventSettings: Readonly<Record<string, ResolvedMoveSettings>> | undefined,
): void {
  const r = s.playerRoute!;
  const cfg = sess.cfg;
  const m = s.move;
  const desiredCfg = movementConfigFor(cfg, settings);
  const stepCfg = r.phase > 0
    ? activeStepConfig({ tx: m.tx, ty: m.ty, px: m.px, py: m.py, phase: r.phase }, desiredCfg)
    : desiredCfg;
  const frames = stepFrames(stepCfg);

  // First tick owning a route installed mid-step: cancel the inherited
  // interpolation and resume from its origin boundary.
  if (r.takeOver) {
    r.takeOver = false;
    cancelCommittedStep(m, cfg);
  }

  if (r.phase < 0) {
    r.phase++;
    return;
  }
  if (r.phase > 0) {
    r.phase++;
    if (r.phase < frames) {
      const { px, py } = stepPixels(m.tx * cfg.tile, m.ty * cfg.tile, r.dir, r.phase, stepCfg);
      m.px = px;
      m.py = py;
      m.moving = true;
      return;
    }
    m.tx += DX[r.dir];
    m.ty += DY[r.dir];
    m.px = m.tx * cfg.tile;
    m.py = m.ty * cfg.tile;
    if (canFace(settings, false)) m.facing = r.dir;
    m.stepDir = r.dir;
    m.moving = false;
    r.phase = 0;
    // The final internal step of a pathTo/approach plan lands here.
    // Apply the approach arrival-facing and advance the route pc once.
    if (r.plan?.done) {
      const ap = r.plan.approach;
      if (ap) {
        const tc = resolvePlayerTarget(ap.target, s);
        if (tc) {
          const f = facingToward(m.tx, m.ty, tc.x, tc.y);
          if (f !== null && canFace(settings, true)) { m.facing = f; m.stepDir = f; r.dir = f; }
        }
      }
      advance();
      return;
    }
    // fall through to the next command on this landing tick
  }

  const table = tableWithBodies(sessionPassageTable(sess, s), s.chars, eventSettings);
  // MV advances a move list at most once per stop tick: consume exactly
  // ONE route command on this reference tick (matching chars.stepRoute).
  // Instant-only routes (a repeat face route) therefore take one command
  // per reference tick and never spin the runaway guard.
  const step = r.steps[r.pc];
  if (step === undefined) {
    endPlayerRoute(s);
    return;
  }
  function advance(): boolean {
    r.plan = null;
    r.pathRetriesLeft = null;
    r.pc++;
    if (r.pc < r.steps.length) return false;
    if (r.repeat) r.pc = 0;
    else {
      endPlayerRoute(s);
      return true;
    }
    return false;
  }

  // --- turn / path steps ---------------------------------------------------
  if (typeof step === "object") {
    if ("control" in step) {
      applyMoveControl(ensureMoveControls(s).player, step.control);
      if (step.control.kind === "stop") endPlayerRoute(s);
      else advance();
      return;
    }
    if ("turnToward" in step) {
      const tc = resolvePlayerTarget(step.turnToward, s);
      if (tc) {
        const f = facingToward(m.tx, m.ty, tc.x, tc.y);
        if (f !== null && canFace(settings, true)) { r.dir = f; m.facing = f; m.stepDir = f; }
      }
      advance();
      return;
    }
    if ("pathTo" in step || "approach" in step) {
      stepPlayerPath(s, sess, table, settings, step, advance);
      return;
    }
    advance(); // unknown object step: skip defensively
    return;
  }
  if (step === "turnTowardPlayer") {
    // The player turning toward the player is a no-op turn; keep facing.
    advance();
    return;
  }

  const faceDir = FACE[step];
  if (faceDir !== undefined) {
    if (canFace(settings, true)) {
      r.dir = faceDir;
      m.facing = faceDir;
      m.stepDir = faceDir;
    }
    advance();
    return;
  }
  if (step === "turnRandom") {
    // The project RNG bank owns randomness, keeping the route
    // deterministic and saveable.
    const roll = randInt(s.sw.rng, 0, 3);
    s.sw.rng = roll.next;
    const dir = roll.value as Dir4;
    if (canFace(settings, true)) {
      r.dir = dir;
      m.facing = dir;
      m.stepDir = dir;
    }
    advance();
    return;
  }
  if (step === "wait") {
    r.phase = -frames;
    r.pc++;
    if (r.repeat && r.pc >= r.steps.length) r.pc = 0;
    // Non-repeat: pc rests at length; the reference tick after the wait
    // hits the undefined branch above and releases the waiter.
    return;
  }
  const dir = step === "stepForward" ? r.dir : MOVE[step];
  if (dir === undefined) {
    advance();
    return;
  }
  r.dir = dir;
  if (canFace(settings, false)) m.facing = dir;
  m.stepDir = dir;
  const tx = m.tx + DX[dir];
  const ty = m.ty + DY[dir];
  const blocked = settings.through
    ? !inMapBounds(table.width, table.height, tx, ty)
    : !canStepFrom(table, m.tx, m.ty, dir);
  if (blocked) {
    // Blocked: the source cell's exit or the target's reverse entry is
    // dirBlocked, or the target terrain is unenterable. Retry on the next
    // reference tick, unless the route is skippable (MV MoveRoute
    // "skip if cannot move").
    if (r.skippable) endPlayerRoute(s);
    return;
  }
  r.phase = 1;
  r.pc++;
  m.moving = true;
  const { px, py } = stepPixels(m.tx * cfg.tile, m.ty * cfg.tile, dir, 1, desiredCfg);
  m.px = px;
  m.py = py;
  if (r.repeat && r.pc >= r.steps.length) r.pc = 0;
}

/** Resolve a route target character to its live cell for a PLAYER route.
 *  The player is always at the mover's own cell; an event resolves through
 *  its live character cell, else its authored origin. */
function resolvePlayerTarget(
  target: "player" | { event: string },
  s: SessionState,
): { x: number; y: number } | null {
  if (target === "player") return { x: s.move.tx, y: s.move.ty };
  const ch = s.chars.chars[target.event];
  if (ch) return { x: ch.tx, y: ch.ty };
  return null;
}

/** Expand/walk one player pathTo or approach step for this reference tick.
 *  The stamped table already carries blocks:true bodies, so the BFS needs
 *  no extra occupancy set. The authored pc advances only when the whole
 *  plan is consumed; `advance` handles repeat/finish/waiter release. */
function stepPlayerPath(
  s: SessionState,
  sess: Session,
  table: PassageTable,
  settings: ResolvedMoveSettings,
  step: Extract<MoveStep, { pathTo: unknown }> | Extract<MoveStep, { approach: unknown }>,
  advance: () => boolean,
): void {
  const r = s.playerRoute!;
  const m = s.move;
  const cfg = sess.cfg;
  const moveCfg = movementConfigFor(cfg, settings);

  if (r.plan === null) {
    let gx: number;
    let gy: number;
    let approach: PathPlan["approach"] = null;
    if ("pathTo" in step) {
      gx = step.pathTo.x;
      gy = step.pathTo.y;
    } else {
      const target = step.approach.target;
      if (target === "player") { endPlayerRoute(s); return; }
      const tc = resolvePlayerTarget(target, s);
      if (!tc) { endPlayerRoute(s); return; }
      let side: Dir4;
      if (step.approach.side) {
        side = DIR4_PLAYER[step.approach.side]!;
      } else {
        const resolved = approachSide(m.tx, m.ty, tc.x, tc.y);
        if (resolved === null) { advance(); return; }
        side = resolved;
      }
      const distance = step.approach.distance ?? 1;
      const stand = approachStand(tc.x, tc.y, side, distance);
      gx = stand.x;
      gy = stand.y;
      approach = { target, side, distance };
    }

    if (gx === m.tx && gy === m.ty) {
      if (approach) {
        const tc = resolvePlayerTarget(approach.target, s);
        if (tc) {
          const f = facingToward(m.tx, m.ty, tc.x, tc.y);
          if (f !== null && canFace(settings, true)) { r.dir = f; m.facing = f; m.stepDir = f; }
        }
      }
      advance();
      return;
    }

    if (r.pathRetriesLeft === null) {
      r.pathRetriesLeft =
        ("pathTo" in step ? step.pathTo.retries : step.approach.retries) ?? DEFAULT_PATH_RETRIES;
    }
    // The stamped table already carries every blocks:true body (and the
    // cell it is stepping into). A blocks:false event is walked over by the
    // mover, so the search crosses it too, the way a character route does.
    // Begin a frame-split BFS (one slice per reference tick).
    const search = createPathSearch(table, m.tx, m.ty, gx, gy, undefined, settings.through);
    if (search === null) { endPlayerRoute(s); return; }
    r.plan = { search, dirs: [], blockedTicks: 0, done: false, approach };
  }

  const plan = r.plan;
  if (!plan) return;
  if (plan.search) {
    const res = advancePathSearch(plan.search, table, BFS_CELLS_PER_TICK);
    if (!res.done) return; // still computing; no movement this tick
    plan.search = null;
    if (res.path === null) {
      plan.dirs = [];
      plan.blockedTicks = 1;
    } else if (res.path.length === 0) {
      if (plan.approach) {
        const tc = resolvePlayerTarget(plan.approach.target, s);
        if (tc) {
          const f = facingToward(m.tx, m.ty, tc.x, tc.y);
          if (f !== null && canFace(settings, true)) { r.dir = f; m.facing = f; m.stepDir = f; }
        }
      }
      advance();
      return;
    } else {
      plan.dirs = res.path;
      plan.blockedTicks = 0;
    }
  }
  if (plan.done) return; // the landing branch advances
  const dir = plan.dirs[0];
  if (dir === undefined) {
    plan.blockedTicks++;
    if (plan.blockedTicks < PATH_REPLAN_TICKS) return;
    if (r.pathRetriesLeft! <= 0) { endPlayerRoute(s); return; }
    r.pathRetriesLeft = r.pathRetriesLeft! - 1;
    r.plan = null;
    return;
  }
  r.dir = dir;
  if (canFace(settings, false)) m.facing = dir;
  m.stepDir = dir;
  const tx = m.tx + DX[dir];
  const ty = m.ty + DY[dir];
  const blocked = settings.through
    ? !inMapBounds(table.width, table.height, tx, ty)
    : !canStepFrom(table, m.tx, m.ty, dir);
  if (blocked) {
    plan.blockedTicks++;
    if (plan.blockedTicks < PATH_REPLAN_TICKS) return;
    if (r.pathRetriesLeft! <= 0) { endPlayerRoute(s); return; }
    r.pathRetriesLeft = r.pathRetriesLeft! - 1;
    r.plan = null;
    return;
  }
  r.phase = 1;
  m.moving = true;
  const { px, py } = stepPixels(m.tx * cfg.tile, m.ty * cfg.tile, dir, 1, moveCfg);
  m.px = px;
  m.py = py;
  plan.dirs.shift();
  if (plan.dirs.length === 0) plan.done = true;
}

const DIR4_PLAYER: Record<Dir, Dir4> = { down: 0, left: 1, up: 2, right: 3 };
