// tools/rpgkit-check/src/dynamic/freeze.ts — the freeze scan: enter every
// map at a known inbound landing (collected from transfer commands) or its
// centre, auto-advance dialogs, and drive every direction in rotation. A
// long window (scanned twice) distinguishes a real stuck fiber/input lock
// from a legitimate wait or cutscene: a map is flagged when the input lock
// holds for the whole window, or a busy fiber (main/modal/inputLocked)
// makes no world progress for the whole window, or the interpreter errors.
//
// Generic port of the Tuxemon corpus "freeze scan" probe. Game-owned
// extension calls and battles are isolated by CHECK_SESSION_OPTIONS, so the
// scan measures event/lock/world liveness, not game logic.

import { BTN_BITS } from "../../../../src/engine/camera.ts";
import type { Command, Project } from "../../../../src/engine/types.ts";
import { makeFinding, type Finding } from "../finding.ts";
import { walkProjectCommands } from "../walk.ts";
import {
  CHECK_HZ,
  makeCheckSession,
  projectWithStart,
  startFresh,
  stepAuto,
  worldFingerprint,
} from "./sim.ts";

export interface FreezeOptions {
  /** Frames the lock/busy condition must hold to count as permanent. The
   *  scan runs twice this many frames per map. Default 6000 (100 s at
   *  60 Hz). */
  windowFrames?: number;
  /** Session tick rate. Default CHECK_HZ (60). */
  hz?: number;
}

export interface FrozenRow {
  map: string;
  start: [number, number];
  finalMap: string;
  final: [number, number];
  cells: number;
  frames: number;
  inputLocked: boolean;
  blocking: boolean;
  error?: string;
}

export interface FreezeReport {
  check: "freeze";
  findings: Finding[];
  summary: Record<string, number>;
  rows: FrozenRow[];
}

const DEFAULT_WINDOW = 6_000;

const pads = [BTN_BITS.UP, BTN_BITS.LEFT, BTN_BITS.DOWN, BTN_BITS.RIGHT];

/** Seed one landing per map from literal transfer commands anywhere in a
 *  command tree (branch bodies and called common programs included).
 *  Dynamic destinations have no static landing; their target maps are
 *  covered by the centre scan. */
function collectLandings(
  project: Project,
  commands: readonly Command[],
  landing: Map<string, [number, number]>,
): void {
  walkProjectCommands(project, commands, (command) => {
    if (
      command.op === "transfer" &&
      typeof command.map === "string" &&
      typeof command.x === "number" &&
      typeof command.y === "number"
    ) {
      if (!landing.has(command.map)) landing.set(command.map, [command.x, command.y]);
    }
  });
}

/** One finding per flagged row. A row can carry more than one flag (a
 *  permanent lock also parks a busy fiber): the most specific condition
 *  names the check, in priority order interpreter-error > input-lock >
 *  blocking-fiber. */
function findingFor(row: FrozenRow, windowFrames: number): Finding {
  if (row.error) {
    return makeFinding(
      "freeze/interpreter-error",
      "error",
      `map ${JSON.stringify(row.map)}: interpreter error after ${row.frames} frames: ${row.error}`,
      "fix the command that throws; the scan aborts the map at the first error",
      { map: row.map },
    );
  }
  if (row.inputLocked) {
    return makeFinding(
      "freeze/permanent-lock",
      "error",
      `map ${JSON.stringify(row.map)}: input lock held for the whole ${windowFrames}-frame window`,
      "every lockInput needs a matching unlockInput on every page path; a page that locks and never releases freezes all player input",
      { map: row.map },
    );
  }
  return makeFinding(
    "freeze/blocking-fiber",
    "error",
    `map ${JSON.stringify(row.map)}: a busy fiber (main/modal/inputLocked) made no world progress for the whole ${windowFrames}-frame window`,
    "the page loops or parks forever without changing the world; add an exit condition (a switch/selfSwitch flip, an erase, a transfer) so it can end",
    { map: row.map },
  );
}

export function checkFreeze(project: Project, options: FreezeOptions = {}): FreezeReport {
  const windowFrames = options.windowFrames ?? DEFAULT_WINDOW;
  const hz = options.hz ?? CHECK_HZ;
  const totalFrames = windowFrames * 2;

  const landing = new Map<string, [number, number]>();
  for (const map of project.maps) {
    for (const event of map.events ?? []) {
      for (const page of event.pages) collectLandings(project, page.commands, landing);
    }
  }

  const rows: FrozenRow[] = [];
  for (const map of project.maps) {
    const start = landing.get(map.id) ?? [Math.floor(map.width / 2), Math.floor(map.height / 2)];
    const localProject = projectWithStart(project, map.id, start[0]!, start[1]!);
    const session = makeCheckSession(localProject, hz);
    let state = startFresh(localProject, session);
    const cells = new Set<string>();
    let error: string | undefined;
    let frames = 0;
    let lastUnlocked = 0;
    let lastWorldProgress = 0;
    let previousWorld = worldFingerprint(state);
    let lastBusy = -1;
    try {
      for (; frames < totalFrames; frames++) {
        state = stepAuto(session, state, frames, pads[Math.floor(frames / 30) % pads.length]!);
        if (state.interp.error) {
          error = state.interp.error.message;
          break;
        }
        if (state.mapId === map.id) cells.add(`${state.move.tx},${state.move.ty}`);
        if (!state.interp.inputLocked) lastUnlocked = frames + 1;
        const fingerprint = worldFingerprint(state);
        if (fingerprint !== previousWorld) {
          lastWorldProgress = frames + 1;
          previousWorld = fingerprint;
        }
        if (state.interp.main || state.interp.modal || state.interp.inputLocked) lastBusy = frames + 1;
      }
    } catch (caught) {
      error = String(caught);
    }
    const row: FrozenRow = {
      map: map.id,
      start,
      finalMap: state.mapId,
      final: [state.move.tx, state.move.ty],
      cells: cells.size,
      frames,
      inputLocked: state.interp.inputLocked && frames - lastUnlocked >= windowFrames,
      // A repeating modal changes interpreter PCs and modal text forever but
      // makes no world progress. Count it even when an autorun restart leaves
      // a one-frame gap with no main fiber.
      blocking: lastBusy >= frames - 2 && frames - lastWorldProgress >= windowFrames,
      ...(error ? { error } : {}),
    };
    if (row.inputLocked || row.blocking || row.error) rows.push(row);
  }

  return {
    check: "freeze",
    findings: rows.map((row) => findingFor(row, windowFrames)),
    summary: {
      maps: project.maps.length,
      windowFrames,
      scannedFramesPerMap: totalFrames,
      permanentLocks: rows.filter((row) => row.inputLocked).length,
      permanentBlockingFibers: rows.filter((row) => row.blocking).length,
      errors: rows.filter((row) => row.error).length,
      flagged: rows.length,
    },
    rows,
  };
}
