import { describe, expect, test } from "bun:test";
import {
  addPageCondition,
  commandFields,
  commandInspectorRows,
  conditionFields,
  deletePageCondition,
  editCommandField,
  editPageConditionField,
  editPageField,
  editPageRouteField,
  nextFieldValue,
  pageFieldDescriptors,
  pageRouteFieldDescriptors,
} from "../editor/engine/event-fields.ts";
import { EDITABLE_COMMAND_OPS, defaultCommand } from "../editor/engine/commands.ts";
import { validateProject } from "../editor/engine/document.ts";
import type { Command, Condition, Page, Project } from "../src/engine/types.ts";

function edit(command: Command, key: string, value: string): Command {
  const result = editCommandField(command, key, value);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function projectWith(commands: Command[], page: Partial<Page> = {}): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Field editor",
    tileSize: 16,
    start: { map: "map", x: 0, y: 0, dir: "down" },
    sheets: [{ id: "town", pak: "chunks", cols: 1, rows: 1 }],
    items: [{ id: "potion", name: "Potion", sprite: "town.0" }],
    commonEvents: [{ id: "ce", trigger: "none", commands: [] }],
    maps: [{
      id: "map", name: "Map", width: 2, height: 2, sheets: ["town"],
      ground: ["town.0", "town.0", "town.0", "town.0"],
      events: [{ id: "event", x: 0, y: 0, pages: [{ trigger: "action", commands, ...page }] }],
    }],
  };
}

describe("event inspector command fields", () => {
  test("lists fields for every editable command and leaves opaque commands read-only", () => {
    const editable = EDITABLE_COMMAND_OPS.map((op) => defaultCommand(op));
    const opaque: Command[] = [
      { op: "shop", id: "s", goods: [{ item: "potion" }] },
      { op: "ext", call: "game.test", args: { untouched: true } },
      { op: "moveControl", target: "player", control: { kind: "speed", value: 6 } },
      { op: "battle", setup: { enemy: "slime" } },
      { op: "screenFade", direction: "out", duration: 1 },
      { op: "screenTint", layer: "night", color: { r: 1, g: 2, b: 3, a: 4 }, duration: 1 },
      { op: "screenFlash", color: { r: 5, g: 6, b: 7, a: 8 }, intensity: 128, duration: 0.2 },
      { op: "screenShake", strength: 6, speed: 4, duration: 0.5 },
      { op: "camera", target: { x: 3, y: 4 }, duration: 1 },
      { op: "balloon", target: "player", icon: "alert" },
      { op: "screenBackdrop", layer: "cutscene", variant: "blue" },
    ];
    const rows = commandInspectorRows([...editable, ...opaque]);
    expect(rows.slice(0, editable.length).every((row) => row.supported && !row.readOnly)).toBe(true);
    expect(rows.slice(editable.length).map((row) => [row.command.op, row.supported, row.fields.length])).toEqual([
      ["shop", false, 0], ["ext", false, 0], ["moveControl", false, 0], ["battle", false, 0],
      ["screenFade", false, 0], ["screenTint", false, 0], ["screenFlash", false, 0],
      ["screenShake", false, 0], ["camera", false, 0], ["balloon", false, 0],
      ["screenBackdrop", false, 0],
    ]);
    expect(commandFields(defaultCommand("choices")).map((entry) => entry.key)).toEqual([
      "prompt", "optionCount", "option:0", "option:1", "cancel",
    ]);
  });

  test("edits text, choices, switches and both variable operand forms", () => {
    expect(edit(defaultCommand("text"), "lines", "Hello\ntraveller")).toEqual({ op: "text", lines: ["Hello", "traveller"] });
    let choices = edit(defaultCommand("choices"), "optionCount", "3");
    choices = edit(choices, "option:2", "Leave");
    choices = edit(choices, "cancel", "true");
    expect(choices).toMatchObject({ options: [{ text: "Option 1" }, { text: "Option 2" }, { text: "Leave" }], cancel: { commands: [] } });
    expect(edit(defaultCommand("switch"), "value", "false")).toEqual({ op: "switch", id: "switch", value: false });
    let variable = edit(defaultCommand("variable"), "mode", "random");
    variable = edit(variable, "min", "2");
    variable = edit(variable, "max", "9");
    expect(variable).toMatchObject({ set: { op: "random", min: 2, max: 9 } });
    variable = edit(variable, "mode", "mul:variable");
    variable = edit(variable, "from", "factor");
    expect(variable).toMatchObject({ set: { op: "mul", from: "factor" } });
  });

  test("edits if conditions, transfer variable operands, and basic movement routes", () => {
    let conditional = edit(defaultCommand("if"), "if.kind", "gold");
    conditional = edit(conditional, "if.amount", "12");
    conditional = edit(conditional, "else", "true");
    expect(conditional).toEqual({ op: "if", if: { kind: "gold", amount: 12 }, then: [], else: [] });

    let transfer = edit(defaultCommand("transfer"), "map", "$destination");
    transfer = edit(transfer, "x", "$door-x");
    transfer = edit(transfer, "y", "7");
    transfer = edit(transfer, "dir", "left");
    expect(transfer).toMatchObject({ map: { variable: "destination" }, x: { variable: "door-x" }, y: 7, dir: "left" });

    let route = edit(defaultCommand("moveRoute"), "target", "event:guard");
    route = edit(route, "steps", "moveUp,faceLeft,wait");
    route = edit(route, "repeat", "true");
    expect(route).toMatchObject({ target: { event: "guard" }, route: { steps: ["moveUp", "faceLeft", "wait"], repeat: true } });
  });

  test("edits the remaining parameterized command forms into a valid project", () => {
    const commands: Command[] = [
      edit(defaultCommand("selfSwitch"), "key", "D"),
      edit(defaultCommand("wait"), "seconds", "0.25"),
      edit(edit(defaultCommand("gold"), "set", "sub"), "amount", "4"),
      edit(edit(edit(defaultCommand("item"), "item", "potion"), "set", "add"), "count", "2"),
      edit(edit(edit(defaultCommand("se"), "name", "door-open"), "volume", "70"), "pitch", "110"),
      edit(defaultCommand("common"), "id", "ce"),
      edit(edit(edit(defaultCommand("place"), "target", "event:guard"), "x", "1"), "y", "1"),
      defaultCommand("erase"), defaultCommand("exit"), defaultCommand("lockInput"), defaultCommand("unlockInput"),
    ];
    expect(validateProject(projectWith(commands))).toEqual([]);
  });

  test("rejects malformed values instead of creating invalid command data", () => {
    expect(editCommandField(defaultCommand("wait"), "seconds", "0")).toMatchObject({ ok: false });
    expect(editCommandField(defaultCommand("item"), "count", "100")).toMatchObject({ ok: false });
    expect(editCommandField(defaultCommand("se"), "name", "Upper Case")).toMatchObject({ ok: false });
    expect(editCommandField({ op: "ext", call: "game.keep", args: { x: 1 } }, "args", "{}"))
      .toMatchObject({ ok: false, error: "ext is read-only" });
  });

  test("shows audio command fields without exposing field edits", () => {
    const audio: Command[] = [
      { op: "playBgm", id: "field", volume: 80, pitch: 90 },
      { op: "fadeoutBgm", duration: 1.5 },
      { op: "stopBgm" },
      { op: "pauseBgm" },
      { op: "resumeBgm" },
      { op: "playBgs", id: "rain" },
      { op: "fadeoutBgs", duration: 0 },
      { op: "playMe", id: "victory", duration: 4, volume: 75 },
      { op: "playSe", id: "door", pitch: 120 },
      { op: "saveBgm" },
      { op: "replayBgm" },
    ];
    const rows = commandInspectorRows(audio);
    expect(rows.every((row) => row.readOnly && !row.supported)).toBe(true);
    expect(rows.map((row) => row.fields.map((entry) => entry.key))).toEqual([
      ["id", "volume", "pitch"],
      ["duration"],
      [], [], [],
      ["id", "volume", "pitch"],
      ["duration"],
      ["id", "duration", "volume", "pitch"],
      ["id", "volume", "pitch"],
      [], [],
    ]);
    expect(rows.flatMap((row) => row.fields).every((entry) => entry.readOnly)).toBe(true);
    expect(editCommandField(audio[0]!, "volume", "50")).toMatchObject({ ok: false, error: "playBgm is read-only" });
  });
});

describe("event inspector page and condition fields", () => {
  test("cycles page enums and toggles a schema-valid authored route", () => {
    let page: Page = { trigger: "action", commands: [] };
    const trigger = pageFieldDescriptors(page)[0]!;
    expect(nextFieldValue(trigger)).toBe("playerTouch");
    let result = editPageField(page, "trigger", nextFieldValue(trigger));
    expect(result.ok).toBe(true);
    page = result.ok ? result.value : page;
    result = editPageRouteField(page, "enabled", "true");
    page = result.ok ? result.value : page;
    result = editPageRouteField(page, "steps", "moveRight,turnTowardPlayer");
    page = result.ok ? result.value : page;
    expect(page.moveRoute).toEqual({ steps: ["moveRight", "turnTowardPlayer"], repeat: false, skippable: false });
    expect(pageRouteFieldDescriptors(page).at(-1)?.value).toBe("moveRight,turnTowardPlayer");
    expect(validateProject(projectWith([], page))).toEqual([]);
  });

  test("adds, edits and deletes AND conditions while preserving ext payloads", () => {
    const ext: Condition = { kind: "ext", call: "quest.ready", args: { exact: [1, 2] } };
    let page: Page = { trigger: "action", condition: { switch: "legacy", all: [ext] }, commands: [] };
    page = addPageCondition(page, "gold");
    const edited = editPageConditionField(page, { kind: "all", index: 1 }, "amount", "25");
    expect(edited.ok).toBe(true);
    page = edited.ok ? edited.value : page;
    expect(page.condition?.all?.[0]).toBe(ext);
    expect(page.condition?.all?.[1]).toEqual({ kind: "gold", amount: 25 });
    const refused = editPageConditionField(page, { kind: "all", index: 0 }, "args", "{}");
    expect(refused).toMatchObject({ ok: false, error: "extension conditions are read-only" });
    page = deletePageCondition(page, { kind: "flat", key: "switch" });
    expect(page.condition).toEqual({ all: [ext, { kind: "gold", amount: 25 }] });
    page = deletePageCondition(page, { kind: "all", index: 1 });
    expect(page.condition?.all).toEqual([ext]);
  });

  test("shows and preserves BGM conditions as read-only", () => {
    const condition: Condition = { kind: "bgmPlaying", id: "field", negate: true };
    expect(conditionFields(condition)).toEqual([
      expect.objectContaining({ key: "id", value: "field", readOnly: true }),
      expect.objectContaining({ key: "negate", value: true, readOnly: true }),
    ]);

    const page: Page = { trigger: "action", condition: { all: [condition] }, commands: [] };
    expect(editPageConditionField(page, { kind: "all", index: 0 }, "id", "other"))
      .toMatchObject({ ok: false, error: "bgmPlaying conditions are read-only" });

    const conditional: Command = { op: "if", if: condition, then: [] };
    expect(commandFields(conditional)).toEqual([
      expect.objectContaining({ key: "if.kind", readOnly: true }),
      expect.objectContaining({ key: "if.id", readOnly: true }),
      expect.objectContaining({ key: "if.negate", readOnly: true }),
      expect.objectContaining({ key: "else" }),
    ]);
    expect(editCommandField(conditional, "if.kind", "switch"))
      .toMatchObject({ ok: false, error: "bgmPlaying conditions are read-only" });
    expect(editCommandField(conditional, "if.id", "other"))
      .toMatchObject({ ok: false, error: "bgmPlaying conditions are read-only" });
  });
});
