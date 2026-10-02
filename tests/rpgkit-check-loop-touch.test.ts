// tests/rpgkit-check-loop-touch.test.ts — rpgkit-check on projects using
// `loop`/`break`, the `eventTouch` trigger, and `{v:<id>}` text tokens:
// loop bodies are walked by every check, a break outside any loop is noted,
// text tokens count as variable reads only when system.textVariables is on,
// and the dynamic drivers (explore, reach) trigger eventTouch pages — a
// blocking one by walking into its body, a non-blocking one on entry.

import { describe, expect, test } from "bun:test";
import { lintProject } from "../tools/rpgkit-check/src/lint.ts";
import { walkCommands, type CommandPath } from "../tools/rpgkit-check/src/walk.ts";
import { checkExplore } from "../tools/rpgkit-check/src/dynamic/explore.ts";
import { checkReach } from "../tools/rpgkit-check/src/dynamic/reach.ts";
import { checkLocks } from "../tools/rpgkit-check/src/dynamic/locks.ts";
import { checkFreeze } from "../tools/rpgkit-check/src/dynamic/freeze.ts";
import type { Finding } from "../tools/rpgkit-check/src/finding.ts";
import type { Command, GameEvent, MapDef, Page, Project } from "../src/engine/types.ts";

function grassMap(id: string, events: GameEvent[] = [], size = 6): MapDef {
  return {
    id,
    name: id,
    width: size,
    height: size,
    sheets: ["grass"],
    ground: new Array<string>(size * size).fill("grass.0"),
    events,
  };
}

function project(events: GameEvent[], extra: Partial<Project> = {}): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Loop/touch fixture",
    tileSize: 16,
    start: { map: "m1", x: 1, y: 1, dir: "down" },
    sheets: [{ id: "grass", cols: 1, rows: 1 }],
    items: [],
    sprites: { npc: { kind: "image", src: "npc.png" } },
    maps: [grassMap("m1", events)],
    ...extra,
  };
}

function pageEvent(id: string, x: number, y: number, page: Page): GameEvent {
  return { id, x, y, pages: [page] };
}

function action(commands: Command[]): GameEvent {
  return pageEvent("ev", 4, 4, { trigger: "action", commands });
}

function of(findings: readonly Finding[], check: string): Finding[] {
  return findings.filter((f) => f.check === check);
}

// --- static walking ------------------------------------------------------------

describe("rpgkit-check: loop bodies are walked", () => {
  test("walkCommands descends into a loop body under the commands tag", () => {
    const seen: CommandPath[] = [];
    walkCommands([
      { op: "loop", commands: [{ op: "wait", seconds: 1 }, { op: "if", if: { kind: "switch", id: "s" }, then: [{ op: "break" }] }] },
    ], (_c, path) => seen.push(path));
    expect(seen).toEqual([[0], [0, "commands", 0], [0, "commands", 1], [0, "commands", 1, "then", 0]]);
  });

  test("a transfer to an unknown map inside a loop body is reported", () => {
    const report = lintProject(project([action([
      { op: "loop", commands: [{ op: "transfer", map: "nowhere", x: 0, y: 0 }, { op: "break" }] },
    ])]));
    const found = of(report.findings, "lint/transfer-target-missing");
    expect(found).toHaveLength(1);
    expect(found[0]!.loc.commandPath).toEqual([0, "commands", 0]);
  });

  test("a variable read inside a loop body counts as a read", () => {
    const report = lintProject(project([action([
      { op: "variable", id: "n", set: { op: "set", value: 0 } },
      {
        op: "loop",
        commands: [
          { op: "variable", id: "n", set: { op: "add", value: 1 } },
          { op: "if", if: { kind: "variable", id: "n", op: ">=", value: 3 }, then: [{ op: "break" }] },
        ],
      },
    ])]));
    expect(of(report.findings, "lint/variable-set-never-read")).toEqual([]);
    expect(of(report.findings, "lint/break-outside-loop")).toEqual([]);
  });

  test("a literal transfer only inside a loop still makes its map reachable", () => {
    const p = project([action([{ op: "loop", commands: [{ op: "transfer", map: "m2", x: 0, y: 0 }, { op: "break" }] }])]);
    p.maps.push(grassMap("m2"));
    const report = lintProject(p);
    expect(of(report.findings, "lint/map-unreachable")).toEqual([]);
  });
});

describe("rpgkit-check: break outside a loop", () => {
  test("a page-level break is an info note, a break nested in a loop is not", () => {
    const report = lintProject(project([action([
      { op: "if", if: { kind: "switch", id: "s" }, then: [{ op: "break" }] },
      { op: "loop", commands: [{ op: "choices", prompt: "go?", options: [{ text: "stop", commands: [{ op: "break" }] }] }] },
      { op: "switch", id: "s", value: true },
    ])]));
    const found = of(report.findings, "lint/break-outside-loop");
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("info");
    expect(found[0]!.loc.commandPath).toEqual([0, "then", 0]);
  });

  test("a break in a common event called from a loop does not cross the call", () => {
    const report = lintProject(project(
      [action([{ op: "loop", commands: [{ op: "common", id: "c" }, { op: "break" }] }])],
      { commonEvents: [{ id: "c", trigger: "none", commands: [{ op: "break" }] }] },
    ));
    const found = of(report.findings, "lint/break-outside-loop");
    expect(found).toHaveLength(1);
    expect(found[0]!.loc.common).toBe("c");
  });
});

// --- {v:<id>} text tokens -------------------------------------------------------

describe("rpgkit-check: {v:id} text tokens", () => {
  const commands: Command[] = [
    { op: "variable", id: "coins", set: { op: "set", value: 3 } },
    { op: "variable", id: "lives", set: { op: "set", value: 1 } },
    { op: "variable", id: "keys", set: { op: "set", value: 2 } },
    { op: "text", lines: ["You hold {v:coins} coins."] },
    { op: "choices", prompt: "Lives: {v:lives}", options: [{ text: "Keys {v:keys}", commands: [{ op: "text", lines: ["{v:ghost}"] }] }] },
  ];

  test("with textVariables on, each token is a variable read", () => {
    const report = lintProject(project([action(commands)], { system: { textVariables: true } }));
    expect(of(report.findings, "lint/variable-set-never-read")).toEqual([]);
    expect(of(report.findings, "lint/text-variable-token-off")).toEqual([]);
    const unset = of(report.findings, "lint/variable-read-never-set");
    expect(unset.map((f) => f.message)).toEqual([expect.stringContaining("\"ghost\"")]);
  });

  test("an extChoice prompt token is a read too", () => {
    const report = lintProject(project([action([
      { op: "variable", id: "hp", set: { op: "set", value: 9 } },
      { op: "extChoice", call: "x.pick", args: null, prompt: "HP {v:hp}" },
    ])], { system: { textVariables: true } }));
    expect(of(report.findings, "lint/variable-set-never-read")).toEqual([]);
  });

  test("with textVariables off, a token is a warning and not a read", () => {
    const report = lintProject(project([action(commands)]));
    const off = of(report.findings, "lint/text-variable-token-off");
    expect(off.map((f) => f.severity)).toEqual(["warning", "warning", "warning"]);
    expect(off.map((f) => f.loc.commandPath)).toEqual([[3], [4], [4, "options", 0, 0]]);
    expect(of(report.findings, "lint/variable-set-never-read")).toHaveLength(3);
    expect(of(report.findings, "lint/variable-read-never-set")).toEqual([]);
  });
});

// --- eventTouch triggers (runtime eventTouch support required) ------------------

describe("rpgkit-check: eventTouch pages are triggered by the drivers", () => {
  const blockingNpc = pageEvent("npc", 4, 4, {
    trigger: "eventTouch",
    sprite: "npc",
    blocks: true,
    commands: [{ op: "text", lines: ["ouch"] }],
  });
  const touchTile = pageEvent("tile", 3, 1, {
    trigger: "eventTouch",
    commands: [{ op: "text", lines: ["tile"] }],
  });

  // A small budget: the explorer must TARGET the page (path + bump/entry
  // takes well under 120 frames); its fallback random walk only stumbles
  // into these cells after ~150 frames.
  test("explore bumps a blocking eventTouch NPC", () => {
    const report = checkExplore(project([blockingNpc]), { frames: 120 });
    expect(report.summary.errors).toBe(0);
    expect(report.endedReason).toBe("complete");
    expect(report.neverTriggered).toEqual([]);
    expect(report.events[0]!.triggers).toBeGreaterThan(0);
  });

  test("explore steps onto a non-blocking eventTouch tile", () => {
    const report = checkExplore(project([touchTile]), { frames: 120 });
    expect(report.summary.errors).toBe(0);
    expect(report.endedReason).toBe("complete");
    expect(report.neverTriggered).toEqual([]);
    expect(report.events[0]!.triggers).toBeGreaterThan(0);
  });

  test("reach follows a transfer behind a blocking eventTouch body", () => {
    const door = pageEvent("door", 3, 3, {
      trigger: "eventTouch",
      sprite: "npc",
      blocks: true,
      commands: [{ op: "transfer", map: "m2", x: 0, y: 0 }],
    });
    const p = project([door]);
    p.maps.push(grassMap("m2"));
    const report = checkReach(p);
    expect(report.reachableMaps).toEqual(["m1", "m2"]);
    expect(report.notFoundMaps).toEqual([]);
  });

  test("reach follows a transfer on a non-blocking eventTouch tile", () => {
    const door = pageEvent("door", 3, 3, {
      trigger: "eventTouch",
      commands: [{ op: "transfer", map: "m2", x: 0, y: 0 }],
    });
    const p = project([door]);
    p.maps.push(grassMap("m2"));
    const report = checkReach(p);
    expect(report.reachableMaps).toEqual(["m1", "m2"]);
  });
});

// --- loops under the dynamic checks (runtime loop/break support required) -------

describe("rpgkit-check: loops in locks and freeze", () => {
  test("a lock released later in the same loop pass is proven unlocked", () => {
    const report = checkLocks(project([action([
      {
        op: "loop",
        commands: [
          { op: "lockInput" },
          { op: "text", lines: ["busy"] },
          { op: "unlockInput" },
          { op: "break" },
        ],
      },
    ])]), { frames: 600 });
    expect(report.rows.map((r) => r.outcome)).toEqual(["unlocked"]);
    expect(report.findings).toEqual([]);
  });

  test("a lock taken before an endless loop is never released", () => {
    const report = checkLocks(project([action([
      { op: "lockInput" },
      { op: "loop", commands: [{ op: "wait", seconds: 0.1 }] },
      { op: "unlockInput" },
    ])]), { frames: 600 });
    expect(report.rows.map((r) => r.outcome)).toEqual(["unresolved"]);
    const finding = of(report.findings, "locks/permanent-lock")[0]!;
    // The unlock after the break-less loop is unreachable: no static hint.
    expect(finding.suggestion).toContain("no local or causally linked automatic-event release path");
  });

  test("a wait-less break-less autorun loop is a blocking fiber, not an error", () => {
    const report = checkFreeze(project([
      pageEvent("spin", 0, 0, { trigger: "autorun", commands: [{ op: "loop", commands: [{ op: "variable", id: "x", set: { op: "set", value: 1 } }] }] }),
    ]), { windowFrames: 300 });
    expect(report.findings.map((f) => f.check)).toEqual(["freeze/blocking-fiber"]);
  });

  test("a parallel polling loop is not flagged", () => {
    const report = checkFreeze(project([
      pageEvent("poll", 0, 0, {
        trigger: "parallel",
        commands: [{
          op: "loop",
          commands: [
            { op: "wait", seconds: 0.1 },
            { op: "if", if: { kind: "switch", id: "done" }, then: [{ op: "break" }] },
          ],
        }],
      }),
    ]), { windowFrames: 300 });
    expect(report.findings).toEqual([]);
  });
});
