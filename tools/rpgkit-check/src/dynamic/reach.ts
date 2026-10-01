// tools/rpgkit-check/src/dynamic/reach.ts — state-based map reachability for
// rpgkit-project/v1 documents. EXPERIMENTAL: its verdicts are leads for a
// human to follow, not proofs. The model is exact on the common shapes
// (guard-aware edges, story state carried through forced entry transfers,
// per-facing page selection) but approximates the corners listed in
// REACH_ASSUMPTIONS; a "reachable" verdict is reliable, an "unreachable"
// verdict can be wrong when a listed assumption is violated.
//
// A static transfer graph stamps every event body that EVER blocks and binds
// every transfer to the authored rectangle, so its "unreachable" verdict is
// not a proof about any real story state. This check instead starts a REAL
// session (createSession/startSession) and builds the world graph from that
// state:
//
//   - Blockers: the engine's own chars state. Every REACHABLE map gets a
//     faithful dry-run entry: fresh interp, local bank cleared, then the real
//     session steps the parallel/autorun create pages, so `local.npc.*`
//     spawns and `place` land exactly as the runtime would on entry. The
//     fixpoint is seeded from the START MAP ONLY — a map is dry-run (and gets
//     an entry bank) only once the graph reaches it, so story state from maps
//     the player can never enter does not propagate. The passage table is the
//     engine's own runtime table (sessionPassageTable: authored terrain plus
//     this visit's `tileProperty` overrides) stamped with `tableWithBodies`.
//   - Active pages: the engine's own `activePage` (switch / self / variable
//     / item / ext / appearance / tileProperty / worldIdle conditions),
//     never a reimplementation, and every call passes the engine's own
//     ConditionContext (checkConditionContext) so KV1 conditions evaluate
//     exactly as the runtime would. Transfer pages are re-selected for EACH
//     of the four facings, so a high-priority facing-conditioned page is not
//     shadowed by a lower unconditional one.
//   - Transfers: `firingTransfers` walks each active page's command tree and
//     collects a literal transfer only on a LIVE path: an `if` guard is
//     evaluated with the engine's `evalCondition` (true -> then, false ->
//     else, unknown -> both, may-reach); `choices`/`battle` descend every
//     branch. A transfer behind a provably-false guard creates no edge.
//     playerTouch edges bind to the event's live trigger rect, action edges
//     to the rect plus the confirmable adjacent tiles.
//   - Story state: the search freezes the story bank, but a parallel/autorun
//     transfer that fires on entry is a forced edge that CARRIES the bank the
//     dry-run produced (the switches the autorun set, plus items and gold) to
//     the target map. A fixpoint merges these arrival banks into each map's
//     entry bank, so an autorun on A that sets `gate` and transfers to B
//     makes B's `gate` page reachable. Arrivals that disagree on a
//     switch/variable/item make it unknown (both guard outcomes live); a
//     disagreed gold amount makes gold unknown.
//
// Assumptions (reported): story variables are frozen except for state
// propagated through forced entry transfers; action/playerTouch pages do not
// run during the walk (state they set before a transfer is not propagated);
// sight/trigger ranges follow the current active page; facing-conditioned
// pages are treated as available; moving NPCs are modelled at their entry
// positions; unknown guards are treated as possibly-true (may-reach);
// extension (ext) conditions and commands are not modelled (guards calling
// them are treated as possibly-true); transfers with a dynamic (variable)
// target map are not followed.

import {
  acquireSessionMap,
  sessionPassageTable,
  stepSession,
  tableWithBodies,
  type Session,
  type SessionInput,
  type SessionState,
} from "../../../../src/engine/session.ts";
import {
  activePage,
  createInterpState,
  createSwitchState,
  evalCondition,
  eventKey,
  type ConditionContext,
  type ExtensionScope,
  type SwitchState,
} from "../../../../src/engine/interpreter.ts";
import { createChars, type CharsState } from "../../../../src/engine/chars.ts";
import { cloneExtension } from "../../../../src/engine/extensions.ts";
import { initialMovement } from "../../../../src/engine/movement.ts";
import {
  canStepFrom,
  isStandable,
  type PassageTable,
} from "../../../../src/engine/passability.ts";
import type {
  Command,
  Condition,
  Dir,
  Facing,
  GameEvent,
  Project,
} from "../../../../src/engine/types.ts";
import { makeFinding, type Finding } from "../finding.ts";
import {
  CHECK_HZ,
  checkConditionContext,
  clearLocalBank,
  makeCheckSession,
  projectWithStart,
  startFresh,
} from "./sim.ts";

const ZERO_INPUT: SessionInput = {
  buttons: 0,
  confirmEdge: false,
  cancelEdge: false,
  upEdge: false,
  downEdge: false,
};
const DIRS = [0, 1, 2, 3] as const; // down, left, up, right
const DX = [0, -1, 0, 1] as const;
const DY = [1, 0, -1, 0] as const;
const DRY_RUN_TICKS = 10;
const FACINGS = [0, 1, 2, 3] as const;

/** The modelling limits every reach verdict is reported under. The first
 *  group is the model's standing assumptions; the second group lists the
 *  known imprecisions that can make an "unreachable" verdict wrong (they
 *  never fabricate reachability). */
const REACH_ASSUMPTIONS: readonly string[] = [
  "story variables are frozen except for state propagated through forced entry transfers",
  "action/playerTouch pages do not run during the walk (state they set before a transfer is not propagated)",
  "sight/trigger ranges follow the current active page",
  "facing-conditioned pages are treated as available",
  "moving NPCs are modelled at their entry positions",
  "unknown guards are treated as possibly-true (may-reach)",
  "extension (ext) conditions and commands are not modelled: guards that call an extension condition are treated as possibly-true (both branches live)",
  "transfers with a dynamic (variable) target map are not followed",
  "KNOWN IMPRECISION (non-zero item/gold baseline): an entry bank is seeded from the frozen snapshot, so an arrival carrying a different item count or gold amount is treated as a disagreement and the id becomes unknown; a page gated on the higher value can be falsely reported unreachable",
  "KNOWN IMPRECISION (fixed-step dry-run): entry pages are dry-run for a fixed 10-tick window; a forced transfer that fires after the window is still followed, but state its page sets before transferring (beyond the window) is lost, so a page on the target map gated on that state can be falsely reported unreachable",
  "KNOWN IMPRECISION (recursive common events): a self-/mutually-recursive common event is not re-expanded (the real interpreter runaways on it); commands after the recursive call can be falsely reported reachable",
  "KNOWN IMPRECISION (battle outcomes): a transfer inside a battle branch is collected as a may-reach edge, but battle outcomes are not modelled, so a fiber that always transfers through battle is not recognized as terminated",
  "KNOWN IMPRECISION (cross-map audio): entry-state merging propagates the switch bank but not persistent audio, so a target-map path gated on BGM started before a transfer can be missed",
];

// --- graph nodes -------------------------------------------------------------

interface GraphNode {
  map: string;
  x: number;
  y: number;
}

const nodeKey = (n: GraphNode): string => `${n.map}@${n.x},${n.y}`;

function parseNode(key: string): GraphNode {
  const at = key.indexOf("@");
  const comma = key.indexOf(",", at);
  return { map: key.slice(0, at), x: Number(key.slice(at + 1, comma)), y: Number(key.slice(comma + 1)) };
}

// --- guard-aware transfer collection -----------------------------------------

interface ForcedTransfer {
  map: string;
  x: number;
  y: number;
}

/** A guard whose outcome the entry bank cannot resolve is unknown: both
 *  branches are possible (may-reach). That covers a switch/variable id
 *  disagreed between arrivals, an item id whose count is disagreed, a gold
 *  amount that is disagreed, and any extension (`ext`) condition (extension
 *  logic is not modelled). */
function guardIsUnknown(c: Condition, bank: EntryBank): boolean {
  if (c.kind === "ext") return true;
  if ((c.kind === "switch" || c.kind === "variable") && bank.unknown.has(c.id)) return true;
  if (c.kind === "item" && bank.unknownItems.has(c.id)) return true;
  if (c.kind === "gold" && bank.goldUnknown) return true;
  return false;
}

/** Collect literal `transfer` commands reachable on a LIVE path through the
 *  command tree, evaluated against the entry story bank.
 *
 *  - `if`: the guard is evaluated with the engine's own `evalCondition`. A
 *    true guard descends only the then branch, a false guard only the else
 *    branch, and an unknown guard (a switch/variable/item id disagreed
 *    between arrivals, a disagreed gold amount, or an extension condition)
 *    descends BOTH (may-reach).
 *  - `choices`/`battle`: descend every branch (any option or outcome may be
 *    taken). `extChoice` has no static branches.
 *  - `common`: the common program runs on the caller's fiber, so it is
 *    inlined (a self-recursive common event is not re-expanded).
 *  - Every other command is a leaf here.
 *
 *  A transfer TERMINATES the fiber (the interpreter publishes it and
 *  returns), so commands after a transfer in the same sequence are dead
 *  code and produce no edges. The termination propagates up through nested
 *  calls: a `if` whose taken branch transfers, a `choices` whose every
 *  branch transfers, or a `common` whose program transfers all end the
 *  parent sequence too. An unknown-guard `if` terminates only when BOTH
 *  branches transfer (either may be taken); a `battle` never claims
 *  termination (outcomes are not modelled). Targets are deduped. A
 *  transfer behind a provably-false guard is never collected, so it
 *  creates no edge.
 *
 *  Returns whether the scanned sequence DEFINITELY terminates the fiber
 *  (a transfer on every live path through it), so a parent sequence stops
 *  scanning its dead tail. */
function firingTransfers(
  project: Project,
  cmds: readonly Command[],
  sw: SwitchState,
  bank: EntryBank,
  key: string,
  facing: Facing | undefined,
  ext: ExtensionScope,
  context: ConditionContext,
  out: ForcedTransfer[],
  expanding: ReadonlySet<string> = new Set(),
): boolean {
  for (const c of cmds) {
    if (
      c.op === "transfer" &&
      typeof c.map === "string" &&
      typeof c.x === "number" &&
      typeof c.y === "number"
    ) {
      const t = { map: c.map, x: c.x, y: c.y };
      if (!out.some((o) => o.map === t.map && o.x === t.x && o.y === t.y)) out.push(t);
      // The interpreter returns after publishing a transfer: the rest of
      // this sequence never runs.
      return true;
    }
    if (c.op === "if") {
      if (guardIsUnknown(c.if, bank)) {
        // Both branches are live: the fiber terminates only if BOTH do.
        const thenT = firingTransfers(project, c.then, sw, bank, key, facing, ext, context, out, expanding);
        const elseT = c.else
          ? firingTransfers(project, c.else, sw, bank, key, facing, ext, context, out, expanding)
          : false;
        if (thenT && elseT) return true;
      } else {
        const holds = evalCondition(c.if, sw, key, facing, ext, context);
        const branch = holds ? c.then : c.else;
        if (branch && firingTransfers(project, branch, sw, bank, key, facing, ext, context, out, expanding)) {
          return true;
        }
      }
      continue;
    }
    if (c.op === "choices") {
      // Any option may be taken: the fiber terminates only if EVERY branch
      // (options plus cancel, when present) transfers.
      const branches = c.options.map((option) => option.commands);
      if (c.cancel) branches.push(c.cancel.commands);
      if (branches.length > 0 && branches.every((b) => firingTransfers(project, b, sw, bank, key, facing, ext, context, out, expanding))) {
        return true;
      }
      continue;
    }
    if (c.op === "battle") {
      // Battle outcomes are not modelled (the check session completes
      // battles instantly without taking a branch): descend every branch
      // for edges, but never claim the fiber terminates.
      if (c.onWin) firingTransfers(project, c.onWin, sw, bank, key, facing, ext, context, out, expanding);
      if (c.onLose) firingTransfers(project, c.onLose, sw, bank, key, facing, ext, context, out, expanding);
      if (c.onEscape) firingTransfers(project, c.onEscape, sw, bank, key, facing, ext, context, out, expanding);
      continue;
    }
    if (c.op === "common" && !expanding.has(c.id)) {
      const common = project.commonEvents?.find((e) => e.id === c.id);
      if (common) {
        // The common program runs on the caller's fiber: if it definitely
        // transfers, the parent sequence terminates too. A recursive common
        // (already expanding) is not re-expanded; its effect is unknown, so
        // it never claims termination.
        if (firingTransfers(
          project,
          common.commands,
          sw,
          bank,
          key,
          facing,
          ext,
          context,
          out,
          new Set(expanding).add(c.id),
        )) {
          return true;
        }
      }
      continue;
    }
    // extChoice: no static branches. Other commands carry no nested command
    // lists, so there is nothing to descend.
  }
  return false;
}

// --- entry-bank fixpoint ------------------------------------------------------

/** A map's entry story bank: the switches/variables/items/gold the player is
 *  known to hold on entry, plus the ids whose value is disagreed between
 *  arrivals (unknown: both guard outcomes are live). A disagreed item count
 *  deletes the id into `unknownItems`; a disagreed gold amount sets
 *  `goldUnknown`. */
interface EntryBank {
  sw: SwitchState;
  unknown: Set<string>;
  unknownItems: Set<string>;
  goldUnknown: boolean;
}

/** A forced entry transfer and the story bank the target map receives. */
interface ForcedArrival {
  target: ForcedTransfer;
  sw: SwitchState;
}

/** The bank a target map receives on a forced transfer: the source's bank at
 *  the transfer moment, with per-visit `local.*` ids cleared (exactly what
 *  the engine's enterMap leaves behind). */
function arrivalBank(sw: SwitchState): SwitchState {
  const clone = createSwitchState(sw);
  clearLocalBank(clone);
  return clone;
}

/** Merge an arrival bank into a map's entry bank. For each switch/variable/
 *  item the arrival carries: a value the bank does not yet know is adopted; a
 *  value that AGREES is kept; a value that DISAGREES makes the id unknown
 *  (deleted from the bank, added to the unknown set) so guard analysis treats
 *  both branches as live. A gold amount that disagrees sets `goldUnknown`.
 *  Returns whether the entry bank changed. */
function mergeArrival(bank: EntryBank, arrival: SwitchState): boolean {
  let changed = false;
  for (const id of Object.keys(arrival.switches)) {
    const value = arrival.switches[id]!;
    if (bank.unknown.has(id)) continue;
    const cur = bank.sw.switches[id];
    if (cur === undefined) {
      bank.sw.switches[id] = value;
      changed = true;
    } else if (cur !== value) {
      delete bank.sw.switches[id];
      bank.unknown.add(id);
      changed = true;
    }
  }
  for (const id of Object.keys(arrival.variables)) {
    const value = arrival.variables[id]!;
    if (bank.unknown.has(id)) continue;
    const cur = bank.sw.variables[id];
    if (cur === undefined) {
      bank.sw.variables[id] = value;
      changed = true;
    } else if (cur !== value) {
      delete bank.sw.variables[id];
      bank.unknown.add(id);
      changed = true;
    }
  }
  for (const id of Object.keys(arrival.items)) {
    const value = arrival.items[id]!;
    if (bank.unknownItems.has(id)) continue;
    const cur = bank.sw.items[id];
    if (cur === undefined) {
      bank.sw.items[id] = value;
      changed = true;
    } else if (cur !== value) {
      delete bank.sw.items[id];
      bank.unknownItems.add(id);
      changed = true;
    }
  }
  if (!bank.goldUnknown && arrival.gold !== bank.sw.gold) {
    bank.goldUnknown = true;
    changed = true;
  }
  return changed;
}

// --- dry-run entry -----------------------------------------------------------

interface MapEntryState {
  mapId: string;
  /** Chars after the dry-run entry (create pages have run). */
  chars: CharsState;
  /** Story bank for this map's event pages: the dry-run bank on THIS map
   *  (pre-transfer if the dry-run was transferred away). */
  sw: SwitchState;
  /** State used for the runtime passage table: the last dry-run state still
   *  on THIS map, so its `interp.tileProperties` overrides belong here. */
  tableState: SessionState;
  /** Forced entry transfers (observed on entry, or parallel/autorun transfers
   *  whose guards hold in the entry bank) with their arrival banks. */
  forced: ForcedArrival[];
}

function firstStandable(session: Session, mapId: string): { x: number; y: number } | null {
  const table = session.tables.get(mapId)!;
  const map = session.maps.get(mapId)!;
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (isStandable(table, x, y)) return { x, y };
    }
  }
  return null;
}

/** Faithfully enter a map with the given entry story bank and step the
 *  parallel/autorun create pages, exactly as the runtime would on entry.
 *  The player stands still (zero input), so no playerTouch/action fiber
 *  starts; only entry-time parallel/autorun pages run.
 *
 *  When the dry-run OBSERVES a forced transfer (the map changed or a transfer
 *  is pending behind a fade), the arrival bank is the dry-run bank at that
 *  moment. Parallel/autorun transfers whose `if` guards HOLD in the entry
 *  bank but did not fire within the tick window are classified as firing
 *  (best-effort arrival: the post-dry-run bank). Transfers behind guards that
 *  FAIL create no edge and no arrival. */
function dryRunEntry(
  project: Project,
  session: Session,
  snapshot: SessionState,
  mapId: string,
  bank: EntryBank,
  ticks = DRY_RUN_TICKS,
): MapEntryState {
  acquireSessionMap(session, mapId);
  const swClone = createSwitchState(bank.sw);
  clearLocalBank(swClone);
  const interp = createInterpState(swClone);
  const spawn = firstStandable(session, mapId);
  let st: SessionState = {
    frame: 0,
    mapId,
    sw: interp.sw,
    move: initialMovement(spawn?.x ?? 0, spawn?.y ?? 0, snapshot.move.facing, session.cfg),
    chars: createChars(),
    interp,
    fade: null,
    playerRoute: null,
    ext: cloneExtension(session.extensions, snapshot.ext),
    scene: null,
  };
  // The last dry-run state still on THIS map. A map with no standable tile is
  // a void the player can never walk on; there is nothing to simulate, but the
  // state still anchors the passage table.
  let tableState = st;
  const forced: ForcedArrival[] = [];
  if (spawn) {
    for (let i = 0; i < ticks; i++) {
      const next = stepSession(session, st, ZERO_INPUT);
      if (next.mapId !== mapId) {
        // A parallel/autorun page transferred the player away on entry.
        forced.push({
          target: { map: next.mapId, x: next.move.tx, y: next.move.ty },
          sw: arrivalBank(next.sw),
        });
        break;
      }
      if (next.interp.pendingTransfer) {
        // A fade transfer is pending: the player has not left yet, so this
        // state still carries THIS map's tileProperty overrides.
        const t = next.interp.pendingTransfer;
        forced.push({
          target: { map: t.map, x: t.x, y: t.y },
          sw: arrivalBank(next.sw),
        });
        tableState = next;
        break;
      }
      st = next;
      tableState = next;
    }
    // No observed transfer: classify active parallel/autorun static transfers
    // by whether their `if` guards hold in the entry bank (engine's
    // evalCondition, with the engine's own ConditionContext). Each live target
    // is a forced entry edge; its arrival bank is the post-dry-run bank (the
    // switches the entry pages set, best effort).
    if (forced.length === 0) {
      const map = session.maps.get(mapId)!;
      const ext = { runtime: session.extensions, ext: st.ext };
      const context = checkConditionContext(st, map);
      for (const ev of map.events ?? []) {
        const active = activePage(ev, st.sw, mapId, snapshot.move.facing, ext, context);
        if (!active) continue;
        if (active.page.trigger !== "parallel" && active.page.trigger !== "autorun") continue;
        const targets: ForcedTransfer[] = [];
        firingTransfers(
          project,
          active.page.commands,
          st.sw,
          bank,
          eventKey(mapId, ev.id),
          snapshot.move.facing,
          ext,
          context,
          targets,
        );
        for (const t of targets) {
          forced.push({ target: t, sw: arrivalBank(st.sw) });
        }
      }
    }
  }
  return { mapId, chars: tableState.chars, sw: tableState.sw, tableState, forced };
}

// --- graph -------------------------------------------------------------------

interface ReachGraph {
  project: Project;
  session: Session;
  snapshot: SessionState;
  entryStates: ReadonlyMap<string, MapEntryState>;
  tables: ReadonlyMap<string, PassageTable>;
  /** playerTouch/action transfer edges: source key -> target keys. */
  transfers: ReadonlyMap<string, readonly string[]>;
  /** Forced entry edges (parallel/autorun transfers that fire on entry):
   *  every standable tile of the source map -> target. */
  forcedEdges: ReadonlyMap<string, readonly string[]>;
  totalStandable: number;
  buildMs: number;
}

/** The live trigger origin of an event: its char cell (the entry state
 *  spawns chars at placed positions), else the authored cell. Mirrors the
 *  engine's eventOrigin priority (live char > placement > authored); the
 *  dry-run chars already reflect placements. */
function eventOrigin(ev: GameEvent, chars: CharsState): { x: number; y: number } {
  const ch = chars.chars[ev.id];
  if (ch) return { x: ch.tx, y: ch.ty };
  return { x: ev.x, y: ev.y };
}

function addEdgeTo(m: Map<string, string[]>, from: string, to: string): void {
  const list = m.get(from) ?? [];
  if (!list.includes(to)) list.push(to);
  m.set(from, list);
}

/** Build the world graph from a session state. Only maps the graph reaches
 *  are modelled: the fixpoint is seeded from the START MAP ONLY, and a map
 *  gets an entry bank + dry-run only once it is reached — by a forced entry
 *  arrival, or by a BFS over the edges built so far. Story state from maps
 *  the player can never enter therefore never propagates.
 *
 *  Each reachable map's entry bank is seeded from the frozen snapshot bank and
 *  then refined to a fixpoint: a forced transfer carries the source's
 *  post-transfer bank to the target as an arrival, and arrivals merge into the
 *  target's entry bank (agreement keeps a value, disagreement makes it
 *  unknown). A map re-runs its dry-run when its entry bank changes, so story
 *  state an autorun sets on one map propagates to the maps it transfers to.
 *  The outer loop (dry-run fixpoint -> edges -> BFS -> newly reached maps) is
 *  bounded by the number of maps. */
function buildReachGraph(
  project: Project,
  session: Session,
  snapshot: SessionState,
  startKey: string,
): ReachGraph {
  const t0 = Date.now();
  const maps = project.maps;
  const mapDefs = new Map(maps.map((m) => [m.id, m]));
  const startMapId = snapshot.mapId;

  // Entry bank per reachable map, seeded from the frozen snapshot bank. A map
  // the graph never reaches keeps no bank and no entry state: it counts as
  // unreachable and its story state never propagates.
  const banks = new Map<string, EntryBank>();
  const entryStates = new Map<string, MapEntryState>();
  const seedBank = (): EntryBank => ({
    sw: createSwitchState(snapshot.sw),
    unknown: new Set(),
    unknownItems: new Set(),
    goldUnknown: false,
  });
  banks.set(startMapId, seedBank());

  let tables = new Map<string, PassageTable>();
  let transferMap = new Map<string, string[]>();
  let forcedEdges = new Map<string, string[]>();
  let totalStandable = 0;

  // Worklist of reachable maps whose entry state must be (re)built. Seeded
  // with the start map; forced arrivals and BFS discovery enqueue more.
  const dirty = new Set<string>([startMapId]);
  let guard = 0;
  while (dirty.size > 0 && guard <= maps.length) {
    guard++;

    // Fixpoint: dry-run each reachable map with its current entry bank;
    // forced transfers produce arrivals that merge into their targets' banks
    // (seeding a bank for a not-yet-reached target and enqueuing it). A map
    // re-runs when its bank changes. Per-map clone isolation keeps one map's
    // dry-run from mutating another's bank (dryRunEntry clones the bank it is
    // given). Bounded by the number of maps.
    let round = 0;
    while (dirty.size > 0 && round < maps.length) {
      round++;
      const todo = [...dirty];
      dirty.clear();
      for (const mapId of todo) {
        let bank = banks.get(mapId);
        if (!bank) {
          bank = seedBank();
          banks.set(mapId, bank);
        }
        const entry = dryRunEntry(project, session, snapshot, mapId, bank);
        entryStates.set(mapId, entry);
        for (const arr of entry.forced) {
          let tb = banks.get(arr.target.map);
          if (!tb) {
            tb = seedBank();
            banks.set(arr.target.map, tb);
            dirty.add(arr.target.map);
          }
          if (mergeArrival(tb, arr.sw)) dirty.add(arr.target.map);
        }
      }
    }

    // Passage tables: the engine's runtime table (authored terrain plus this
    // visit's tileProperty overrides) stamped with blocking-character bodies.
    tables = new Map<string, PassageTable>();
    totalStandable = 0;
    for (const [mapId, entry] of entryStates) {
      const m = mapDefs.get(mapId)!;
      const table = tableWithBodies(sessionPassageTable(session, entry.tableState), entry.chars);
      tables.set(mapId, table);
      for (let y = 0; y < m.height; y++) {
        for (let x = 0; x < m.width; x++) if (isStandable(table, x, y)) totalStandable++;
      }
    }

    // Transfer edges. The active page is re-selected for EACH of the four
    // facings with the engine's own activePage, so a high-priority
    // facing-conditioned page is not shadowed by a lower unconditional one:
    // every (facing, active page) pair whose trigger is playerTouch/action
    // contributes its live transfers, and targets dedupe across facings.
    transferMap = new Map<string, string[]>();
    for (const [mapId, entry] of entryStates) {
      const m = mapDefs.get(mapId)!;
      const bank = banks.get(mapId)!;
      const ext = { runtime: session.extensions, ext: entry.tableState.ext };
      const context = checkConditionContext(entry.tableState, m);
      for (const ev of m.events ?? []) {
        const byTrigger = new Map<string, ForcedTransfer[]>();
        for (const f of FACINGS) {
          const active = activePage(ev, entry.sw, mapId, f, ext, context);
          if (!active) continue;
          const trig = active.page.trigger;
          if (trig !== "playerTouch" && trig !== "action") continue;
          let list = byTrigger.get(trig);
          if (!list) {
            list = [];
            byTrigger.set(trig, list);
          }
          firingTransfers(
            project,
            active.page.commands,
            entry.sw,
            bank,
            eventKey(mapId, ev.id),
            f,
            ext,
            context,
            list,
          );
        }
        if (byTrigger.size === 0) continue;
        const origin = eventOrigin(ev, entry.chars);
        const w = ev.w ?? 1;
        const h = ev.h ?? 1;
        for (const [trig, targets] of byTrigger) {
          if (targets.length === 0) continue;
          if (trig === "playerTouch") {
            for (const t of targets) {
              for (let dy = 0; dy < h; dy++) {
                for (let dx = 0; dx < w; dx++) {
                  addEdgeTo(
                    transferMap,
                    nodeKey({ map: mapId, x: origin.x + dx, y: origin.y + dy }),
                    nodeKey(t),
                  );
                }
              }
            }
          } else {
            // Confirm from a tile in the rect, or one tile in front of the
            // player facing the rect: the rect tiles plus their 4 neighbours.
            const cells = new Set<string>();
            for (let dy = 0; dy < h; dy++) {
              for (let dx = 0; dx < w; dx++) {
                const cx = origin.x + dx;
                const cy = origin.y + dy;
                cells.add(nodeKey({ map: mapId, x: cx, y: cy }));
                for (const d of DIRS) cells.add(nodeKey({ map: mapId, x: cx + DX[d], y: cy + DY[d] }));
              }
            }
            for (const t of targets) for (const c of cells) addEdgeTo(transferMap, c, nodeKey(t));
          }
        }
      }
    }

    // Forced entry edges: a parallel/autorun transfer that fires on entry
    // (observed, or its `if` guards hold in the entry bank) redirects every
    // arrival tile of that map to its target.
    forcedEdges = new Map<string, string[]>();
    for (const [mapId, entry] of entryStates) {
      if (entry.forced.length === 0) continue;
      const m = mapDefs.get(mapId)!;
      const table = tables.get(mapId)!;
      for (let y = 0; y < m.height; y++) {
        for (let x = 0; x < m.width; x++) {
          if (isStandable(table, x, y)) {
            for (const arr of entry.forced) {
              addEdgeTo(forcedEdges, nodeKey({ map: mapId, x, y }), nodeKey(arr.target));
            }
          }
        }
      }
    }

    // BFS over the graph built so far, and seed+enqueue any map it newly
    // reaches: the next outer iteration dry-runs it, which may add edges and
    // arrivals of its own. Maps the BFS never reaches keep no entry state.
    const graph: ReachGraph = {
      project,
      session,
      snapshot,
      entryStates,
      tables,
      transfers: transferMap,
      forcedEdges,
      totalStandable,
      buildMs: 0,
    };
    const { reachable } = bfsState(graph, startKey);
    for (const key of reachable) {
      const at = key.indexOf("@");
      const mapId = key.slice(0, at);
      if (!entryStates.has(mapId) && mapDefs.has(mapId)) dirty.add(mapId);
    }
  }

  return {
    project,
    session,
    snapshot,
    entryStates,
    tables,
    transfers: transferMap,
    forcedEdges,
    totalStandable,
    buildMs: Date.now() - t0,
  };
}

// --- BFS ---------------------------------------------------------------------

interface BfsResult {
  reachable: ReadonlySet<string>;
  parent: ReadonlyMap<string, string | null>;
}

function* walkNeighbors(graph: ReachGraph, map: string, x: number, y: number): Generator<string> {
  const table = graph.tables.get(map);
  if (!table) return;
  for (const d of DIRS) {
    if (canStepFrom(table, x, y, d)) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (isStandable(table, nx, ny)) yield nodeKey({ map, x: nx, y: ny });
    }
  }
}

/** BFS over the multi-map graph: walking edges plus transfer and forced
 *  entry edges. Story-gated parallel transfers (guards fail in the entry
 *  bank) are never edges: they never fire. */
function bfsState(graph: ReachGraph, start: string): BfsResult {
  const reachable = new Set<string>([start]);
  const parent = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const { map, x, y } = parseNode(cur);
    for (const next of walkNeighbors(graph, map, x, y)) {
      if (!reachable.has(next)) {
        reachable.add(next);
        parent.set(next, cur);
        queue.push(next);
      }
    }
    for (const edges of [graph.transfers.get(cur), graph.forcedEdges.get(cur)]) {
      for (const next of edges ?? []) {
        if (!reachable.has(next)) {
          reachable.add(next);
          parent.set(next, cur);
          queue.push(next);
        }
      }
    }
  }
  return { reachable, parent };
}

function reconstructPath(parent: ReadonlyMap<string, string | null>, target: string): string[] {
  if (!parent.has(target)) return [];
  const out: string[] = [];
  let cur: string | null = target;
  while (cur !== null) {
    out.unshift(cur);
    cur = parent.get(cur) ?? null;
  }
  return out;
}

/** Return a copy of a session state with one story variable set (cloning
 *  the switch bank so the live state is never mutated). */
export function withVariable(state: SessionState, id: string, value: number): SessionState {
  const sw = createSwitchState(state.sw);
  (sw.variables as Record<string, number>)[id] = value;
  return { ...state, sw };
}

// --- check -------------------------------------------------------------------

export interface ReachOptions {
  /** Session frames per second (default 60). */
  hz?: number;
  /** Where the search starts, with the frozen story bank. Defaults to the
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
}

export interface ReachReport {
  check: "reach";
  /** Always true: reach is an experimental check. Its verdicts — especially
   *  "unreachable" — are leads for a human to follow, not proofs; see
   *  `assumptions` for the known imprecisions. */
  experimental: true;
  findings: Finding[];
  summary: Record<string, number>;
  start: string;
  reachableTilesByMap: Record<string, number>;
  reachableMaps: string[];
  unreachableMaps: string[];
  /** The modelling limits every verdict in this report is computed under. */
  assumptions: string[];
}

/** Build the state graph from a fresh session and report which maps the
 *  player can reach from the start. EXPERIMENTAL: a map with not one
 *  reachable tile is a warning (a lead, not a proof — events that set story
 *  state before transferring, extensions, recursive common events and
 *  dynamic pages may change the result; see `assumptions`). A start that is
 *  missing or unstandable is an error. */
export function checkReach(project: Project, options?: ReachOptions): ReachReport {
  const start = options?.start ?? {
    map: project.start.map,
    x: project.start.x,
    y: project.start.y,
    dir: project.start.dir,
  };
  // The session must actually start where the caller asked: rewrite the
  // project start so the dry-run snapshot and the BFS agree. An unknown start
  // map is left as the project start (startSession would otherwise throw);
  // the start-unreachable finding below reports it.
  const startMapDef = project.maps.find((m) => m.id === start.map);
  const proj = startMapDef
    ? projectWithStart(project, start.map, start.x, start.y, start.dir ?? project.start.dir)
    : project;
  const session = makeCheckSession(proj, options?.hz ?? CHECK_HZ);
  const sw0 = options?.start
    ? createSwitchState({
        switches: options.start.switches,
        variables: options.start.variables,
        items: options.start.items,
        gold: options.start.gold ?? project.initialGold ?? 0,
      })
    : undefined;
  const snapshot = startFresh(proj, session, sw0);
  const startKey = nodeKey({ map: start.map, x: start.x, y: start.y });
  const graph = buildReachGraph(proj, session, snapshot, startKey);

  const findings: Finding[] = [];

  const startTable = graph.tables.get(start.map);
  const startStandable =
    startMapDef !== undefined && startTable !== undefined && isStandable(startTable, start.x, start.y);
  if (!startStandable) {
    findings.push(makeFinding(
      "reach/start-unreachable",
      "error",
      startMapDef === undefined
        ? `start map ${JSON.stringify(start.map)} is not in the document`
        : `start tile (${start.x}, ${start.y}) is not standable on map ${JSON.stringify(start.map)}`,
      startMapDef === undefined
        ? "fix start.map"
        : "the start tile is not standable; move the start to a standable tile",
      { map: start.map },
    ));
  }

  const { reachable } = bfsState(graph, startKey);

  const reachableTilesByMap: Record<string, number> = {};
  for (const map of project.maps) reachableTilesByMap[map.id] = 0;
  for (const key of reachable) {
    const at = key.indexOf("@");
    const map = key.slice(0, at);
    if (Object.prototype.hasOwnProperty.call(reachableTilesByMap, map)) {
      reachableTilesByMap[map]!++;
    }
  }
  const reachableMaps = project.maps
    .filter((m) => (reachableTilesByMap[m.id] ?? 0) > 0)
    .map((m) => m.id);
  const unreachableMaps = project.maps
    .filter((m) => (reachableTilesByMap[m.id] ?? 0) === 0)
    .map((m) => m.id);

  const startCount = reachableTilesByMap[start.map] ?? 0;
  for (const mapId of unreachableMaps) {
    findings.push(makeFinding(
      "reach/map-unreachable",
      "warning",
      `under the frozen-story-state assumptions, no path to map ${JSON.stringify(mapId)} was found (start map ${JSON.stringify(start.map)} has ${startCount} reachable tile${startCount === 1 ? "" : "s"}); this is a lead, not a proof — see the report's assumptions for the known imprecisions`,
      "add a transfer path to it from a reachable map, or remove the map from the document; dynamic transfers, extension logic, recursive common events and action-page state effects may still reach it",
      { map: mapId },
    ));
  }

  return {
    check: "reach",
    experimental: true,
    findings,
    summary: {
      maps: project.maps.length,
      totalStandable: graph.totalStandable,
      reachableTiles: reachable.size,
      reachableMaps: reachableMaps.length,
      unreachableMaps: unreachableMaps.length,
      buildMs: graph.buildMs,
    },
    start: startKey,
    reachableTilesByMap,
    reachableMaps,
    unreachableMaps,
    assumptions: [...REACH_ASSUMPTIONS],
  };
}
