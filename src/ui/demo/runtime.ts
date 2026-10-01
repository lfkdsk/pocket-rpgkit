// Pure demo state transitions shared by the opt-in menu and reducer tests.
// No JSX or presentation import belongs here.

import { BTN } from "@pocketjs/framework/input";
import type { AttractSpeed } from "../../engine/attract.ts";
import { cloneSnapshot, decodeSaveCode, SaveError, type SaveSnapshot } from "../../engine/save.ts";
import { restoreSessionSnapshot } from "../../engine/save-restore.ts";
import { validateSnapshot } from "../../engine/save-validate.ts";
import { isStandable } from "../../engine/passability.ts";
import { acquireSessionMap, startSession, type SessionState } from "../../engine/session.ts";
import type { Dir, Facing, MapDef, ProjectSource } from "../../engine/types.ts";
import { isProjectShell } from "../../engine/map-repository.ts";
import type { GameViewDemoHost } from "../demo-contract.ts";
import type { DemoChapter, DemoOptions, DemoSpawn, DemoTapeFrames, DemoTapeProvider } from "./types.ts";

export const DEMO_ID = /^[a-z0-9][a-z0-9._-]*$/i;

const DIR_FOR_FACING: Readonly<Record<Facing, Dir>> = {
  0: "down",
  1: "left",
  2: "up",
  3: "right",
};

export function validateDemoOptions(options: DemoOptions): void {
  if (!Array.isArray(options.chapters)) throw new TypeError("demo: chapters must be an array");
  const ids = new Set<string>();
  for (const [index, chapter] of options.chapters.entries()) {
    if (!chapter || typeof chapter !== "object") throw new TypeError(`demo: chapters[${index}] must be an object`);
    if (!DEMO_ID.test(chapter.id)) throw new TypeError(`demo: chapters[${index}].id is not usable`);
    if (ids.has(chapter.id)) throw new TypeError(`demo: duplicate chapter id ${JSON.stringify(chapter.id)}`);
    ids.add(chapter.id);
    if (typeof chapter.title !== "string" || chapter.title.trim().length === 0) {
      throw new TypeError(`demo: chapters[${index}].title must be non-empty`);
    }
    // A provider tape is resolved on first selection; its frames are not
    // walked at boot so a pak-backed tape costs nothing until it is used.
    const tape = chapter.tape;
    if (tape !== undefined && typeof tape !== "function") {
      for (let frame = 0; frame < tape.length; frame++) {
        const mask = tape[frame];
        if (!Number.isInteger(mask) || mask! < 0 || mask! > 0xffff) {
          throw new RangeError(`demo: chapters[${index}].tape[${frame}] must be a u16 button mask`);
        }
      }
    }
    for (const field of ["tapeStart", "tapeFrames"] as const) {
      const value = chapter[field];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        throw new RangeError(`demo: chapters[${index}].${field} must be a non-negative safe integer`);
      }
    }
    if (tape !== undefined && typeof tape !== "function" &&
      (chapter.tapeStart ?? 0) + (chapter.tapeFrames ?? 0) > tape.length) {
      throw new RangeError(`demo: chapters[${index}] tape window ends past the tape`);
    }
    if (chapter.timelineFrame !== undefined &&
      (!Number.isSafeInteger(chapter.timelineFrame) || chapter.timelineFrame < 0)) {
      throw new RangeError(`demo: chapters[${index}].timelineFrame must be a non-negative safe integer`);
    }
  }
  const open = options.openButton ?? BTN.SELECT;
  if (!Number.isInteger(open) || open <= 0 || open > 0xffff || (open & (open - 1)) !== 0) {
    throw new RangeError("demo: openButton must be one u16 button bit");
  }
  for (const [mapId, spawn] of Object.entries(options.warp?.spawns ?? {})) {
    if (!DEMO_ID.test(mapId) || !spawn || !Number.isInteger(spawn.x) || !Number.isInteger(spawn.y) || spawn.x < 0 || spawn.y < 0) {
      throw new RangeError(`demo: invalid warp spawn for ${JSON.stringify(mapId)}`);
    }
    if (spawn.dir !== undefined && !["down", "left", "up", "right"].includes(spawn.dir)) {
      throw new RangeError(`demo: invalid warp direction for ${JSON.stringify(mapId)}`);
    }
  }
}

export function demoMaps(project: ProjectSource): readonly { id: string; title: string }[] {
  return isProjectShell(project)
    ? project.mapIndex.map((map) => ({ id: map.id, title: map.id }))
    : project.maps.map((map) => ({ id: map.id, title: map.name || map.id }));
}

export function decodeDemoSnapshot(host: GameViewDemoHost, value: SaveSnapshot | string): SaveSnapshot {
  if (typeof value === "string") return decodeSaveCode(value, host.session.content);
  const reason = validateSnapshot(value);
  if (reason !== null) throw new SaveError("shape", `save state is invalid: ${reason}`);
  return cloneSnapshot(value);
}

// One decoded tape per provider function, shared by every chapter that
// names it. Weak, so a dropped DemoOptions releases its tapes.
const resolvedTapes = new WeakMap<DemoTapeProvider, DemoTapeFrames>();

function resolveTape(tape: readonly number[] | DemoTapeProvider): DemoTapeFrames {
  if (typeof tape !== "function") return tape;
  let resolved = resolvedTapes.get(tape);
  if (resolved === undefined) {
    resolved = tape();
    if (!resolved || typeof resolved.length !== "number") throw new TypeError("demo: tape provider must return an array of frames");
    resolvedTapes.set(tape, resolved);
  }
  return resolved;
}

/** Frame count the autoplay page can know without resolving a provider:
 *  exact for inline tapes and declared windows, otherwise null. */
export function chapterTapeFrames(chapter: DemoChapter): number | null {
  const tape = chapter.tape;
  if (tape === undefined) return 0;
  if (chapter.tapeFrames !== undefined) return chapter.tapeFrames;
  if (typeof tape === "function") return null;
  return Math.max(0, tape.length - (chapter.tapeStart ?? 0));
}

/** Resolve a chapter's input window. A provider is called at most once and
 *  its tape shared; a typed-array tape is windowed without copying. */
export function chapterTape(chapter: DemoChapter): DemoTapeFrames {
  if (chapter.tape === undefined) return [];
  const tape = resolveTape(chapter.tape);
  const start = chapter.tapeStart ?? 0;
  const end = chapter.tapeFrames === undefined ? tape.length : start + chapter.tapeFrames;
  if (end > tape.length) {
    throw new RangeError(`chapter ${JSON.stringify(chapter.id)} tape window ${start}..${end} ends past ${tape.length} frames`);
  }
  if (start === 0 && end === tape.length) return tape;
  return ArrayBuffer.isView(tape)
    ? (tape as unknown as Uint16Array).subarray(start, end)
    : Array.prototype.slice.call(tape, start, end) as number[];
}

function firstStandable(host: GameViewDemoHost, map: MapDef): DemoSpawn {
  const table = host.session.tables.get(map.id)!;
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (isStandable(table, x, y) && !authoredEventOccupies(map, x, y)) {
        return { x, y };
      }
    }
  }
  throw new Error(`map ${JSON.stringify(map.id)} has no free standable tile`);
}

function authoredEventOccupies(map: MapDef, x: number, y: number): boolean {
  return (map.events ?? []).some((event) =>
    x >= event.x && x < event.x + (event.w ?? 1) &&
    y >= event.y && y < event.y + (event.h ?? 1)
  );
}

function checkedSpawn(host: GameViewDemoHost, map: MapDef, spawn: DemoSpawn): DemoSpawn {
  const table = host.session.tables.get(map.id)!;
  if (
    spawn.x < 0 || spawn.y < 0 || spawn.x >= map.width || spawn.y >= map.height ||
    !isStandable(table, spawn.x, spawn.y) || authoredEventOccupies(map, spawn.x, spawn.y)
  ) {
    throw new Error(`map ${JSON.stringify(map.id)} spawn (${spawn.x},${spawn.y}) is not a free standable tile`);
  }
  return spawn;
}

export function createWarpState(host: GameViewDemoHost, mapId: string, requested?: DemoSpawn): SessionState {
  const current = host.getState();
  const map = acquireSessionMap(host.session, mapId);
  const spawn = checkedSpawn(host, map, requested ?? firstStandable(host, map));

  // Transfer semantics: rebuild map-local execution while retaining the
  // story banks, self switches, inventory, gold and extension state.
  // Override only the start descriptor passed to startSession. This avoids
  // touching the project's real start map — important for a sharded project,
  // where that map may have been evicted and would otherwise be loaded only
  // to be discarded again before the destination is entered.
  const projectAtDestination: ProjectSource = {
    ...host.project,
    start: {
      map: map.id,
      x: spawn.x,
      y: spawn.y,
      dir: spawn.dir ?? DIR_FOR_FACING[current.move.facing],
    },
  };
  const warped = startSession(projectAtDestination, host.session, current.sw, current.ext);
  warped.frame = current.frame;
  return warped;
}

export function loadDemoChapter(
  host: GameViewDemoHost,
  chapter: DemoChapter,
  autoplay: boolean,
  speed: AttractSpeed,
): SessionState {
  const tape = chapterTape(chapter);
  if (autoplay && tape.length === 0) throw new Error(`chapter ${JSON.stringify(chapter.id)} has no autoplay tape`);
  const snapshot = decodeDemoSnapshot(host, chapter.snapshot);
  const restored = restoreSessionSnapshot(host.session, snapshot);
  // The snapshot carries only the per-map interpreter clock; a chapter
  // authored mid-tape supplies the global reducer frame so its suffix
  // replay lands on the same timeline as a full replay.
  if (chapter.timelineFrame !== undefined) restored.frame = chapter.timelineFrame;
  return host.attract.loadState(restored, snapshot.held, tape, autoplay, speed);
}

export function loadDemoWarp(
  host: GameViewDemoHost,
  options: DemoOptions,
  mapId: string,
  requested: DemoSpawn | undefined,
  speed: AttractSpeed,
): SessionState {
  if (!demoMaps(host.project).some((map) => map.id === mapId)) throw new Error(`unknown map ${JSON.stringify(mapId)}`);
  const restored = createWarpState(host, mapId, requested ?? options.warp?.spawns?.[mapId]);
  return host.attract.loadState(restored, 0, [], false, speed);
}

export function parseDemoCoordinate(name: "x" | "y", value: unknown): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${name} is outside the safe integer range`);
  return number;
}

export function parseDemoSpeed(value: unknown): AttractSpeed {
  if (value === undefined || value === "1" || value === 1) return 1;
  if (value === "2" || value === 2) return 2;
  if (value === "4" || value === 4) return 4;
  throw new Error("speed must be 1, 2, or 4");
}
