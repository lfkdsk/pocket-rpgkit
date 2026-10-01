// tests/rpgkit-check-dynamic-reach.test.ts — the state-based reach check
// must prove reachability from a real session state: transfers bind to live
// trigger rects, blocking event bodies stamp the passage table, and maps no
// edge reaches are reported once each.

import { describe, expect, test } from "bun:test";
import { checkReach, type ReachReport } from "../tools/rpgkit-check/src/dynamic/reach.ts";
import { loadProjectFile } from "../tools/rpgkit-check/src/doc.ts";
import { makeCheckSession, startFresh } from "../tools/rpgkit-check/src/dynamic/sim.ts";
import { stepSession } from "../src/engine/session.ts";
import { BTN_BITS } from "../src/engine/camera.ts";
import type { GameEvent, MapDef, Project } from "../src/engine/types.ts";

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
    pages: [
      { trigger: "playerTouch", commands: [{ op: "transfer", map: target, x: 0, y: 0 }] },
    ],
  };
}

function actionEvent(id: string, x: number, y: number, target: string): GameEvent {
  return {
    id,
    x,
    y,
    pages: [
      { trigger: "action", commands: [{ op: "transfer", map: target, x: 0, y: 0 }] },
    ],
  };
}

function blockEvent(id: string, x: number, y: number): GameEvent {
  return {
    id,
    x,
    y,
    pages: [{ trigger: "action", sprite: "wall", blocks: true, commands: [] }],
  };
}

describe("rpgkit-check reach: connected maps", () => {
  test("playerTouch transfer reaches the target map", () => {
    const project = fixtureProject([
      grassMap("A", [touchEvent("door", 2, 2, "B")]),
      grassMap("B"),
    ]);
    const report = checkReach(project);
    expect(report.findings).toEqual([]);
    expect(report.reachableMaps).toEqual(["A", "B"]);
    expect(report.unreachableMaps).toEqual([]);
    expect(report.reachableTilesByMap["A"]).toBe(25);
    expect(report.reachableTilesByMap["B"]).toBe(25);
  });
});

describe("rpgkit-check reach: disconnected map", () => {
  test("map no transfer targets is one warning", () => {
    const project = fixtureProject([
      grassMap("A", [touchEvent("door", 2, 2, "B")]),
      grassMap("B"),
      grassMap("C"),
    ]);
    const report = checkReach(project);
    expect(report.reachableMaps).toEqual(["A", "B"]);
    expect(report.unreachableMaps).toEqual(["C"]);
    expect(report.findings).toHaveLength(1);
    const finding = report.findings[0]!;
    expect(finding.check).toBe("reach/map-unreachable");
    expect(finding.severity).toBe("warning");
    expect(finding.loc.map).toBe("C");
  });
});

describe("rpgkit-check reach: blocking event bodies", () => {
  test("a wall of blocks:true events hides the tiles behind it", () => {
    // A vertical wall at column 2 splits the 5x5 map: only columns 0-1
    // (10 tiles) are reachable from the start at (0,0).
    const project = fixtureProject([
      grassMap("A", [0, 1, 2, 3, 4].map((y) => blockEvent(`wall${y}`, 2, y))),
    ]);
    const report = checkReach(project);
    expect(report.findings).toEqual([]);
    expect(report.reachableMaps).toEqual(["A"]);
    expect(report.reachableTilesByMap["A"]).toBe(10);
  });
});

describe("rpgkit-check reach: action transfers", () => {
  test("action edge (rect plus neighbours) reaches the target map", () => {
    const project = fixtureProject([
      grassMap("A", [actionEvent("portal", 2, 2, "B")]),
      grassMap("B"),
    ]);
    const report = checkReach(project);
    expect(report.findings).toEqual([]);
    expect(report.reachableMaps).toEqual(["A", "B"]);
    expect(report.reachableTilesByMap["B"]).toBe(25);
  });
});

describe("rpgkit-check reach: start", () => {
  test("start tile occupied by a blocking body is an error", () => {
    const project = fixtureProject([grassMap("A", [blockEvent("guard", 0, 0)])]);
    const report = checkReach(project);
    const errors = report.findings.filter((f) => f.severity === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.check).toBe("reach/start-unreachable");
    expect(errors[0]!.loc.map).toBe("A");
  });
});

describe("rpgkit-check reach: guard-aware transfer edges", () => {
  test("a transfer behind a never-true if guard creates no edge", () => {
    // The only way to B is a transfer inside `if (switch "never")`, and
    // "never" is never set anywhere: the guard provably fails, so no edge
    // exists and B is unreachable. (Before the fix the transfer was collected
    // unconditionally and B was falsely reachable.)
    const guardedDoor: GameEvent = {
      id: "door",
      x: 2,
      y: 2,
      pages: [
        {
          trigger: "playerTouch",
          commands: [
            {
              op: "if",
              if: { kind: "switch", id: "never" },
              then: [{ op: "transfer", map: "B", x: 0, y: 0 }],
            },
          ],
        },
      ],
    };
    const project = fixtureProject([grassMap("A", [guardedDoor]), grassMap("B")]);
    const report = checkReach(project);
    expect(report.reachableMaps).toEqual(["A"]);
    expect(report.unreachableMaps).toEqual(["B"]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.check).toBe("reach/map-unreachable");
    expect(report.findings[0]!.loc.map).toBe("B");
  });

  test("a transfer behind a held if guard does create an edge", () => {
    // The same shape, but the start bank sets "never" (here named "open"):
    // the guard holds and the edge exists.
    const guardedDoor: GameEvent = {
      id: "door",
      x: 2,
      y: 2,
      pages: [
        {
          trigger: "playerTouch",
          commands: [
            {
              op: "if",
              if: { kind: "switch", id: "open" },
              then: [{ op: "transfer", map: "B", x: 0, y: 0 }],
            },
          ],
        },
      ],
    };
    const project = fixtureProject([grassMap("A", [guardedDoor]), grassMap("B")]);
    const report = checkReach(project, {
      start: { map: "A", x: 0, y: 0, switches: { open: true } },
    });
    expect(report.reachableMaps).toEqual(["A", "B"]);
    expect(report.unreachableMaps).toEqual([]);
    expect(report.findings).toEqual([]);
  });
});

describe("rpgkit-check reach: story state through forced transfers", () => {
  test("an autorun that sets a switch and transfers propagates it to the target", () => {
    // A's autorun sets `gate` and transfers to B; B's gate-gated autorun
    // transfers to C. The arrival bank from A must make B's gate page active,
    // so C is reachable. (Before the fix every map dry-ran from the same
    // frozen snapshot and C was falsely unreachable.)
    const project = fixtureProject([
      grassMap("A", [
        {
          id: "boot",
          x: 0,
          y: 0,
          pages: [
            {
              trigger: "autorun",
              commands: [
                { op: "switch", id: "gate", value: true },
                { op: "transfer", map: "B", x: 0, y: 0 },
              ],
            },
          ],
        },
      ]),
      grassMap("B", [
        {
          id: "gateDoor",
          x: 2,
          y: 2,
          pages: [
            {
              condition: { switch: "gate" },
              trigger: "autorun",
              commands: [{ op: "transfer", map: "C", x: 0, y: 0 }],
            },
          ],
        },
      ]),
      grassMap("C"),
    ]);
    const report = checkReach(project);
    expect(report.reachableMaps).toEqual(["A", "B", "C"]);
    expect(report.unreachableMaps).toEqual([]);
    expect(report.findings).toEqual([]);

    // Real engine smoke: the same project driven through stepSession really
    // reaches C with gate set.
    const session = makeCheckSession(project);
    let state = startFresh(project, session);
    for (let i = 0; i < 30; i++) {
      state = stepSession(session, state, {
        buttons: 0,
        confirmEdge: false,
        cancelEdge: false,
        upEdge: false,
        downEdge: false,
      });
      if (state.mapId === "C") break;
    }
    expect(state.mapId).toBe("C");
    expect(state.sw.switches["gate"]).toBe(true);
  });

  test("a guarded target and an unconditional target in one page are classified separately", () => {
    // One autorun page transfers to B unconditionally and to C only behind a
    // never-true guard. B is a forced edge; C is not.
    const project = fixtureProject([
      grassMap("A", [
        {
          id: "boot",
          x: 0,
          y: 0,
          pages: [
            {
              trigger: "autorun",
              commands: [
                { op: "transfer", map: "B", x: 0, y: 0 },
                {
                  op: "if",
                  if: { kind: "switch", id: "never" },
                  then: [{ op: "transfer", map: "C", x: 0, y: 0 }],
                },
              ],
            },
          ],
        },
      ]),
      grassMap("B"),
      grassMap("C"),
    ]);
    const report = checkReach(project);
    expect(report.reachableMaps).toEqual(["A", "B"]);
    expect(report.unreachableMaps).toEqual(["C"]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.loc.map).toBe("C");
  });
});

describe("rpgkit-check reach: runtime tileProperty passage (KV1)", () => {
  test("a parallel tileProperty wall blocks the cells beyond it", () => {
    // A parallel create page blocks column 2 for the visit. The 5x5 map is
    // split: only columns 0-1 (10 tiles) are reachable from the start, and
    // the door at (4,0) beyond the wall cannot be reached, so B is
    // unreachable. (Before the fix the check rebuilt the authored passage
    // table and ignored the runtime override, so all 25 tiles and B were
    // falsely reachable.)
    const wall: GameEvent = {
      id: "wall",
      x: 0,
      y: 0,
      pages: [
        {
          trigger: "parallel",
          commands: [0, 1, 2, 3, 4].map((y) => ({
            op: "tileProperty" as const,
            x: 2,
            y,
            passage: "block" as const,
          })),
        },
      ],
    };
    const project = fixtureProject([
      grassMap("A", [wall, touchEvent("door", 4, 0, "B")]),
      grassMap("B"),
    ]);
    const report = checkReach(project);
    expect(report.reachableMaps).toEqual(["A"]);
    expect(report.unreachableMaps).toEqual(["B"]);
    expect(report.reachableTilesByMap["A"]).toBe(10);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.loc.map).toBe("B");
  });
});

describe("rpgkit-check reach: options.start", () => {
  test("reachability is computed from the requested start map", () => {
    // The project start is A, but the caller asks to start on B. A's door
    // leads to D and B's door leads to C: from B only B and C are reachable.
    const project = fixtureProject([
      grassMap("A", [touchEvent("aDoor", 2, 2, "D")]),
      grassMap("B", [touchEvent("bDoor", 2, 2, "C")]),
      grassMap("C"),
      grassMap("D"),
    ]);
    const report = checkReach(project, { start: { map: "B", x: 0, y: 0 } });
    expect(report.start).toBe("B@0,0");
    expect(report.reachableMaps).toEqual(["B", "C"]);
    expect(report.unreachableMaps).toEqual(["A", "D"]);
  });
});

describe("rpgkit-check reach: report honesty", () => {
  test("the report is marked experimental and lists its assumptions", () => {
    const project = fixtureProject([grassMap("A"), grassMap("B")]);
    const report = checkReach(project);
    // Reach is experimental: verdicts are leads, not proofs.
    expect(report.experimental).toBe(true);
    expect(report.assumptions.length).toBeGreaterThan(0);
    expect(report.assumptions).toContain(
      "story variables are frozen except for state propagated through forced entry transfers",
    );
    // The known imprecisions are disclosed, not hidden.
    const joined = report.assumptions.join("\n");
    expect(joined).toContain("non-zero item/gold baseline");
    expect(joined).toContain("fixed 10-tick window");
    expect(joined).toContain("recursive common events");
    expect(joined).toContain("battle outcomes");
    const unreachable = report.findings.find((f) => f.check === "reach/map-unreachable")!;
    expect(unreachable.message).toContain("under the frozen-story-state assumptions");
    expect(unreachable.message).toContain("lead, not a proof");
    expect(unreachable.message.toLowerCase()).not.toContain("proved");
    expect(unreachable.suggestion).not.toContain("refuse");
  });

  test("the start-unreachable suggestion does not claim the engine refuses the start", () => {
    const project = fixtureProject([grassMap("A", [blockEvent("guard", 0, 0)])]);
    const report = checkReach(project);
    const error = report.findings.find((f) => f.check === "reach/start-unreachable")!;
    expect(error.suggestion).toBe("the start tile is not standable; move the start to a standable tile");
  });
});

describe("rpgkit-check reach: example documents", () => {
  // Maps the frozen walk cannot reach because an action/playerTouch page the
  // walk does not run must set story state first (an item, a self switch).
  // These are honest under-assumptions verdicts, not proofs: the old "no
  // findings" result for sunstone came from collecting the thorn-gate's
  // item-guarded transfer unconditionally (the B3 false-positive).
  const expectedUnreachable: Record<string, string[]> = {
    "examples/sunstone/data/sunstone.json": ["cave"],
  };
  for (const path of [
    "examples/sunstone/data/sunstone.json",
    "examples/meadow/data/meadow.json",
    "examples/grow/data/grow-settlement.json",
  ]) {
    test(`${path} has no unexpected unreachable maps`, () => {
      const loaded = loadProjectFile(path);
      expect(loaded.project).not.toBeNull();
      expect(loaded.shell).toBe(false);
      const report: ReachReport = checkReach(loaded.project!);
      const unreachable = report.findings
        .filter((f) => f.check === "reach/map-unreachable")
        .map((f) => f.loc.map);
      expect(unreachable.sort()).toEqual([...(expectedUnreachable[path] ?? [])].sort());
    });
  }
});

describe("rpgkit-check reach: common events", () => {
  test("a transfer nested two common calls deep is an edge", () => {
    const project = fixtureProject([
      grassMap("A", [actionEvent("portal", 2, 2, "B")]),
      grassMap("B"),
    ]);
    project.commonEvents = [
      { trigger: "none", id: "go", commands: [{ op: "common", id: "go2" }] },
      { trigger: "none", id: "go2", commands: [{ op: "transfer", map: "B", x: 0, y: 0 }] },
    ];
    // The action page calls the common chain instead of transferring directly.
    project.maps[0]!.events![0]!.pages[0]!.commands = [{ op: "common", id: "go" }];
    const report = checkReach(project);
    expect(report.reachableMaps).toEqual(["A", "B"]);
    expect(report.unreachableMaps).toEqual([]);
  });
});

describe("rpgkit-check reach: unreachable maps do not pollute story state", () => {
  test("an unreachable map's autorun cannot set a switch a reachable page reads", () => {
    // B has no inbound edge, but its autorun sets `opened` and transfers to
    // A. A's action page transfers to C only when `opened` is set. The real
    // engine never enters B, so `opened` stays unset and the player stays on
    // A; the checker must not dry-run B and pollute A's entry bank. (Before
    // the fix every map was dry-run from the start, B's autorun arrival made
    // A's gate page active, and C was falsely reachable.)
    const project = fixtureProject([
      grassMap("A", [
        {
          id: "gate",
          x: 2,
          y: 2,
          pages: [
            {
              condition: { switch: "opened" },
              trigger: "action",
              commands: [{ op: "transfer", map: "C", x: 0, y: 0 }],
            },
          ],
        },
      ]),
      grassMap("B", [
        {
          id: "boot",
          x: 0,
          y: 0,
          pages: [
            {
              trigger: "autorun",
              commands: [
                { op: "switch", id: "opened", value: true },
                { op: "transfer", map: "A", x: 0, y: 0 },
              ],
            },
          ],
        },
      ]),
      grassMap("C"),
    ]);
    const report = checkReach(project);
    expect(report.reachableMaps).toEqual(["A"]);
    expect(report.unreachableMaps).toEqual(["B", "C"]);
  });
});

describe("rpgkit-check reach: items and gold carried on arrival", () => {
  test("an item added by an autorun arrives with the forced transfer", () => {
    // A's autorun adds item `key` and force-transfers to B; B's action page
    // is conditioned on holding `key` and transfers to C. The arrival bank
    // must carry items (not just switches/variables), so C is reachable.
    // (Before the fix mergeArrival dropped items and C was falsely
    // unreachable.)
    const project = fixtureProject([
      grassMap("A", [
        {
          id: "boot",
          x: 0,
          y: 0,
          pages: [
            {
              trigger: "autorun",
              commands: [
                { op: "item", item: "key", set: "add", count: 1 },
                { op: "transfer", map: "B", x: 0, y: 0 },
              ],
            },
          ],
        },
      ]),
      grassMap("B", [
        {
          id: "door",
          x: 2,
          y: 2,
          pages: [
            {
              condition: { item: "key" },
              trigger: "action",
              commands: [{ op: "transfer", map: "C", x: 0, y: 0 }],
            },
          ],
        },
      ]),
      grassMap("C"),
    ]);
    const report = checkReach(project);
    expect(report.reachableMaps).toEqual(["A", "B", "C"]);
    expect(report.unreachableMaps).toEqual([]);
  });
});

describe("rpgkit-check reach: facing selects the active page", () => {
  test("a high-priority facing:right page transfers even when a lower page is unconditional", () => {
    // Page 0 is an unconditional action page with no transfer; page 1 is an
    // action page that holds only when the player faces right and transfers
    // to B. The engine runs page 1 when facing right, so B is reachable; the
    // checker must re-select the active page for each facing. (Before the fix
    // the first active page — page 0, facing down — was scanned for all four
    // facings, so page 1's transfer was never seen.)
    const project = fixtureProject([
      grassMap("A", [
        {
          id: "lever",
          x: 2,
          y: 2,
          pages: [
            { trigger: "action", commands: [] },
            {
              condition: { all: [{ kind: "facing", dir: "right" }] },
              trigger: "action",
              commands: [{ op: "transfer", map: "B", x: 0, y: 0 }],
            },
          ],
        },
      ]),
      grassMap("B"),
    ]);
    const report = checkReach(project);
    expect(report.reachableMaps).toEqual(["A", "B"]);
    expect(report.unreachableMaps).toEqual([]);
  });
});

describe("rpgkit-check reach: a transfer terminates the page", () => {
  test("commands after a transfer in the same sequence are dead code", () => {
    // The interpreter publishes a transfer and returns immediately, so the
    // second transfer in the sequence never runs: C is unreachable.
    const project = fixtureProject([
      grassMap("A", [
        {
          id: "door",
          x: 2,
          y: 2,
          pages: [
            {
              trigger: "action",
              commands: [
                { op: "transfer", map: "B", x: 0, y: 0 },
                { op: "transfer", map: "C", x: 0, y: 0 },
              ],
            },
          ],
        },
      ]),
      grassMap("B"),
      grassMap("C"),
    ]);
    const report = checkReach(project);
    expect(report.reachableMaps).toEqual(["A", "B"]);
    expect(report.unreachableMaps).toEqual(["C"]);
  });
});

// The transfer-terminates-fiber semantics must propagate up through nested
// command trees: a transfer inside a taken branch ends the PARENT sequence
// too, so commands after the branch are dead code.
describe("rpgkit-check reach: a transfer in a nested branch terminates the parent", () => {
  test("transfer inside a provably-true if branch kills the parent tail", () => {
    // An unset switch reads false, so the guard holds: the branch transfers
    // to B and the fiber ends. The transfer to C after the if never runs.
    const project = fixtureProject([
      grassMap("A", [
        {
          id: "door",
          x: 2,
          y: 2,
          pages: [
            {
              trigger: "action",
              commands: [
                {
                  op: "if",
                  if: { kind: "switch", id: "later", value: false },
                  then: [{ op: "transfer", map: "B", x: 0, y: 0 }],
                },
                { op: "transfer", map: "C", x: 0, y: 0 },
              ],
            },
          ],
        },
      ]),
      grassMap("B"),
      grassMap("C"),
    ]);
    const report = checkReach(project);
    expect(report.reachableMaps).toEqual(["A", "B"]);
    expect(report.unreachableMaps).toEqual(["C"]);
  });

  test("transfer inside a called common event kills the parent tail", () => {
    // The common program runs on the caller's fiber: its transfer ends the
    // page's sequence too.
    const project = fixtureProject([
      grassMap("A", [
        {
          id: "door",
          x: 2,
          y: 2,
          pages: [
            {
              trigger: "action",
              commands: [
                { op: "common", id: "exit" },
                { op: "transfer", map: "C", x: 0, y: 0 },
              ],
            },
          ],
        },
      ]),
      grassMap("B"),
      grassMap("C"),
    ]);
    project.commonEvents = [
      { trigger: "none", id: "exit", commands: [{ op: "transfer", map: "B", x: 0, y: 0 }] },
    ];
    const report = checkReach(project);
    expect(report.reachableMaps).toEqual(["A", "B"]);
    expect(report.unreachableMaps).toEqual(["C"]);
  });

  test("unknown guard: only one branch transferring keeps the parent tail live", () => {
    // An extension guard is not modelled, so both branches are live. Only
    // `then` transfers; the (empty) else path falls through to the parent
    // tail, so C stays reachable (may-reach).
    const project = fixtureProject([
      grassMap("A", [
        {
          id: "door",
          x: 2,
          y: 2,
          pages: [
            {
              trigger: "action",
              commands: [
                {
                  op: "if",
                  if: { kind: "ext", call: "mood", args: null },
                  then: [{ op: "transfer", map: "B", x: 0, y: 0 }],
                },
                { op: "transfer", map: "C", x: 0, y: 0 },
              ],
            },
          ],
        },
      ]),
      grassMap("B"),
      grassMap("C"),
    ]);
    const report = checkReach(project);
    expect(report.reachableMaps).toEqual(["A", "B", "C"]);
  });

  test("unknown guard: both branches transferring kills the parent tail", () => {
    const project = fixtureProject([
      grassMap("A", [
        {
          id: "door",
          x: 2,
          y: 2,
          pages: [
            {
              trigger: "action",
              commands: [
                {
                  op: "if",
                  if: { kind: "ext", call: "mood", args: null },
                  then: [{ op: "transfer", map: "B", x: 0, y: 0 }],
                  else: [{ op: "transfer", map: "D", x: 0, y: 0 }],
                },
                { op: "transfer", map: "C", x: 0, y: 0 },
              ],
            },
          ],
        },
      ]),
      grassMap("B"),
      grassMap("C"),
      grassMap("D"),
    ]);
    const report = checkReach(project);
    expect(report.reachableMaps.sort()).toEqual(["A", "B", "D"]);
    expect(report.unreachableMaps).toEqual(["C"]);
  });

  test("choices: every branch transferring kills the parent tail", () => {
    const project = fixtureProject([
      grassMap("A", [
        {
          id: "door",
          x: 2,
          y: 2,
          pages: [
            {
              trigger: "action",
              commands: [
                {
                  op: "choices",
                  prompt: "?",
                  options: [
                    { text: "b", commands: [{ op: "transfer", map: "B", x: 0, y: 0 }] },
                    { text: "d", commands: [{ op: "transfer", map: "D", x: 0, y: 0 }] },
                  ],
                },
                { op: "transfer", map: "C", x: 0, y: 0 },
              ],
            },
          ],
        },
      ]),
      grassMap("B"),
      grassMap("C"),
      grassMap("D"),
    ]);
    const report = checkReach(project);
    expect(report.reachableMaps.sort()).toEqual(["A", "B", "D"]);
    expect(report.unreachableMaps).toEqual(["C"]);
  });

  test("choices: one branch falling through keeps the parent tail live", () => {
    const project = fixtureProject([
      grassMap("A", [
        {
          id: "door",
          x: 2,
          y: 2,
          pages: [
            {
              trigger: "action",
              commands: [
                {
                  op: "choices",
                  prompt: "?",
                  options: [
                    { text: "b", commands: [{ op: "transfer", map: "B", x: 0, y: 0 }] },
                    { text: "stay", commands: [] },
                  ],
                },
                { op: "transfer", map: "C", x: 0, y: 0 },
              ],
            },
          ],
        },
      ]),
      grassMap("B"),
      grassMap("C"),
    ]);
    const report = checkReach(project);
    expect(report.reachableMaps).toEqual(["A", "B", "C"]);
  });

  test("the real engine ends on B for the nested-if project", () => {
    // Cross-check: the checker's "C unreachable" must match the engine,
    // which takes the true branch and terminates the fiber on B. The door
    // is a playerTouch tile east of the start, so holding right fires it.
    const project = fixtureProject([
      grassMap("A", [
        {
          id: "door",
          x: 1,
          y: 0,
          pages: [
            {
              trigger: "playerTouch",
              commands: [
                {
                  op: "if",
                  if: { kind: "switch", id: "later", value: false },
                  then: [{ op: "transfer", map: "B", x: 0, y: 0 }],
                },
                { op: "transfer", map: "C", x: 0, y: 0 },
              ],
            },
          ],
        },
      ]),
      grassMap("B"),
      grassMap("C"),
    ]);
    const session = makeCheckSession(project);
    let state = startFresh(project, session);
    for (let frame = 0; frame < 120; frame++) {
      state = stepSession(session, state, {
        buttons: state.mapId === "A" ? BTN_BITS.RIGHT : 0,
        confirmEdge: false,
        cancelEdge: false,
        upEdge: false,
        downEdge: false,
      });
      if (state.mapId === "B" || state.mapId === "C") break;
    }
    expect(state.mapId).toBe("B");
  });
});
