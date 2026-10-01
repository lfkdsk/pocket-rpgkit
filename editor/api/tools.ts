// editor/api/tools.ts — MCP-visible descriptions for the edit operations.

import type { EditCommandName } from "./types.ts";

export interface EditToolDefinition {
  kind: "edit";
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  command: EditCommandName;
  mutates: boolean;
}

const file = {
  type: "string",
  minLength: 1,
  description: "Path inside the server's configured --root directory to a rpgkit-project/v1 JSON document. Relative paths resolve from the server working directory.",
};
const map = { type: "string", minLength: 1, description: "Stable map id returned by rpgkit_maps_list." };
const event = { type: "string", minLength: 1, description: "Stable map-local event id returned by rpgkit_events_list." };
const page = { type: "integer", minimum: 0, description: "Zero-based page index returned by rpgkit_pages_list." };
const tile = { type: ["string", "null"], description: "Tile id such as town.43, or null to erase." };
const layer = { type: "string", enum: ["ground", "upper"], default: "ground" };
const mapChanges = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    id: { type: "string", pattern: "^[a-z0-9_-]+$" },
    name: { type: "string", minLength: 1, maxLength: 40 },
    width: { type: "integer", minimum: 1, maximum: 256 },
    height: { type: "integer", minimum: 1, maximum: 256 },
    sheets: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } },
  },
};
const passage = { type: ["string", "null"], enum: ["pass", "block", null], description: "Per-cell passage override, or null to clear it." };
const dryRun = { type: "boolean", default: false, description: "Compute and validate the edit, diff and reversible patch without writing the file." };
const address = {
  type: "object",
  additionalProperties: false,
  required: ["path", "index"],
  properties: {
    path: {
      type: "array",
      description: "Recursive command-list path. Use the commandAddress returned by rpgkit_commands_list; [] is the page root.",
      items: {
        oneOf: [
          { type: "object", additionalProperties: false, required: ["kind", "index", "branch"], properties: { kind: { const: "if" }, index: { type: "integer", minimum: 0 }, branch: { enum: ["then", "else"] } } },
          { type: "object", additionalProperties: false, required: ["kind", "index", "branch", "option"], properties: { kind: { const: "choices" }, index: { type: "integer", minimum: 0 }, branch: { const: "option" }, option: { type: "integer", minimum: 0 } } },
          { type: "object", additionalProperties: false, required: ["kind", "index", "branch"], properties: { kind: { const: "choices" }, index: { type: "integer", minimum: 0 }, branch: { const: "cancel" } } },
          { type: "object", additionalProperties: false, required: ["kind", "index", "branch"], properties: { kind: { const: "battle" }, index: { type: "integer", minimum: 0 }, branch: { enum: ["win", "lose", "escape"] } } },
        ],
      },
    },
    index: { type: "integer", minimum: 0, description: "Command index, or insertion slot when inserting." },
  },
};

const commandValue = {
  type: "object",
  required: ["op"],
  properties: { op: { type: "string", minLength: 1 } },
  description: "Complete Command object. Nested payloads are checked against the project schema before write.",
};

const pageValue = {
  type: "object",
  additionalProperties: false,
  required: ["trigger", "commands"],
  properties: {
    condition: { type: "object", description: "PageCondition object." },
    trigger: { enum: ["action", "playerTouch", "autorun", "parallel"] },
    sprite: { type: ["string", "null"] },
    blocks: { type: "boolean" },
    moveType: { enum: ["static", "random", "approach"] },
    moveRoute: { type: "object" },
    moveSpeed: { type: "integer", minimum: 1, maximum: 6 },
    moveFrequency: { type: "integer", minimum: 1, maximum: 5 },
    directionFix: { type: "boolean" },
    through: { type: "boolean" },
    facingMode: { enum: ["followMovement", "locked", "scripted"] },
    dir: { enum: ["down", "left", "right", "up"] },
    commands: { type: "array", items: commandValue },
  },
};

const eventValue = {
  type: "object",
  additionalProperties: false,
  required: ["id", "x", "y", "pages"],
  properties: {
    id: { type: "string", pattern: "^[A-Za-z0-9_-]+$" },
    name: { type: "string" },
    x: { type: "integer", minimum: 0 },
    y: { type: "integer", minimum: 0 },
    w: { type: "integer", minimum: 1 },
    h: { type: "integer", minimum: 1 },
    pages: { type: "array", minItems: 1, items: pageValue },
  },
};

const patchSide = {
  oneOf: [
    { type: "object", additionalProperties: false, required: ["exists"], properties: { exists: { const: false } } },
    { type: "object", additionalProperties: false, required: ["exists", "value"], properties: { exists: { const: true }, value: {} } },
  ],
};

const patchValue = {
  type: "object",
  additionalProperties: false,
  required: ["format", "beforeHash", "afterHash", "changes"],
  properties: {
    format: { const: "rpgkit-edit/patch-v1" },
    beforeHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    afterHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "before", "after"],
        properties: { path: { type: "string" }, before: patchSide, after: patchSide },
      },
    },
  },
};

function schema(
  properties: Record<string, unknown>,
  required: string[],
  mutates = false,
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["file", ...required],
    properties: { file, ...properties, ...(mutates ? { dryRun } : {}) },
  };
}

function tool(
  name: string,
  title: string,
  command: EditCommandName,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = [],
  mutates = false,
): EditToolDefinition {
  return { kind: "edit", name, title, command, description, inputSchema: schema(properties, required, mutates), mutates };
}

/** Ordered registry used for both tools/list and tools/call dispatch. */
export const EDIT_TOOLS: readonly EditToolDefinition[] = [
  tool("rpgkit_project_open", "Open RPG Kit project", "open", "Parse and schema-check a project, then report whether it is an editable inline document or a read-only sharded ProjectShell."),
  tool("rpgkit_maps_list", "List maps", "list-maps", "List maps with deterministic map:<id> addresses. ProjectShell map indexes are supported without loading their shards."),
  tool("rpgkit_events_list", "List map events", "list-events", "List every event on an inline map with stable map/event addresses and page counts.", { map }, ["map"]),
  tool("rpgkit_pages_list", "List event pages", "list-pages", "List pages in priority order with stable map/event/page addresses, conditions, triggers and command counts.", { map, event }, ["map", "event"]),
  tool("rpgkit_commands_list", "List command tree", "list-commands", "Flatten one page's recursive command tree. Each row includes a reusable structured commandAddress, stable text address, branch, summary and read-only flag.", { map, event, page }, ["map", "event", "page"]),
  tool("rpgkit_map_update", "Update map properties", "update-map", "Rename a map or update its display name, size and sheet list through the editor model. Literal transfer references follow an id rename; resize reports cropped event ids.", { map, changes: mapChanges }, ["map", "changes"], true),
  tool("rpgkit_tile_paint", "Paint one tile", "paint-tile", "Paint or erase one ground/upper cell using the editor stroke model. The tile must belong to a sheet declared by the map.", { map, layer, x: { type: "integer", minimum: 0 }, y: { type: "integer", minimum: 0 }, tile }, ["map", "x", "y", "tile"], true),
  tool("rpgkit_tile_rect", "Paint tile rectangle", "paint-rect", "Paint or erase a complete in-bounds rectangle as one editor stroke and one reversible patch.", { map, layer, x: { type: "integer", minimum: 0 }, y: { type: "integer", minimum: 0 }, width: { type: "integer", minimum: 1 }, height: { type: "integer", minimum: 1 }, tile }, ["map", "x", "y", "width", "height", "tile"], true),
  tool("rpgkit_tile_fill", "Flood-fill tile region", "fill-region", "Four-way flood-fill the contiguous region containing x,y on ground or upper. null erases the region.", { map, layer, x: { type: "integer", minimum: 0 }, y: { type: "integer", minimum: 0 }, tile }, ["map", "x", "y", "tile"], true),
  tool("rpgkit_passage_paint", "Paint passage override", "paint-passage", "Set one map cell's passage override to pass or block, or clear it with null, through the editor stroke model.", { map, x: { type: "integer", minimum: 0 }, y: { type: "integer", minimum: 0 }, value: passage }, ["map", "x", "y", "value"], true),
  tool("rpgkit_event_add", "Add event", "add-event", "Add a complete schema-shaped event through the editor event transaction model. IDs must be unique on the map and the footprint must fit.", { map, event: eventValue }, ["map", "event"], true),
  tool("rpgkit_event_update", "Update event fields", "update-event", "Update event id/name/x/y/w/h. Use null to remove optional name/w/h; page content is edited with page tools.", { map, event, changes: { type: "object", additionalProperties: false, properties: { id: { type: "string", pattern: "^[A-Za-z0-9_-]+$" }, name: { type: ["string", "null"] }, x: { type: "integer", minimum: 0 }, y: { type: "integer", minimum: 0 }, w: { type: ["integer", "null"], minimum: 1 }, h: { type: ["integer", "null"], minimum: 1 } } } }, ["map", "event", "changes"], true),
  tool("rpgkit_event_delete", "Delete event", "delete-event", "Delete one map-local event and return its old value in the structured result.", { map, event }, ["map", "event"], true),
  tool("rpgkit_page_add", "Add event page", "add-page", "Add a complete schema-shaped page, optionally at a zero-based index. Higher indexes have higher runtime priority.", { map, event, page: pageValue, index: { type: "integer", minimum: 0 } }, ["map", "event", "page"], true),
  tool("rpgkit_page_update", "Replace event page", "update-page", "Replace one page with a complete schema-shaped Page value through the editor page transaction model.", { map, event, page, value: pageValue }, ["map", "event", "page", "value"], true),
  tool("rpgkit_page_delete", "Delete event page", "delete-page", "Delete one page. The operation refuses to remove an event's final page.", { map, event, page }, ["map", "event", "page"], true),
  tool("rpgkit_command_insert", "Insert command", "insert-command", "Insert a schema-valid command at a root or recursive branch slot. Opaque runtime commands are inserted intact; obtain nested paths from rpgkit_commands_list.", { map, event, page, address, command: commandValue }, ["map", "event", "page", "address", "command"], true),
  tool("rpgkit_command_delete", "Delete command", "delete-command", "Delete any command at a commandAddress, including an opaque command as one intact value.", { map, event, page, address }, ["map", "event", "page", "address"], true),
  tool("rpgkit_command_update", "Update command field", "update-command", "Edit one supported command field using the editor's validated text adapter. Errors name legal fields and accepted values.", { map, event, page, address, field: { type: "string", minLength: 1 }, value: { type: "string", description: "Editor text spelling, for example 10, true, or newline-separated text lines." } }, ["map", "event", "page", "address", "field", "value"], true),
  tool("rpgkit_project_validate", "Validate project", "validate", "Parse and validate a document against rpgkit-project/v1. Invalid input is returned as valid:false with field paths and messages."),
  tool("rpgkit_project_save", "Apply reversible patch", "save", "Apply a patch returned by a dry-run edit, forward or reverse, after checking its semantic SHA-256 base. Saves atomically unless dryRun is true.", { patch: patchValue, direction: { type: "string", enum: ["forward", "reverse"], default: "forward" } }, ["patch"], true),
] as const;

export const EDIT_TOOL_BY_NAME: ReadonlyMap<string, EditToolDefinition> = new Map(
  EDIT_TOOLS.map((definition) => [definition.name, definition]),
);
