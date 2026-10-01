// Structured field adapters for the event inspector. They translate the
// editor's small text/enum controls into schema-shaped Page, Condition and
// Command values without exposing raw JSON editing.

import type {
  Command,
  Condition,
  Dir,
  MoveRoute,
  Page,
  PageCondition,
  TransferCoordinate,
  TransferDirection,
  TransferMap,
} from "../../src/engine/types.ts";
import {
  BASIC_MOVE_STEPS,
  CONDITION_KINDS,
  defaultCondition,
  flattenCommands,
  isEditableCommand,
  type BasicMoveStep,
  type ConditionKind,
  type FlatCommandRow,
} from "./commands.ts";

export type FieldKind = "text" | "integer" | "number" | "boolean" | "enum";

export interface EditableField {
  key: string;
  label: string;
  value: string | number | boolean | null;
  kind: FieldKind;
  options?: readonly string[];
  readOnly?: boolean;
}

export type FieldEdit<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const DIRS = ["down", "left", "right", "up"] as const;
const TRIGGERS = ["action", "playerTouch", "autorun", "parallel"] as const;
const MOVE_TYPES = ["static", "random", "approach"] as const;
const BOOLS = ["true", "false"] as const;
const VAR_MODES = [
  "set", "add", "sub", "random", "copy:variable", "add:variable",
  "sub:variable", "mul:variable", "div:variable", "mod:variable",
] as const;
const IDENTIFIER = /^[A-Za-z0-9_.-]+$/;
const SOUND_ID = /^[a-z0-9_-]+$/;

const field = (
  key: string,
  label: string,
  value: EditableField["value"],
  kind: FieldKind = "text",
  options?: readonly string[],
  readOnly = false,
): EditableField => ({ key, label, value, kind, ...(options ? { options } : {}), ...(readOnly ? { readOnly } : {}) });

function good<T>(value: T): FieldEdit<T> {
  return { ok: true, value };
}

function bad<T>(error: string): FieldEdit<T> {
  return { ok: false, error };
}

function bool(raw: string): boolean | null {
  if (raw === "true" || raw === "on" || raw === "yes") return true;
  if (raw === "false" || raw === "off" || raw === "no") return false;
  return null;
}

function integer(raw: string, label: string, min?: number, max?: number): FieldEdit<number> {
  if (!/^-?\d+$/.test(raw.trim())) return bad(`${label} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return bad(`${label} is outside the safe integer range`);
  if (min !== undefined && value < min) return bad(`${label} must be at least ${min}`);
  if (max !== undefined && value > max) return bad(`${label} must be at most ${max}`);
  return good(value);
}

function finite(raw: string, label: string, min?: number, max?: number): FieldEdit<number> {
  const value = Number(raw.trim());
  if (raw.trim() === "" || !Number.isFinite(value)) return bad(`${label} must be a number`);
  if (min !== undefined && value < min) return bad(`${label} must be at least ${min}`);
  if (max !== undefined && value > max) return bad(`${label} must be at most ${max}`);
  return good(value);
}

function enumValue<T extends string>(raw: string, values: readonly T[], label: string): FieldEdit<T> {
  return values.includes(raw as T) ? good(raw as T) : bad(`${label} must be ${values.join(", ")}`);
}

function identifier(raw: string, label: string, pattern = IDENTIFIER): FieldEdit<string> {
  return raw.length > 0 && pattern.test(raw) ? good(raw) : bad(`${label} has invalid characters`);
}

export function nextFieldValue(field: EditableField, delta = 1): string {
  if (field.kind === "boolean") return field.value === true || String(field.value).toLowerCase() === "true" ? "false" : "true";
  if (field.kind !== "enum" || !field.options?.length) return String(field.value ?? "");
  const at = Math.max(0, field.options.indexOf(String(field.value)));
  return field.options[(at + delta + field.options.length) % field.options.length]!;
}

function variableMode(command: Extract<Command, { op: "variable" }>): string {
  return "from" in command.set ? `${command.set.op}:variable` : command.set.op;
}

function operand(value: TransferMap | TransferCoordinate | TransferDirection): string | number {
  return typeof value === "object" ? `$${value.variable}` : value;
}

function target(value: "player" | "this" | { event: string }): string {
  return typeof value === "object" ? `event:${value.event}` : value;
}

function routeSteps(route: MoveRoute): string {
  return route.steps.map((step) => typeof step === "string" ? step : JSON.stringify(step)).join(",");
}

export function conditionFields(condition: Condition, prefix = ""): EditableField[] {
  const p = (name: string) => `${prefix}${name}`;
  switch (condition.kind) {
    case "switch":
      return [field(p("id"), "ID", condition.id), field(p("value"), "VALUE", condition.value ?? true, "boolean", BOOLS)];
    case "variable":
      return [
        field(p("id"), "ID", condition.id),
        field(p("op"), "OP", condition.op, "enum", [">=", "<=", "==", "!="]),
        field(p("value"), "VALUE", condition.value, "integer"),
      ];
    case "selfSwitch":
      return [field(p("key"), "KEY", condition.key, "enum", ["A", "B", "C", "D"]), field(p("value"), "VALUE", condition.value ?? true, "boolean", BOOLS)];
    case "item":
      return [field(p("id"), "ITEM", condition.id), field(p("count"), "COUNT", condition.count, "integer")];
    case "gold":
      return [field(p("amount"), "AMOUNT", condition.amount, "integer")];
    case "facing":
      return [field(p("dir"), "DIR", condition.dir, "enum", DIRS)];
    case "worldIdle":
      return [field(p("negate"), "NEGATE", condition.negate ?? false, "boolean", BOOLS)];
    case "ext":
      return [field(p("call"), "CALL", condition.call, "text", undefined, true), field(p("args"), "ARGS", JSON.stringify(condition.args), "text", undefined, true)];
    case "appearance":
      return [field(p("target"), "TARGET", JSON.stringify(condition.target), "text", undefined, true), field(p("sprite"), "SPRITE", condition.sprite ?? "null", "text", undefined, true)];
    case "tileProperty":
      return [
        field(p("x"), "X", condition.x, "integer", undefined, true), field(p("y"), "Y", condition.y, "integer", undefined, true),
        field(p("props"), "PROPS", JSON.stringify({ passage: condition.passage, enter: condition.enter, exit: condition.exit }), "text", undefined, true),
      ];
  }
}

export function commandFields(command: Command): EditableField[] {
  switch (command.op) {
    case "text":
      return [field("lines", "LINES", command.lines.join("\n")), field("cps", "CPS", command.cps ?? "", "integer")];
    case "choices":
      return [
        field("prompt", "PROMPT", command.prompt),
        field("optionCount", "OPTIONS", command.options.length, "integer"),
        ...command.options.map((option, i) => field(`option:${i}`, `OPTION ${i + 1}`, option.text)),
        field("cancel", "CANCEL", command.cancel !== undefined, "boolean", BOOLS),
      ];
    case "switch":
      return [field("id", "ID", command.id), field("value", "VALUE", command.value, "boolean", BOOLS)];
    case "variable": {
      const fields = [field("id", "ID", command.id), field("mode", "MODE", variableMode(command), "enum", VAR_MODES)];
      if (command.set.op === "random") {
        fields.push(field("min", "MIN", command.set.min, "integer"), field("max", "MAX", command.set.max, "integer"));
      } else if ("from" in command.set) {
        fields.push(field("from", "FROM", command.set.from));
      } else {
        fields.push(field("value", "VALUE", command.set.value, "integer"));
      }
      return fields;
    }
    case "selfSwitch":
      return [field("key", "KEY", command.key, "enum", ["A", "B", "C", "D"]), field("value", "VALUE", command.value, "boolean", BOOLS)];
    case "if":
      return [
        field("if.kind", "KIND", command.if.kind, "enum", CONDITION_KINDS),
        ...conditionFields(command.if, "if."),
        field("else", "ELSE", command.else !== undefined, "boolean", BOOLS),
      ];
    case "transfer":
      return [
        field("map", "MAP", operand(command.map)), field("x", "X", operand(command.x)),
        field("y", "Y", operand(command.y)), field("dir", "DIR", command.dir ? operand(command.dir) : "keep"),
        field("fade", "FADE", command.fade ?? "", "number"),
      ];
    case "moveRoute":
      return [
        field("target", "TARGET", target(command.target)), field("wait", "WAIT", command.wait ?? false, "boolean", BOOLS),
        field("steps", "STEPS", routeSteps(command.route)),
        field("repeat", "REPEAT", command.route.repeat, "boolean", BOOLS),
        field("skippable", "SKIP", command.route.skippable, "boolean", BOOLS),
      ];
    case "wait": return [field("seconds", "SECONDS", command.seconds, "number")];
    case "gold": return [field("set", "MODE", command.set, "enum", ["add", "sub"]), field("amount", "AMOUNT", command.amount, "integer")];
    case "item": return [field("item", "ITEM", command.item), field("set", "MODE", command.set, "enum", ["add", "sub"]), field("count", "COUNT", command.count, "integer")];
    case "se": return [field("name", "NAME", command.name), field("volume", "VOLUME", command.volume ?? "", "integer"), field("pitch", "PITCH", command.pitch ?? "", "integer")];
    case "common": return [field("id", "ID", command.id)];
    case "place": return [field("target", "TARGET", target(command.target)), field("x", "X", command.x, "integer"), field("y", "Y", command.y, "integer"), field("dir", "DIR", command.dir ?? "down", "enum", DIRS)];
    case "erase":
    case "exit":
    case "lockInput":
    case "unlockInput": return [];
    case "shop":
    case "ext":
    case "extChoice":
    case "moveControl":
    case "appearance":
    case "layer":
    case "tileProperty":
    case "mapAnim":
    case "stopAnim":
    case "battle": return [];
  }
}

export type InspectorCommandRow = FlatCommandRow & {
  fields: readonly EditableField[];
  supported: boolean;
};

export function commandInspectorRows(commands: readonly Command[]): InspectorCommandRow[] {
  return flattenCommands(commands).map((row) => ({
    ...row,
    fields: commandFields(row.command),
    supported: isEditableCommand(row.command),
  }));
}

function editCondition(condition: Condition, key: string, raw: string): FieldEdit<Condition> {
  if (condition.kind === "ext") return bad("extension conditions are read-only");
  if (condition.kind === "switch") {
    if (key === "id") return identifier(raw, "switch id").ok ? good({ ...condition, id: raw }) : bad("switch id has invalid characters");
    if (key === "value") { const value = bool(raw); return value === null ? bad("value must be true or false") : good({ ...condition, value }); }
  } else if (condition.kind === "variable") {
    if (key === "id") return identifier(raw, "variable id").ok ? good({ ...condition, id: raw }) : bad("variable id has invalid characters");
    if (key === "op") { const value = enumValue(raw, [">=", "<=", "==", "!="] as const, "operator"); return value.ok ? good({ ...condition, op: value.value }) : value; }
    if (key === "value") { const value = integer(raw, "value"); return value.ok ? good({ ...condition, value: value.value }) : value; }
  } else if (condition.kind === "selfSwitch") {
    if (key === "key") { const value = enumValue(raw, ["A", "B", "C", "D"] as const, "self switch"); return value.ok ? good({ ...condition, key: value.value }) : value; }
    if (key === "value") { const value = bool(raw); return value === null ? bad("value must be true or false") : good({ ...condition, value }); }
  } else if (condition.kind === "item") {
    if (key === "id") return raw ? good({ ...condition, id: raw }) : bad("item id is required");
    if (key === "count") { const value = integer(raw, "count", 1); return value.ok ? good({ ...condition, count: value.value }) : value; }
  } else if (condition.kind === "gold" && key === "amount") {
    const value = integer(raw, "amount", 0); return value.ok ? good({ ...condition, amount: value.value }) : value;
  } else if (condition.kind === "facing" && key === "dir") {
    const value = enumValue(raw, DIRS, "direction"); return value.ok ? good({ ...condition, dir: value.value }) : value;
  } else if (condition.kind === "worldIdle" && key === "negate") {
    const value = bool(raw); return value === null ? bad("negate must be true or false") : good({ ...condition, negate: value });
  }
  return bad(`field ${key} is not editable`);
}

function parseTarget(raw: string, allowPlayer: boolean): FieldEdit<"player" | "this" | { event: string }> {
  if (raw === "this" || (allowPlayer && raw === "player")) return good(raw);
  const id = raw.startsWith("event:") ? raw.slice(6) : raw;
  return identifier(id, "event id").ok ? good({ event: id }) : bad("target must be this, player, or event:<id>");
}

function parseOperand(raw: string, label: string, numeric: boolean): FieldEdit<string | number | { variable: string }> {
  if (raw.startsWith("$") && raw.length > 1) return good({ variable: raw.slice(1) });
  if (!numeric) return raw ? good(raw) : bad(`${label} is required`);
  return integer(raw, label, 0);
}

function parseSteps(raw: string, requireOne: boolean): FieldEdit<BasicMoveStep[]> {
  const steps = raw.split(",").map((part) => part.trim()).filter(Boolean);
  if (requireOne && steps.length === 0) return bad("route needs at least one step");
  const unknown = steps.find((step) => !BASIC_MOVE_STEPS.includes(step as BasicMoveStep));
  return unknown ? bad(`unsupported move step ${unknown}`) : good(steps as BasicMoveStep[]);
}

export function editCommandField(command: Command, key: string, raw: string): FieldEdit<Command> {
  if (!isEditableCommand(command)) return bad(`${command.op} is read-only`);
  switch (command.op) {
    case "text": {
      if (key === "lines") {
        const lines = raw.split("\n");
        if (lines.length < 1 || lines.length > 4 || lines.some((line) => line.length > 52)) return bad("text needs 1-4 lines of at most 52 characters");
        return good({ ...command, lines });
      }
      if (key === "cps") {
        if (raw.trim() === "") { const { cps: _, ...rest } = command; return good(rest); }
        const value = integer(raw, "cps", 1, 120); return value.ok ? good({ ...command, cps: value.value }) : value;
      }
      break;
    }
    case "choices": {
      if (key === "prompt") return raw.length <= 52 ? good({ ...command, prompt: raw }) : bad("prompt is longer than 52 characters");
      if (key === "optionCount") {
        const count = integer(raw, "option count", 2, 8);
        if (!count.ok) return count;
        const options = command.options.slice(0, count.value);
        while (options.length < count.value) options.push({ text: `Option ${options.length + 1}`, commands: [] });
        return good({ ...command, options });
      }
      if (key.startsWith("option:")) {
        const at = Number(key.slice(7));
        if (!Number.isInteger(at) || !command.options[at]) return bad("choice option does not exist");
        if (raw.length < 1 || raw.length > 64) return bad("choice text needs 1-64 characters");
        const options = command.options.slice();
        options[at] = { ...options[at]!, text: raw };
        return good({ ...command, options });
      }
      if (key === "cancel") {
        const value = bool(raw);
        if (value === null) return bad("cancel must be true or false");
        if (value) return good({ ...command, cancel: command.cancel ?? { commands: [] } });
        const { cancel: _, ...rest } = command;
        return good(rest);
      }
      break;
    }
    case "switch": {
      if (key === "id") { const value = identifier(raw, "switch id"); return value.ok ? good({ ...command, id: value.value }) : value; }
      if (key === "value") { const value = bool(raw); return value === null ? bad("value must be true or false") : good({ ...command, value }); }
      break;
    }
    case "variable": {
      if (key === "id") { const value = identifier(raw, "variable id"); return value.ok ? good({ ...command, id: value.value }) : value; }
      if (key === "mode") {
        const mode = enumValue(raw, VAR_MODES, "variable mode");
        if (!mode.ok) return mode;
        if (mode.value === "random") return good({ ...command, set: { op: "random", min: 0, max: 1 } });
        if (mode.value.endsWith(":variable")) return good({ ...command, set: { op: mode.value.slice(0, -9) as "copy" | "add" | "sub" | "mul" | "div" | "mod", from: "variable" } });
        return good({ ...command, set: { op: mode.value as "set" | "add" | "sub", value: 0 } });
      }
      if (key === "value" && !("from" in command.set) && command.set.op !== "random") { const value = integer(raw, "value"); return value.ok ? good({ ...command, set: { ...command.set, value: value.value } }) : value; }
      if (key === "from" && "from" in command.set) { const value = identifier(raw, "source variable"); return value.ok ? good({ ...command, set: { ...command.set, from: value.value } }) : value; }
      if ((key === "min" || key === "max") && command.set.op === "random") { const value = integer(raw, key); return value.ok ? good({ ...command, set: { ...command.set, [key]: value.value } }) : value; }
      break;
    }
    case "selfSwitch": {
      if (key === "key") { const value = enumValue(raw, ["A", "B", "C", "D"] as const, "self switch"); return value.ok ? good({ ...command, key: value.value }) : value; }
      if (key === "value") { const value = bool(raw); return value === null ? bad("value must be true or false") : good({ ...command, value }); }
      break;
    }
    case "if": {
      if (key === "if.kind") {
        const kind = enumValue(raw, CONDITION_KINDS, "condition kind");
        return kind.ok ? good({ ...command, if: defaultCondition(kind.value) }) : kind;
      }
      if (key.startsWith("if.")) {
        const edited = editCondition(command.if, key.slice(3), raw);
        return edited.ok ? good({ ...command, if: edited.value }) : edited;
      }
      if (key === "else") {
        const value = bool(raw);
        if (value === null) return bad("else must be true or false");
        if (value) return good({ ...command, else: command.else ?? [] });
        const { else: _, ...rest } = command;
        return good(rest);
      }
      break;
    }
    case "transfer": {
      if (key === "map") { const value = parseOperand(raw, "map", false); return value.ok ? good({ ...command, map: value.value as TransferMap }) : value; }
      if (key === "x" || key === "y") { const value = parseOperand(raw, key, true); return value.ok ? good({ ...command, [key]: value.value as TransferCoordinate }) : value; }
      if (key === "dir") {
        if (raw.startsWith("$") && raw.length > 1) return good({ ...command, dir: { variable: raw.slice(1) } });
        const value = enumValue(raw, [...DIRS, "keep"] as const, "direction"); return value.ok ? good({ ...command, dir: value.value }) : value;
      }
      if (key === "fade") {
        if (raw.trim() === "") { const { fade: _, ...rest } = command; return good(rest); }
        const value = finite(raw, "fade", 0, 2); return value.ok ? good({ ...command, fade: value.value }) : value;
      }
      break;
    }
    case "moveRoute": {
      if (key === "target") { const value = parseTarget(raw, true); return value.ok ? good({ ...command, target: value.value }) : value; }
      if (key === "wait") { const value = bool(raw); return value === null ? bad("wait must be true or false") : good({ ...command, wait: value }); }
      if (key === "steps") { const value = parseSteps(raw, false); return value.ok ? good({ ...command, route: { ...command.route, steps: value.value } }) : value; }
      if (key === "repeat" || key === "skippable") { const value = bool(raw); return value === null ? bad(`${key} must be true or false`) : good({ ...command, route: { ...command.route, [key]: value } }); }
      break;
    }
    case "wait": { if (key === "seconds") { const value = finite(raw, "seconds", Number.MIN_VALUE, 30); return value.ok ? good({ ...command, seconds: value.value }) : value; } break; }
    case "gold": {
      if (key === "set") { const value = enumValue(raw, ["add", "sub"] as const, "mode"); return value.ok ? good({ ...command, set: value.value }) : value; }
      if (key === "amount") { const value = integer(raw, "amount", 0); return value.ok ? good({ ...command, amount: value.value }) : value; }
      break;
    }
    case "item": {
      if (key === "item") return raw ? good({ ...command, item: raw }) : bad("item id is required");
      if (key === "set") { const value = enumValue(raw, ["add", "sub"] as const, "mode"); return value.ok ? good({ ...command, set: value.value }) : value; }
      if (key === "count") { const value = integer(raw, "count", 1, 99); return value.ok ? good({ ...command, count: value.value }) : value; }
      break;
    }
    case "se": {
      if (key === "name") { const value = identifier(raw, "sound name", SOUND_ID); return value.ok ? good({ ...command, name: value.value }) : value; }
      if (key === "volume" || key === "pitch") {
        if (raw.trim() === "") { const next = { ...command }; delete next[key]; return good(next); }
        const value = integer(raw, key, key === "volume" ? 0 : 50, key === "volume" ? 100 : 150);
        return value.ok ? good({ ...command, [key]: value.value }) : value;
      }
      break;
    }
    case "common": return key === "id" && raw ? good({ ...command, id: raw }) : bad("common event id is required");
    case "place": {
      if (key === "target") { const value = parseTarget(raw, false); return value.ok ? good({ ...command, target: value.value === "player" ? "this" : value.value }) : value; }
      if (key === "x" || key === "y") { const value = integer(raw, key, 0); return value.ok ? good({ ...command, [key]: value.value }) : value; }
      if (key === "dir") { const value = enumValue(raw, DIRS, "direction"); return value.ok ? good({ ...command, dir: value.value }) : value; }
      break;
    }
    case "erase":
    case "exit":
    case "lockInput":
    case "unlockInput": break;
  }
  return bad(`field ${key} is not editable for ${command.op}`);
}

export type ConditionSource =
  | { kind: "flat"; key: "switch" | "selfSwitch" | "variable" | "item" }
  | { kind: "all"; index: number };

function cleanPageCondition(condition: PageCondition): PageCondition | undefined {
  const next = { ...condition };
  if (next.all?.length === 0) delete next.all;
  return Object.keys(next).length === 0 ? undefined : next;
}

/** Add every new clause to `all`, preserving all authored flat spellings. */
export function addPageCondition(page: Page, kind: ConditionKind): Page {
  const condition = page.condition ?? {};
  return { ...page, condition: { ...condition, all: [...(condition.all ?? []), defaultCondition(kind)] } };
}

export function deletePageCondition(page: Page, source: ConditionSource): Page {
  if (!page.condition) return page;
  const condition: PageCondition = { ...page.condition };
  if (source.kind === "flat") delete condition[source.key];
  else if (condition.all?.[source.index]) condition.all = condition.all.filter((_, i) => i !== source.index);
  const cleaned = cleanPageCondition(condition);
  if (cleaned) return { ...page, condition: cleaned };
  const { condition: _, ...rest } = page;
  return rest;
}

export function editPageConditionField(
  page: Page,
  source: ConditionSource,
  key: string,
  raw: string,
): FieldEdit<Page> {
  const condition = page.condition;
  if (!condition) return bad("condition no longer exists");
  if (source.kind === "all") {
    const current = condition.all?.[source.index];
    if (!current) return bad("condition no longer exists");
    const edited = editCondition(current, key, raw);
    if (!edited.ok) return edited;
    const all = condition.all!.slice();
    all[source.index] = edited.value;
    return good({ ...page, condition: { ...condition, all } });
  }
  if (source.key === "switch" && key === "id" && condition.switch !== undefined) {
    const value = identifier(raw, "switch id"); return value.ok ? good({ ...page, condition: { ...condition, switch: value.value } }) : value;
  }
  if (source.key === "selfSwitch" && key === "key" && condition.selfSwitch !== undefined) {
    const value = enumValue(raw, ["A", "B", "C", "D"] as const, "self switch"); return value.ok ? good({ ...page, condition: { ...condition, selfSwitch: value.value } }) : value;
  }
  if (source.key === "item" && key === "id" && condition.item !== undefined) {
    return raw ? good({ ...page, condition: { ...condition, item: raw } }) : bad("item id is required");
  }
  if (source.key === "variable" && condition.variable !== undefined) {
    const edited = editCondition({ kind: "variable", ...condition.variable }, key, raw);
    return edited.ok && edited.value.kind === "variable"
      ? good({ ...page, condition: { ...condition, variable: { id: edited.value.id, op: edited.value.op, value: edited.value.value } } })
      : edited.ok ? bad("condition changed kind") : edited;
  }
  return bad(`field ${key} is not editable`);
}

export function editPageField(page: Page, key: string, raw: string): FieldEdit<Page> {
  if (key === "trigger") { const value = enumValue(raw, TRIGGERS, "trigger"); return value.ok ? good({ ...page, trigger: value.value }) : value; }
  if (key === "sprite") return good({ ...page, sprite: raw === "" || raw.toLowerCase() === "none" ? null : raw });
  if (key === "direction") { const value = enumValue(raw, DIRS, "direction"); return value.ok ? good({ ...page, dir: value.value }) : value; }
  if (key === "moveType") { const value = enumValue(raw, MOVE_TYPES, "move type"); return value.ok ? good({ ...page, moveType: value.value }) : value; }
  if (key === "blocks") { const value = bool(raw); return value === null ? bad("blocks must be true or false") : good({ ...page, blocks: value }); }
  return bad(`unknown page field ${key}`);
}

export function editPageRouteField(page: Page, key: string, raw: string): FieldEdit<Page> {
  if (key === "enabled") {
    const value = bool(raw);
    if (value === null) return bad("route enabled must be true or false");
    if (value) return good({ ...page, moveRoute: page.moveRoute ?? { steps: ["moveDown"], repeat: false, skippable: false } });
    const { moveRoute: _, ...rest } = page;
    return good(rest);
  }
  const route = page.moveRoute ?? { steps: ["moveDown"], repeat: false, skippable: false };
  if (key === "steps") { const value = parseSteps(raw, true); return value.ok ? good({ ...page, moveRoute: { ...route, steps: value.value } }) : value; }
  if (key === "repeat" || key === "skippable") { const value = bool(raw); return value === null ? bad(`${key} must be true or false`) : good({ ...page, moveRoute: { ...route, [key]: value } }); }
  return bad(`unknown route field ${key}`);
}

export function pageFieldDescriptors(page: Page): EditableField[] {
  return [
    field("trigger", "TRIGGER", page.trigger, "enum", TRIGGERS),
    field("sprite", "SPRITE", page.sprite ?? "NONE"),
    field("direction", "DIR", page.dir ?? "down", "enum", DIRS),
    field("moveType", "MOVE", page.moveType ?? "static", "enum", MOVE_TYPES),
    field("blocks", "BLOCKS", page.blocks ?? false, "boolean", BOOLS),
  ];
}

export function pageRouteFieldDescriptors(page: Page): EditableField[] {
  return [
    field("enabled", "ROUTE", page.moveRoute !== undefined, "boolean", BOOLS),
    field("repeat", "REPEAT", page.moveRoute?.repeat ?? false, "boolean", BOOLS),
    field("skippable", "SKIP", page.moveRoute?.skippable ?? false, "boolean", BOOLS),
    field("steps", "STEPS", page.moveRoute ? routeSteps(page.moveRoute) : "moveDown"),
  ];
}

export function eventGeometryValue(raw: string, label: string): FieldEdit<number> {
  return integer(raw, label, label === "x" || label === "y" ? 0 : 1);
}

export function directionOptions(): readonly Dir[] {
  return DIRS;
}
