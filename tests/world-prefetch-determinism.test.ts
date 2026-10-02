import { describe, expect, test } from "bun:test";
import {
  acquireSessionMap,
  createSession,
  prepareSessionMap,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import { MapNotReadyError, createJsonMapRepository } from "../src/engine/map-repository.ts";
import { createWorldPrefetcher } from "../src/engine/world-prefetch.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";
import type { MapDef, Project, ProjectShell } from "../src/engine/types.ts";
import type { WorldWorkingSet } from "../src/engine/world-working-set.ts";

function map(id: string, next?: string): MapDef {
  return {
    id,
    name: id,
    width: 4,
    height: 4,
    sheets: ["tiles"],
    ground: new Array(16).fill("tiles.0"),
    events: next ? [{
      id: "door",
      x: 1,
      y: 1,
      pages: [{
        trigger: "action",
        commands: [{ op: "transfer", map: next, x: 2, y: 2, dir: "up", fade: 0.4 }],
      }],
    }] : [],
  };
}

function project(): Project {
  return {
    format: "rpgkit-project/v1",
    title: "determinism fixture",
    tileSize: 16,
    start: { map: "map_a", x: 1, y: 1, dir: "up" },
    sheets: [{ id: "tiles", pak: "tiles", cols: 1, rows: 1, defaultPassage: "pass" }],
    items: [],
    maps: [map("map_a", "map_b"), map("map_b")],
  };
}

const SET: WorldWorkingSet = {
  active: "map_a",
  visible: ["map_a"],
  imminent: [
    { mapId: "map_b", portalId: "p1", side: "east", distance: 0, compatibility: "coordinate-preserving" },
  ],
  parsedKeep: ["map_a", "map_b"],
  compiledKeep: ["map_a", "map_b"],
};

interface Harness {
  session: Session;
  shell: ProjectShell;
}

/** `missingId` simulates a shard that never made it into the package. */
function setup(missingId?: string): Harness {
  const split = splitProjectMaps(project());
  const files = new Map(split.entries.map((entry) => [entry.meta.id, entry.bytes]));
  const repository = createJsonMapRepository(split.shell.mapIndex, {
    read: (entry) => {
      const meta = split.shell.mapIndex.find((m) => m.entry === entry);
      if (!meta || meta.id === missingId) return undefined;
      return files.get(meta.id);
    },
  });
  const session = createSession(split.shell, 60, repository);
  startSession(split.shell, session);
  return { session, shell: split.shell };
}

const snapshot = (s: SessionState) => ({
  mapId: s.mapId,
  x: s.move.tx,
  y: s.move.ty,
  fade: s.fade ? `${s.fade.phase}:${s.fade.left}` : null,
});

describe("prefetch determinism", () => {
  test("a prefetched transfer target executes the same ticks as a fade-staged one", () => {
    const prefetched = setup();
    const plain = setup();
    // startSession first: it releases every map but the start map, so
    // staging must happen after it or the staged target is cleared before
    // the tape runs (which would make both sides fade-staged, not
    // prefetched-vs-plain).
    let a = startSession(prefetched.shell, prefetched.session);
    let b = startSession(plain.shell, plain.session);
    // Stage map_b ahead of any input.
    const prefetcher = createWorldPrefetcher(prefetched.session, { budgetMs: 1000, now: () => 0 });
    expect(prefetcher.update(SET).staged).toBe(1);
    expect(prefetched.session.maps.has("map_b")).toBe(false); // unpublished

    const tape = (tick: number) => ({
      buttons: 0,
      confirmEdge: tick === 0,
      cancelEdge: false,
      upEdge: false,
      downEdge: false,
      leftEdge: false,
      rightEdge: false,
    });
    for (let tick = 0; tick < 24; tick++) {
      a = stepSession(prefetched.session, a, tape(tick));
      b = stepSession(plain.session, b, tape(tick));
      // The same input tick produces the same state whether or not the
      // target was prefetched: no tick lost, no tick executed twice.
      expect(snapshot(a)).toEqual(snapshot(b));
    }
    expect(a.mapId).toBe("map_b");
    expect(a.move.tx).toBe(2);
    expect(a.move.ty).toBe(2);
    // Both paths published through the staged slot, never a blocking acquire.
    expect(prefetched.session.preparingMaps.size).toBe(0);
    expect(plain.session.preparingMaps.size).toBe(0);
  });

  test("a missing shard is a stable error at the boundary, never a hang", () => {
    const { session } = setup("map_b");
    const prefetcher = createWorldPrefetcher(session, { budgetMs: 1000, now: () => 0 });
    const stats = prefetcher.update(SET);
    expect(stats.failures.map_b).toMatch(/missing entry/);
    expect(stats.pending).toBe(1);
    // Recorded once: later updates neither retry nor throw.
    expect(prefetcher.update(SET).stages).toBe(0);
    expect(prefetcher.update(SET).failures.map_b).toMatch(/missing entry/);
    // The same stable error surfaces at the real transfer boundary.
    expect(() => acquireSessionMap(session, "map_b")).toThrow(/missing entry/);
  });

  test("an async prepare rejection propagates as a stable error", async () => {
    const split = splitProjectMaps(project());
    const files = new Map(split.entries.map((entry) => [entry.meta.id, entry.bytes]));
    const repository = createJsonMapRepository(split.shell.mapIndex, {
      // The start map stays readable; map_b's bytes are never resident.
      read: (entry) => {
        const meta = split.shell.mapIndex.find((m) => m.entry === entry);
        return meta && meta.id !== "map_b" ? files.get(meta.id) : undefined;
      },
      prepare: async () => {
        throw new Error("network down");
      },
    });
    const session = createSession(split.shell, 60, repository);
    startSession(split.shell, session);
    // Bytes are not resident: acquire reports not-ready instead of blocking.
    expect(() => acquireSessionMap(session, "map_b")).toThrow(MapNotReadyError);
    // The async prepare fails with the source's error, deterministically.
    await expect(prepareSessionMap(session, "map_b")).rejects.toThrow("network down");
  });

  test("an async prepare rejection with an undefined reason still rejects", async () => {
    const split = splitProjectMaps(project());
    const files = new Map(split.entries.map((entry) => [entry.meta.id, entry.bytes]));
    const repository = createJsonMapRepository(split.shell.mapIndex, {
      read: (entry) => {
        const meta = split.shell.mapIndex.find((m) => m.entry === entry);
        return meta && meta.id !== "map_b" ? files.get(meta.id) : undefined;
      },
      // A falsy reason must still reject the promise, never resolve it.
      prepare: async () => {
        throw undefined;
      },
    });
    const session = createSession(split.shell, 60, repository);
    startSession(split.shell, session);
    expect(() => acquireSessionMap(session, "map_b")).toThrow(MapNotReadyError);
    // The rejection settles (not a hang) and the falsy reason is propagated.
    await expect(prepareSessionMap(session, "map_b")).rejects.toBeUndefined();
  });
});
