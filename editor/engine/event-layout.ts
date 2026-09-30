// Pure, deterministic geometry for the event inspector.  The renderer and
// the companion-input path both consume this object, so there are no hidden
// DOM hit targets (PocketJS receives raw logical-pixel pointer coordinates).

export interface InspectorRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface InspectorField {
  /** Stable key understood by the event editor reducer. */
  key: string;
  label: string;
  value: string | number | boolean | null;
  readOnly?: boolean;
}

/** Structural row accepted from the command-tree flattener.  It deliberately
 * does not import the command editor: the app can adapt any address/path
 * representation while this presentational module stays independent. */
export interface InspectorCommandRow {
  readonly key: string;
  readonly depth: number;
  /** Branch caption such as THEN, ELSE, CHOICE 2, WIN, or CANCEL. */
  readonly branch?: string;
  readonly branchLabel?: string;
  /** `flattenCommands()` supplies command; `op` remains as a convenient
   * adapter shorthand for tests or other flatteners. */
  readonly command?: { readonly op: string };
  readonly op?: string;
  readonly summary?: string;
  readonly fields?: readonly InspectorField[];
  readonly editable?: boolean;
  readonly readOnly?: boolean;
  /** Explicit false marks an operation the editor can display but not edit. */
  readonly supported?: boolean;
  /** Equivalent positive marker for adapters whose flattener uses this form. */
  readonly unsupported?: boolean;
}

export type InspectorConditionSource =
  | { kind: "flat"; key: "switch" | "selfSwitch" | "variable" | "item" }
  | { kind: "all"; index: number };

export interface InspectorConditionRow {
  key: string;
  kind: string;
  summary: string;
  source: InspectorConditionSource;
  fields: readonly InspectorField[];
  readOnly?: boolean;
}

export interface InspectorScrollOffsets {
  pagesX: number;
  conditionsY: number;
  commandsY: number;
}

export const ZERO_INSPECTOR_SCROLL: Readonly<InspectorScrollOffsets> = {
  pagesX: 0,
  conditionsY: 0,
  commandsY: 0,
};

export type EventField = "name" | "x" | "y" | "w" | "h";
export type PageField = "trigger" | "sprite" | "direction" | "moveType" | "blocks";
export type RouteField = "enabled" | "repeat" | "skippable" | "steps";
export type PageAction = "add" | "delete" | "up" | "down" | "copy";
export type ConditionAction = "add" | "delete";
export type CommandAction = "add" | "delete" | "up" | "down" | "copy";

export type EventInspectorAction =
  | { kind: "close" }
  | { kind: "event-field"; field: EventField }
  | { kind: "page-action"; action: PageAction }
  | { kind: "page-select"; page: number }
  | { kind: "page-field"; field: PageField }
  | { kind: "route-field"; field: RouteField }
  | { kind: "condition-action"; action: ConditionAction }
  | { kind: "condition-select"; row: number }
  | { kind: "condition-field"; row: number; field: string; readOnly: boolean }
  | { kind: "command-action"; action: CommandAction }
  | { kind: "command-select"; row: number }
  | { kind: "command-field"; row: number; field: string; readOnly: boolean };

export interface InspectorControl<A extends EventInspectorAction = EventInspectorAction> {
  rect: InspectorRect;
  action: A;
  label: string;
}

export interface InspectorRowGeometry {
  row: number;
  key: string;
  /** Unclipped content rectangle. Children are clipped to the list window. */
  rect: InspectorRect;
  header: InspectorControl;
  fields: InspectorControl[];
  readOnly: boolean;
}

export interface EventInspectorLayout {
  width: number;
  height: number;
  compact: boolean;
  bodyTop: number;
  leftWidth: number;
  close: InspectorControl;
  eventFields: InspectorControl[];
  pageActions: InspectorControl[];
  pageTabs: InspectorControl[];
  pageFields: InspectorControl[];
  routeFields: InspectorControl[];
  conditionActions: InspectorControl[];
  conditionClip: InspectorRect;
  conditionRows: InspectorRowGeometry[];
  commandActions: InspectorControl[];
  commandClip: InspectorRect;
  commandRows: InspectorRowGeometry[];
  /** Front-to-back pointer regions. Kept public for tests and focus rings. */
  hitRegions: InspectorControl[];
}

export interface EventInspectorLayoutOptions {
  width: number;
  height: number;
  pageCount: number;
  activePage: number;
  conditions: readonly InspectorConditionRow[];
  commands: readonly InspectorCommandRow[];
  scroll?: Partial<InspectorScrollOffsets>;
}

export const INSPECTOR_HEADER_H = 24;
export const INSPECTOR_EVENT_H = 28;
export const INSPECTOR_PAGES_H = 28;
export const INSPECTOR_BODY_TOP =
  INSPECTOR_HEADER_H + INSPECTOR_EVENT_H + INSPECTOR_PAGES_H;
export const INSPECTOR_ROW_H = 18;

const PAD = 4;
const GAP = 3;
const CONTROL_H = 20;
const SECTION_H = 22;
const PAGE_TAB_W = 42;

function printable(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "?";
  }
}

function own(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function commandField(key: string, label: string, value: unknown, readOnly = false): InspectorField {
  const printableValue = value === undefined ? "" : printable(value);
  return { key, label, value: printableValue, ...(readOnly ? { readOnly: true } : {}) };
}

export function inspectorCommandOp(row: InspectorCommandRow): string {
  return row.op ?? row.command?.op ?? "unknown";
}

/** Default editable rows for a command-tree FlatCommandRow. An adapter may
 * override these by supplying `fields`; otherwise the renderer and hit-test
 * derive the same stable dotted keys directly from the command payload. */
export function inspectorCommandFields(row: InspectorCommandRow): readonly InspectorField[] {
  if (row.fields) return row.fields;
  const command = row.command;
  if (!command) return [];
  const op = inspectorCommandOp(row);
  switch (op) {
    case "text": {
      const lines = own(command, "lines");
      const fields = Array.isArray(lines)
        ? lines.map((line, index) => commandField(`lines.${index}`, `LINE ${index + 1}`, line))
        : [];
      const cps = own(command, "cps");
      if (cps !== undefined) fields.push(commandField("cps", "CPS", cps));
      return fields;
    }
    case "choices": {
      const fields = [commandField("prompt", "PROMPT", own(command, "prompt"))];
      const options = own(command, "options");
      if (Array.isArray(options)) {
        options.forEach((option, index) => fields.push(commandField(
          `options.${index}.text`,
          `OPTION ${index + 1}`,
          own(option, "text"),
        )));
      }
      return fields;
    }
    case "switch": return [
      commandField("id", "ID", own(command, "id")),
      commandField("value", "VALUE", own(command, "value")),
    ];
    case "variable": {
      const set = own(command, "set");
      const fields = [
        commandField("id", "ID", own(command, "id")),
        commandField("set.op", "OP", own(set, "op")),
      ];
      for (const key of ["value", "min", "max", "from"] as const) {
        const value = own(set, key);
        if (value !== undefined) fields.push(commandField(`set.${key}`, key.toUpperCase(), value));
      }
      return fields;
    }
    case "selfSwitch": return [
      commandField("key", "KEY", own(command, "key")),
      commandField("value", "VALUE", own(command, "value")),
    ];
    case "if": return [commandField("if", "IF", own(command, "if"))];
    case "transfer": return [
      commandField("map", "MAP", own(command, "map")),
      commandField("x", "X", own(command, "x")),
      commandField("y", "Y", own(command, "y")),
      commandField("dir", "DIR", own(command, "dir")),
      commandField("fade", "FADE", own(command, "fade")),
    ];
    case "wait": return [commandField("seconds", "SECONDS", own(command, "seconds"))];
    case "gold": return [
      commandField("set", "OP", own(command, "set")),
      commandField("amount", "AMOUNT", own(command, "amount")),
    ];
    case "item": return [
      commandField("item", "ITEM", own(command, "item")),
      commandField("set", "OP", own(command, "set")),
      commandField("count", "COUNT", own(command, "count")),
    ];
    case "se": return [
      commandField("name", "NAME", own(command, "name")),
      commandField("volume", "VOLUME", own(command, "volume")),
      commandField("pitch", "PITCH", own(command, "pitch")),
    ];
    case "common": return [commandField("id", "ID", own(command, "id"))];
    case "place": return [
      commandField("target", "TARGET", own(command, "target")),
      commandField("x", "X", own(command, "x")),
      commandField("y", "Y", own(command, "y")),
      commandField("dir", "DIR", own(command, "dir")),
    ];
    case "moveRoute": {
      const route = own(command, "route");
      const steps = own(route, "steps");
      return [
        commandField("target", "TARGET", own(command, "target")),
        commandField("wait", "WAIT", own(command, "wait")),
        commandField("route.steps", "STEPS", Array.isArray(steps) ? steps.map(printable).join(",") : ""),
        commandField("route.repeat", "REPEAT", own(route, "repeat")),
        commandField("route.skippable", "SKIP", own(route, "skippable")),
      ];
    }
    case "erase":
    case "exit":
    case "lockInput":
    case "unlockInput":
      return [];
    default:
      // Opaque payloads remain inspectable but never acquire an editable
      // field target by accident.
      return [commandField("payload", "DATA", command, true)];
  }
}

function rect(x: number, y: number, w: number, h: number): InspectorRect {
  return { x, y, w: Math.max(0, w), h: Math.max(0, h) };
}

function control<A extends EventInspectorAction>(
  label: string,
  r: InspectorRect,
  action: A,
): InspectorControl<A> {
  return { label, rect: r, action };
}

function intersects(a: InspectorRect, b: InspectorRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function intersection(a: InspectorRect, b: InspectorRect): InspectorRect | null {
  if (!intersects(a, b)) return null;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  return rect(x, y, right - x, bottom - y);
}

function visibleControl(c: InspectorControl, clip: InspectorRect): InspectorControl | null {
  const clipped = intersection(c.rect, clip);
  return clipped ? { ...c, rect: clipped } : null;
}

function normalizeScroll(scroll: Partial<InspectorScrollOffsets> | undefined): InspectorScrollOffsets {
  return {
    pagesX: Math.max(0, scroll?.pagesX ?? 0),
    conditionsY: Math.max(0, scroll?.conditionsY ?? 0),
    commandsY: Math.max(0, scroll?.commandsY ?? 0),
  };
}

function addVisibleRows(
  hitRegions: InspectorControl[],
  rows: InspectorRowGeometry[],
  clip: InspectorRect,
): void {
  for (const row of rows) {
    const header = visibleControl(row.header, clip);
    if (header) hitRegions.push(header);
    for (const field of row.fields) {
      const visible = visibleControl(field, clip);
      if (visible) hitRegions.push(visible);
    }
  }
}

/** Create the complete inspector geometry in logical pixels.  It is usable at
 * arbitrary sizes; 480x272 selects a 210 px detail column and 720x480 a
 * 260 px column. Lists scroll inside their own clips while all chrome stays
 * fixed. */
export function createEventInspectorLayout(
  options: EventInspectorLayoutOptions,
): EventInspectorLayout {
  const width = Math.max(320, Math.floor(options.width));
  const height = Math.max(200, Math.floor(options.height));
  const compact = width < 640;
  const leftWidth = Math.min(width - 180, compact ? 210 : 260);
  const scroll = normalizeScroll(options.scroll);
  const hitRegions: InspectorControl[] = [];

  const close = control("BACK", rect(PAD, 3, 48, 18), { kind: "close" });
  hitRegions.push(close);

  // Event row. Give the name everything not needed by four equal numeric
  // cells; it remains a generous 280 px at the compact target size.
  const eventY = INSPECTOR_HEADER_H + 3;
  const numberW = compact ? 43 : 52;
  const nameW = width - PAD * 2 - (numberW + GAP) * 4;
  let x = PAD;
  const eventFields: InspectorControl[] = [];
  eventFields.push(control("NAME", rect(x, eventY, nameW, CONTROL_H), { kind: "event-field", field: "name" }));
  x += nameW + GAP;
  for (const field of ["x", "y", "w", "h"] as const) {
    const c = control(field.toUpperCase(), rect(x, eventY, numberW, CONTROL_H), {
      kind: "event-field" as const,
      field,
    });
    eventFields.push(c);
    x += numberW + GAP;
  }
  hitRegions.push(...eventFields);

  // Page operations occupy a stable 158 px prefix; tabs scroll horizontally
  // in the remainder. A partially visible tab gets a correspondingly clipped
  // hit box, never a target under the COPY button.
  const pagesY = INSPECTOR_HEADER_H + INSPECTOR_EVENT_H + 3;
  const pageActionSpecs: readonly [PageAction, string, number][] = [
    ["add", "+", 25],
    ["delete", "DEL", 32],
    ["up", "UP", 27],
    ["down", "DN", 27],
    ["copy", "COPY", 40],
  ];
  const pageActions: InspectorControl[] = [];
  x = PAD;
  for (const [action, label, w] of pageActionSpecs) {
    const c = control(label, rect(x, pagesY, w, CONTROL_H), { kind: "page-action", action });
    pageActions.push(c);
    x += w + GAP;
  }
  hitRegions.push(...pageActions);
  const tabsX = x + 1;
  const tabsClip = rect(tabsX, pagesY, width - tabsX - PAD, CONTROL_H);
  const pageTabs: InspectorControl[] = [];
  const pageCount = Math.max(0, Math.floor(options.pageCount));
  for (let page = 0; page < pageCount; page++) {
    const raw = control(
      `P${page + 1}`,
      rect(tabsX + page * (PAGE_TAB_W + GAP) - scroll.pagesX, pagesY, PAGE_TAB_W, CONTROL_H),
      { kind: "page-select" as const, page },
    );
    const visible = visibleControl(raw, tabsClip);
    if (visible) {
      pageTabs.push(visible);
      hitRegions.push(visible);
    }
  }

  const bodyTop = INSPECTOR_BODY_TOP;
  const detailX = PAD;
  const detailW = leftWidth - PAD * 2;
  const half = Math.floor((detailW - GAP) / 2);
  const third = Math.floor((detailW - GAP * 2) / 3);

  const pageFields: InspectorControl[] = [
    control("TRIGGER", rect(detailX, bodyTop + 3, half, CONTROL_H), { kind: "page-field", field: "trigger" }),
    control("SPRITE", rect(detailX + half + GAP, bodyTop + 3, detailW - half - GAP, CONTROL_H), { kind: "page-field", field: "sprite" }),
    control("DIR", rect(detailX, bodyTop + 3 + SECTION_H, third, CONTROL_H), { kind: "page-field", field: "direction" }),
    control("MOVE", rect(detailX + third + GAP, bodyTop + 3 + SECTION_H, third, CONTROL_H), { kind: "page-field", field: "moveType" }),
    control("BLOCKS", rect(detailX + (third + GAP) * 2, bodyTop + 3 + SECTION_H, detailW - (third + GAP) * 2, CONTROL_H), { kind: "page-field", field: "blocks" }),
  ];
  hitRegions.push(...pageFields);

  const routeY = bodyTop + 3 + SECTION_H * 2;
  const routeFields: InspectorControl[] = [
    control("ROUTE", rect(detailX, routeY, third, CONTROL_H), { kind: "route-field", field: "enabled" }),
    control("REPEAT", rect(detailX + third + GAP, routeY, third, CONTROL_H), { kind: "route-field", field: "repeat" }),
    control("SKIP", rect(detailX + (third + GAP) * 2, routeY, detailW - (third + GAP) * 2, CONTROL_H), { kind: "route-field", field: "skippable" }),
    control("STEPS", rect(detailX, routeY + SECTION_H, detailW, CONTROL_H), { kind: "route-field", field: "steps" }),
  ];
  hitRegions.push(...routeFields);

  const conditionBarY = routeY + SECTION_H * 2 + 2;
  const conditionActions: InspectorControl[] = [
    control("+", rect(leftWidth - 49, conditionBarY, 20, CONTROL_H), { kind: "condition-action", action: "add" }),
    control("DEL", rect(leftWidth - 27, conditionBarY, 24, CONTROL_H), { kind: "condition-action", action: "delete" }),
  ];
  hitRegions.push(...conditionActions);
  const conditionClip = rect(PAD, conditionBarY + CONTROL_H + 2, leftWidth - PAD * 2, height - (conditionBarY + CONTROL_H + 2) - PAD);

  const conditionRows: InspectorRowGeometry[] = [];
  let rowY = conditionClip.y - scroll.conditionsY;
  options.conditions.forEach((condition, row) => {
    const rowH = INSPECTOR_ROW_H + condition.fields.length * INSPECTOR_ROW_H + 3;
    const rowRect = rect(conditionClip.x, rowY, conditionClip.w, rowH);
    const header = control(
      condition.kind.toUpperCase(),
      rect(rowRect.x, rowY, rowRect.w, INSPECTOR_ROW_H),
      { kind: "condition-select" as const, row },
    );
    const fields = condition.fields.map((field, fieldIndex) => control(
      field.label,
      rect(rowRect.x + 8, rowY + INSPECTOR_ROW_H + fieldIndex * INSPECTOR_ROW_H, rowRect.w - 8, INSPECTOR_ROW_H),
      {
        kind: "condition-field" as const,
        row,
        field: field.key,
        readOnly: condition.readOnly === true || field.readOnly === true,
      },
    ));
    conditionRows.push({
      row,
      key: condition.key,
      rect: rowRect,
      header,
      fields,
      readOnly: condition.readOnly === true,
    });
    rowY += rowH + GAP;
  });
  addVisibleRows(hitRegions, conditionRows, conditionClip);

  const commandX = leftWidth + 2;
  const commandW = width - commandX;
  const commandBarY = bodyTop + 3;
  const commandActionSpecs: readonly [CommandAction, string, number][] = [
    ["add", "+", 25],
    ["delete", "DEL", 32],
    ["up", "UP", 27],
    ["down", "DN", 27],
    ["copy", "COPY", 40],
  ];
  const commandActions: InspectorControl[] = [];
  x = commandX + commandW - PAD;
  for (let i = commandActionSpecs.length - 1; i >= 0; i--) {
    const [action, label, w] = commandActionSpecs[i]!;
    x -= w;
    commandActions.unshift(control(label, rect(x, commandBarY, w, CONTROL_H), { kind: "command-action", action }));
    x -= GAP;
  }
  hitRegions.push(...commandActions);
  const commandClip = rect(commandX + PAD, commandBarY + CONTROL_H + 2, commandW - PAD * 2, height - (commandBarY + CONTROL_H + 2) - PAD);

  const commandRows: InspectorRowGeometry[] = [];
  rowY = commandClip.y - scroll.commandsY;
  options.commands.forEach((command, row) => {
    const fieldsList = inspectorCommandFields(command);
    const rowH = CONTROL_H + fieldsList.length * INSPECTOR_ROW_H + 3;
    const indent = Math.max(0, Math.floor(command.depth)) * 10;
    const contentX = commandClip.x + Math.min(indent, Math.max(0, commandClip.w - 50));
    const contentW = commandClip.x + commandClip.w - contentX;
    const rowRect = rect(contentX, rowY, contentW, rowH);
    const readOnly = command.readOnly === true
      || command.unsupported === true
      || command.supported === false
      || command.editable === false
      || inspectorCommandOp(command) === "ext";
    const header = control(
      inspectorCommandOp(command).toUpperCase(),
      rect(rowRect.x, rowY, rowRect.w, CONTROL_H),
      { kind: "command-select" as const, row },
    );
    const fields = fieldsList.map((field, fieldIndex) => control(
      field.label,
      rect(rowRect.x + 8, rowY + CONTROL_H + fieldIndex * INSPECTOR_ROW_H, rowRect.w - 8, INSPECTOR_ROW_H),
      {
        kind: "command-field" as const,
        row,
        field: field.key,
        readOnly: readOnly || field.readOnly === true,
      },
    ));
    commandRows.push({ row, key: command.key, rect: rowRect, header, fields, readOnly });
    rowY += rowH + GAP;
  });
  addVisibleRows(hitRegions, commandRows, commandClip);

  return {
    width,
    height,
    compact,
    bodyTop,
    leftWidth,
    close,
    eventFields,
    pageActions,
    pageTabs,
    pageFields,
    routeFields,
    conditionActions,
    conditionClip,
    conditionRows,
    commandActions,
    commandClip,
    commandRows,
    hitRegions,
  };
}

function inside(x: number, y: number, r: InspectorRect): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

/** Raw-pointer hit test. Passing the already-created layout ensures the
 * input path uses precisely the same viewport, rows and scroll offsets that
 * were drawn. */
export function hitTestEventInspector(
  layout: EventInspectorLayout,
  x: number,
  y: number,
): EventInspectorAction | null {
  if (x < 0 || y < 0 || x >= layout.width || y >= layout.height) return null;
  // Later controls are visually on top (field rows over their containing
  // row), hence the reverse traversal.
  for (let i = layout.hitRegions.length - 1; i >= 0; i--) {
    const region = layout.hitRegions[i]!;
    if (inside(x, y, region.rect)) return region.action;
  }
  return null;
}

/** Short aliases keep companion/app call sites pleasant. */
export const eventInspectorLayout = createEventInspectorLayout;
export const eventInspectorHitTest = hitTestEventInspector;

/** Stable identity for focus/input-buffer state. */
export function inspectorActionKey(action: EventInspectorAction | null): string {
  if (!action) return "";
  switch (action.kind) {
    case "close": return "close";
    case "event-field": return `event:${action.field}`;
    case "page-action": return `page-action:${action.action}`;
    case "page-select": return `page:${action.page}`;
    case "page-field": return `page-field:${action.field}`;
    case "route-field": return `route:${action.field}`;
    case "condition-action": return `condition-action:${action.action}`;
    case "condition-select": return `condition:${action.row}`;
    case "condition-field": return `condition:${action.row}:${action.field}`;
    case "command-action": return `command-action:${action.action}`;
    case "command-select": return `command:${action.row}`;
    case "command-field": return `command:${action.row}:${action.field}`;
  }
}
