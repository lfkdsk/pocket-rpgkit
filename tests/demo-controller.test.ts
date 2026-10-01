// Pure opt-in demo transitions: validated chapter replacement, preserve-story
// warp and deep-link value parsing. Presentation is covered by render tests.

import { describe, expect, test } from "bun:test";
import { buildGame } from "../examples/sunstone/game-data.ts";
import { AttractController } from "../src/engine/attract.ts";
import { createSession, startSession } from "../src/engine/session.ts";
import { createSessionSnapshot, type SaveSnapshot } from "../src/engine/save.ts";
import { initialMovement } from "../src/engine/movement.ts";
import { isStandable } from "../src/engine/passability.ts";
import { createJsonMapRepository } from "../src/engine/map-repository.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";
import {
  createWarpState,
  decodeDemoSnapshot,
  demoMaps,
  loadDemoChapter,
  loadDemoWarp,
  parseDemoCoordinate,
  parseDemoSpeed,
  validateDemoOptions,
} from "../src/ui/demo/runtime.ts";
import type { GameViewDemoHost } from "../src/ui/demo-contract.ts";
import type { DemoOptions } from "../src/ui/demo/types.ts";

const BTN_RIGHT = 0x0020;
const { project } = buildGame();

function startSnapshot(): SaveSnapshot {
  const session = createSession(project, 60);
  return createSessionSnapshot(session, startSession(project, session), 0);
}

function snapshotAt(map: "village" | "forest" | "cave", x: number, y: number): SaveSnapshot {
  const snapshot = startSnapshot();
  snapshot.map = map;
  snapshot.player = initialMovement(x, y, 2, { tile: 16, speed: 2 });
  return snapshot;
}

function mounted(): { attract: AttractController; host: GameViewDemoHost } {
  const attract = new AttractController(project, [], { hz: 60 });
  return {
    attract,
    host: {
      project,
      session: attract.getSession(),
      attract,
      getState: () => attract.state,
    },
  };
}

describe("ui/demo pure runtime", () => {
  test("chapter restore is atomic and leaves its tape ready for live or autoplay", () => {
    const forest = snapshotAt("forest", 10, 13);
    forest.interp.sw.variables.chapter = 2;
    const chapter = { id: "forest", title: "Forest", snapshot: forest, tape: [0, 0, BTN_RIGHT] };

    const live = mounted();
    const liveState = loadDemoChapter(live.host, chapter, false, 1);
    expect(live.attract.state).toBe(liveState);
    expect(liveState).toMatchObject({ mapId: "forest", move: { tx: 10, ty: 13 } });
    expect(liveState.interp.sw.variables.chapter).toBe(2);
    expect(live.attract.status()).toMatchObject({ phase: "play", demoFrame: 0 });
    expect(live.attract.getPlaybackSpeed()).toBe(1);

    const auto = mounted();
    loadDemoChapter(auto.host, chapter, true, 4);
    expect(auto.attract.status()).toMatchObject({ phase: "attract", demoFrame: 0 });
    expect(auto.attract.getPlaybackSpeed()).toBe(4);
    auto.attract.step(0);
    expect(auto.attract.status().demoFrame).toBe(3);
  });

  test("a malformed snapshot is refused without replacing the live state", () => {
    const bad = snapshotAt("forest", 10, 13);
    bad.player.px++;
    const { attract, host } = mounted();
    const before = attract.state;
    expect(() => loadDemoChapter(host, { id: "bad", title: "Broken", snapshot: bad }, false, 1)).toThrow(
      "save state is invalid",
    );
    expect(attract.state).toBe(before);
  });

  test("warp keeps story banks, rebuilds the visit, and uses a safe configured spawn", () => {
    const { attract, host } = mounted();
    attract.state.sw.switches.quest = true;
    attract.state.sw.variables.route = 17;
    attract.state.sw.items["thorn-key"] = 1;
    attract.state.sw.gold = 42;
    attract.state.interp.sw = attract.state.sw;
    const options: DemoOptions = {
      chapters: [],
      warp: { spawns: { cave: { x: 9, y: 10, dir: "up" } } },
    };

    const next = loadDemoWarp(host, options, "cave", undefined, 1);
    expect(next).toMatchObject({ mapId: "cave", move: { tx: 9, ty: 10, facing: 2 } });
    expect(next.sw).toMatchObject({
      switches: { quest: true },
      variables: { route: 17 },
      items: { "thorn-key": 1 },
      gold: 42,
    });
    expect(next.interp.modal).toBeNull();
    expect(next.interp.sw).toEqual(next.sw);
  });

  test("warp refuses occupied event cells without replacing the world", () => {
    const { attract, host } = mounted();
    const before = attract.state;
    expect(() => createWarpState(host, "village", { x: 9, y: 5 })).toThrow("not a free standable tile");
    expect(attract.state).toBe(before);
  });

  test("warp treats every cell of a multi-cell event as occupied", () => {
    const wideProject = structuredClone(project);
    wideProject.maps.find((map) => map.id === "village")!.events!.push({
      id: "wide-demo-blocker",
      x: 1,
      y: 1,
      w: 3,
      h: 2,
      pages: [{ trigger: "action", commands: [] }],
    });
    const attract = new AttractController(wideProject, [], { hz: 60 });
    const host: GameViewDemoHost = {
      project: wideProject,
      session: attract.getSession(),
      attract,
      getState: () => attract.state,
    };
    expect(() => createWarpState(host, "village", { x: 3, y: 2 })).toThrow("not a free standable tile");
  });

  test("warp without a configured spawn chooses a free standable tile", () => {
    const { host } = mounted();
    const next = createWarpState(host, "forest");
    const map = project.maps.find((candidate) => candidate.id === "forest")!;
    const table = host.session.tables.get("forest")!;
    expect(isStandable(table, next.move.tx, next.move.ty)).toBe(true);
    expect(map.events?.some((event) => event.x === next.move.tx && event.y === next.move.ty)).toBe(false);
  });

  test("a sharded warp loads its destination once without revisiting the project start", () => {
    const split = splitProjectMaps(project);
    const files = new Map(split.entries.map((entry) => [entry.path, entry.text]));
    const reads: string[] = [];
    const repository = createJsonMapRepository(split.shell.mapIndex, {
      read(entry) {
        reads.push(entry);
        return files.get(entry);
      },
    });
    const attract = new AttractController(split.shell, [], { hz: 60, maps: repository });
    const host: GameViewDemoHost = {
      project: split.shell,
      session: attract.getSession(),
      attract,
      getState: () => attract.state,
    };
    const caveEntry = split.shell.mapIndex.find((entry) => entry.id === "cave")!.entry;

    const next = createWarpState(host, "cave", { x: 9, y: 10, dir: "up" });
    expect(next).toMatchObject({ mapId: "cave", move: { tx: 9, ty: 10, facing: 2 } });
    expect(reads.filter((entry) => entry === caveEntry)).toHaveLength(1);
    expect([...host.session.maps.keys()]).toEqual(["cave"]);
  });

  test("configuration and deep-link scalars are validated before use", () => {
    expect(() => validateDemoOptions({ chapters: [] })).not.toThrow();
    expect(() => validateDemoOptions({
      chapters: [
        { id: "same", title: "One", snapshot: startSnapshot() },
        { id: "same", title: "Two", snapshot: startSnapshot() },
      ],
    })).toThrow("duplicate chapter id");
    expect(() => validateDemoOptions({
      chapters: [{ id: "bad id", title: "Bad", snapshot: startSnapshot() }],
    })).toThrow("id is not usable");
    expect(() => validateDemoOptions({ chapters: [], openButton: 3 })).toThrow("one u16 button bit");
    expect(() => validateDemoOptions({
      chapters: [{ id: "bad-tape", title: "Bad tape", snapshot: startSnapshot(), tape: [0x1_0000] }],
    })).toThrow("u16 button mask");

    expect(parseDemoCoordinate("x", "23")).toBe(23);
    expect(() => parseDemoCoordinate("y", "-1")).toThrow("non-negative integer");
    expect(parseDemoSpeed(undefined)).toBe(1);
    expect(parseDemoSpeed("2")).toBe(2);
    expect(parseDemoSpeed(4)).toBe(4);
    expect(() => parseDemoSpeed("3")).toThrow("1, 2, or 4");
  });

  test("map labels prefer authored display names", () => {
    expect(demoMaps(project)).toEqual([
      { id: "village", title: "Bramble Hollow" },
      { id: "forest", title: "Whispering Wood" },
      { id: "cave", title: "Sunstone Cave" },
    ]);
  });

  test("object snapshots are cloned before they enter the controller", () => {
    const { host } = mounted();
    const snapshot = startSnapshot();
    const decoded = decodeDemoSnapshot(host, snapshot);
    decoded.interp.sw.variables.changed = 1;
    expect(snapshot.interp.sw.variables.changed).toBeUndefined();
  });
});
