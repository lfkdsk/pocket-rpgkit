// tests/rpgkit-check-dynamic-freeze.test.ts — the freeze scan must stay
// silent on a clean map, flag a permanent input lock and a permanently
// blocking fiber on fixtures broken exactly that way, and stay silent on
// the shipped example documents.

import { describe, expect, test } from "bun:test";
import { checkFreeze } from "../tools/rpgkit-check/src/dynamic/freeze.ts";
import { loadProjectFile } from "../tools/rpgkit-check/src/doc.ts";
import type { Project } from "../src/engine/types.ts";

function fixture(events: NonNullable<Project["maps"][number]["events"]>): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Freeze fixture",
    tileSize: 16,
    start: { map: "m1", x: 2, y: 2, dir: "down" },
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
        events,
      },
    ],
  };
}

/** A small window keeps the tests fast; the scan still runs twice the
 *  window per map. */
const WINDOW = 300;

describe("rpgkit-check freeze: clean fixture", () => {
  test("one action text event flags nothing", () => {
    const project = fixture([
      {
        id: "sign",
        x: 0,
        y: 0,
        pages: [{ trigger: "action", commands: [{ op: "text", lines: ["hi"] }] }],
      },
    ]);
    const report = checkFreeze(project, { windowFrames: WINDOW });
    expect(report.rows).toEqual([]);
    expect(report.findings).toEqual([]);
    expect(report.summary.flagged).toBe(0);
  });
});

describe("rpgkit-check freeze: permanent input lock", () => {
  test("autorun lockInput without unlock flags the map", () => {
    // The page runs on entry, locks input, shows a line the driver
    // auto-confirms, then restarts (autorun) — the lock is never released.
    const project = fixture([
      {
        id: "locker",
        x: 0,
        y: 0,
        pages: [
          {
            trigger: "autorun",
            commands: [{ op: "lockInput" }, { op: "text", lines: ["locked"] }],
          },
        ],
      },
    ]);
    const report = checkFreeze(project, { windowFrames: WINDOW });
    expect(report.rows).toHaveLength(1);
    const row = report.rows[0]!;
    expect(row.map).toBe("m1");
    expect(row.inputLocked).toBe(true);
    // One finding per flagged row; the lock is the most specific condition,
    // so it names the check even though the row is also busy the whole time.
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.check).toBe("freeze/permanent-lock");
    expect(report.findings[0]!.severity).toBe("error");
    expect(report.findings[0]!.loc.map).toBe("m1");
    expect(report.summary.permanentLocks).toBe(1);
    expect(report.summary.flagged).toBe(1);
  });
});

describe("rpgkit-check freeze: permanent blocking fiber", () => {
  test("autorun choices with no options and no cancel flags the map", () => {
    // An autorun page that only shows a text line does NOT block forever:
    // the driver auto-confirms the box, the fiber finishes, and in the
    // one-frame restart gap the held d-pad moves the player, so world
    // progress never stalls for a whole window. A choices modal with no
    // options and no cancel branch, on the other hand, can never be
    // dismissed — confirm picks nothing and cancel is inert — so the modal
    // stays open forever: busy every frame, no world progress.
    const project = fixture([
      {
        id: "stuck",
        x: 0,
        y: 0,
        pages: [
          {
            trigger: "autorun",
            commands: [{ op: "choices", prompt: "?", options: [] }],
          },
        ],
      },
    ]);
    const report = checkFreeze(project, { windowFrames: WINDOW });
    expect(report.rows).toHaveLength(1);
    const row = report.rows[0]!;
    expect(row.map).toBe("m1");
    expect(row.blocking).toBe(true);
    expect(row.inputLocked).toBe(false);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.check).toBe("freeze/blocking-fiber");
    expect(report.findings[0]!.severity).toBe("error");
    expect(report.findings[0]!.loc.map).toBe("m1");
    expect(report.summary.permanentBlockingFibers).toBe(1);
    expect(report.summary.flagged).toBe(1);
  });
});

describe("rpgkit-check freeze: example documents", () => {
  for (const path of [
    "examples/sunstone/data/sunstone.json",
    "examples/meadow/data/meadow.json",
    "examples/grow/data/grow-settlement.json",
  ]) {
    test(`${path} has no permanent locks or blocking fibers`, () => {
      const loaded = loadProjectFile(path);
      expect(loaded.project).not.toBeNull();
      const report = checkFreeze(loaded.project!, { windowFrames: 600 });
      if (report.rows.length > 0) {
        console.log(`${path} freeze rows:`, JSON.stringify(report.rows, null, 2));
      }
      expect(report.rows).toEqual([]);
      expect(report.findings).toEqual([]);
    });
  }
});

describe("rpgkit-check freeze: common events", () => {
  test("a transfer landing inside a common event is the scan start", () => {
    // m2's only inbound landing lives inside a common event called from
    // m1. The scan must start there, not at m2's centre.
    const base = fixture([
      {
        id: "door",
        x: 0,
        y: 0,
        pages: [{ trigger: "action", commands: [{ op: "common", id: "toM2" }] }],
      },
    ]);
    const project: Project = {
      ...base,
      maps: [
        ...base.maps,
        {
          id: "m2",
          name: "M2",
          width: 5,
          height: 5,
          sheets: ["grass"],
          ground: new Array<string>(25).fill("grass.0"),
          events: [
            {
              id: "auto",
              x: 4,
              y: 4,
              pages: [{ trigger: "autorun", commands: [{ op: "lockInput" }] }],
            },
          ],
        },
      ],
      commonEvents: [
        { trigger: "none", id: "toM2", commands: [{ op: "transfer", map: "m2", x: 1, y: 2 }] },
      ],
    };
    const report = checkFreeze(project, { windowFrames: WINDOW });
    const m2 = report.rows.find((r) => r.map === "m2");
    expect(m2).toBeDefined();
    expect(m2!.start).toEqual([1, 2]);
  });
});

// A recursive common event makes the real interpreter hit its runaway
// guard: the scan must report the interpreter error, not crash.
describe("rpgkit-check freeze: recursive common events", () => {
  test("self-recursive common from an autorun page reports interpreter-error", () => {
    const project = fixture([
      {
        id: "runaway",
        x: 0,
        y: 0,
        pages: [{ trigger: "autorun", commands: [{ op: "common", id: "loop" }] }],
      },
    ]);
    project.commonEvents = [{
      trigger: "none",
      id: "loop",
      commands: [{ op: "common", id: "loop" }],
    }];
    const report = checkFreeze(project, { windowFrames: WINDOW });
    expect(report.summary.errors).toBe(1);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.check).toBe("freeze/interpreter-error");
    expect(report.findings[0]!.message).toContain("stack depth");
  });
});
