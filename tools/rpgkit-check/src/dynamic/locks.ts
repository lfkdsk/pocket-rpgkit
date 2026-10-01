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
      // its own run; the battle itself no-ops here and is kept as-is. A
      // battle with no lock anywhere cannot affect the run and is dropped.
      if (command.onWin && containsProjectCommand(project, command.onWin, target)) {
        out.push(...forceLockBranch(project, command.onWin, target, forcedCommons, expanding));
      } else if (command.onLose && containsProjectCommand(project, command.onLose, target)) {
        out.push(...forceLockBranch(project, command.onLose, target, forcedCommons, expanding));
      } else if (command.onEscape && containsProjectCommand(project, command.onEscape, target)) {
        out.push(...forceLockBranch(project, command.onEscape, target, forcedCommons, expanding));
      } else if (containsLock(project, command.onWin ?? []) || containsLock(project, command.onLose ?? []) ||
        containsLock(project, command.onEscape ?? [])) {
        out.push(command);
      }
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
): { sw: ReturnType<typeof createSwitchState>; localVariables: Record<string, number>; facing: Dir } {
  const sw = createSwitchState({ variables: { "sys.party_size": 1 }, gold: 999_999 });
  const localVariables: Record<string, number> = {};
  let facing: Dir = "down";
  for (const condition of conditions) {
    if (condition.kind === "variable") {
      const value = condition.op === "!=" ? (condition.value === 0 ? 1 : 0) : condition.value;
      if (condition.id.startsWith("local.")) localVariables[condition.id] = value;
      else sw.variables[condition.id] = value;
    } else if (condition.kind === "switch") {
      sw.switches[condition.id] = condition.value ?? true;
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
  return { sw, localVariables, facing };
}

/** A passable cell adjacent to the event, so an action-trigger page starts
 * where the player could actually have triggered it. */
function startCell(
  project: Project,
  mapId: string,
  event: GameEvent,
  dir: Dir,
  hz: number,
): { x: number; y: number } {
  const session = makeCheckSession(project, hz);
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
): LockAttempt {
  const eventKey = `${mapId}/${event.id}`;
  const initial = satisfy(pageConditions(page.condition), eventKey);
  const start = startCell(project, mapId, event, initial.facing, hz);
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
  const session = makeCheckSession(runProject, hz);
  let state = startFresh(runProject, session, initial.sw);
  Object.assign(state.sw.variables, initial.localVariables);
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
    if (state.mapId !== mapId) {
      outcome = "transferred";
      resolvedAt = frame;
      break;
    }
    if (lockedAt >= 0 && !state.interp.inputLocked) {
      outcome = "unlocked";
      resolvedAt = frame;
      break;
    }
  }
  if (outcome === "unresolved" && lockedAt < 0) error = "instrumented lock was not reached";
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
      const key = `${state.terminated}:${[...state.unresolved].sort((a, b) => a - b).join(",")}`;
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
        if (state.terminated) {
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
        } else if (command.op === "common") {
          const common = project.commonEvents?.find((c) => c.id === command.id);
          if (common && !expanding.has(command.id)) {
            outputs.push(...run(common.commands, [state], new Set(expanding).add(command.id)));
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
          return checkPage(project, map.id, event, page, target, lockIndex, frames, hz);
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
              : "no static release path was found on the page";
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
