// tools/rpgkit-check/src/dynamic/locks.ts — permanent input-lock check.
//
// Every page containing a lockInput is instrumented so the lock branch runs
// in isolation on the REAL engine: ancestor guards/choices are selected to
// reach the lock, sibling lock-bearing branches are suppressed, and the
// page is forced through a one-shot autorun fiber. The run then proves the
// lock is released — by unlockInput or by a map transfer — inside a frame
// budget. A lock that is only released by a chain of other events cannot
// be proven locally and is reported unresolved, with the static
// local-resolution hint when the page structure shows one.

import type { Command, Condition, Dir, GameEvent, Page, Project } from "../../../../src/engine/types.ts";
import { canStepFrom, type Dir4 } from "../../../../src/engine/passability.ts";
import type { SessionOptions } from "../../../../src/engine/session.ts";
import { makeFinding, type Finding } from "../finding.ts";
import { collectProjectOp, containsProjectCommand, countProjectOp, walkProjectCommands } from "../walk.ts";
import {
  CHECK_HZ,
  createSwitchState,
  makeCheckSession,
  pageConditions,
  startFresh,
  stepAuto,
} from "./sim.ts";

export interface LockCheckOptions {
  /** Frame budget for one isolated lock run (default 12000). */
  frames?: number;
  /** Virtual frames per second the session runs at (default CHECK_HZ). */
  hz?: number;
  /** Game-owned registrations loaded by the CLI's --session module. */
  sessionOptions?: SessionOptions;
}

export interface LockRow {
  map: string;
  event: string;
  name: string;
  page: number;
  trigger: string;
  locks: number;
  outcome: "unlocked" | "transferred" | "unresolved" | "error";
  lockedAt: number;
  resolvedAt: number;
  error?: string;
}

export interface LockReport {
  check: "locks";
  findings: Finding[];
  summary: Record<string, number>;
  rows: LockRow[];
}

const DIRS = ["down", "left", "up", "right"] as const satisfies readonly Dir[];
const DX = [0, -1, 0, 1] as const;
const DY = [1, 0, -1, 0] as const;

const DEFAULT_FRAMES = 12_000;

/** A lock counts when it is reachable on the caller's fiber: a `common` op
 *  runs the common program inline, so a lockInput inside a called common
 *  event (nested calls included) is a lock the page can take. */
function containsLock(project: Project, commands: readonly Command[]): boolean {
  return countProjectOp(project, commands, "lockInput") > 0;
}

function lockCommands(project: Project, commands: readonly Command[]): Command[] {
  return collectProjectOp(project, commands, "lockInput");
}

/** Instrument one real lock branch. Ancestor guards/choices are selected so
 * the requested lock is reached, other lock-bearing sibling branches are
 * suppressed, and a one-tick wait makes an instant lock/unlock observable.
 * A `common` op whose program holds the target lock forces a COPY of that
 * program (recorded in `forcedCommons`; the run project swaps it in, so
 * the shared common event is never mutated); a `common` op whose program
 * holds a sibling lock is dropped (the sibling gets its own run). The
 * `expanding` chain stops a self-/mutually-recursive common event from
 * re-expanding at instrumentation time (which would overflow the JS
 * stack): the recursive `common` op is kept as-is, so the run project
 * still contains the cycle and the REAL engine hits its own
 * MAX_FIBER_STACK_DEPTH runaway guard — the check reports that runaway
 * (outcome "error") instead of crashing. */
function forceLockBranch(
  project: Project,
  commands: readonly Command[],
  target: Command,
  forcedCommons: Map<string, Command[]>,
  expanding: ReadonlySet<string> = new Set(),
): Command[] {
  const out: Command[] = [];
  for (const command of commands) {
    if (command === target) {
      out.push(command, { op: "wait", seconds: 1 / 60 });
    } else if (command.op === "lockInput") {
      // A different lock on this merged page gets its own dynamic run.
    } else if (command.op === "if") {
      if (containsProjectCommand(project, command.then, target)) {
        out.push(...forceLockBranch(project, command.then, target, forcedCommons, expanding));
      } else if (command.else && containsProjectCommand(project, command.else, target)) {
        out.push(...forceLockBranch(project, command.else, target, forcedCommons, expanding));
      } else if (!containsLock(project, command.then) && !containsLock(project, command.else ?? [])) {
        out.push(command);
      }
    } else if (command.op === "choices") {
      const selected = command.options.find((option) => containsProjectCommand(project, option.commands, target))?.commands ??
        (command.cancel && containsProjectCommand(project, command.cancel.commands, target)
          ? command.cancel.commands
          : undefined);
      if (selected) out.push(...forceLockBranch(project, selected, target, forcedCommons, expanding));
      else if (!command.options.some((option) => containsLock(project, option.commands)) &&
        !containsLock(project, command.cancel?.commands ?? [])) out.push(command);
    } else if (command.op === "battle") {
      // The check session's battle rules complete instantly without taking a
      // branch, so the branch holding the target lock is inlined (exactly as
      // an if/choices arm is selected). A lock-bearing sibling branch gets
      // its own run. Battles outside the target branch stay live because a
      // game-supplied QA adapter may publish result variables/switches that
      // let another event release the lock. Lock-bearing outcome branches
      // are stripped from that preserved battle so a sibling lock cannot
      // contaminate this target's run.
      if (command.onWin && containsProjectCommand(project, command.onWin, target)) {
        out.push(...forceLockBranch(project, command.onWin, target, forcedCommons, expanding));
      } else if (command.onLose && containsProjectCommand(project, command.onLose, target)) {
        out.push(...forceLockBranch(project, command.onLose, target, forcedCommons, expanding));
      } else if (command.onEscape && containsProjectCommand(project, command.onEscape, target)) {
        out.push(...forceLockBranch(project, command.onEscape, target, forcedCommons, expanding));
      } else {
        const { onWin: rawWin, onLose: rawLose, onEscape: rawEscape, ...battle } = command;
        const onWin = containsLock(project, rawWin ?? []) ? undefined : rawWin;
        const onLose = containsLock(project, rawLose ?? []) ? undefined : rawLose;
        const onEscape = containsLock(project, rawEscape ?? []) ? undefined : rawEscape;
        out.push({
          ...battle,
          ...(onWin ? { onWin } : {}),
          ...(onLose ? { onLose } : {}),
          ...(onEscape ? { onEscape } : {}),
        });
      }
    } else if (command.op === "loop") {
      // A loop body is a SEQUENCE, not a choice between arms: it is forced
      // exactly like the page root (the target's guards selected, sibling
      // locks dropped) and kept as a loop, so its break/repeat behavior —
      // and an unlock later in the body — stay live in the run. A lock held
      // across an endless (break-less) wait-less repeat is never observed
      // released and is reported, as the player never regains control.
      out.push({ ...command, commands: forceLockBranch(project, command.commands, target, forcedCommons, expanding) });
    } else if (command.op === "common") {
      const common = project.commonEvents?.find((c) => c.id === command.id);
      if (common && !expanding.has(command.id) && containsProjectCommand(project, common.commands, target)) {
        forcedCommons.set(
          common.id,
          forceLockBranch(project, common.commands, target, forcedCommons, new Set(expanding).add(command.id)),
        );
        out.push(command);
      } else if (common && !expanding.has(command.id) && containsLock(project, common.commands)) {
        // A sibling lock inside the common program gets its own run.
      } else {
        // A recursive common call (already on the expanding chain) is kept
        // verbatim: the run project retains the cycle and the engine's own
        // runaway guard fires, exactly as it would for the real project.
        out.push(command);
      }
    } else {
      out.push(command);
    }
  }
  return out;
}

function satisfy(
  conditions: readonly Condition[],
  eventKey: string,
): {
  sw: ReturnType<typeof createSwitchState>;
  localVariables: Record<string, number>;
  localSwitches: Record<string, boolean>;
  facing: Dir;
} {
  const sw = createSwitchState({ variables: { "sys.party_size": 1 }, gold: 999_999 });
  const localVariables: Record<string, number> = {};
  const localSwitches: Record<string, boolean> = {};
  let facing: Dir = "down";
  for (const condition of conditions) {
    if (condition.kind === "variable") {
      const value = condition.op === "!=" ? (condition.value === 0 ? 1 : 0) : condition.value;
      if (condition.id.startsWith("local.")) localVariables[condition.id] = value;
      else sw.variables[condition.id] = value;
    } else if (condition.kind === "switch") {
      const value = condition.value ?? true;
      if (condition.id.startsWith("local.")) localSwitches[condition.id] = value;
      else sw.switches[condition.id] = value;
    } else if (condition.kind === "selfSwitch") {
      sw.self[eventKey] = (condition.value ?? true) ? condition.key : undefined;
    } else if (condition.kind === "item") {
      sw.items[condition.id] = condition.count;
    } else if (condition.kind === "gold") {
      sw.gold = condition.amount;
    } else if (condition.kind === "facing") {
      facing = condition.dir;
    }
  }
  return { sw, localVariables, localSwitches, facing };
}

/** A passable cell adjacent to the event, so an action-trigger page starts
 * where the player could actually have triggered it. */
function startCell(
  project: Project,
  mapId: string,
  event: GameEvent,
  dir: Dir,
  hz: number,
  sessionOptions?: SessionOptions,
): { x: number; y: number } {
  const session = makeCheckSession(project, hz, sessionOptions);
  const table = session.tables.get(mapId)!;
  const d = DIRS.indexOf(dir) as Dir4;
  const cells: [number, number][] = [];
  for (let y = event.y; y < event.y + (event.h ?? 1); y++) {
    for (let x = event.x; x < event.x + (event.w ?? 1); x++) cells.push([x, y]);
  }
  for (const [x, y] of cells) {
    const sx = x - DX[d]!;
    const sy = y - DY[d]!;
    if (sx >= 0 && sy >= 0 && sx < table.width && sy < table.height && canStepFrom(table, sx, sy, d)) {
      return { x: sx, y: sy };
    }
  }
  return { x: Math.max(0, event.x - DX[d]!), y: Math.max(0, event.y - DY[d]!) };
}

interface LockAttempt {
  lock: number;
  outcome: LockRow["outcome"];
  lockedAt: number;
  resolvedAt: number;
  error?: string;
}

/** Run one instrumented lock branch on the real engine and watch for the
 * release: unlockInput, a map transfer, an interpreter error, or the budget
 * expiring with the lock still held. */
function checkPage(
  project: Project,
  mapId: string,
  event: GameEvent,
  page: Page,
  target: Command,
  lockIndex: number,
  frames: number,
  hz: number,
  sessionOptions?: SessionOptions,
  seed?: ResolutionSeed,
): LockAttempt {
  const eventKey = `${mapId}/${event.id}`;
  const initial = satisfy(pageConditions(page.condition), eventKey);
  if (seed) {
    const extra = satisfy(seed.conditions, seed.eventKey);
    Object.assign(initial.sw.variables, extra.sw.variables);
    Object.assign(initial.sw.switches, extra.sw.switches);
    Object.assign(initial.sw.self, extra.sw.self);
    Object.assign(initial.sw.items, extra.sw.items);
    Object.assign(initial.localVariables, extra.localVariables);
    Object.assign(initial.localSwitches, extra.localSwitches);
  }
  const start = startCell(project, mapId, event, initial.facing, hz, sessionOptions);
  const forcedCommons = new Map<string, Command[]>();
  const forced: GameEvent = {
    ...event,
    pages: [{
      ...page,
      trigger: "autorun",
      condition: undefined,
      commands: [...forceLockBranch(project, page.commands, target, forcedCommons), { op: "erase" }],
    }],
  };
  const runProject: Project = {
    ...project,
    start: { map: mapId, x: start.x, y: start.y, dir: initial.facing },
    maps: project.maps.map((map) => map.id === mapId
      ? { ...map, events: (map.events ?? []).map((candidate) => candidate.id === event.id ? forced : candidate) }
      : map),
    // Common events holding the target lock run a forced COPY (the branch
    // selected), so the shared common event is never mutated.
    commonEvents: project.commonEvents?.map((common) =>
      forcedCommons.has(common.id) ? { ...common, commands: forcedCommons.get(common.id)! } : common),
  };
  const session = makeCheckSession(runProject, hz, sessionOptions);
  let state = startFresh(runProject, session, initial.sw);
  Object.assign(state.sw.variables, initial.localVariables);
  Object.assign(state.sw.switches, initial.localSwitches);
  let lockedAt = -1;
  let resolvedAt = -1;
  let outcome: LockAttempt["outcome"] = "unresolved";
  let error: string | undefined;
  for (let frame = 0; frame < frames; frame++) {
    state = stepAuto(session, state, frame);
    if (state.interp.error) {
      outcome = "error";
      resolvedAt = frame;
      error = state.interp.error.message;
      break;
    }
    if (lockedAt < 0 && state.interp.inputLocked) lockedAt = frame;
    if (state.mapId !== mapId && lockedAt >= 0) {
      outcome = "transferred";
      resolvedAt = frame;
      break;
    } else if (state.mapId !== mapId) {
      error = "the run transferred before the instrumented lock was reached";
      break;
    }
    if (lockedAt >= 0 && !state.interp.inputLocked) {
      outcome = "unlocked";
      resolvedAt = frame;
      break;
    }
  }
  if (outcome === "unresolved" && lockedAt < 0 && !error) error = "instrumented lock was not reached";
  return {
    lock: lockIndex,
    outcome,
    lockedAt,
    resolvedAt,
    ...(error ? { error } : {}),
  };
}

interface LockFlowState {
  unresolved: ReadonlySet<number>;
  terminated: boolean;
  /** A `break` ran: the rest of the innermost loop body is skipped. The
   *  enclosing `loop` turns it back into a live state after the loop; a
   *  common event or the page root ends there instead. */
  broken?: boolean;
}

/** Prove each individual lock on at least one executable control-flow path
 * of the page. Branches are kept separate, so an unlock in an `else` arm
 * cannot resolve a lock that only exists in the sibling `then` arm. */
function localResolution(project: Project, commands: readonly Command[]): "local-unlock" | "local-transfer" | undefined {
  const lockIds = new Map<Command, number>();
  walkProjectCommands(project, commands, (command) => {
    if (command.op === "lockInput") lockIds.set(command, lockIds.size);
  });
  if (!lockIds.size) return undefined;

  const unlocked = new Set<number>();
  const transferred = new Set<number>();
  const dedupe = (states: readonly LockFlowState[]): LockFlowState[] => {
    const unique = new Map<string, LockFlowState>();
    for (const state of states) {
      const key = `${state.terminated}:${state.broken === true}:${[...state.unresolved].sort((a, b) => a - b).join(",")}`;
      unique.set(key, state);
    }
    return [...unique.values()];
  };
  // A `common` op runs the common program on the same fiber, so its
  // locks/unlocks/transfers are part of THIS page's flow; the expanding
  // chain keeps a self-recursive common event from looping forever.
  const run = (
    sequence: readonly Command[],
    inputs: readonly LockFlowState[],
    expanding: ReadonlySet<string> = new Set(),
  ): LockFlowState[] => {
    let states = [...inputs];
    for (const command of sequence) {
      const outputs: LockFlowState[] = [];
      for (const state of states) {
        if (state.terminated || state.broken) {
          outputs.push(state);
          continue;
        }
        if (command.op === "lockInput") {
          outputs.push({ unresolved: new Set([...state.unresolved, lockIds.get(command)!]), terminated: false });
        } else if (command.op === "unlockInput" || command.op === "transfer") {
          const sink = command.op === "unlockInput" ? unlocked : transferred;
          for (const id of state.unresolved) sink.add(id);
          outputs.push({ unresolved: new Set(), terminated: command.op === "transfer" });
        } else if (command.op === "if") {
          outputs.push(...run(command.then, [state], expanding));
          outputs.push(...run(command.else ?? [], [state], expanding));
        } else if (command.op === "choices") {
          for (const option of command.options) outputs.push(...run(option.commands, [state], expanding));
          if (command.cancel) outputs.push(...run(command.cancel.commands, [state], expanding));
          if (!command.options.length && !command.cancel) outputs.push(state);
        } else if (command.op === "battle") {
          // The three battle outcomes are alternative paths: a lock taken in
          // onWin is only resolved by a release in onWin, never by one in
          // onLose/onEscape (branch separation, same as if then/else).
          if (command.onWin) outputs.push(...run(command.onWin, [state], expanding));
          if (command.onLose) outputs.push(...run(command.onLose, [state], expanding));
          if (command.onEscape) outputs.push(...run(command.onEscape, [state], expanding));
          if (!command.onWin && !command.onLose && !command.onEscape) outputs.push(state);
        } else if (command.op === "break") {
          outputs.push({ ...state, broken: true });
        } else if (command.op === "loop") {
          // The body runs one or more times; only a break (or a transfer)
          // leaves it. Iterate the body to a fixpoint over the finite set
          // of flow states: each pass's fall-through states feed the next
          // pass, broken states exit the loop as live states. A loop with
          // no reachable break yields no live state, so nothing after it
          // runs — a lock taken before an endless loop is never resolved
          // by a later unlock.
          const seen = new Set<string>();
          const keyOf = (s: LockFlowState) => [...s.unresolved].sort((a, b) => a - b).join(",");
          let pending: LockFlowState[] = [state];
          for (const p of pending) seen.add(keyOf(p));
          while (pending.length > 0) {
            const next: LockFlowState[] = [];
            for (const out of run(command.commands, pending, expanding)) {
              if (out.broken) outputs.push({ unresolved: out.unresolved, terminated: false });
              else if (out.terminated) outputs.push(out);
              else if (!seen.has(keyOf(out))) {
                seen.add(keyOf(out));
                next.push(out);
              }
            }
            pending = next;
          }
        } else if (command.op === "common") {
          const common = project.commonEvents?.find((c) => c.id === command.id);
          if (common && !expanding.has(command.id)) {
            // A break does not cross the call: inside the common event (and
            // outside any loop there) it ends the common event only.
            for (const out of run(common.commands, [state], new Set(expanding).add(command.id))) {
              outputs.push(out.broken ? { unresolved: out.unresolved, terminated: false } : out);
            }
          } else {
            outputs.push(state);
          }
        } else {
          outputs.push(state);
        }
      }
      states = dedupe(outputs);
    }
    return states;
  };
  run(commands, [{ unresolved: new Set(), terminated: false }]);
  const resolved = new Set([...unlocked, ...transferred]);
  if (resolved.size !== lockIds.size) return undefined;
  return transferred.size ? "local-transfer" : "local-unlock";
}

type Fact =
  | { kind: "variable"; id: string; value: number }
  | { kind: "switch"; id: string; value: boolean };

function factsWritten(project: Project, commands: readonly Command[]): Fact[] {
  const facts: Fact[] = [];
  walkProjectCommands(project, commands, (command) => {
    if (command.op === "variable" && command.set.op === "set") {
      facts.push({ kind: "variable", id: command.id, value: command.set.value });
    } else if (command.op === "switch") {
      facts.push({ kind: "switch", id: command.id, value: command.value });
    }
  });
  return facts;
}

function factSatisfies(fact: Fact, condition: Condition): boolean {
  if (fact.kind === "switch" && condition.kind === "switch") {
    return fact.id === condition.id && fact.value === (condition.value ?? true);
  }
  if (fact.kind !== "variable" || condition.kind !== "variable" || fact.id !== condition.id) return false;
  if (condition.op === "==") return fact.value === condition.value;
  if (condition.op === "!=") return fact.value !== condition.value;
  if (condition.op === ">=") return fact.value >= condition.value;
  return fact.value <= condition.value;
}

function negate(condition: Condition): Condition | undefined {
  if (condition.kind === "switch" || condition.kind === "selfSwitch") {
    return { ...condition, value: !(condition.value ?? true) };
  }
  if (condition.kind === "variable") {
    if (condition.op === "==") return { ...condition, op: "!=" };
    if (condition.op === "!=") return { ...condition, op: "==" };
    if (condition.op === ">=") return { ...condition, op: "<=", value: condition.value - 1 };
    return { ...condition, op: ">=", value: condition.value + 1 };
  }
  if (condition.kind === "facing") {
    return { kind: "facing", dir: DIRS.find((dir) => dir !== condition.dir)! };
  }
  return undefined;
}

/** Guard sets for branches that can release a lock held by another event.
 *  These are candidates only: a later real-engine run must still observe
 *  the target lock before accepting an unlock or transfer. */
function resolutionConditions(
  project: Project,
  commands: readonly Command[],
  expanding: ReadonlySet<string> = new Set(),
): Condition[][] {
  const paths: Condition[][] = [];
  for (const command of commands) {
    if (command.op === "unlockInput" || command.op === "transfer") {
      paths.push([]);
    } else if (command.op === "if") {
      for (const path of resolutionConditions(project, command.then, expanding)) {
        paths.push([command.if, ...path]);
      }
      const inverse = negate(command.if);
      if (inverse) {
        for (const path of resolutionConditions(project, command.else ?? [], expanding)) {
          paths.push([inverse, ...path]);
        }
      }
    } else if (command.op === "choices") {
      for (const option of command.options) {
        paths.push(...resolutionConditions(project, option.commands, expanding));
      }
      paths.push(...resolutionConditions(project, command.cancel?.commands ?? [], expanding));
    } else if (command.op === "battle") {
      paths.push(...resolutionConditions(project, command.onWin ?? [], expanding));
      paths.push(...resolutionConditions(project, command.onLose ?? [], expanding));
      paths.push(...resolutionConditions(project, command.onEscape ?? [], expanding));
    } else if (command.op === "scene") {
      paths.push(...resolutionConditions(project, command.onDone ?? [], expanding));
      paths.push(...resolutionConditions(project, command.onCancel ?? [], expanding));
    } else if (command.op === "common" && !expanding.has(command.id)) {
      const common = project.commonEvents?.find((candidate) => candidate.id === command.id);
      if (common) {
        paths.push(...resolutionConditions(project, common.commands, new Set(expanding).add(command.id)));
      }
    }
  }
  return paths;
}

function seedable(condition: Condition): boolean {
  if (condition.kind === "variable" || condition.kind === "switch") {
    return !condition.id.startsWith("local.");
  }
  return condition.kind === "selfSwitch" || condition.kind === "item" ||
    condition.kind === "gold" || condition.kind === "facing";
}

interface ResolutionSeed {
  label: string;
  eventKey: string;
  conditions: Condition[];
}

/** Find automatic sibling pages whose release path has a causal guard
 *  written by the lock page. The causal guard is deliberately NOT seeded;
 *  only the other historical prerequisites are. Thus the real source flow
 *  must publish the linking fact after taking the lock before the sibling
 *  can release it. Per-visit `local.*` facts are not historical state: map
 *  entry clears them, so a release path that requires one is not seedable. */
function crossEventSeeds(
  project: Project,
  map: Project["maps"][number],
  source: GameEvent,
  page: Page,
): ResolutionSeed[] {
  const sourceFacts = factsWritten(project, page.commands);
  const sourceGuards = pageConditions(page.condition);
  const seeds: ResolutionSeed[] = [];
  const seen = new Set<string>();
  for (const event of map.events ?? []) {
    if (event.id === source.id) continue;
    event.pages.forEach((candidate, pageIndex) => {
      if (candidate.trigger !== "parallel" && candidate.trigger !== "autorun") return;
      for (const branchGuards of resolutionConditions(project, candidate.commands)) {
        const required = [...pageConditions(candidate.condition), ...branchGuards];
        const causalIndex = required.findIndex((condition) => sourceFacts.some((fact) =>
          factSatisfies(fact, condition) && !sourceGuards.some((guard) => factSatisfies(fact, guard))
        ));
        if (causalIndex < 0) continue;
        const conditions = required.filter((_, index) => index !== causalIndex);
        if (!conditions.every(seedable)) continue;
        const key = JSON.stringify([event.id, pageIndex, conditions]);
        if (seen.has(key)) continue;
        seen.add(key);
        seeds.push({
          label: `${event.id}#${pageIndex}`,
          eventKey: `${map.id}/${event.id}`,
          conditions,
        });
      }
    });
  }
  return seeds;
}

/** Check every lockInput page in the project. Returns one row per checked
 * page and one error-severity finding per page whose lock was not proven
 * released. */
export function checkLocks(project: Project, options: LockCheckOptions = {}): LockReport {
  const frames = options.frames ?? DEFAULT_FRAMES;
  const hz = options.hz ?? CHECK_HZ;
  const rows: LockRow[] = [];
  const findings: Finding[] = [];
  let lockCommandCount = 0;
  let dynamicChecks = 0;

  for (const map of project.maps) {
    for (const event of map.events ?? []) {
      event.pages.forEach((page, pageIndex) => {
        if (!containsLock(project, page.commands)) return;
        const local = localResolution(project, page.commands);
        const locks = lockCommands(project, page.commands);
        lockCommandCount += locks.length;
        const checks = locks.map((target, lockIndex) => {
          dynamicChecks++;
          let result = checkPage(
            project,
            map.id,
            event,
            page,
            target,
            lockIndex,
            frames,
            hz,
            options.sessionOptions,
          );
          if (result.outcome !== "unresolved" || local) return result;
          // Only an unresolved local run earns bounded cross-event retries.
          // Static analysis proposes prerequisite seeds; the real engine must
          // still observe this exact lock before a sibling releases it.
          for (const seed of crossEventSeeds(project, map, event, page).slice(0, 16)) {
            dynamicChecks++;
            const retried = checkPage(
              project,
              map.id,
              event,
              page,
              target,
              lockIndex,
              frames,
              hz,
              options.sessionOptions,
              seed,
            );
            if (retried.outcome === "unlocked" || retried.outcome === "transferred") return retried;
            result = retried;
          }
          return result;
        });
        const outcome: LockRow["outcome"] = checks.some((check) => check.outcome === "error")
          ? "error"
          : checks.some((check) => check.outcome === "unresolved")
            ? "unresolved"
            : checks.every((check) => check.outcome === "transferred")
              ? "transferred"
              : "unlocked";
        const lockedFrames = checks.map((check) => check.lockedAt).filter((frame) => frame >= 0);
        const resolvedFrames = checks.map((check) => check.resolvedAt).filter((frame) => frame >= 0);
        const failed = checks.filter((check) => check.outcome === "unresolved" || check.outcome === "error");
        const row: LockRow = {
          map: map.id,
          event: event.id,
          name: event.name ?? "",
          page: pageIndex,
          trigger: page.trigger,
          locks: locks.length,
          outcome,
          lockedAt: lockedFrames.length ? Math.min(...lockedFrames) : -1,
          resolvedAt: resolvedFrames.length ? Math.max(...resolvedFrames) : -1,
          ...(failed.length
            ? { error: failed.map((check) => `lock ${check.lock}: ${check.error ?? check.outcome}`).join("; ") }
            : {}),
        };
        rows.push(row);

        if (outcome === "unresolved" || outcome === "error") {
          const hint = local === "local-unlock"
            ? "static analysis shows an unlockInput on the same page"
            : local === "local-transfer"
              ? "static analysis shows a transfer on the same page"
              : "no local or causally linked automatic-event release path was proven";
          findings.push(makeFinding(
            "locks/permanent-lock",
            "error",
            `page ${pageIndex} of event ${JSON.stringify(event.id)} on map ${JSON.stringify(map.id)} locks input and the isolated run never released it (${row.error ?? outcome})`,
            `${hint}; release the lock with unlockInput on the lock's own branch, or hand it to an automatic event that provably releases it`,
            { map: map.id, event: event.id, page: pageIndex },
          ));
        }
      });
    }
  }

  return {
    check: "locks",
    findings,
    summary: {
      pages: rows.length,
      lockCommands: lockCommandCount,
      dynamicChecks,
      unlocked: rows.filter((row) => row.outcome === "unlocked").length,
      transferred: rows.filter((row) => row.outcome === "transferred").length,
      unresolved: rows.filter((row) => row.outcome === "unresolved").length,
      errors: rows.filter((row) => row.outcome === "error").length,
    },
    rows,
  };
}
