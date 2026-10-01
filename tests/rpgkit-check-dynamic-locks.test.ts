// tests/rpgkit-check-dynamic-locks.test.ts — the permanent input-lock check
// must prove a lock released on the real engine (unlock or transfer), flag
// a lock that is never released, and stay silent on the example documents.

import { describe, expect, test } from "bun:test";
import { checkLocks, type LockReport } from "../tools/rpgkit-check/src/dynamic/locks.ts";
import { makeCheckSession, startFresh, stepAuto } from "../tools/rpgkit-check/src/dynamic/sim.ts";
import { loadProjectFile } from "../tools/rpgkit-check/src/doc.ts";
import type { Command, Project } from "../src/engine/types.ts";

function baseProject(commands: Command[], extraMaps: Project["maps"] = []): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Locks",
    tileSize: 16,
    start: { map: "m1", x: 1, y: 1, dir: "down" },
    sheets: [{ id: "grass", cols: 1, rows: 1 }],
    items: [],
    sprites: {},
    maps: [
      {
        id: "m1",
        name: "M1",
        width: 5,
        height: 5,
        sheets: ["grass"],
        ground: new Array<string>(25).fill("grass.0"),
        events: [
          { id: "ev1", x: 2, y: 2, pages: [{ trigger: "action", commands }] },
        ],
      },
      ...extraMaps,
    ],
  };
}

function map2(): Project["maps"][number] {
  return {
    id: "m2",
    name: "M2",
    width: 5,
    height: 5,
    sheets: ["grass"],
    ground: new Array<string>(25).fill("grass.0"),
  };
}

// Small frame budgets keep the fixture tests fast; the lock either releases
// within a few frames or never will.
const FAST = { frames: 600 };

describe("rpgkit-check locks: lock released on the same page", () => {
  test("lockInput → text → unlockInput proves unlocked, no findings", () => {
    const report = checkLocks(baseProject([
      { op: "lockInput" },
      { op: "text", lines: ["hello"] },
      { op: "unlockInput" },
    ]), FAST);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.outcome).toBe("unlocked");
    expect(report.rows[0]!.lockedAt).toBeGreaterThanOrEqual(0);
    expect(report.rows[0]!.resolvedAt).toBeGreaterThanOrEqual(0);
    expect(report.findings).toEqual([]);
    expect(report.summary.pages).toBe(1);
    expect(report.summary.lockCommands).toBe(1);
    expect(report.summary.dynamicChecks).toBe(1);
    expect(report.summary.unlocked).toBe(1);
  });

  test("audio leaves stay intact while instrumenting a released lock", () => {
    const project = baseProject([
      { op: "playBgm", id: "field" },
      { op: "saveBgm" },
      { op: "lockInput" },
      { op: "playBgs", id: "rain" },
      { op: "playMe", id: "fanfare", duration: 0.1 },
      { op: "playSe", id: "door" },
      { op: "pauseBgm" },
      { op: "resumeBgm" },
      { op: "fadeoutBgm", duration: 0.1 },
      { op: "fadeoutBgs", duration: 0.1 },
      { op: "stopBgm" },
      { op: "replayBgm" },
      { op: "unlockInput" },
    ]);
    project.audio = {
      field: "audio:wav.field",
      rain: "audio:wav.rain",
      fanfare: "audio:wav.fanfare",
      door: "audio:wav.door",
    };
    const report = checkLocks(project, FAST);
    expect(report.rows[0]!.outcome).toBe("unlocked");
    expect(report.findings).toEqual([]);
  });
});

describe("rpgkit-check locks: lock never released", () => {
  test("lockInput → text with no unlock is unresolved with one error finding", () => {
    const report = checkLocks(baseProject([
      { op: "lockInput" },
      { op: "text", lines: ["stuck"] },
    ]), FAST);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.outcome).toBe("unresolved");
    expect(report.rows[0]!.lockedAt).toBeGreaterThanOrEqual(0);
    expect(report.rows[0]!.error).toBeDefined();
    expect(report.findings).toHaveLength(1);
    const finding = report.findings[0]!;
    expect(finding.check).toBe("locks/permanent-lock");
    expect(finding.severity).toBe("error");
    expect(finding.loc).toEqual({ map: "m1", event: "ev1", page: 0 });
    expect(report.summary.unresolved).toBe(1);
  });
});

describe("rpgkit-check locks: lock released by a transfer", () => {
  test("lockInput → transfer to another map proves transferred", () => {
    const report = checkLocks(baseProject(
      [
        { op: "lockInput" },
        { op: "text", lines: ["away"] },
        { op: "transfer", map: "m2", x: 0, y: 0 },
      ],
      [map2()],
    ), FAST);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.outcome).toBe("transferred");
    expect(report.findings).toEqual([]);
    expect(report.summary.transferred).toBe(1);
  });
});

describe("rpgkit-check locks: static local-resolution hint", () => {
  test("linear lock → wait → unlock page carries no error", () => {
    const report = checkLocks(baseProject([
      { op: "lockInput" },
      { op: "wait", seconds: 0.1 },
      { op: "text", lines: ["linear"] },
      { op: "unlockInput" },
    ]), FAST);
    expect(report.rows).toHaveLength(1);
    const row = report.rows[0]!;
    expect(row.outcome).toBe("unlocked");
    expect(row.error).toBeUndefined();
    expect(report.findings).toEqual([]);
  });
});

describe("rpgkit-check locks: lock inside a battle branch", () => {
  test("lockInput only in battle.onWin with an unlock there is checked and unlocked", () => {
    const report = checkLocks(baseProject([
      {
        op: "battle",
        setup: {},
        onWin: [
          { op: "lockInput" },
          { op: "text", lines: ["victory"] },
          { op: "unlockInput" },
        ],
      },
    ]), FAST);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.outcome).toBe("unlocked");
    expect(report.rows[0]!.lockedAt).toBeGreaterThanOrEqual(0);
    expect(report.rows[0]!.resolvedAt).toBeGreaterThanOrEqual(0);
    expect(report.findings).toEqual([]);
    expect(report.summary.pages).toBe(1);
    expect(report.summary.lockCommands).toBe(1);
    expect(report.summary.dynamicChecks).toBe(1);
    expect(report.summary.unlocked).toBe(1);
  });

  test("lockInput in onWin is not resolved by an unlock only in onLose", () => {
    const report = checkLocks(baseProject([
      {
        op: "battle",
        setup: {},
        onWin: [
          { op: "lockInput" },
          { op: "text", lines: ["won but stuck"] },
        ],
        onLose: [
          { op: "unlockInput" },
        ],
      },
    ]), FAST);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.outcome).toBe("unresolved");
    expect(report.rows[0]!.lockedAt).toBeGreaterThanOrEqual(0);
    expect(report.findings).toHaveLength(1);
    const finding = report.findings[0]!;
    expect(finding.check).toBe("locks/permanent-lock");
    expect(finding.severity).toBe("error");
    expect(finding.loc).toEqual({ map: "m1", event: "ev1", page: 0 });
    expect(report.summary.unresolved).toBe(1);
  });

  test("lockInput in onWin with no release anywhere fires permanent-lock", () => {
    const report = checkLocks(baseProject([
      {
        op: "battle",
        setup: {},
        onWin: [
          { op: "lockInput" },
          { op: "text", lines: ["trapped"] },
        ],
      },
    ]), FAST);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.outcome).toBe("unresolved");
    expect(report.rows[0]!.lockedAt).toBeGreaterThanOrEqual(0);
    expect(report.findings).toHaveLength(1);
    const finding = report.findings[0]!;
    expect(finding.check).toBe("locks/permanent-lock");
    expect(finding.severity).toBe("error");
    expect(finding.loc).toEqual({ map: "m1", event: "ev1", page: 0 });
    expect(report.summary.unresolved).toBe(1);
  });
});

describe("rpgkit-check locks: example documents", () => {
  for (const path of [
    "examples/sunstone/data/sunstone.json",
    "examples/meadow/data/meadow.json",
    "examples/grow/data/grow-settlement.json",
  ]) {
    test(`${path} has no permanent-lock findings`, () => {
      const loaded = loadProjectFile(path);
      expect(loaded.project).not.toBeNull();
      const report: LockReport = checkLocks(loaded.project!);
      const errors = report.findings.filter((f) => f.severity === "error");
      if (errors.length > 0) {
        console.log(`${path} lock rows:`, JSON.stringify(report.rows, null, 2));
      }
      expect(errors).toEqual([]);
    });
  }
});

describe("rpgkit-check locks: common events", () => {
  test("a permanent lock inside a called common event is found and flagged", () => {
    const project: Project = {
      ...baseProject([{ op: "common", id: "lockForever" }]),
      commonEvents: [{ trigger: "none", id: "lockForever", commands: [{ op: "lockInput" }] }],
    };
    const report = checkLocks(project, FAST);
    expect(report.summary.lockCommands).toBe(1);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.outcome).toBe("unresolved");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.check).toBe("locks/permanent-lock");
  });

  test("an unlock inside a called common event resolves the lock", () => {
    const project: Project = {
      ...baseProject([
        { op: "lockInput" },
        { op: "text", lines: ["hi"] },
        { op: "common", id: "release" },
      ]),
      commonEvents: [{ trigger: "none", id: "release", commands: [{ op: "unlockInput" }] }],
    };
    const report = checkLocks(project, FAST);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.outcome).toBe("unlocked");
    expect(report.findings).toEqual([]);
  });

  test("static hint sees an unlock nested in a common event behind a guard", () => {
    // The isolated run cannot release the lock (the guard is false in the
    // isolated bank), so the finding's hint must come from the static
    // local-resolution analysis, which inlines the common program.
    const project: Project = {
      ...baseProject([
        { op: "lockInput" },
        {
          op: "if",
          if: { kind: "switch", id: "later", value: true },
          then: [{ op: "common", id: "release" }],
        },
      ]),
      commonEvents: [{ trigger: "none", id: "release", commands: [{ op: "unlockInput" }] }],
    };
    const report = checkLocks(project, FAST);
    expect(report.rows[0]!.outcome).toBe("unresolved");
    expect(report.findings[0]!.suggestion).toContain("unlockInput on the same page");
  });
});

// A self-/mutually-recursive common event makes the REAL interpreter hit its
// MAX_FIBER_STACK_DEPTH runaway guard (a controlled interpreter error, not a
// crash). The instrumentation must keep the cycle instead of re-expanding it
// at build time (which would overflow the JS stack): the isolated run then
// reports the engine's runaway as the lock outcome, exactly as the engine
// would report it for the real project.
describe("rpgkit-check locks: recursive common events report the engine runaway", () => {
  test("self-recursive common holding the lock: runaway outcome, no throw", () => {
    const project: Project = {
      ...baseProject([{ op: "common", id: "loop" }]),
      commonEvents: [{
        trigger: "none",
        id: "loop",
        commands: [{ op: "lockInput" }, { op: "common", id: "loop" }],
      }],
    };
    const report = checkLocks(project, FAST);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.outcome).toBe("error");
    expect(report.rows[0]!.error).toContain("stack depth");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.check).toBe("locks/permanent-lock");
  });

  test("self-recursive common called after the page's own lock: runaway outcome", () => {
    const project: Project = {
      ...baseProject([{ op: "lockInput" }, { op: "common", id: "spin" }]),
      commonEvents: [{ trigger: "none", id: "spin", commands: [{ op: "common", id: "spin" }] }],
    };
    const report = checkLocks(project, FAST);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.outcome).toBe("error");
    expect(report.rows[0]!.error).toContain("stack depth");
    expect(report.rows[0]!.lockedAt).toBeGreaterThanOrEqual(0);
  });

  test("mutually recursive commons holding the lock: runaway outcome", () => {
    const project: Project = {
      ...baseProject([{ op: "common", id: "ping" }]),
      commonEvents: [
        { trigger: "none", id: "ping", commands: [{ op: "lockInput" }, { op: "common", id: "pong" }] },
        { trigger: "none", id: "pong", commands: [{ op: "common", id: "ping" }] },
      ],
    };
    const report = checkLocks(project, FAST);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.outcome).toBe("error");
    expect(report.rows[0]!.error).toContain("stack depth");
  });

  test("the real engine runaways on the same recursive project", () => {
    // Cross-check: the checker's "error" outcome must match the engine's own
    // runaway verdict, not a checker-specific approximation. The page is
    // autorun so the real session executes the recursive common on entry.
    const base = baseProject([]);
    const project: Project = {
      ...base,
      maps: base.maps.map((m) => m.id === "m1"
        ? {
          ...m,
          events: [
            { id: "ev1", x: 2, y: 2, pages: [{ trigger: "autorun", commands: [{ op: "common", id: "loop" }] }] },
          ],
        }
        : m),
      commonEvents: [{
        trigger: "none",
        id: "loop",
        commands: [{ op: "lockInput" }, { op: "common", id: "loop" }],
      }],
    };
    const session = makeCheckSession(project);
    let state = startFresh(project, session);
    for (let frame = 0; frame < 600; frame++) {
      state = stepAuto(session, state, frame);
      if (state.interp.error) break;
    }
    expect(state.interp.error?.kind).toBe("runaway");
    expect(state.interp.error?.message).toContain("stack depth");
  });
});
