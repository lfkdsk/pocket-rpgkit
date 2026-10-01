// tests/rpgkit-check-dynamic-reach.test.ts — the reach check proves
// reachability with a replayable witness: every "reached" map carries a
// button-mask tape the tool itself replays in a fresh session to verify the
// arrival; a "notFound" map is a lead with frontier stats, never a proof.

import { describe, expect, test } from "bun:test";
import { checkReach, type ReachMapResult, type ReachReport } from "../tools/rpgkit-check/src/dynamic/reach.ts";
import { Driver } from "../tools/rpgkit-check/src/dynamic/reach-driver.ts";
import {
  BTN_DOWN,
  replayWitness,
  verifyWitness,
  type ReachWitness,
} from "../tools/rpgkit-check/src/dynamic/reach-witness.ts";
import { checkSessionOptions } from "../tools/rpgkit-check/src/dynamic/sim.ts";
import { loadProjectFile } from "../tools/rpgkit-check/src/doc.ts";
import { createSession, startSession } from "../src/engine/session.ts";
import type { BattleRules } from "../src/engine/battle.ts";
import type { Command, GameEvent, MapDef, PageCondition, Project } from "../src/engine/types.ts";

function grassMap(id: string, events: GameEvent[] = []): MapDef {
  return {
    id,
    name: id,
    width: 5,
    height: 5,
    sheets: ["grass"],
    ground: new Array<string>(25).fill("grass.0"),
    events,
  };
}

function fixtureProject(maps: MapDef[], startMap = "A"): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Reach fixture",
    tileSize: 16,
    start: { map: startMap, x: 0, y: 0, dir: "down" },
    sheets: [{ id: "grass", cols: 1, rows: 1 }],
    items: [],
    sprites: { wall: { kind: "image", src: "wall.png" } },
    maps,
  };
}

function touchEvent(id: string, x: number, y: number, target: string): GameEvent {
  return {
    id,
    x,
    y,
    pages: [{ trigger: "playerTouch", commands: [{ op: "transfer", map: target, x: 0, y: 0 }] }],
  };
}

function actionEvent(id: string, x: number, y: number, commands: Command[], condition?: PageCondition): GameEvent {
  return { id, x, y, pages: [{ trigger: "action", ...(condition ? { condition } : {}), commands }] };
}

function blockEvent(id: string, x: number, y: number): GameEvent {
  return { id, x, y, pages: [{ trigger: "action", sprite: "wall", blocks: true, commands: [] }] };
}

function reached(report: ReachReport, map: string): Extract<ReachMapResult, { status: "reached" }> {
  const m = report.maps.find((r) => r.map === map);
  if (!m || m.status !== "reached") throw new Error(`map ${map} not reached`);
  return m;
}

function freshSession(project: Project, hz = 60) {
  return createSession(project, hz, checkSessionOptions(project));
}

// --- basic connectivity -------------------------------------------------------

describe("rpgkit-check reach: connected maps", () => {
  test("playerTouch transfer reaches the target map with a replayable witness", () => {
    const project = fixtureProject([grassMap("A", [touchEvent("door", 2, 2, "B")]), grassMap("B")]);
    const report = checkReach(project);
    expect(report.findings).toEqual([]);
    expect(report.reachableMaps).toEqual(["A", "B"]);
    expect(report.notFoundMaps).toEqual([]);
    const b = reached(report, "B");
    expect(b.frames).toBeGreaterThan(0);
    // The witness really replays to B in a fresh session.
    const replay = replayWitness(freshSession(project), project, b.witness);
    expect(replay.state.mapId).toBe("B");
    expect(replay.finalHash).toBe(b.stateHash);
  });

  test("action transfer reaches the target map", () => {
    const project = fixtureProject([
      grassMap("A", [actionEvent("portal", 2, 2, [{ op: "transfer", map: "B", x: 0, y: 0 }])]),
      grassMap("B"),
    ]);
    const report = checkReach(project);
    expect(report.reachableMaps).toEqual(["A", "B"]);
    expect(report.notFoundMaps).toEqual([]);
  });

  test("disconnected map is notFound with a frontier, not a proof", () => {
    const project = fixtureProject([grassMap("A", [touchEvent("door", 2, 2, "B")]), grassMap("B"), grassMap("C")]);
    const report = checkReach(project);
    expect(report.reachableMaps).toEqual(["A", "B"]);
    expect(report.notFoundMaps).toEqual(["C"]);
    const c = report.maps.find((m) => m.map === "C")!;
    expect(c.status).toBe("notFound");
    if (c.status === "notFound") {
      // No literal transfer names C: the frontier is empty and the finding
      // says so.
      expect(c.frontier.inbound).toEqual([]);
    }
    const finding = report.findings.find((f) => f.check === "reach/map-not-found")!;
    expect(finding.severity).toBe("warning");
    expect(finding.message).toContain("lead, not a proof");
    expect(finding.loc.map).toBe("C");
  });

  test("a wall of blocks:true events hides the tiles behind it", () => {
    const project = fixtureProject([grassMap("A", [0, 1, 2, 3, 4].map((y) => blockEvent(`wall${y}`, 2, y)))]);
    const report = checkReach(project);
    expect(report.findings).toEqual([]);
    expect(report.reachableMaps).toEqual(["A"]);
  });

  test("start tile occupied by a blocking body is an error", () => {
    const project = fixtureProject([grassMap("A", [blockEvent("guard", 0, 0)])]);
    const report = checkReach(project);
    const errors = report.findings.filter((f) => f.severity === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.check).toBe("reach/start-unreachable");
  });

  test("options.start computes reachability from the requested start", () => {
    const project = fixtureProject([
      grassMap("A", [touchEvent("aDoor", 2, 2, "D")]),
      grassMap("B", [touchEvent("bDoor", 2, 2, "C")]),
      grassMap("C"),
      grassMap("D"),
    ]);
    const report = checkReach(project, { start: { map: "B", x: 0, y: 0 } });
    expect(report.start).toBe("B@0,0");
    expect(report.reachableMaps.sort()).toEqual(["B", "C"]);
    expect(report.notFoundMaps.sort()).toEqual(["A", "D"]);
  });
});

describe("rpgkit-check reach: transfer tile at the map edge", () => {
  test("a door on the east edge is reached via its in-bounds neighbor", () => {
    // The door is on the east edge of a 3x3 map. Its only path-onto neighbor
    // is in bounds; an out-of-bounds neighbor must not produce a bogus path
    // (the y*width+x key collides for off-map cells).
    const edgeMap: MapDef = {
      id: "A", name: "A", width: 3, height: 3, sheets: ["grass"],
      ground: new Array<string>(9).fill("grass.0"),
      events: [touchEvent("door", 2, 0, "B")],
    };
    const project = fixtureProject([edgeMap, grassMap("B")]);
    const report = checkReach(project);
    expect(report.reachableMaps).toEqual(["A", "B"]);
  });
});

// --- the three review rounds' edge cases --------------------------------------
//
// Each fixture has a map the search MUST find (witness replays) and a map the
// search MUST NOT fabricate. These are the shapes the old second-interpreter
// reach got wrong; the real engine gets them right by construction.

describe("rpgkit-check reach: nested branch transfer", () => {
  test("a transfer inside a taken branch kills the parent tail", () => {
    // if (unset switch → true) { transfer B }; transfer C  → B reached, C notFound.
    const project = fixtureProject([
      grassMap("A", [actionEvent("door", 2, 2, [
        { op: "if", if: { kind: "switch", id: "later", value: false }, then: [{ op: "transfer", map: "B", x: 0, y: 0 }] },
        { op: "transfer", map: "C", x: 0, y: 0 },
      ])]),
      grassMap("B"),
      grassMap("C"),
    ]);
    const report = checkReach(project);
    expect(report.reachableMaps).toEqual(["A", "B"]);
    expect(report.notFoundMaps).toEqual(["C"]);
    // Cross-check: the real engine ends on B, not C.
    const replay = replayWitness(freshSession(project), project, reached(report, "B").witness);
    expect(replay.state.mapId).toBe("B");
  });
});

describe("rpgkit-check reach: recursive common events", () => {
  test("a self-recursive common runaways before its transfer", () => {
    // common loop = [common loop, transfer B]. The engine hits its stack-depth
    // guard; B is never reached.
    const project = fixtureProject([
      grassMap("A", [actionEvent("door", 2, 2, [{ op: "common", id: "loop" }])]),
      grassMap("B"),
    ]);
    project.commonEvents = [
      { trigger: "none", id: "loop", commands: [{ op: "common", id: "loop" }, { op: "transfer", map: "B", x: 0, y: 0 }] },
    ];
    const report = checkReach(project);
    expect(report.reachableMaps).toEqual(["A"]);
    expect(report.notFoundMaps).toEqual(["B"]);
  });

  test("mutual recursion also runaways", () => {
    const project = fixtureProject([
      grassMap("A", [actionEvent("door", 2, 2, [{ op: "common", id: "ping" }])]),
      grassMap("B"),
    ]);
    project.commonEvents = [
      { trigger: "none", id: "ping", commands: [{ op: "common", id: "pong" }] },
      { trigger: "none", id: "pong", commands: [{ op: "common", id: "ping" }, { op: "transfer", map: "B", x: 0, y: 0 }] },
    ];
    const report = checkReach(project);
    expect(report.reachableMaps).toEqual(["A"]);
    expect(report.notFoundMaps).toEqual(["B"]);
  });

  test("a non-recursive common that transfers is found", () => {
    const project = fixtureProject([
      grassMap("A", [actionEvent("door", 2, 2, [{ op: "common", id: "go" }])]),
      grassMap("B"),
    ]);
    project.commonEvents = [
      { trigger: "none", id: "go", commands: [{ op: "transfer", map: "B", x: 0, y: 0 }] },
    ];
    const report = checkReach(project);
    expect(report.reachableMaps).toEqual(["A", "B"]);
  });
});

describe("rpgkit-check reach: non-zero item/gold baseline", () => {
  test("an item added on top of a non-zero baseline propagates through a forced transfer", () => {
    // Start holding key=1. A's autorun adds one (→2) and transfers to B; B's
    // page gated on key>=2 transfers to C. The old merge treated the non-zero
    // baseline as a disagreement and lost it.
    const project = fixtureProject([
      grassMap("A", [{
        id: "boot", x: 0, y: 0,
        pages: [{ trigger: "autorun", commands: [
          { op: "item", item: "key", set: "add", count: 1 },
          { op: "transfer", map: "B", x: 0, y: 0 },
        ] }],
      }]),
      grassMap("B", [actionEvent("door", 2, 2, [
        { op: "if", if: { kind: "item", id: "key", count: 2 }, then: [{ op: "transfer", map: "C", x: 0, y: 0 }] },
      ])]),
      grassMap("C"),
    ]);
    const report = checkReach(project, { start: { map: "A", x: 0, y: 0, items: { key: 1 } } });
    expect(report.reachableMaps.sort()).toEqual(["A", "B", "C"]);
    expect(report.notFoundMaps).toEqual([]);
  });

  test("a gate above the carried count is notFound", () => {
    // Same shape, but B's gate needs key>=3 while only 2 is carried.
    const project = fixtureProject([
      grassMap("A", [{
        id: "boot", x: 0, y: 0,
        pages: [{ trigger: "autorun", commands: [
          { op: "item", item: "key", set: "add", count: 1 },
          { op: "transfer", map: "B", x: 0, y: 0 },
        ] }],
      }]),
      grassMap("B", [actionEvent("door", 2, 2, [
        { op: "if", if: { kind: "item", id: "key", count: 3 }, then: [{ op: "transfer", map: "C", x: 0, y: 0 }] },
      ])]),
      grassMap("C"),
    ]);
    const report = checkReach(project, { start: { map: "A", x: 0, y: 0, items: { key: 1 } } });
    expect(report.reachableMaps.sort()).toEqual(["A", "B"]);
    expect(report.notFoundMaps).toEqual(["C"]);
  });

  test("gold above a non-zero baseline propagates", () => {
    const project = fixtureProject([
      grassMap("A", [{
        id: "boot", x: 0, y: 0,
        pages: [{ trigger: "autorun", commands: [
          { op: "gold", set: "add", amount: 5 },
          { op: "transfer", map: "B", x: 0, y: 0 },
        ] }],
      }]),
      grassMap("B", [actionEvent("door", 2, 2, [
        { op: "if", if: { kind: "gold", amount: 15 }, then: [{ op: "transfer", map: "C", x: 0, y: 0 }] },
      ])]),
      grassMap("C"),
    ]);
    const report = checkReach(project, { start: { map: "A", x: 0, y: 0, gold: 10 } });
    expect(report.reachableMaps.sort()).toEqual(["A", "B", "C"]);
  });
});

describe("rpgkit-check reach: delayed forced transfer chain", () => {
  test("a forced transfer after a 1 s wait is followed (no fixed tick window)", () => {
    // A's autorun waits 1 s, adds key, transfers B; B's autorun gated on key
    // transfers C. The old 10-tick dry-run window lost the delayed state.
    const project = fixtureProject([
      grassMap("A", [{
        id: "boot", x: 0, y: 0,
        pages: [{ trigger: "autorun", commands: [
          { op: "wait", seconds: 1.0 },
          { op: "item", item: "key", set: "add", count: 1 },
          { op: "transfer", map: "B", x: 0, y: 0 },
        ] }],
      }]),
      grassMap("B", [{
        id: "gate", x: 2, y: 2,
        pages: [{ condition: { item: "key" }, trigger: "autorun", commands: [{ op: "transfer", map: "C", x: 0, y: 0 }] }],
      }]),
      grassMap("C"),
    ]);
    const report = checkReach(project);
    expect(report.reachableMaps.sort()).toEqual(["A", "B", "C"]);
    expect(report.notFoundMaps).toEqual([]);
    // Every reached map's witness replays to that map at 60 Hz.
    for (const id of ["A", "B", "C"]) {
      const m = reached(report, id);
      expect(replayWitness(freshSession(project), project, m.witness).state.mapId).toBe(id);
    }
  });

  test("a gate the delayed chain never satisfies is notFound", () => {
    const project = fixtureProject([
      grassMap("A", [{
        id: "boot", x: 0, y: 0,
        pages: [{ trigger: "autorun", commands: [
          { op: "wait", seconds: 1.0 },
          { op: "transfer", map: "B", x: 0, y: 0 },
        ] }],
      }]),
      grassMap("B", [{
        id: "gate", x: 2, y: 2,
        pages: [{ condition: { switch: "never" }, trigger: "autorun", commands: [{ op: "transfer", map: "C", x: 0, y: 0 }] }],
      }]),
      grassMap("C"),
    ]);
    const report = checkReach(project);
    expect(report.reachableMaps.sort()).toEqual(["A", "B"]);
    expect(report.notFoundMaps).toEqual(["C"]);
  });
});

describe("rpgkit-check reach: parallel transient page", () => {
  const transientProject = (farX: number, farY: number): Project => {
    // A parallel opens `open` for ~0.33 s starting at 0.5 s. A near action
    // page (1,0) gated on open transfers B; a far one gated on open transfers
    // C. The search must catch the transient page and reach B; the far event
    // cannot be reached while the window is open.
    const timer: GameEvent = {
      id: "timer", x: 0, y: 0,
      pages: [
        { trigger: "parallel", commands: [
          { op: "wait", seconds: 0.5 },
          { op: "switch", id: "open", value: true },
          { op: "wait", seconds: 0.33 },
          { op: "switch", id: "open", value: false },
          { op: "selfSwitch", key: "A", value: true },
        ] },
        { trigger: "parallel", condition: { selfSwitch: "A" }, commands: [] },
      ],
    };
    const gate = (id: string, x: number, y: number, target: string): GameEvent => ({
      id, x, y,
      pages: [{ condition: { switch: "open" }, trigger: "action", commands: [{ op: "transfer", map: target, x: 0, y: 0 }] }],
    });
    return fixtureProject([
      grassMap("A", [timer, gate("near", 1, 0, "B"), gate("far", farX, farY, "C")]),
      grassMap("B"),
      grassMap("C"),
    ]);
  };

  test("a page a parallel activates briefly is caught and triggered", () => {
    const report = checkReach(transientProject(4, 4));
    expect(report.reachableMaps).toContain("B");
  });

  test("an event too far to reach while the window is open is notFound", () => {
    const report = checkReach(transientProject(4, 4));
    expect(report.notFoundMaps).toContain("C");
    const c = report.maps.find((m) => m.map === "C")!;
    expect(c.status).toBe("notFound");
  });
});

describe("rpgkit-check reach: dedup key soundness", () => {
  test("a long parallel timer opening a door is ridden out and the door is found", () => {
    // The timer runs longer than the wait macro's quiet-exit window, so the
    // first wait leaf parks with the fiber still mid-wait. The dedup key
    // zeroes the absolute frame clock; it must also rebase the fiber's
    // absolute `since` anchor onto the same zero, or the leaf's key equals
    // the root's (same absolute since, frame zeroed both) and the leaf is
    // dropped — the queue empties and the door's map is never found.
    const project = fixtureProject([
      grassMap("A", [
        { id: "timer", x: 0, y: 0, pages: [{ trigger: "parallel", commands: [
          { op: "wait", seconds: 10 },
          { op: "switch", id: "open", value: true },
        ] }] },
        { id: "door", x: 2, y: 0, pages: [{
          condition: { switch: "open" },
          trigger: "playerTouch",
          commands: [{ op: "transfer", map: "B", x: 0, y: 0 }],
        }] },
      ]),
      grassMap("B"),
    ]);
    const report = checkReach(project, { maxFrames: 5000 });
    expect(report.reachableMaps).toEqual(["A", "B"]);
    expect(report.notFoundMaps).toEqual([]);
    // The witness really replays to B in a fresh session.
    const b = reached(report, "B");
    expect(replayWitness(freshSession(project), project, b.witness).state.mapId).toBe("B");
  });
});

describe("rpgkit-check reach: switch set before an in-page transfer", () => {
  test("a switch an action page sets before transferring opens the target's door", () => {
    // A's action: set gate=true; transfer B. B's action gated on gate → C.
    // The old reach never ran action pages, so gate never propagated.
    const project = fixtureProject([
      grassMap("A", [actionEvent("door", 2, 2, [
        { op: "switch", id: "gate", value: true },
        { op: "transfer", map: "B", x: 0, y: 0 },
      ])]),
      grassMap("B", [actionEvent("door", 2, 2, [
        { op: "if", if: { kind: "switch", id: "gate" }, then: [{ op: "transfer", map: "C", x: 0, y: 0 }] },
      ])]),
      grassMap("C"),
    ]);
    const report = checkReach(project);
    expect(report.reachableMaps.sort()).toEqual(["A", "B", "C"]);
    expect(report.notFoundMaps).toEqual([]);
  });

  test("a gate the page never sets stays notFound", () => {
    const project = fixtureProject([
      grassMap("A", [actionEvent("door", 2, 2, [
        { op: "switch", id: "gate", value: true },
        { op: "transfer", map: "B", x: 0, y: 0 },
      ])]),
      grassMap("B", [actionEvent("door", 2, 2, [
        { op: "if", if: { kind: "switch", id: "other" }, then: [{ op: "transfer", map: "C", x: 0, y: 0 }] },
      ])]),
      grassMap("C"),
    ]);
    const report = checkReach(project);
    expect(report.reachableMaps.sort()).toEqual(["A", "B"]);
    expect(report.notFoundMaps).toEqual(["C"]);
  });
});

// --- cross-macro key state ------------------------------------------------------
//
// A macro inherits the button state the previous macro ended with: a key still
// held across the boundary must not be re-observed as a fresh pressed edge by
// the search (the replay carries `prev` across the whole tape, so a search
// that resets it records a tape whose edges do not match the replay's).

describe("rpgkit-check reach: cross-macro key state", () => {
  test("a switch set on another map, then a gated door back on the first, is witnessed", () => {
    // A→B (action sets open=true) → back to A → a playerTouch door on A that
    // is only active while `open` holds → C. The witness spans three macros;
    // the second macro ends with a held confirm, and the third must inherit
    // that held state instead of treating its own first press as a new edge.
    const project = fixtureProject([
      grassMap("A", [
        actionEvent("to-b", 1, 0, [{ op: "transfer", map: "B", x: 0, y: 0 }]),
        {
          id: "gate-c",
          x: 0,
          y: 2,
          pages: [{
            condition: { switch: "open" },
            trigger: "playerTouch",
            commands: [{ op: "transfer", map: "C", x: 0, y: 0 }],
          }],
        },
      ]),
      grassMap("B", [actionEvent("return", 1, 0, [
        { op: "switch", id: "open", value: true },
        { op: "transfer", map: "A", x: 0, y: 0 },
      ])]),
      grassMap("C"),
    ]);
    const report = checkReach(project);
    expect(report.reachableMaps.sort()).toEqual(["A", "B", "C"]);
    expect(report.notFoundMaps).toEqual([]);
    // The witness really replays to C from a fresh session.
    const c = reached(report, "C");
    const replay = replayWitness(freshSession(project), project, c.witness);
    expect(replay.state.mapId).toBe("C");
    expect(replay.finalHash).toBe(c.stateHash);
  });
});

// --- choices branching ---------------------------------------------------------

describe("rpgkit-check reach: choices branch per option", () => {
  test("every option's transfer target is reached", () => {
    const project = fixtureProject([
      grassMap("A", [actionEvent("door", 2, 2, [
        { op: "choices", prompt: "?", options: [
          { text: "b", commands: [{ op: "transfer", map: "B", x: 0, y: 0 }] },
          { text: "c", commands: [{ op: "transfer", map: "C", x: 0, y: 0 }] },
        ] },
      ])]),
      grassMap("B"),
      grassMap("C"),
    ]);
    const report = checkReach(project);
    expect(report.reachableMaps.sort()).toEqual(["A", "B", "C"]);
  });

  test("a cancellable choices box also reaches the post-choice map", () => {
    // Option 0 → B; cancel → falls through to C.
    const project = fixtureProject([
      grassMap("A", [actionEvent("door", 2, 2, [
        { op: "choices", prompt: "?", cancel: { commands: [] }, options: [
          { text: "b", commands: [{ op: "transfer", map: "B", x: 0, y: 0 }] },
        ] },
        { op: "transfer", map: "C", x: 0, y: 0 },
      ])]),
      grassMap("B"),
      grassMap("C"),
    ]);
    const report = checkReach(project);
    expect(report.reachableMaps.sort()).toEqual(["A", "B", "C"]);
  });
});

// --- audio state in the dedup key ------------------------------------------------
//
// The dedup key is the engine's canonical state fingerprint, so persistent
// audio intent (which BGM plays) is part of the key: a page gated on
// bgmPlaying must be found after a playBgm, and the pre-/post-music states
// must never merge.

describe("rpgkit-check reach: audio-gated pages", () => {
  const bgmProject = (): Project => ({
    ...fixtureProject([
      grassMap("A", [
        actionEvent("music", 2, 2, [{ op: "playBgm", id: "field" }]),
        actionEvent("door", 1, 0, [
          { op: "transfer", map: "B", x: 0, y: 0 },
        ], { all: [{ kind: "bgmPlaying", id: "field" }] }),
        actionEvent("wrong-door", 0, 2, [
          { op: "transfer", map: "C", x: 0, y: 0 },
        ], { all: [{ kind: "bgmPlaying", id: "battle" }] }),
      ]),
      grassMap("B"),
      grassMap("C"),
    ]),
    audio: { field: "audio:wav.field", battle: "audio:wav.battle" },
  });

  test("a bgmPlaying-gated door is found after the matching playBgm", () => {
    // The search triggers the music event, then observes the door's page
    // active and triggers it. A dedup key that omits persistent audio merges
    // the post-music state into the pre-music root and never sees the door.
    const project = bgmProject();
    const report = checkReach(project);
    // C is intentionally notFound (its door needs a BGM that never plays),
    // so it carries a map-not-found warning; there must be no errors.
    expect(report.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(report.reachableMaps).toContain("B");
    expect(report.notFoundMaps).toContain("C");
    // The witness really replays to B with the recorded state.
    const b = reached(report, "B");
    const replay = replayWitness(freshSession(project), project, b.witness);
    expect(replay.state.mapId).toBe("B");
    expect(replay.finalHash).toBe(b.stateHash);
    // The BGM is really playing in the replayed state.
    expect(replay.state.interp.audio?.bgm?.id).toBe("field");
  });

  test("the pre- and post-music states are distinct search states", () => {
    // The search explores the root (no music) and the post-music node: the
    // music event is triggered from the root, and the door from the node
    // with the BGM playing.
    const project = bgmProject();
    const report = checkReach(project);
    expect(Number(report.summary.statesExplored)).toBeGreaterThanOrEqual(2);
  });
});

// --- witness integrity ----------------------------------------------------------

describe("rpgkit-check reach: witness tampering", () => {
  test("a witness with its tail cut off fails replay verification", () => {
    const project = fixtureProject([grassMap("A", [touchEvent("door", 2, 2, "B")]), grassMap("B")]);
    const report = checkReach(project);
    const b = reached(report, "B");
    const tampered: ReachWitness = { hz: 60, masks: b.witness.masks.slice(0, -10) };
    const verdict = verifyWitness(freshSession(project), project, tampered, "B", b.stateHash);
    expect(verdict.ok).toBe(false);
  });

  test("a witness replayed against the wrong expected hash fails", () => {
    const project = fixtureProject([grassMap("A", [touchEvent("door", 2, 2, "B")]), grassMap("B")]);
    const report = checkReach(project);
    const b = reached(report, "B");
    const verdict = verifyWitness(freshSession(project), project, b.witness, "B", "deadbeef");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("hash");
  });
});

describe("rpgkit-check reach: determinism", () => {
  test("two runs with the same params are byte-identical", () => {
    const project = fixtureProject([
      grassMap("A", [
        touchEvent("door", 2, 2, "B"),
        actionEvent("choice", 4, 4, [
          { op: "choices", prompt: "?", options: [
            { text: "b", commands: [{ op: "transfer", map: "B", x: 0, y: 0 }] },
          ] },
        ]),
      ]),
      grassMap("B"),
    ]);
    const r1 = JSON.stringify(checkReach(project));
    const r2 = JSON.stringify(checkReach(project));
    expect(r2).toBe(r1);
  });
});

// --- budgets ---------------------------------------------------------------------
//
// maxFrames / maxStates / maxSeconds are execution limits, not hints: the
// search checks them inside each macro's ride-out / battle / wait loop and
// parks the macro the moment the budget is spent, so a long macro cannot run
// a full macro past the limit. The block-constant tape makes one block
// (6 ticks) the minimum unit of work, so maxFrames=1 runs one block.

describe("rpgkit-check reach: budgets are execution limits", () => {
  test("maxFrames=1 runs one block of work and ends on the frame budget", () => {
    const project = fixtureProject([
      grassMap("A", [touchEvent("door", 2, 2, "B")]),
      grassMap("B"),
    ]);
    const report = checkReach(project, { maxFrames: 1 });
    expect(report.endedReason).toBe("frame-budget");
    // One block (6 ticks) is the minimum unit of work: the search steps one
    // block, the in-macro check parks it, and no map is falsely reached.
    expect(report.summary.framesRun).toBeGreaterThan(0);
    expect(report.summary.framesRun).toBeLessThanOrEqual(12);
    expect(report.reachableMaps).toEqual(["A"]);
    expect(report.notFoundMaps).toEqual(["B"]);
  });

  test("a tiny maxSeconds parks the macro inside its ride-out, not after a full macro", () => {
    // A's autorun waits 10000 s then transfers B; without an in-macro
    // deadline the ride-out would run the whole wait. With a 1 ms budget it
    // parks inside the first few blocks (the long wait guarantees the
    // search cannot finish before the deadline on any machine).
    const project = fixtureProject([
      grassMap("A", [{
        id: "boot", x: 0, y: 0,
        pages: [{ trigger: "autorun", commands: [
          { op: "wait", seconds: 10000.0 },
          { op: "transfer", map: "B", x: 0, y: 0 },
        ] }],
      }]),
      grassMap("B"),
    ]);
    const report = checkReach(project, { maxSeconds: 0.001 });
    expect(report.endedReason).toBe("time-budget");
    // It parked inside the ride-out, nowhere near the 600000-tick wait.
    expect(report.summary.framesRun).toBeLessThan(6000);
  });

  test("maxStates stops the search after exploring that many states", () => {
    const project = fixtureProject([
      grassMap("A", [touchEvent("door", 2, 2, "B")]),
      grassMap("B"),
    ]);
    const report = checkReach(project, { maxStates: 1 });
    expect(report.endedReason).toBe("state-budget");
    expect(report.summary.statesExplored).toBeLessThanOrEqual(1);
  });

  test("a budget-exhausted search still reports notFound with frontier stats", () => {
    const project = fixtureProject([
      grassMap("A", [touchEvent("door", 2, 2, "B")]),
      grassMap("B"),
    ]);
    const report = checkReach(project, { maxFrames: 1 });
    const b = report.maps.find((m) => m.map === "B");
    expect(b?.status).toBe("notFound");
    // The frontier points at the inbound transfer whose source page never ran.
    expect(b?.status === "notFound" && b.frontier.inbound.length).toBeGreaterThan(0);
  });

  test("a choices fan-out charges its shared prefix once, not once per leaf", () => {
    // A's action event waits 1 s, then opens an 8-option choices box; every
    // option transfers to B0..B7, and B0 has an onward door to C. The walk,
    // the wait, the trigger and the cursor navigation are a SHARED prefix:
    // the old accounting added every leaf's full tape suffix to framesRun,
    // charging the prefix eight times (1266 ticks for a 600-tick budget) and
    // stopping with all eight B nodes still queued, so C was left notFound
    // with real budget left. The macro now reports the ticks it really
    // executed once.
    const options = Array.from({ length: 8 }, (_, i) => ({
      text: `b${i}`,
      commands: [{ op: "transfer" as const, map: `B${i}`, x: 0, y: 0 }],
    }));
    const project = fixtureProject([
      grassMap("A", [actionEvent("fan", 2, 2, [
        { op: "wait", seconds: 1.0 },
        { op: "choices", prompt: "?", options },
      ])]),
      ...Array.from({ length: 8 }, (_, i) =>
        grassMap(`B${i}`, i === 0 ? [actionEvent("onward", 2, 2, [{ op: "transfer", map: "C", x: 0, y: 0 }])] : []),
      ),
      grassMap("C"),
    ]);
    const report = checkReach(project, { maxFrames: 1000 });
    // The fan-out's real spend is well under the budget; the search finishes.
    expect(Number(report.summary.framesRun)).toBeLessThan(1000);
    expect(report.endedReason).toBe("exhausted");
    // C is reached: B0 was explored and its onward door triggered.
    expect(report.reachableMaps).toContain("C");
    expect(report.notFoundMaps).toEqual([]);
    const c = reached(report, "C");
    const replay = replayWitness(freshSession(project), project, c.witness);
    expect(replay.state.mapId).toBe("C");
    expect(replay.finalHash).toBe(c.stateHash);
    // The shared prefix is charged once, not eight times: the whole search
    // spends fewer ticks than eight times the shortest B witness (the old
    // per-leaf accounting charged at least that for the fan-out alone).
    const bFrames = report.maps
      .filter((m) => m.map.startsWith("B") && m.status === "reached")
      .map((m) => (m as Extract<ReachMapResult, { status: "reached" }>).frames);
    expect(Number(report.summary.framesRun)).toBeLessThan(8 * Math.min(...bFrames));
  });

  test("the frame budget is never overshot by more than one block", () => {
    // Every macro parks the moment its real spend reaches the remaining
    // budget (checked before each 6-tick block, between a release block and
    // its edge block, and after each block), so the whole search spends at
    // most one block past maxFrames. The old per-leaf accounting could
    // report hundreds of ticks over the budget.
    const project = fixtureProject([
      grassMap("A", [actionEvent("fan", 2, 2, [
        { op: "wait", seconds: 1.0 },
        { op: "choices", prompt: "?", options: [
          { text: "b0", commands: [{ op: "transfer", map: "B0", x: 0, y: 0 }] },
          { text: "b1", commands: [{ op: "transfer", map: "B1", x: 0, y: 0 }] },
        ] },
      ])]),
      grassMap("B0"),
      grassMap("B1"),
    ]);
    for (const maxFrames of [1, 30, 60, 120, 300]) {
      const report = checkReach(project, { maxFrames });
      expect(Number(report.summary.framesRun)).toBeLessThanOrEqual(maxFrames + 6);
    }
  });

  test("a held edge across macros never overshoots by more than one block", () => {
    // The first macro presses CIRCLE on A's action door and rides the
    // transfer out inside the same block, so the node's end mask still
    // holds CIRCLE. The next macro (B's action door) re-requests CIRCLE:
    // the driver emits a release block before the edge block. The release
    // block's six ticks must count toward the budget BEFORE the park
    // callback is consulted between the two blocks, or one act() runs
    // twelve ticks and the search overshoots by nearly two blocks (the
    // 13..17 budgets below all ran 24 ticks before the fix — 7..11 over).
    const project = {
      ...fixtureProject([
        grassMap("A", [actionEvent("door", 1, 0, [
          { op: "transfer", map: "B", x: 0, y: 0 },
        ])]),
        grassMap("B", [actionEvent("door", 1, 0, [
          { op: "transfer", map: "C", x: 0, y: 0 },
        ])]),
        grassMap("C"),
      ]),
      // Facing the door: the first macro presses CIRCLE and rides the
      // transfer out inside the same block, so the node still holds CIRCLE.
      start: { map: "A", x: 0, y: 0, dir: "right" as const },
    };
    for (const maxFrames of [1, 13, 14, 15, 16, 17, 30, 60, 120, 300]) {
      const report = checkReach(project, { maxFrames });
      expect(Number(report.summary.framesRun)).toBeLessThanOrEqual(maxFrames + 6);
    }
  });
});

// --- driver block boundary ---------------------------------------------------------
//
// A pressed edge whose button is still held from the previous block needs a
// release block first. The budget check runs between the release and the edge
// block, so a macro parks at most one block past the budget even there.

describe("rpgkit-check reach: driver block boundary", () => {
  test("a re-requested held edge parks between its release and edge block", () => {
    const project = fixtureProject([grassMap("A")]);
    const session = freshSession(project);
    const state = startSession(project, session);
    const driver = new Driver(session, state, 0);
    // First block holds DOWN; prevMask is now BTN_DOWN.
    expect(driver.act({ hold: BTN_DOWN })).toHaveLength(6);
    // Re-requesting DOWN while held emits a release block first. A park that
    // trips after the release block keeps the edge block from running.
    let parked = false;
    const ticks = driver.act({ hold: 0, down: true }, () => {
      parked = true;
      return true;
    });
    expect(ticks).toHaveLength(6); // release block only
    expect(parked).toBe(true);
  });
});

// --- witness tape format ---------------------------------------------------------
//
// A witness records masks in constant 6-tick blocks, with every pressed edge
// on a block boundary. The tool verifies witnesses at 60 Hz only and makes
// no claim about other host frame rates.

describe("rpgkit-check reach: witness tape format", () => {
  test("a witness is recorded in constant 6-tick blocks with edges on block boundaries", () => {
    const project = fixtureProject([
      grassMap("A", [touchEvent("door", 2, 2, "B")]),
      grassMap("B"),
    ]);
    const report = checkReach(project);
    const b = reached(report, "B");
    const masks = b.witness.masks;
    expect(masks.length % 6).toBe(0);
    for (let i = 0; i < masks.length; i += 6) {
      for (let j = i + 1; j < i + 6; j++) expect(masks[j]).toBe(masks[i]);
    }
    // Every pressed edge lands on a block boundary (tick 0 of a block):
    // no block introduces a bit the previous block did not already hold,
    // except at a block start.
    let prev = 0;
    for (let i = 0; i < masks.length; i += 6) {
      const m = masks[i]!;
      const pressed = (m & ~prev) >>> 0;
      if (i % 6 !== 0) expect(pressed).toBe(0);
      prev = m;
    }
    // The witness is a 60 Hz tape.
    expect(b.witness.hz).toBe(60);
  });
});

// --- battle policy ---------------------------------------------------------------

describe("rpgkit-check reach: battles", () => {
  const winRules: BattleRules = {
    start: () => ({ state: { t: 0 }, ext: null }),
    step: (state: { t: number }) => ({ t: state.t + 1 }),
    done: (state: { t: number }) =>
      state.t >= 30 ? { ext: null, result: "win", switches: { won: true } } : null,
  };

  test("under the default policy encounters are declined and onWin never runs", () => {
    const project = fixtureProject([
      grassMap("A", [actionEvent("boss", 2, 2, [
        { op: "battle", setup: null, onWin: [{ op: "transfer", map: "B", x: 0, y: 0 }] },
      ])]),
      grassMap("B"),
    ]);
    const report = checkReach(project);
    expect(report.battlePolicy).toBe("encounters-declined");
    expect(report.notFoundMaps).toContain("B");
  });

  test("registered rules fight the battle for real and follow onWin", () => {
    const project = fixtureProject([
      grassMap("A", [actionEvent("boss", 2, 2, [
        { op: "battle", setup: null, onWin: [{ op: "transfer", map: "B", x: 0, y: 0 }] },
      ])]),
      grassMap("B"),
    ]);
    const report = checkReach(project, { battle: { rules: winRules } });
    expect(report.battlePolicy).toBe("registered-rules");
    expect(report.reachableMaps).toContain("B");
    // The witness replays the battle identically.
    const b = reached(report, "B");
    const replay = replayWitness(createSession(project, 60, { ...checkSessionOptions(project), battle: winRules }), project, b.witness);
    expect(replay.state.mapId).toBe("B");
  });
});

// --- structural checks ------------------------------------------------------------

describe("rpgkit-check reach: structural transfer checks", () => {
  test("a transfer to a missing map is an error", () => {
    const project = fixtureProject([grassMap("A", [touchEvent("door", 2, 2, "GONE")])]);
    const report = checkReach(project);
    const f = report.findings.find((x) => x.check === "reach/transfer-target-missing");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("error");
    expect(f!.loc.event).toBe("door");
  });

  test("a transfer landing on a void tile is a warning", () => {
    const b: MapDef = { ...grassMap("B"), ground: [...grassMap("B").ground] };
    b.ground[0] = null as never;
    const project = fixtureProject([grassMap("A", [touchEvent("door", 2, 2, "B")]), b]);
    const report = checkReach(project);
    const f = report.findings.find((x) => x.check === "reach/transfer-landing-blocked");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("warning");
  });

  test("a map no literal transfer names is an orphan info", () => {
    const project = fixtureProject([grassMap("A", [touchEvent("door", 2, 2, "B")]), grassMap("B"), grassMap("C")]);
    const report = checkReach(project);
    const orphans = report.findings.filter((x) => x.check === "reach/map-orphan").map((x) => x.loc.map);
    expect(orphans).toEqual(["C"]);
  });

  test("a dynamic-target transfer is listed as info", () => {
    const project = fixtureProject([
      grassMap("A", [actionEvent("door", 2, 2, [
        { op: "switch", id: "dest", value: true },
        { op: "transfer", map: { variable: "destMap" }, x: 0, y: 0 },
      ])]),
    ]);
    const report = checkReach(project);
    const f = report.findings.find((x) => x.check === "reach/dynamic-transfer");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("info");
  });
});

// --- report shape ------------------------------------------------------------------

describe("rpgkit-check reach: report shape", () => {
  test("the report is not marked experimental and lists its assumptions", () => {
    const project = fixtureProject([grassMap("A"), grassMap("B")]);
    const report = checkReach(project);
    expect((report as unknown as Record<string, unknown>).experimental).toBeUndefined();
    expect(report.assumptions.length).toBeGreaterThan(0);
    expect(report.assumptions.join("\n")).toContain("lead, not a proof");
  });

  test("budgets are reported", () => {
    const project = fixtureProject([grassMap("A"), grassMap("B")]);
    const report = checkReach(project, { maxFrames: 100, maxStates: 5, maxSeconds: 10 });
    expect(report.budgets).toEqual({ maxFrames: 100, maxStates: 5, maxSeconds: 10 });
  });
});

// --- example documents ---------------------------------------------------------------

describe("rpgkit-check reach: example documents", () => {
  for (const path of [
    "examples/sunstone/data/sunstone.json",
    "examples/meadow/data/meadow.json",
  ]) {
    // The sunstone search takes a few seconds; the default 5s timeout is too
    // tight under full-suite load.
    test(`${path} runs and every reached map's witness replays`, () => {
      const loaded = loadProjectFile(path);
      expect(loaded.project).not.toBeNull();
      const report = checkReach(loaded.project!);
      // Every reached map's witness replays to that map in a fresh session.
      for (const m of report.maps) {
        if (m.status !== "reached") continue;
        const replay = replayWitness(freshSession(loaded.project!), loaded.project!, m.witness);
        expect(replay.state.mapId).toBe(m.map);
        expect(replay.finalHash).toBe(m.stateHash);
        // The witness is a 60 Hz tape in constant 6-tick blocks.
        expect(m.witness.hz).toBe(60);
        expect(m.witness.masks.length % 6).toBe(0);
      }
      // The search explores more than one state on a real project.
      expect(Number(report.summary.statesExplored)).toBeGreaterThan(1);
    }, 60_000);
  }
});
