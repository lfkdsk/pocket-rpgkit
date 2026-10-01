// tools/rpgkit-check/src/dynamic/reach.ts — map reachability by real-engine
// search with replayable witnesses.
//
// "Reached" means a WITNESS exists: a button-mask tape from a fresh game
// that the tool itself replays in a brand-new session, verifying the replay
// really lands on the map with the recorded state. "notFound" means the
// search spent its budgets (frames / states / wall clock) without finding
// one — a lead with frontier statistics, never a proof of unreachability.
//
// The search is a breadth-first graph over real engine states:
//
//   - a node is a world-idle SessionState (deep-cloned, so branches restore
//     a snapshot instead of replaying a prefix);
//   - an edge is a MACRO (reach-driver.ts): walk to a triggerable event on
//     the engine's own passage table, fire it, and ride out dialogs, shops,
//     battles and transfers until the world is idle again. A choices box
//     branches — every option is its own edge;
//   - a wait macro stands still sampling active pages, so a page a parallel
//     activates on a timer is caught and targeted;
//   - states dedupe on the engine's canonical state fingerprint (the
//     save-snapshot payload with between-fold transients dropped and pure
//     progress — frame clock, audio positions, sub-tile movement — zeroed,
//     and every absolute time anchor rebased onto the zeroed clock, so
//     persistent audio intent, fibers, latches and every other
//     condition-relevant field are in the key automatically).
//
// Structural transfer checks (missing target, blocked landing, orphan maps,
// dynamic-target transfers) are deterministic proofs and live in
// reach-static.ts. The old frozen-variable / fixed-tick / command-tree
// interpreter is gone: there is no second model of the engine to disagree
// with it.

import type { BattleInput, BattleRules } from "../../../../src/engine/battle.ts";
import { activePage, createSwitchState, type ExtensionScope, type SwitchState } from "../../../../src/engine/interpreter.ts";
import { deepClone } from "../../../../src/engine/clone.ts";
import { isStandable } from "../../../../src/engine/passability.ts";
import {
  createSession,
  sessionPassageTable,
  stepSession,
  tableWithBodies,
  type Session,
  type SessionInput,
  type SessionState,
} from "../../../../src/engine/session.ts";
import type { Dir, Project } from "../../../../src/engine/types.ts";
import { makeFinding, type CheckReport, type Finding, type FindingLocation } from "../finding.ts";
import {
  CHECK_HZ,
  checkSessionOptions,
  NOOP_BATTLE_RULES,
  checkConditionContext,
  projectWithStart,
  startFresh,
} from "./sim.ts";
import {
  executeMacro,
  executeWait,
  planTargets,
  type MacroContext,
  type MacroLeaf,
  type TransientSnapshot,
} from "./reach-driver.ts";
import { staticTransferChecks } from "./reach-static.ts";
import {
  replayWitness,
  stateHash,
  stateKey,
  verifyWitness,
  type ReachWitness,
} from "./reach-witness.ts";

/** The search limitations every verdict is reported under. */
const REACH_ASSUMPTIONS: readonly string[] = [
  "a \"notFound\" verdict means the search spent its budgets without finding a replayable witness — a lead, not a proof; puzzles, shops, extension logic, dynamic-target transfers and battle outcomes under non-default rules may still reach the map",
  "shops are dismissed (cancel), not used to buy or sell: a map gated on a shop purchase is notFound",
  "transfers with a dynamic (variable) target map are not followed (they are listed as reach/dynamic-transfer info findings)",
  "extension (ext) commands and conditions run under allowUnknown no-op semantics; extension choice options are not branched",
  "battles under the default policy are declined (no encounter, no result branch); under registered rules the battle auto-input is zero-input and a battle that never completes dead-ends",
  "the state dedup key is the engine's canonical state fingerprint (the save-snapshot payload — map, player, the full interpreter state, ext — with between-fold transients dropped and pure progress zeroed: the absolute frame clock, audio playback positions, and the mover's sub-tile interpolation kept at tile+facing; every absolute time anchor is rebased onto the zeroed clock, so same elapsed time merges and different elapsed time splits); two states equal on the key are merged, which can only leave a map unfound, never fabricate a witness",
  "witnesses are 60 Hz tapes recorded in constant 6-tick blocks (pressed edges on block boundaries); each witness is replayed and verified at 60 Hz in a fresh session — the tool makes no claim about other host frame rates",
  "moving characters step under the real engine during a macro; a path blocked by a wandering body aborts that macro (the search may retry from another state)",
];

const ZERO_INPUT: SessionInput = {
  buttons: 0,
  confirmEdge: false,
  cancelEdge: false,
  upEdge: false,
  downEdge: false,
};

export interface ReachOptions {
  /** Where the search starts, with the initial story bank. Defaults to the
   *  project's own start. */
  start?: {
    map: string;
    x: number;
    y: number;
    dir?: Dir;
    switches?: Record<string, boolean>;
    variables?: Record<string, number>;
    items?: Record<string, number>;
    gold?: number;
  };
  /** Total engine tick budget for the whole search (default 120000). */
  maxFrames?: number;
  /** Max nodes expanded (default 3000). */
  maxStates?: number;
  /** Wall-clock budget in seconds (default 60). A safety valve only: when it
   *  fires the run is marked time-budget and results may vary under load;
   *  the frame/state budgets are deterministic. */
  maxSeconds?: number;
  /** Battle policy. Default: encounters are declined (the engine resumes the
   *  fiber with no result branch). Supply registered rules to fight battles
   *  for real, with an optional per-frame auto-input. */
  battle?: {
    rules: BattleRules;
    input?: (state: unknown) => BattleInput;
  };
}

export interface ReachInboundRef {
  source: string;
  loc: FindingLocation;
  /** What the search observed about the source page. */
  state: "triggered" | "observed-active" | "never-active" | "dynamic";
}

export interface ReachFrontier {
  /** Static transfers (and dynamic-target transfers) that name this map. */
  inbound: ReachInboundRef[];
}

export type ReachMapResult =
  | {
      map: string;
      status: "reached";
      /** Witness length in ticks. */
      frames: number;
      witness: ReachWitness;
      /** stateHash of the recorded arrival state. */
      stateHash: string;
    }
  | {
      map: string;
      status: "notFound";
      frontier: ReachFrontier;
    };

export interface ReachReport extends CheckReport {
  check: "reach";
  findings: Finding[];
  start: string;
  battlePolicy: "encounters-declined" | "registered-rules";
  endedReason: "exhausted" | "frame-budget" | "state-budget" | "time-budget";
  budgets: { maxFrames: number; maxStates: number; maxSeconds: number };
  maps: ReachMapResult[];
  /** Convenience: maps with a replayed witness, in document order. */
  reachableMaps: string[];
  /** Convenience: maps no witness was found for, in document order. */
  notFoundMaps: string[];
  assumptions: string[];
}

// --- priority queue -------------------------------------------------------------

interface SearchNode {
  state: SessionState;
  key: string;
  stateHash: string;
  parent: SearchNode | null;
  tapeSuffix: number[];
  /** Button mask this node's tape suffix ends with (inherited from the
   *  parent when the suffix is empty), so the next macro derives edges
   *  against the same mask a continuous replay carries across the join. */
  endMask: number;
  depth: number;
  isWait: boolean;
  seq: number;
}

/** BFS by depth; wait-macro children go last; among same-depth nodes, prefer
 *  a map that still has an observed-active page nobody triggered. Ties break
 *  by enqueue order, so the search is deterministic. */
class NodeQueue {
  private heap: SearchNode[] = [];

  constructor(private readonly mapScore: (mapId: string) => number) {}

  get size(): number {
    return this.heap.length;
  }

  push(node: SearchNode): void {
    this.heap.push(node);
    this.up(this.heap.length - 1);
  }

  pop(): SearchNode | undefined {
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.down(0);
    }
    return top;
  }

  private less(a: SearchNode, b: SearchNode): boolean {
    if (a.depth !== b.depth) return a.depth < b.depth;
    if (a.isWait !== b.isWait) return a.isWait ? false : true;
    const sa = this.mapScore(a.state.mapId);
    const sb = this.mapScore(b.state.mapId);
    if (sa !== sb) return sa < sb;
    return a.seq < b.seq;
  }

  private up(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(this.heap[i]!, this.heap[p]!)) break;
      [this.heap[i], this.heap[p]] = [this.heap[p]!, this.heap[i]!];
      i = p;
    }
  }

  private down(i: number): void {
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < this.heap.length && this.less(this.heap[l]!, this.heap[m]!)) m = l;
      if (r < this.heap.length && this.less(this.heap[r]!, this.heap[m]!)) m = r;
      if (m === i) break;
      [this.heap[i], this.heap[m]] = [this.heap[m]!, this.heap[i]!];
      i = m;
    }
  }
}

// --- search ---------------------------------------------------------------------

/** The button mask a tape suffix ends with — the mask the next macro's
 *  driver must derive its first edges against. An empty suffix inherits the
 *  parent's ending mask, so the join matches a continuous replay. */
function endingMask(suffix: readonly number[], inherited: number): number {
  return suffix.length > 0 ? suffix[suffix.length - 1]! >>> 0 : inherited;
}

const DEFAULT_MAX_FRAMES = 120_000;
const DEFAULT_MAX_STATES = 3_000;
const DEFAULT_MAX_SECONDS = 60;

export function checkReach(project: Project, options: ReachOptions = {}): ReachReport {
  const maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES;
  const maxStates = options.maxStates ?? DEFAULT_MAX_STATES;
  const maxSeconds = options.maxSeconds ?? DEFAULT_MAX_SECONDS;
  const battleRules = options.battle?.rules ?? NOOP_BATTLE_RULES;
  const battlePolicy: ReachReport["battlePolicy"] = options.battle ? "registered-rules" : "encounters-declined";

  const start = options.start ?? {
    map: project.start.map,
    x: project.start.x,
    y: project.start.y,
    dir: project.start.dir,
  };
  const startMapDef = project.maps.find((m) => m.id === start.map);
  const proj = startMapDef
    ? projectWithStart(project, start.map, start.x, start.y, start.dir ?? project.start.dir)
    : project;

  // Fiber-start trace: which (event,page) actually ran, for the frontier.
  const triggeredPages = new Set<string>();

  // The search records and verifies witnesses at the 60 Hz reference: the
  // engine folds MOTION_HZ/hz ticks per host frame, and the tool makes no
  // claim about other host frame rates.
  const session: Session = createSession(proj, CHECK_HZ, {
    ...checkSessionOptions(proj),
    battle: battleRules,
    onFiberStart: (key: string, pageIndex: number): void => {
      triggeredPages.add(`${key}#${pageIndex}`);
    },
  });
  const sw0: SwitchState | undefined = options.start
    ? createSwitchState({
        switches: options.start.switches,
        variables: options.start.variables,
        items: options.start.items,
        gold: options.start.gold ?? project.initialGold ?? 0,
      })
    : undefined;

  const findings: Finding[] = [];

  // Structural transfer proofs (always run, deterministic).
  findings.push(...staticTransferChecks(proj, session));

  if (!startMapDef) {
    findings.push(makeFinding(
      "reach/start-unreachable",
      "error",
      `start map ${JSON.stringify(start.map)} is not in the document`,
      "fix start.map",
      { map: start.map },
    ));
    return emptyReport(proj, findings, start, battlePolicy, maxFrames, maxStates, maxSeconds);
  }

  // --- BFS over real engine states ---------------------------------------

  const rootState = startFresh(proj, session, sw0);
  const root: SearchNode = {
    state: rootState,
    key: stateKey(rootState),
    stateHash: stateHash(rootState),
    parent: null,
    tapeSuffix: [],
    endMask: 0,
    depth: 0,
    isWait: false,
    seq: 0,
  };

  // The start tile must be standable (terrain plus the entry-time character
  // bodies, which spawn on the first tick). The engine itself does not
  // refuse a non-standable start, so the player would be stuck; flag it.
  // A one-tick probe lets the entry pages spawn their chars without running
  // the search from a mutated state.
  const probe = stepSession(session, deepClone(rootState), ZERO_INPUT);
  if (probe.mapId === start.map) {
    const startTable = tableWithBodies(sessionPassageTable(session, probe), probe.chars);
    if (!isStandable(startTable, start.x, start.y)) {
      findings.push(makeFinding(
        "reach/start-unreachable",
        "error",
        `start tile (${start.x}, ${start.y}) is not standable on map ${JSON.stringify(start.map)}`,
        "the start tile is not standable; move the start to a standable tile",
        { map: start.map },
      ));
    }
  }

  /** Pages observed active at a node (or transiently), per map. */
  const mapObservedPages = new Map<string, Set<string>>();
  const observedPages = new Set<string>();
  const observePage = (mapId: string, pageKey: string): void => {
    if (observedPages.has(pageKey)) return;
    observedPages.add(pageKey);
    let set = mapObservedPages.get(mapId);
    if (!set) {
      set = new Set();
      mapObservedPages.set(mapId, set);
    }
    set.add(pageKey);
  };
  const mapScore = (mapId: string): number => {
    const set = mapObservedPages.get(mapId);
    if (!set) return 1;
    for (const pageKey of set) if (!triggeredPages.has(pageKey)) return 0;
    return 1;
  };

  const queue = new NodeQueue(mapScore);
  queue.push(root);
  const seen = new Set<string>([root.key]);
  /** How each map was first reached: a node (idle state) or a mid-ride-out
   *  entry (the tape truncated at the entry pair). */
  type ReachRecord =
    | { kind: "node"; node: SearchNode }
    | { kind: "entry"; parent: SearchNode; suffix: number[]; hash: string };
  const reached = new Map<string, ReachRecord>([[rootState.mapId, { kind: "node", node: root }]]);
  let seq = 1;
  let statesExplored = 0;
  let framesRun = 0;
  let endedReason: ReachReport["endedReason"] = "exhausted";
  const t0 = Date.now();

  /** Sample the active page of every event on the node's map, so the
   *  frontier can distinguish "condition never held" from "never confirmed". */
  const sampleNodePages = (state: SessionState): void => {
    const map = session.maps.get(state.mapId);
    if (!map) return;
    const ctx = checkConditionContext(state, map);
    const ext: ExtensionScope = { runtime: session.extensions, ext: state.ext };
    for (const ev of map.events ?? []) {
      const active = activePage(ev, state.sw, state.mapId, state.move.facing, ext, ctx);
      if (active) observePage(state.mapId, `${state.mapId}/${ev.id}#${active.index}`);
    }
  };

  /** Record a map first reached by passing through it mid-ride-out. */
  const addMapEntry = (entry: { map: string; suffix: number[]; stateHash: string }, parent: SearchNode): void => {
    if (reached.has(entry.map)) return;
    reached.set(entry.map, { kind: "entry", parent, suffix: entry.suffix, hash: entry.stateHash });
  };

  const addLeaf = (leaf: MacroLeaf, parent: SearchNode, isWait: boolean): void => {
    if (leaf.error || leaf.battleTimeout || leaf.rideBudget || leaf.budget) return; // dead end
    for (const pageKey of leaf.pagesObserved) {
      observePage(leaf.state.mapId, pageKey);
    }
    for (const entry of leaf.mapEntries) addMapEntry(entry, parent);
    const key = stateKey(leaf.state);
    if (seen.has(key)) return;
    seen.add(key);
    const node: SearchNode = {
      state: leaf.state,
      key,
      stateHash: stateHash(leaf.state),
      parent,
      tapeSuffix: leaf.tapeSuffix,
      endMask: endingMask(leaf.tapeSuffix, parent.endMask),
      depth: parent.depth + Math.ceil(leaf.tapeSuffix.length / 2),
      isWait,
      seq: seq++,
    };
    if (!reached.has(leaf.state.mapId)) reached.set(leaf.state.mapId, { kind: "node", node });
    queue.push(node);
  };

  const addSnapshot = (snap: TransientSnapshot, parent: SearchNode): void => {
    observePage(snap.state.mapId, snap.pageKey);
    const key = stateKey(snap.state);
    if (seen.has(key)) return;
    seen.add(key);
    const node: SearchNode = {
      state: snap.state,
      key,
      stateHash: stateHash(snap.state),
      parent,
      tapeSuffix: snap.tapeSuffix,
      endMask: endingMask(snap.tapeSuffix, parent.endMask),
      depth: parent.depth + Math.ceil(snap.tapeSuffix.length / 2),
      isWait: false,
      seq: seq++,
    };
    if (!reached.has(snap.state.mapId)) reached.set(snap.state.mapId, { kind: "node", node });
    queue.push(node);
  };

  const makeCtx = (node: SearchNode): MacroContext => ({
    battleInput: options.battle?.input as MacroContext["battleInput"],
    knownPages: observedPages,
    onTransient: (snap) => addSnapshot(snap, node),
    // Live remaining frame budget (the search updates framesRun between
    // macros) and the wall-clock deadline, so a macro parks inside its own
    // ride-out/battle/wait loop instead of a full macro past the limit.
    framesLeft: () => maxFrames - framesRun,
    deadline: t0 + maxSeconds * 1000,
  });

  while (queue.size > 0) {
    if (framesRun >= maxFrames) {
      endedReason = "frame-budget";
      break;
    }
    if (statesExplored >= maxStates) {
      endedReason = "state-budget";
      break;
    }
    if (Date.now() - t0 > maxSeconds * 1000) {
      endedReason = "time-budget";
      break;
    }
    const node = queue.pop()!;
    statesExplored++;
    sampleNodePages(node.state);

    const ctx = makeCtx(node);

    // Target macros: one per triggerable active page. The macro reports the
    // REAL ticks it executed (branches restore snapshots and re-run, so the
    // spend is measured per executed block): a choices fan-out's shared
    // prefix is charged once, not once per leaf. Charging leaf tape lengths
    // instead would re-charge the shared walk/dialog/cursor prefix for every
    // branch and exhaust the frame budget before the real work is done.
    const targets = planTargets(proj, session, node.state);
    for (const target of targets) {
      observePage(node.state.mapId, `${target.eventKey}#${target.activePage}`);
      const { leaves, framesSpent } = executeMacro(session, node.state, target, ctx, node.endMask);
      framesRun += framesSpent;
      for (const leaf of leaves) addLeaf(leaf, node, false);
    }

    // Wait macro: ride out entry autoruns and catch pages a parallel
    // activates on a timer. Cheap (one pair) on maps without parallels.
    {
      const { leaves, framesSpent } = executeWait(session, node.state, ctx, node.endMask);
      framesRun += framesSpent;
      for (const leaf of leaves) addLeaf(leaf, node, true);
    }
  }

  // A budget park pushes a dead-end leaf (no node), so the queue can empty
  // on a budget hit without the loop-top check running again. Classify the
  // end by the budget that was actually spent.
  if (endedReason === "exhausted") {
    if (framesRun >= maxFrames) endedReason = "frame-budget";
    else if (statesExplored >= maxStates) endedReason = "state-budget";
    else if (Date.now() - t0 > maxSeconds * 1000) endedReason = "time-budget";
  }

  // --- witness verification ----------------------------------------------
  // Every "reached" map gets its tape replayed in a FRESH 60 Hz session;
  // only a replay that lands on the map with the recorded state counts.
  // The witness is verified at 60 Hz only — the tool makes no claim about
  // other host frame rates.

  const verifySession: Session = createSession(proj, CHECK_HZ, {
    ...checkSessionOptions(proj),
    battle: battleRules,
  });
  const materialize = (node: SearchNode): ReachWitness => {
    const masks: number[] = [];
    let cur: SearchNode | null = node;
    while (cur && cur.parent) {
      masks.unshift(...cur.tapeSuffix);
      cur = cur.parent;
    }
    return { hz: CHECK_HZ as 60, masks };
  };

  const maps: ReachMapResult[] = [];
  const reachableMaps: string[] = [];
  const notFoundMaps: string[] = [];
  for (const map of proj.maps) {
    const rec = reached.get(map.id);
    if (!rec) {
      notFoundMaps.push(map.id);
      maps.push({ map: map.id, status: "notFound", frontier: frontierFor(proj, map.id, observedPages, triggeredPages) });
      continue;
    }
    const witness = rec.kind === "node"
      ? materialize(rec.node)
      : { hz: CHECK_HZ as 60, masks: [...materialize(rec.parent).masks, ...rec.suffix] };
    const expectedHash = rec.kind === "node" ? rec.node.stateHash : rec.hash;
    const verdict = verifyWitness(verifySession, proj, witness, map.id, expectedHash, sw0);
    if (!verdict.ok) {
      // A witness that does not replay is a tool bug, never a verdict.
      findings.push(makeFinding(
        "reach/witness-replay-failed",
        "error",
        `the recorded witness for ${JSON.stringify(map.id)} failed replay: ${verdict.reason}`,
        "this is a check-tool bug; please report it with the project",
        { map: map.id },
      ));
      notFoundMaps.push(map.id);
      maps.push({ map: map.id, status: "notFound", frontier: frontierFor(proj, map.id, observedPages, triggeredPages) });
      continue;
    }
    reachableMaps.push(map.id);
    maps.push({ map: map.id, status: "reached", frames: witness.masks.length, witness, stateHash: expectedHash });
  }

  for (const mapId of notFoundMaps) {
    const f = maps.find((m) => m.map === mapId && m.status === "notFound");
    const inbound = f && f.status === "notFound" ? f.frontier.inbound.length : 0;
    findings.push(makeFinding(
      "reach/map-not-found",
      "warning",
      `no replayable witness to map ${JSON.stringify(mapId)} was found within budget (${statesExplored} states explored, ${framesRun} frames, ended: ${endedReason}) — a lead, not a proof`,
      inbound > 0
        ? `the map has ${inbound} static transfer route${inbound === 1 ? "" : "s"}; the report's frontier says whether its source pages ever ran`
        : "no literal transfer in the document names this map; check dynamic (variable-target) transfers, battle completions and extension logic",
      { map: mapId },
    ));
  }

  return {
    check: "reach",
    findings,
    summary: {
      maps: proj.maps.length,
      reached: reachableMaps.length,
      notFound: notFoundMaps.length,
      statesExplored,
      statesQueued: queue.size,
      framesRun,
      endedReason,
    },
    start: `${start.map}@${start.x},${start.y}`,
    battlePolicy,
    endedReason,
    budgets: { maxFrames, maxStates, maxSeconds },
    maps,
    reachableMaps,
    notFoundMaps,
    assumptions: [...REACH_ASSUMPTIONS],
  };
}

// --- frontier -------------------------------------------------------------------

/** The static routes into a map and what the search observed about each
 *  source page: triggered (a fiber ran), observed-active (the condition held
 *  in some explored state but nobody confirmed it), never-active, or dynamic
 *  (a variable-target transfer). */
function frontierFor(
  project: Project,
  mapId: string,
  observedPages: ReadonlySet<string>,
  triggeredPages: ReadonlySet<string>,
): ReachFrontier {
  const inbound: ReachInboundRef[] = [];
  for (const map of project.maps) {
    for (const ev of map.events ?? []) {
      ev.pages.forEach((page, pageIndex) => {
        const pageKey = `${map.id}/${ev.id}#${pageIndex}`;
        for (const cmd of page.commands) {
          collectInbound(project, cmd, mapId, { map: map.id, event: ev.id, page: pageIndex }, pageKey, observedPages, triggeredPages, inbound, new Set());
        }
      });
    }
  }
  for (const common of project.commonEvents ?? []) {
    for (const cmd of common.commands) {
      collectInbound(project, cmd, mapId, { common: common.id }, common.id, observedPages, triggeredPages, inbound, new Set());
    }
  }
  return { inbound };
}

function collectInbound(
  project: Project,
  cmd: import("../../../../src/engine/types.ts").Command,
  mapId: string,
  loc: FindingLocation,
  pageKey: string,
  observedPages: ReadonlySet<string>,
  triggeredPages: ReadonlySet<string>,
  inbound: ReachInboundRef[],
  expanding: ReadonlySet<string>,
): void {
  if (cmd.op === "transfer") {
    if (cmd.map === mapId) {
      inbound.push({
        source: loc.map ?? loc.common ?? "?",
        loc,
        state: triggeredPages.has(pageKey) ? "triggered" : observedPages.has(pageKey) ? "observed-active" : "never-active",
      });
    } else if (typeof cmd.map !== "string") {
      inbound.push({ source: loc.map ?? loc.common ?? "?", loc, state: "dynamic" });
    }
    return;
  }
  // Descend into branches and common calls. A recursive common event is not
  // re-expanded (the real interpreter runaways on it).
  switch (cmd.op) {
    case "if":
      for (const c of cmd.then) collectInbound(project, c, mapId, loc, pageKey, observedPages, triggeredPages, inbound, expanding);
      if (cmd.else) for (const c of cmd.else) collectInbound(project, c, mapId, loc, pageKey, observedPages, triggeredPages, inbound, expanding);
      break;
    case "choices":
      for (const opt of cmd.options) for (const c of opt.commands) collectInbound(project, c, mapId, loc, pageKey, observedPages, triggeredPages, inbound, expanding);
      if (cmd.cancel) for (const c of cmd.cancel.commands) collectInbound(project, c, mapId, loc, pageKey, observedPages, triggeredPages, inbound, expanding);
      break;
    case "battle":
      if (cmd.onWin) for (const c of cmd.onWin) collectInbound(project, c, mapId, loc, pageKey, observedPages, triggeredPages, inbound, expanding);
      if (cmd.onLose) for (const c of cmd.onLose) collectInbound(project, c, mapId, loc, pageKey, observedPages, triggeredPages, inbound, expanding);
      if (cmd.onEscape) for (const c of cmd.onEscape) collectInbound(project, c, mapId, loc, pageKey, observedPages, triggeredPages, inbound, expanding);
      break;
    case "common": {
      if (expanding.has(cmd.id)) break;
      const common = project.commonEvents?.find((e) => e.id === cmd.id);
      if (common) {
        const next = new Set(expanding);
        next.add(cmd.id);
        for (const c of common.commands) collectInbound(project, c, mapId, loc, pageKey, observedPages, triggeredPages, inbound, next);
      }
      break;
    }
    default:
      break;
  }
}

// --- report helpers ---------------------------------------------------------------

function emptyReport(
  project: Project,
  findings: Finding[],
  start: { map: string; x: number; y: number },
  battlePolicy: ReachReport["battlePolicy"],
  maxFrames: number,
  maxStates: number,
  maxSeconds: number,
): ReachReport {
  return {
    check: "reach",
    findings,
    summary: { maps: project.maps.length, reached: 0, notFound: project.maps.length, statesExplored: 0, statesQueued: 0, framesRun: 0, endedReason: "exhausted" },
    start: `${start.map}@${start.x},${start.y}`,
    battlePolicy,
    endedReason: "exhausted",
    budgets: { maxFrames, maxStates, maxSeconds },
    maps: project.maps.map((m) => ({ map: m.id, status: "notFound" as const, frontier: { inbound: [] } })),
    reachableMaps: [],
    notFoundMaps: project.maps.map((m) => m.id),
    assumptions: [...REACH_ASSUMPTIONS],
  };
}
