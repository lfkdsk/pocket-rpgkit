// tests/rpgkit-check-explore.test.ts — the headless explorer walks to every
// reachable action/playerTouch event and triggers it. Coverage on the
// example documents must be complete (or honestly reported).

import { describe, expect, test } from "bun:test";
import { checkExplore } from "../tools/rpgkit-check/src/dynamic/explore.ts";
import type { Project } from "../src/engine/types.ts";

function grassProject(events: Project["maps"][number]["events"]): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Explore Fixture",
    tileSize: 16,
    start: { map: "m1", x: 1, y: 1, dir: "down" },
    sheets: [{ id: "grass", cols: 1, rows: 1 }],
    items: [],
    maps: [
      {
        id: "m1",
        name: "M1",
        width: 6,
        height: 6,
        sheets: ["grass"],
        ground: new Array<string>(36).fill("grass.0"),
        events,
      },
    ],
  };
}

describe("rpgkit-check explore", () => {
  test("walks to an action event and triggers it", () => {
    const project = grassProject([
      {
        id: "sign",
        x: 4,
        y: 4,
        pages: [{ trigger: "action", commands: [{ op: "text", lines: ["hi"] }] }],
      },
    ]);
    const report = checkExplore(project, { frames: 600 });
    expect(report.endedReason).toBe("complete");
    expect(report.events).toHaveLength(1);
    expect(report.events[0]!.triggers).toBeGreaterThan(0);
    expect(report.neverTriggered).toEqual([]);
    expect(report.summary.errors).toBe(0);
  });

  test("walks onto a playerTouch event and triggers it", () => {
    const project = grassProject([
      {
        id: "plate",
        x: 3,
        y: 3,
        pages: [{ trigger: "playerTouch", commands: [{ op: "text", lines: ["plate"] }] }],
      },
    ]);
    const report = checkExplore(project, { frames: 600 });
    expect(report.endedReason).toBe("complete");
    expect(report.events[0]!.triggers).toBeGreaterThan(0);
  });

  test("transfers to a second map and triggers events there", () => {
    const project = grassProject([
      {
        id: "gate",
        x: 1,
        y: 4,
        pages: [
          {
            trigger: "playerTouch",
            commands: [{ op: "transfer", map: "m2", x: 1, y: 1, dir: "down" }],
          },
        ],
      },
    ]);
    project.maps.push({
      id: "m2",
      name: "M2",
      width: 6,
      height: 6,
      sheets: ["grass"],
      ground: new Array<string>(36).fill("grass.0"),
      events: [
        {
          id: "m2-sign",
          x: 4,
          y: 4,
          pages: [{ trigger: "action", commands: [{ op: "text", lines: ["m2"] }] }],
        },
      ],
    });
    const report = checkExplore(project, { frames: 1200 });
    expect(report.mapsVisited).toContain("m2");
    expect(report.events.find((e) => e.event === "gate")!.triggers).toBeGreaterThan(0);
    expect(report.events.find((e) => e.event === "m2-sign")!.triggers).toBeGreaterThan(0);
    expect(report.neverTriggered).toEqual([]);
  });

  test("a story-gated event (switch never set) is reported no-active-page", () => {
    const project = grassProject([
      {
        id: "gated",
        x: 4,
        y: 4,
        pages: [
          {
            trigger: "action",
            condition: { switch: "story-flag" },
            commands: [{ op: "text", lines: ["secret"] }],
          },
        ],
      },
    ]);
    const report = checkExplore(project, { frames: 600 });
    expect(report.neverTriggered).toHaveLength(1);
    expect(report.neverTriggered[0]!.reason).toBe("no-active-page");
    // The run still completes: the gated event is accounted for.
    expect(report.endedReason).toBe("complete");
  });

  test("auto-picks choices option 0", () => {
    const project = grassProject([
      {
        id: "chooser",
        x: 4,
        y: 4,
        pages: [
          {
            trigger: "action",
            commands: [
              {
                op: "choices",
                prompt: "pick",
                options: [
                  { text: "a", commands: [{ op: "switch", id: "picked-a", value: true }] },
                  { text: "b", commands: [] },
                ],
              },
            ],
          },
        ],
      },
    ]);
    const report = checkExplore(project, { frames: 600 });
    expect(report.summary.autoChoices).toBeGreaterThan(0);
    expect(report.events[0]!.triggers).toBeGreaterThan(0);
  });

  test("an instant action event (single switch command) triggers once", () => {
    // The fiber starts and ends inside one tick; a post-step residual-fiber
    // scan cannot see it. The onFiberStart trace counts it.
    const project = grassProject([
      {
        id: "instant",
        x: 4,
        y: 4,
        pages: [{ trigger: "action", commands: [{ op: "switch", id: "did-run", value: true }] }],
      },
    ]);
    const report = checkExplore(project, { frames: 600 });
    expect(report.endedReason).toBe("complete");
    expect(report.events).toHaveLength(1);
    expect(report.events[0]!.triggers).toBe(1);
    expect(report.events[0]!.pages).toEqual([1]);
    expect(report.neverTriggered).toEqual([]);
  });

  test("a playerTouch crossed twice counts both triggers", () => {
    // The explorer enters the 2-wide plate on the way to the goal, then
    // crosses its second cell while pathing there — two entries, two starts.
    const project = grassProject([
      {
        id: "plate",
        x: 2,
        y: 1,
        w: 2,
        pages: [{ trigger: "playerTouch", commands: [{ op: "switch", id: "crossed", value: true }] }],
      },
      {
        id: "goal",
        x: 5,
        y: 1,
        pages: [{ trigger: "action", commands: [{ op: "text", lines: ["goal"] }] }],
      },
    ]);
    const report = checkExplore(project, { frames: 600 });
    expect(report.endedReason).toBe("complete");
    const plate = report.events.find((e) => e.event === "plate")!;
    expect(plate.triggers).toBe(2);
    expect(report.neverTriggered).toEqual([]);
  });

  test("finds a page gated on a runtime tileProperty condition", () => {
    // An autorun sets a tileProperty override on entry; the engine then
    // activates the portal page whose tileProperty condition holds. The
    // planner must see that page (not report no-active-page) and trigger it.
    const project = grassProject([
      {
        id: "opener",
        x: 1,
        y: 3,
        pages: [
          {
            trigger: "autorun",
            commands: [
              { op: "tileProperty", x: 2, y: 2, passage: "block" },
              { op: "switch", id: "opened", value: true },
            ],
          },
          { trigger: "autorun", condition: { switch: "opened" }, commands: [] },
        ],
      },
      {
        id: "portal",
        x: 4,
        y: 4,
        pages: [
          {
            trigger: "action",
            condition: { all: [{ kind: "tileProperty", x: 2, y: 2, passage: "block" }] },
            commands: [{ op: "text", lines: ["portal"] }],
          },
        ],
      },
    ]);
    const report = checkExplore(project, { frames: 600 });
    expect(report.endedReason).toBe("complete");
    const portal = report.events.find((e) => e.event === "portal")!;
    expect(portal.triggers).toBeGreaterThan(0);
    expect(report.neverTriggered).toEqual([]);
  });

  test("an empty action page is attempted-no-fiber, not triggered", () => {
    // The explorer reaches the tile and confirms, but the engine starts no
    // fiber for a page with no commands — the hook never fires, so the
    // event is honestly reported as attempted-only.
    const project = grassProject([
      {
        id: "hollow",
        x: 4,
        y: 4,
        pages: [{ trigger: "action", commands: [] }],
      },
    ]);
    const report = checkExplore(project, { frames: 200, stuckFrames: 60 });
    const hollow = report.events.find((e) => e.event === "hollow")!;
    expect(hollow.triggers).toBe(0);
    expect(hollow.attemptedOnly).toBe(true);
    expect(report.neverTriggered).toHaveLength(1);
    expect(report.neverTriggered[0]!.reason).toBe("attempted-no-fiber");
  });

  test("covers every page of a multi-page action event", () => {
    // Page 0 sets a switch; page 1 is gated on that switch and shows text.
    // Coverage is per PAGE: both pages must start a fiber before the run
    // may report complete.
    const project = grassProject([
      {
        id: "e",
        x: 4,
        y: 4,
        pages: [
          { trigger: "action", commands: [{ op: "switch", id: "done", value: true }] },
          {
            trigger: "action",
            condition: { switch: "done" },
            commands: [{ op: "text", lines: ["page 1"] }],
          },
        ],
      },
    ]);
    const report = checkExplore(project, { frames: 600 });
    expect(report.endedReason).toBe("complete");
    const stat = report.events.find((e) => e.event === "e")!;
    expect(stat.pages[0]).toBeGreaterThanOrEqual(1);
    expect(stat.pages[1]).toBeGreaterThanOrEqual(1);
    expect(report.neverTriggered).toEqual([]);
  });

  test("waits out a delayed autorun before judging complete", () => {
    // An autorun waits 0.1s then sets `ready`; an action event gated on
    // `ready` becomes active only after the autorun's fiber ends. The
    // explorer must not declare complete while the autorun could still
    // flip the page condition. The autorun runs once (it flips self
    // switch A, whose spent page is empty and starts no fiber), so the
    // main fiber is free once it has run.
    const project = grassProject([
      {
        id: "boot",
        x: 1,
        y: 3,
        pages: [
          {
            trigger: "autorun",
            commands: [
              { op: "wait", seconds: 0.1 },
              { op: "switch", id: "ready", value: true },
              { op: "selfSwitch", key: "A", value: true },
            ],
          },
          {
            trigger: "autorun",
            condition: { selfSwitch: "A" },
            commands: [],
          },
        ],
      },
      {
        id: "gated",
        x: 4,
        y: 4,
        pages: [
          {
            trigger: "action",
            condition: { switch: "ready" },
            commands: [{ op: "text", lines: ["gated"] }],
          },
        ],
      },
    ]);
    const report = checkExplore(project, { frames: 600 });
    expect(report.endedReason).toBe("complete");
    const gated = report.events.find((e) => e.event === "gated")!;
    expect(gated.pages[0]).toBeGreaterThanOrEqual(1);
    expect(report.neverTriggered).toEqual([]);
  });

  test("a page whose condition never holds is reported no-active-page per page", () => {
    // A single page gated on a switch that is never set: it never fires and
    // was never observed active, so it is honestly reported at page level.
    const project = grassProject([
      {
        id: "gated",
        x: 4,
        y: 4,
        pages: [
          {
            trigger: "action",
            condition: { all: [{ kind: "switch", id: "never", value: true }] },
            commands: [{ op: "text", lines: ["secret"] }],
          },
        ],
      },
    ]);
    const report = checkExplore(project, { frames: 600 });
    expect(report.neverTriggered).toHaveLength(1);
    expect(report.neverTriggered[0]!.page).toBe(0);
    expect(report.neverTriggered[0]!.reason).toBe("no-active-page");
    expect(report.endedReason).toBe("complete");
  });
});

describe("rpgkit-check explore: audio-conditioned pages", () => {
  test("uses live BGM state when selecting an action page", () => {
    const project = grassProject([
      {
        id: "boot",
        x: 0,
        y: 0,
        pages: [
          {
            trigger: "autorun",
            commands: [
              { op: "playBgm", id: "field" },
              { op: "selfSwitch", key: "A", value: true },
            ],
          },
          { trigger: "autorun", condition: { selfSwitch: "A" }, commands: [] },
        ],
      },
      {
        id: "listener",
        x: 4,
        y: 4,
        pages: [{
          trigger: "action",
          condition: { all: [{ kind: "bgmPlaying", id: "field" }] },
          commands: [{ op: "text", lines: ["I hear it"] }],
        }],
      },
    ]);
    project.audio = { field: "audio:wav.field" };

    const report = checkExplore(project, { frames: 600 });
    expect(report.endedReason).toBe("complete");
    expect(report.events.find((event) => event.event === "listener")!.pages[0]).toBeGreaterThan(0);
    expect(report.neverTriggered).toEqual([]);
  });

  test("waits for an ME to release BGM before declaring completion", () => {
    const project = grassProject([
      {
        id: "boot",
        x: 0,
        y: 0,
        pages: [
          {
            trigger: "autorun",
            commands: [
              { op: "playBgm", id: "field" },
              { op: "playMe", id: "fanfare", duration: 1 },
              { op: "selfSwitch", key: "A", value: true },
            ],
          },
          { trigger: "autorun", condition: { selfSwitch: "A" }, commands: [] },
        ],
      },
      {
        id: "listener",
        x: 4,
        y: 4,
        pages: [{
          trigger: "action",
          condition: { all: [{ kind: "bgmPlaying", id: "field" }] },
          commands: [{ op: "text", lines: ["The fanfare ended"] }],
        }],
      },
    ]);
    project.audio = {
      field: "audio:wav.field",
      fanfare: "audio:wav.fanfare",
    };

    const report = checkExplore(project, { frames: 600 });
    expect(report.framesRun).toBeGreaterThan(60);
    expect(report.events.find((event) => event.event === "listener")!.pages[0]).toBeGreaterThan(0);
    expect(report.neverTriggered).toEqual([]);
  });

  test("does not treat a delayed parallel BGM change as benign ambience", () => {
    const project = grassProject([
      {
        id: "delayed-music",
        x: 0,
        y: 0,
        pages: [{
          trigger: "parallel",
          commands: [
            { op: "wait", seconds: 0.75 },
            { op: "playBgm", id: "field" },
          ],
        }],
      },
      {
        id: "listener",
        x: 4,
        y: 4,
        pages: [{
          trigger: "action",
          condition: { all: [{ kind: "bgmPlaying", id: "field" }] },
          commands: [{ op: "text", lines: ["Delayed music"] }],
        }],
      },
    ]);
    project.audio = { field: "audio:wav.field" };

    const report = checkExplore(project, { frames: 600, stuckFrames: 240 });
    expect(report.framesRun).toBeGreaterThan(45);
    expect(report.events.find((event) => event.event === "listener")!.pages[0]).toBeGreaterThan(0);
  });
});

describe("rpgkit-check explore: example documents", () => {
  for (const [path, maps] of [
    ["examples/sunstone/data/sunstone.json", 3],
    ["examples/meadow/data/meadow.json", 1],
    ["examples/grow/data/grow-settlement.json", 1],
  ] as const) {
    test(`${path} explores to completion`, async () => {
      const project = (await Bun.file(path).json()) as Project;
      const report = checkExplore(project, { frames: 6000 });
      expect(report.mapsVisited.length).toBe(maps);
      expect(report.neverTriggered).toEqual([]);
      expect(report.summary.errors).toBe(0);
      expect(report.endedReason).toBe("complete");
    });
  }
});

// A parallel can switch a page on for a few frames and off again. plan()
// only samples active pages at planning time (~every 120 frames), so the old
// code could miss the window entirely, still report `complete`, and write
// the page off as `no-active-page` — the opposite of the per-frame truth.
// Per-frame sampling now observes the brief page and counts it toward
// coverage.
describe("rpgkit-check explore: parallel page switches count toward coverage", () => {
  test("a looping parallel's brief page is observed, targeted and fired", () => {
    // The driver parallel flips `phase` to 1 for half a second, back to 0,
    // then parks itself on an empty follow-up page (selfSwitch A) so the
    // world can go idle. The blink event's high-priority page 1 is gated on
    // phase==1: the explorer must observe it while active, walk over, and
    // fire it — not write it off as never active.
    const project = grassProject([
      {
        id: "driver",
        x: 0,
        y: 0,
        pages: [
          {
            trigger: "parallel",
            commands: [
              { op: "wait", seconds: 0.1 },
              { op: "variable", id: "phase", set: { op: "set", value: 1 } },
              { op: "wait", seconds: 2.0 },
              { op: "variable", id: "phase", set: { op: "set", value: 0 } },
              { op: "selfSwitch", key: "A", value: true },
            ],
          },
          { trigger: "parallel", condition: { selfSwitch: "A" }, commands: [] },
        ],
      },
      {
        id: "blink",
        x: 4,
        y: 4,
        pages: [
          { trigger: "action", commands: [{ op: "text", lines: ["default"] }] },
          {
            trigger: "action",
            condition: { variable: { id: "phase", op: "==", value: 1 } },
            commands: [{ op: "text", lines: ["blink"] }],
          },
        ],
      },
    ]);
    const report = checkExplore(project, { frames: 1200, stuckFrames: 240 });
    expect(report.endedReason).toBe("complete");
    const blink = report.events.find((e) => e.event === "blink")!;
    expect(blink.pages[0]).toBeGreaterThan(0);
    expect(blink.pages[1]).toBeGreaterThan(0);
    expect(report.neverTriggered).toEqual([]);
  });

  test("a one-shot brief page that can no longer fire is reported honestly, not as complete", () => {
    // The driver flips `phase` to 1 for ~3 frames early on, then to 2 and
    // parks. The blink event's page 1 (gated on phase==1) is active only
    // during that early window, before the explorer can reach it. The
    // per-frame sample still OBSERVES it active, so the run must not claim
    // `complete` and must not dismiss the page as `no-active-page`.
    const project = grassProject([
      {
        id: "driver",
        x: 0,
        y: 0,
        pages: [
          {
            trigger: "parallel",
            commands: [
              { op: "wait", seconds: 0.05 },
              { op: "variable", id: "phase", set: { op: "set", value: 1 } },
              { op: "wait", seconds: 0.05 },
              { op: "variable", id: "phase", set: { op: "set", value: 2 } },
              { op: "selfSwitch", key: "A", value: true },
            ],
          },
          { trigger: "parallel", condition: { selfSwitch: "A" }, commands: [] },
        ],
      },
      {
        id: "blink",
        x: 4,
        y: 4,
        pages: [
          { trigger: "action", commands: [{ op: "text", lines: ["default"] }] },
          {
            trigger: "action",
            condition: { variable: { id: "phase", op: "==", value: 1 } },
            commands: [{ op: "text", lines: ["blink"] }],
          },
        ],
      },
    ]);
    const report = checkExplore(project, { frames: 1200, stuckFrames: 240 });
    expect(report.endedReason).not.toBe("complete");
    const missed = report.neverTriggered.find((n) => n.event === "blink" && n.page === 1);
    expect(missed).toBeDefined();
    // The page WAS observed active (per-frame sampling): it must not be
    // dismissed with "its condition never held".
    expect(missed!.reason).not.toBe("no-active-page");
    // The finding wording scopes the claim to the observation window.
    const finding = report.findings.find((f) => f.check === "explore/never-triggered");
    expect(finding?.message).toContain("observation window");
  });
});

describe("rpgkit-check explore: common events", () => {
  test("a playerTouch exit hidden in a common event is routed around, then used", () => {
    // The plate at (3,1) transfers to m2 (no return) through a common
    // event; the sign at (5,1) sits past it on the same row, so the
    // shortest path crosses the plate. The explorer must classify the
    // common-transfer tile as an exit (route around it), exercise the
    // sign first, then walk onto the plate to reach m2.
    const project: Project = {
      format: "rpgkit-project/v1",
      title: "Explore common exit",
      tileSize: 16,
      start: { map: "m1", x: 1, y: 1, dir: "down" },
      sheets: [{ id: "grass", cols: 1, rows: 1 }],
      items: [],
      sprites: {},
      maps: [
        {
          id: "m1",
          name: "M1",
          width: 6,
          height: 6,
          sheets: ["grass"],
          ground: new Array<string>(36).fill("grass.0"),
          events: [
            {
              id: "plate",
              x: 3,
              y: 1,
              pages: [{ trigger: "playerTouch", commands: [{ op: "common", id: "toM2" }] }],
            },
            {
              id: "sign",
              x: 5,
              y: 1,
              pages: [{ trigger: "action", commands: [{ op: "text", lines: ["sign"] }] }],
            },
          ],
        },
        {
          id: "m2",
          name: "M2",
          width: 5,
          height: 5,
          sheets: ["grass"],
          ground: new Array<string>(25).fill("grass.0"),
        },
      ],
      commonEvents: [
        { trigger: "none", id: "toM2", commands: [{ op: "transfer", map: "m2", x: 0, y: 0 }] },
      ],
    };
    const report = checkExplore(project, { frames: 1200, stuckFrames: 240 });
    expect(report.mapsVisited).toContain("m2");
    const sign = report.events.find((e) => e.event === "sign");
    expect(sign!.triggers).toBeGreaterThan(0);
    expect(report.endedReason).toBe("complete");
  });
});

// A recursive common event makes the real interpreter hit its runaway
// guard: the explorer must surface the interpreter error, not crash.
describe("rpgkit-check explore: recursive common events", () => {
  test("self-recursive common from an autorun page ends with explore/error", () => {
    const project = grassProject([
      {
        id: "runaway",
        x: 4,
        y: 4,
        pages: [{ trigger: "autorun", commands: [{ op: "common", id: "loop" }] }],
      },
    ]);
    project.commonEvents = [{
      trigger: "none",
      id: "loop",
      commands: [{ op: "common", id: "loop" }],
    }];
    const report = checkExplore(project, { frames: 600 });
    expect(report.endedReason).toBe("error");
    expect(report.summary.errors).toBe(1);
    expect(report.findings.some((f) => f.check === "explore/error" && f.message.includes("stack depth"))).toBe(true);
  });
});

describe("rpgkit-check explore: scene commands", () => {
  test("a scene command previews through noop rules and its onDone branch runs", () => {
    const project = grassProject([
      {
        id: "scene-ev",
        x: 1,
        y: 1,
        pages: [
          {
            trigger: "autorun",
            commands: [
              {
                op: "scene",
                id: "game.journal",
                args: {},
                onDone: [{ op: "switch", id: "scene-done", value: true }],
              },
            ],
          },
          {
            condition: { switch: "scene-done" },
            trigger: "parallel",
            commands: [{ op: "text", lines: ["after scene"] }],
          },
        ],
      },
    ]);
    const report = checkExplore(project, { frames: 600 });
    // The noop scene rules keep the session alive (no unregistered-scene
    // crash) and the onDone switch flip activates the second page.
    expect(report.summary.errors).toBe(0);
    const stat = report.events.find((e) => e.event === "scene-ev");
    expect(stat).toBeDefined();
    expect(stat!.pages[1] ?? 0).toBeGreaterThan(0);
  });
});
