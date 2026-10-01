// tests/choice-icon-engine.test.ts — optional `choices.options[].icon`
// (render-only row pictures). The schema accepts exactly {sprite, dir?,
// frame?}; the reducer copies icons into the open modal aligned with the
// options and adds nothing at all when no option has one; modalChanged sees
// icon edits; save validation checks both the compiled instruction and the
// modal column; rpgkit-check reports an unknown icon sprite.

import { describe, expect, test } from "bun:test";
import {
  cloneModal,
  compile,
  createInterpState,
  createWorld,
  modalChanged,
  stepInterp,
  type ChoiceModal,
  type InterpInput,
  type InterpState,
} from "../src/engine/interpreter.ts";
import { validateSchema } from "../src/engine/schema-validate.ts";
import { validateSnapshot } from "../src/engine/save-validate.ts";
import { createSnapshot, type SaveSnapshot } from "../src/engine/save.ts";
import { initialMovement } from "../src/engine/movement.ts";
import { lintProject } from "../tools/rpgkit-check/src/lint.ts";
import schema from "../src/data/schema.json" with { type: "json" };
import type { ChoiceOption, Command, GameEvent, MapDef, Project, TileId } from "../src/engine/types.ts";

const MAP_ID = "v";
const GRASS: TileId = "town.0";
const NO_EDGE = { confirmEdge: false, cancelEdge: false, upEdge: false, downEdge: false };

function iinput(partial: Partial<InterpInput> = {}): InterpInput {
  const cell = partial.playerCell ?? { x: 10, y: 10 };
  return { ...NO_EDGE, playerCell: cell, prevCell: partial.prevCell ?? cell, facing: partial.facing ?? 2, ...partial };
}

function imap(events: GameEvent[]): MapDef {
  return { id: MAP_ID, name: "t", width: 20, height: 13, sheets: ["town"], ground: Array(260).fill(GRASS), events };
}

function choiceWorld(options: ChoiceOption[]) {
  const event: GameEvent = {
    id: "e", x: 10, y: 10,
    pages: [{ trigger: "action", sprite: null, commands: [{ op: "choices", prompt: "Who?", options }] }],
  };
  return createWorld(imap([event]));
}

function opened(options: ChoiceOption[]): { state: InterpState; modal: ChoiceModal } {
  const w = choiceWorld(options);
  const state = stepInterp(w, createInterpState(), iinput({ confirmEdge: true }));
  expect(state.modal?.kind).toBe("choices");
  return { state, modal: state.modal as ChoiceModal };
}

const ICON_OPTIONS: ChoiceOption[] = [
  { text: "Hero", icon: { sprite: "hero", dir: "left", frame: 1 }, commands: [] },
  { text: "Nobody", commands: [] },
  { text: "Sign", icon: { sprite: "sign" }, commands: [] },
];

describe("choice icon schema", () => {
  const project = (options: unknown[]): Project => ({
    format: "rpgkit-project/v1", title: "t", tileSize: 16,
    start: { map: "a", x: 0, y: 0, dir: "down" },
    sheets: [{ id: "t", pak: "chunks", cols: 1, rows: 1 }],
    items: [],
    maps: [{
      id: "a", name: "a", width: 1, height: 1, sheets: ["t"], ground: ["t.0"],
      events: [{
        id: "e", x: 0, y: 0,
        pages: [{ trigger: "action", commands: [{ op: "choices", prompt: "p", options } as Command] }],
      }],
    }],
  });
  const plain = { text: "b", commands: [] };

  test("accepts an icon with sprite only, and with dir/frame", () => {
    expect(validateSchema(schema, project([{ text: "a", icon: { sprite: "hero" }, commands: [] }, plain]))).toEqual([]);
    for (const frame of [0, 1, 2]) {
      expect(validateSchema(schema, project([
        { text: "a", icon: { sprite: "hero", dir: "up", frame }, commands: [] }, plain,
      ]))).toEqual([]);
    }
  });

  test("rejects frame 3, a missing/empty sprite, a bad dir, and an extra key", () => {
    const bad = [
      { sprite: "hero", frame: 3 },
      { dir: "down" },
      { sprite: "" },
      { sprite: "hero", dir: "north" },
      { sprite: "hero", tint: "red" },
      "hero",
    ];
    for (const icon of bad) {
      expect(validateSchema(schema, project([{ text: "a", icon, commands: [] }, plain])).length).toBeGreaterThan(0);
    }
  });
});

describe("choice icon interpreter", () => {
  test("compile omits icons when no option has one, and aligns them otherwise", () => {
    const none = compile([{ op: "choices", prompt: "p", options: [plain("a"), plain("b")] }]);
    expect(Object.keys(none[0]!)).not.toContain("icons");
    const some = compile([{ op: "choices", prompt: "p", options: ICON_OPTIONS }]);
    expect((some[0] as { icons?: unknown }).icons).toEqual([
      { sprite: "hero", dir: "left", frame: 1 },
      null,
      { sprite: "sign" },
    ]);
  });

  test("the opened modal carries icons aligned with options (null on plain rows)", () => {
    const { modal } = opened(ICON_OPTIONS);
    expect(modal.options).toEqual(["Hero", "Nobody", "Sign"]);
    expect(modal.icons).toEqual([{ sprite: "hero", dir: "left", frame: 1 }, null, { sprite: "sign" }]);
    // Only the defined fields are copied: no dir/frame keys on the sign.
    expect(Object.keys(modal.icons![2]!)).toEqual(["sprite"]);
  });

  test("a box without icons has no icons key at all", () => {
    const { modal } = opened([plain("Yes"), plain("No")]);
    expect("icons" in modal).toBe(false);
    expect(modal).toEqual({
      kind: "choices",
      fiber: `${MAP_ID}/e`,
      prompt: "Who?",
      options: ["Yes", "No"],
      index: 0,
      cancellable: false,
    });
  });

  test("icons survive cursor moves and a re-installed modal; selection is unchanged", () => {
    const options: ChoiceOption[] = ICON_OPTIONS.map((option, i) => ({
      ...option,
      commands: [{ op: "variable", id: "picked", set: { op: "set", value: i } }],
    }));
    const w = choiceWorld(options);
    let s = stepInterp(w, createInterpState(), iinput({ confirmEdge: true }));
    s = stepInterp(w, s, iinput({ downEdge: true }));
    expect((s.modal as ChoiceModal).index).toBe(1);
    expect((s.modal as ChoiceModal).icons).toHaveLength(3);
    // The fiber-step path rebuilds the box when the fiber is parked in
    // choices mode but no modal is installed.
    const cleared = { ...s, modal: null };
    const rebuilt = stepInterp(w, cleared, iinput());
    expect((rebuilt.modal as ChoiceModal).icons).toEqual([
      { sprite: "hero", dir: "left", frame: 1 }, null, { sprite: "sign" },
    ]);
    s = stepInterp(w, s, iinput({ downEdge: true }));
    s = stepInterp(w, s, iinput({ confirmEdge: true }));
    expect(s.sw.variables.picked).toBe(2);
    expect(s.modal).toBeNull();
  });

  test("the modal reuses the compiled icon column; cloneModal copies the array and keeps absence", () => {
    const w = choiceWorld(ICON_OPTIONS);
    const a = stepInterp(w, createInterpState(), iinput({ confirmEdge: true }));
    const b = stepInterp(w, createInterpState(), iinput({ confirmEdge: true }));
    // Icons are immutable render data: both boxes read the one compiled column.
    expect((a.modal as ChoiceModal).icons).toBe((b.modal as ChoiceModal).icons);
    const { modal } = opened(ICON_OPTIONS);
    const copy = cloneModal(modal) as ChoiceModal;
    expect(copy).toEqual(modal);
    expect(copy.icons).not.toBe(modal.icons);
    const plainModal = opened([plain("Yes"), plain("No")]).modal;
    expect("icons" in (cloneModal(plainModal) as ChoiceModal)).toBe(false);
  });

  test("modalChanged detects icon presence and per-field differences", () => {
    const { modal } = opened(ICON_OPTIONS);
    const same = cloneModal(modal) as ChoiceModal;
    expect(modalChanged(modal, same)).toBe(false);
    const { icons: _drop, ...withoutIcons } = modal;
    expect(modalChanged(modal, withoutIcons)).toBe(true);
    expect(modalChanged(withoutIcons, modal)).toBe(true);
    const edits: Array<(m: ChoiceModal) => void> = [
      (m) => { m.icons![0] = { ...m.icons![0]!, sprite: "other" }; },
      (m) => { m.icons![0] = { ...m.icons![0]!, dir: "right" }; },
      (m) => { m.icons![0] = { ...m.icons![0]!, frame: 2 }; },
      (m) => { m.icons![0] = { sprite: "hero", dir: "left" }; },
      (m) => { m.icons![1] = { sprite: "hero" }; },
      (m) => { m.icons![2] = null; },
    ];
    for (const edit of edits) {
      const changed = cloneModal(modal) as ChoiceModal;
      edit(changed);
      expect(modalChanged(modal, changed)).toBe(true);
    }
  });
});

function plain(text: string): ChoiceOption {
  return { text, commands: [] };
}

// --- save validation -------------------------------------------------------

const FIBER = "map/p";

function snapshotWith(prog: unknown[], modal: unknown = null): SaveSnapshot {
  const snapshot = createSnapshot("map", initialMovement(1, 2, 0, { tile: 16, speed: 2 }), createInterpState(), 0);
  snapshot.interp.parallels[FIBER] = {
    key: FIBER, pageIndex: 0, parallel: true, stack: [{ prog, pc: 0 }], mode: "run", since: 0, erase: false,
  } as never;
  snapshot.interp.modal = modal as never;
  return snapshot;
}

function choicesInstr(icons?: unknown): Record<string, unknown> {
  const ins: Record<string, unknown> = { op: "choices", prompt: "p", texts: ["a", "b"], branches: [[], []], cancel: null };
  if (icons !== undefined) ins.icons = icons;
  return ins;
}

function choiceModal(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: "choices", fiber: FIBER, prompt: "p", options: ["a", "b"], index: 0, cancellable: false, ...extra };
}

const BAD_ICON_COLUMNS: Array<[string, unknown]> = [
  ["null column", null],
  ["wrong length", [null]],
  ["not an object", ["hero", null]],
  ["missing sprite", [{ dir: "down" }, null]],
  ["empty sprite", [{ sprite: "" }, null]],
  ["bad dir", [{ sprite: "hero", dir: "north" }, null]],
  ["frame 3", [{ sprite: "hero", frame: 3 }, null]],
  ["extra key", [{ sprite: "hero", tint: 1 }, null]],
];

describe("choice icon save validation", () => {
  test("compiled choices: icons omitted or valid are accepted", () => {
    expect(validateSnapshot(snapshotWith([choicesInstr()]))).toBeNull();
    expect(validateSnapshot(snapshotWith([choicesInstr([{ sprite: "hero", dir: "up", frame: 2 }, null])]))).toBeNull();
    // A real compiled program round-trips through the validator.
    expect(validateSnapshot(snapshotWith(compile([{ op: "choices", prompt: "p", options: ICON_OPTIONS }])))).toBeNull();
  });

  test("compiled choices: malformed icon columns are rejected", () => {
    for (const [name, icons] of BAD_ICON_COLUMNS) {
      const error = validateSnapshot(snapshotWith([choicesInstr(icons)]));
      expect({ name, error: error?.includes(".icons") ?? false }).toEqual({ name, error: true });
    }
  });

  test("modal: a well-formed icon column passes shape checks", () => {
    // A save never holds an open modal; reaching that rule proves the modal
    // itself (icons included) was structurally valid.
    const open = "state.interp.modal: a save cannot hold an open modal";
    expect(validateSnapshot(snapshotWith([], choiceModal()))).toBe(open);
    expect(validateSnapshot(snapshotWith([], choiceModal({ icons: [null, { sprite: "s", dir: "left", frame: 0 }] })))).toBe(open);
  });

  test("modal: malformed icon columns, and icons on an extension choice, are rejected", () => {
    for (const [name, icons] of BAD_ICON_COLUMNS) {
      const error = validateSnapshot(snapshotWith([], choiceModal({ icons })));
      expect({ name, error: error?.startsWith("state.interp.modal.icons") ?? false }).toEqual({ name, error: true });
    }
    const dynamic = choiceModal({ keys: ["a", "b"], enabled: [true, true], icons: [null, null] });
    expect(validateSnapshot(snapshotWith([], dynamic))).toStartWith("state.interp.modal.icons");
  });
});

// --- rpgkit-check ----------------------------------------------------------

function lintFixture(iconSprite: string): Project {
  const iconChoice = (sprite: string): Command => ({
    op: "choices",
    prompt: "Pick",
    options: [
      { text: "Plain", commands: [{ op: "text", lines: ["a"] }] },
      { text: "Pic", icon: { sprite, frame: 1 }, commands: [{ op: "text", lines: ["b"] }] },
    ],
  });
  return {
    format: "rpgkit-project/v1",
    title: "Fixture",
    tileSize: 16,
    start: { map: "m1", x: 1, y: 1, dir: "down" },
    sheets: [{ id: "grass", cols: 1, rows: 1 }],
    items: [],
    sprites: { npc: { kind: "image", src: "npc.png" } },
    commonEvents: [{ id: "ask", trigger: "none", commands: [iconChoice(iconSprite)] }],
    maps: [{
      id: "m1", name: "M1", width: 5, height: 5, sheets: ["grass"],
      ground: new Array<string>(25).fill("grass.0"),
      events: [{
        id: "ev1", x: 2, y: 2,
        pages: [{
          trigger: "action",
          commands: [
            { op: "text", lines: ["hi"] },
            { op: "if", if: { kind: "switch", id: "s" }, then: [iconChoice(iconSprite)] },
            { op: "switch", id: "s", value: true },
            { op: "common", id: "ask" },
          ],
        }],
      }],
    }],
  };
}

describe("choice icon rpgkit-check lint", () => {
  test("an unknown icon sprite is a sprite-missing error located at the option", () => {
    const findings = lintProject(lintFixture("ghost")).findings.filter((f) => f.check === "lint/sprite-missing");
    expect(findings).toHaveLength(2);
    for (const finding of findings) {
      expect(finding.severity).toBe("error");
      expect(finding.message).toContain('"ghost"');
    }
    const locs = findings.map((f) => f.loc);
    expect(locs).toContainEqual({ map: "m1", event: "ev1", page: 0, commandPath: [1, "then", 0, "options", 1, "icon"] });
    expect(locs.some((loc) => loc.common === "ask" &&
      JSON.stringify(loc.commandPath) === JSON.stringify([0, "options", 1, "icon"]))).toBe(true);
  });

  test("a registered icon sprite reports nothing", () => {
    const findings = lintProject(lintFixture("npc")).findings.filter((f) => f.check === "lint/sprite-missing");
    expect(findings).toEqual([]);
  });
});
