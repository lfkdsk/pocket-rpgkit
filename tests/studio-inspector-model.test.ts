import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, GameEvent, MapDef, Page } from "../src/engine/types.ts";
import { EditSession } from "../editor/api/session.ts";
import {
  EDITABLE_COMMAND_OPS,
  flattenCommands,
  getCommand,
  pageConditionClauses,
  type CommandAddress,
} from "../editor/engine/commands.ts";
import { commandFields, conditionFields } from "../editor/engine/event-fields.ts";
import {
  addPageOp,
  adjacentCommand,
  cellInfo,
  clauseFields,
  COMMAND_CATEGORIES,
  commandBranchTargets,
  commandCategory,
  commandCopyOp,
  commandMoveOps,
  commandTreeItems,
  conditionSource,
  deleteCommandOp,
  eventCopyOp,
  fieldControl,
  fieldLabel,
  filterPickerEntries,
  insertCommandOp,
  insertionAddress,
  nextFreeCell,
  opLabel,
  pageCopyOp,
  pageDeleteOp,
  pageMoveOps,
  parseSheetList,
  PICKER_ENTRIES,
  selectionAfterDelete,
  sessionResources,
  updatePageOp,
  type PageRef,
} from "../editor/studio/inspector-model.ts";

const SUNSTONE = readFileSync(join(import.meta.dir, "../examples/sunstone/data/sunstone.json"), "utf8");

function open(): EditSession {
  return EditSession.open(SUNSTONE);
}

function eventOf(session: EditSession, map: string, event: string): GameEvent {
  return session.map(map)!.events!.find((item) => item.id === event)!;
}

/** One history step, a real change, and undo restores the exact bytes. */
function expectOneUndoableStep(session: EditSession, apply: () => { ok: boolean }): void {
  const before = session.exportText();
  const depth = session.history().length;
  const response = apply();
  expect(response.ok).toBe(true);
  expect(session.history().length).toBe(depth + 1);
  expect(session.exportText()).not.toBe(before);
  const after = session.exportText();
  session.undo();
  expect(session.history().length).toBe(depth);
  expect(session.exportText()).toBe(before);
  session.redo();
  expect(session.exportText()).toBe(after);
  session.undo();
  expect(session.exportText()).toBe(before);
}

describe("command categories and picker", () => {
  test("every editable op has a category and a picker entry", () => {
    for (const op of EDITABLE_COMMAND_OPS) expect(COMMAND_CATEGORIES).toContain(commandCategory(op));
    expect(PICKER_ENTRIES.map((entry) => entry.op)).toEqual([...EDITABLE_COMMAND_OPS]);
    for (const entry of PICKER_ENTRIES) {
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.description).not.toContain("Unknown command");
    }
  });

  test("category groups", () => {
    expect(["if", "battle", "scene", "wait", "exit", "common"].map(commandCategory)).toEqual(Array(6).fill("flow"));
    expect(["text", "choices", "balloon"].map(commandCategory)).toEqual(Array(3).fill("message"));
    expect(["switch", "variable", "selfSwitch", "item", "gold"].map(commandCategory)).toEqual(Array(5).fill("state"));
    expect(["moveRoute", "transfer", "moveControl", "place"].map(commandCategory)).toEqual(Array(4).fill("move"));
    expect(["screenFade", "camera", "mapAnim", "appearance", "layer"].map(commandCategory)).toEqual(Array(5).fill("present"));
    expect(["se", "playBgm", "fadeoutBgs", "playMe"].map(commandCategory)).toEqual(Array(4).fill("audio"));
    expect(commandCategory("ext")).toBe("other");
    expect(commandCategory("somethingNew")).toBe("other");
    expect(commandCategory(42)).toBe("other");
  });

  test("labels", () => {
    expect(opLabel("screenFade")).toBe("Screen fade");
    expect(opLabel("playBgm")).toBe("Play BGM");
    expect(fieldLabel("MOVE TYPE")).toBe("Move type");
  });

  test("filter ranks name matches first and searches descriptions", () => {
    expect(filterPickerEntries("").length).toBe(EDITABLE_COMMAND_OPS.length);
    expect(filterPickerEntries("text")[0]!.op).toBe("text");
    const fade = filterPickerEntries("fade").map((entry) => entry.op);
    expect(fade).toContain("screenFade");
    expect(fade).toContain("fadeoutBgm");
    expect(fade.indexOf("fadeoutBgm")).toBeLessThan(fade.indexOf("screenFade"));
    expect(filterPickerEntries("audio").map((entry) => entry.op)).toContain("playSe");
    expect(filterPickerEntries("zzz-no-such")).toEqual([]);
  });
});

describe("branches and the visible tree", () => {
  const merchant = () => eventOf(open(), "village", "merchant").pages[0]!.commands;

  test("branch targets mirror op@branch", () => {
    const commands = merchant();
    const choices = commandBranchTargets(commands[1]!, { path: [], index: 1 });
    expect(choices.map((target) => target.key)).toEqual(["option1", "option2", "cancel"]);
    expect(choices.at(-1)!.present).toBe(false);
    const ifAddress: CommandAddress = { path: choices[0]!.path, index: 0 };
    const ifTargets = commandBranchTargets(getCommand(commands, ifAddress)!, ifAddress);
    expect(ifTargets.map((target) => [target.key, target.present])).toEqual([["then", true], ["else", true]]);
    expect(commandBranchTargets({ op: "battle", setup: {} } as unknown as Command, { path: [], index: 0 }).map((t) => t.key))
      .toEqual(["win", "lose", "escape"]);
    expect(commandBranchTargets({ op: "scene", id: "x" } as Command, { path: [], index: 0 }).map((t) => t.key)).toEqual(["done", "cancel"]);
    expect(commandBranchTargets({ op: "wait", seconds: 1 }, { path: [], index: 0 })).toEqual([]);
  });

  test("insertion address: after, into a branch, or at the end", () => {
    const commands = merchant();
    expect(insertionAddress(commands, undefined)).toEqual({ path: [], index: commands.length });
    expect(insertionAddress(commands, { path: [], index: 0 })).toEqual({ path: [], index: 1 });
    const into = insertionAddress(commands, { path: [], index: 1 }, "option1")!;
    expect(into.index).toBe(1);
    expect(into.path).toEqual([{ kind: "choices", index: 1, branch: "option", option: 0 }]);
    const cancel = insertionAddress(commands, { path: [], index: 1 }, "cancel")!;
    expect(cancel.index).toBe(0);
    expect(insertionAddress(commands, { path: [], index: 1 }, "win")).toBeNull();
  });

  test("tree items interleave branch headers and honour collapse", () => {
    const commands = merchant();
    const rows = flattenCommands(commands);
    const items = commandTreeItems(commands, rows);
    expect(items.map((item) => item.kind === "branch" ? `[${item.label.split(":")[0]}]` : item.key)).toEqual([
      "root#0",
      "root#1",
      "[Option 1]",
      "c1:option:0#0",
      "[Then]",
      "c1:option:0/i0:then#0",
      "c1:option:0/i0:then#1",
      "c1:option:0/i0:then#2",
      "[Else]",
      "c1:option:0/i0:else#0",
      "[Option 2]",
      "c1:option:1#0",
    ]);
    expect(items.filter((item) => item.kind === "branch").map((item) => item.depth)).toEqual([1, 2, 2, 1]);
    const commandItems = items.filter((item) => item.kind === "command");
    expect(commandItems.length).toBe(rows.length);
    expect(commandItems.find((item) => item.key === "root#1")).toMatchObject({ hasChildren: true, collapsed: false, depth: 0 });
    const collapsed = commandTreeItems(commands, rows, (key) => key === "c1:option:0#0");
    expect(collapsed.filter((item) => item.kind === "command").map((item) => item.key))
      .toEqual(["root#0", "root#1", "c1:option:0#0", "c1:option:1#0"]);
    const all = commandTreeItems(commands, rows, () => true);
    expect(all.map((item) => item.key)).toEqual(["root#0", "root#1"]);
  });

  test("keyboard navigation and selection after delete", () => {
    const commands = merchant();
    const items = commandTreeItems(commands, flattenCommands(commands));
    expect(adjacentCommand(items, undefined, 1)).toEqual({ path: [], index: 0 });
    expect(adjacentCommand(items, undefined, -1)!.index).toBe(0);
    const next = adjacentCommand(items, { path: [], index: 1 }, 1)!;
    expect(next.path.length).toBe(1);
    expect(adjacentCommand(items, { path: [], index: 0 }, -1)).toEqual({ path: [], index: 0 });
    expect(selectionAfterDelete(commands, { path: [], index: 1 })).toEqual({ path: [], index: 0 });
    const onlyElse = { path: [{ kind: "choices", index: 1, branch: "option", option: 0 }, { kind: "if", index: 0, branch: "else" }], index: 0 } as const;
    expect(selectionAfterDelete(commands, onlyElse)).toEqual({ path: [{ kind: "choices", index: 1, branch: "option", option: 0 }], index: 0 });
    expect(selectionAfterDelete([{ op: "exit" }], { path: [], index: 0 })).toBeUndefined();
  });
});

describe("pure helpers", () => {
  test("field controls", () => {
    const text = commandFields({ op: "text", lines: ["a", "b"] });
    expect(text.map(fieldControl)).toEqual(["textarea", "number"]);
    const sw = commandFields({ op: "switch", id: "s", value: true });
    expect(sw.map(fieldControl)).toEqual(["text", "checkbox"]);
    const self = commandFields({ op: "selfSwitch", key: "A", value: true });
    expect(fieldControl(self[0]!)).toBe("select");
  });

  test("cell info reads sparse layers last-wins", () => {
    const map = {
      id: "m", name: "M", width: 3, height: 2,
      ground: ["a.0", "a.1", null, "a.2", "a.3", "a.4"],
      upper: [[1, "u.0"], [1, "u.1"]],
      passage: [[4, "block"]],
    } as MapDef;
    expect(cellInfo(map, 1, 0)).toEqual({ x: 1, y: 0, ground: "a.1", upper: "u.1", passage: null });
    expect(cellInfo(map, 1, 1)).toEqual({ x: 1, y: 1, ground: "a.3", upper: null, passage: "block" });
    expect(cellInfo(map, 2, 0)!.ground).toBeNull();
    expect(cellInfo(map, 3, 0)).toBeNull();
  });

  test("sheet lists", () => {
    expect(parseSheetList(" town, ,cave ,")).toEqual(["town", "cave"]);
  });

  test("next free cell avoids events and fits the rectangle", () => {
    const event = (id: string, x: number, y: number, w?: number, h?: number) => ({ id, x, y, ...(w ? { w } : {}), ...(h ? { h } : {}), pages: [] });
    const map = { width: 4, height: 3, events: [event("a", 1, 1), event("b", 2, 1)] };
    expect(nextFreeCell(map, map.events[0]!)).toEqual({ x: 1, y: 0 });
    const wide = event("w", 0, 0, 2, 2);
    expect(nextFreeCell({ width: 4, height: 2, events: [wide] }, wide)).toEqual({ x: 2, y: 0 });
    const full = { width: 1, height: 1, events: [event("a", 0, 0)] };
    expect(nextFreeCell(full, full.events[0]!)).toEqual({ x: 0, y: 0 });
  });

  test("flat condition clauses expose only the fields the page gate can hold", () => {
    const page = { trigger: "action", commands: [], condition: { switch: "s", selfSwitch: "A", all: [{ kind: "gold", amount: 3 }] } } as Page;
    const clauses = pageConditionClauses(page.condition);
    const [flatSwitch, flatSelf, gold] = clauses.map((clause) => clauseFields(clause, conditionFields(clause.condition)));
    expect(flatSwitch!.map((field) => [field.key, field.readOnly === true])).toEqual([["id", false], ["value", true]]);
    expect(flatSelf!.map((field) => [field.key, field.readOnly === true])).toEqual([["key", false], ["value", true]]);
    expect(gold!.every((field) => !field.readOnly)).toBe(true);
    expect(clauses.map(conditionSource)).toEqual([
      { kind: "flat", key: "switch" },
      { kind: "flat", key: "selfSwitch" },
      { kind: "all", index: 0 },
    ]);
  });

  test("resources for an inline session", () => {
    const session = open();
    const resources = sessionResources(session, session.map("village")!);
    expect(resources.maps).toEqual(["cave", "forest", "village"]);
    expect(resources.events).toContain("merchant");
  });
});

describe("protocol op lists: one history step each, undo restores the bytes", () => {
  test("page move left and right", () => {
    const session = open();
    const chest = eventOf(session, "village", "village-chest");
    expect(pageMoveOps("village", chest, 0, 0)).toBeNull();
    expect(pageMoveOps("village", chest, 1, 2)).toBeNull();
    const ops = pageMoveOps("village", chest, 0, 1)!;
    expect(ops.map((op) => op.command)).toEqual(["delete-page", "add-page"]);
    expectOneUndoableStep(session, () => session.transaction("Move page", ops));
    session.transaction("Move page", ops);
    const moved = eventOf(session, "village", "village-chest");
    expect(moved.pages[1]).toEqual(chest.pages[0]!);
    expect(moved.pages[0]).toEqual(chest.pages[1]!);
    const back = pageMoveOps("village", moved, 1, 0)!;
    session.transaction("Move page back", back);
    expect(session.exportText()).toBe(SUNSTONE); // moving back restores the exact bytes too
  });

  test("page copy, add and delete", () => {
    const session = open();
    const elder = eventOf(session, "village", "elder");
    const copy = pageCopyOp("village", elder, 0)!;
    expectOneUndoableStep(session, () => session.run(copy.command, copy.args));
    session.run(copy.command, copy.args);
    const copied = eventOf(session, "village", "elder");
    expect(copied.pages.length).toBe(2);
    expect(copied.pages[1]).toEqual(copied.pages[0]!);
    session.undo();
    const add = addPageOp("village", "elder", 1);
    expectOneUndoableStep(session, () => session.run(add.command, add.args));
    expect(pageDeleteOp("village", elder, 0)).toBeNull(); // last page is kept
    const chest = eventOf(session, "village", "village-chest");
    const del = pageDeleteOp("village", chest, 1)!;
    expectOneUndoableStep(session, () => session.run(del.command, del.args));
  });

  test("page condition and field updates", () => {
    const session = open();
    const chest = eventOf(session, "village", "village-chest");
    const ref: PageRef = { map: "village", event: "village-chest", page: 1 };
    const op = updatePageOp(ref, { ...chest.pages[1]!, trigger: "playerTouch" });
    expectOneUndoableStep(session, () => session.run(op.command, op.args));
  });

  test("command move up/down at the root and inside a branch", () => {
    const session = open();
    const ref: PageRef = { map: "village", event: "merchant", page: 0 };
    const commands = () => eventOf(session, "village", "merchant").pages[0]!.commands;
    const original = commands();
    expect(commandMoveOps(ref, original, { path: [], index: 0 }, -1)).toBeNull();
    expect(commandMoveOps(ref, original, { path: [], index: 1 }, 1)).toBeNull();
    const down = commandMoveOps(ref, original, { path: [], index: 0 }, 1)!;
    expect(down.to).toEqual({ path: [], index: 1 });
    expectOneUndoableStep(session, () => session.transaction("Move command down", down.ops));
    session.transaction("Move command down", down.ops);
    expect(commands()[0]).toEqual(original[1]!);
    expect(commands()[1]).toEqual(original[0]!);
    session.undo();

    const thenPath = [{ kind: "choices", index: 1, branch: "option", option: 0 }, { kind: "if", index: 0, branch: "then" }] as const;
    const up = commandMoveOps(ref, original, { path: thenPath, index: 2 }, -1)!;
    expect(up.to).toEqual({ path: thenPath, index: 1 });
    expectOneUndoableStep(session, () => session.transaction("Move command up", up.ops));
    session.transaction("Move command up", up.ops);
    expect(getCommand(commands(), up.to)).toEqual(getCommand(original, { path: thenPath, index: 2 })!);
    expect(session.history().length).toBe(1);
  });

  test("command copy, insert into a new branch, and delete", () => {
    const session = open();
    const ref: PageRef = { map: "village", event: "merchant", page: 0 };
    const commands = () => eventOf(session, "village", "merchant").pages[0]!.commands;
    const original = commands();
    const copy = commandCopyOp(ref, original, { path: [], index: 1 })!;
    expect(copy.to).toEqual({ path: [], index: 2 });
    expectOneUndoableStep(session, () => session.run(copy.op.command, copy.op.args));
    session.run(copy.op.command, copy.op.args);
    expect(commands()[2]).toEqual(original[1]!);
    session.undo();

    const cancel = insertionAddress(original, { path: [], index: 1 }, "cancel")!;
    const insert = insertCommandOp(ref, cancel, { op: "text", lines: ["Maybe later."] });
    expectOneUndoableStep(session, () => session.run(insert.command, insert.args));

    const del = deleteCommandOp(ref, { path: [], index: 0 });
    expectOneUndoableStep(session, () => session.run(del.command, del.args));
  });

  test("event copy lands on a free cell with a unique id", () => {
    const session = open();
    const map = session.map("village")!;
    const elder = eventOf(session, "village", "elder");
    const { op, id } = eventCopyOp(map, elder);
    expect(id).toBe("elder-copy");
    expectOneUndoableStep(session, () => session.run(op.command, op.args));
    session.run(op.command, op.args);
    const copy = eventOf(session, "village", id);
    expect(copy.pages).toEqual(elder.pages);
    const occupied = (map.events ?? []).filter((event) => event.x === copy.x && event.y === copy.y);
    expect(occupied).toEqual([]);
    expect(eventCopyOp(session.map("village")!, elder).id).toBe("elder-copy-2");
  });
});
