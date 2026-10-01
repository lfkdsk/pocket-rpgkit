// editor/api/operations.ts — pure JSON-in/JSON-out project edit operations.
//
// The API deliberately composes editor/engine's reducers and validators. It
// owns wire-level argument checks, stable addresses, diffs and reversible
// patches; it does not duplicate the editor's mutation rules.

import type {
  Command,
  Dir,
  GameEvent,
  MapDef,
  Page,
  Project,
  ProjectShell,
  ProjectSource,
  JsonValue,
  TileId,
} from "../../src/engine/types.ts";
import { validateMapDefStructure } from "../../src/engine/map-repository.ts";
import { sha256Text } from "../../src/engine/map-repository.ts";
import { canonicalJson } from "../../src/engine/save.ts";
import {
  commandAddressKey,
  flattenCommands,
  getCommand,
  getCommandList,
  insertCommand,
  deleteCommand,
  isEditableCommand,
  updateCommand,
  type CommandAddress,
  type CommandListPath,
  type CommandListPathSegment,
} from "../engine/commands.ts";
import {
  commandFields,
  editCommandField,
} from "../engine/event-fields.ts";
import { eventEditorResources } from "../engine/event-resources.ts";
import {
  addPage,
  canPaint,
  createEditorState,
  createEventAt,
  deleteMap,
  deletePage,
  deleteSelectedEvent,
  duplicateMap,
  edgePaintCell,
  edgeStrokeEnd,
  edgeStrokeStart,
  exportProject,
  mapReferences,
  newMap,
  paintCell,
  renameMap,
  resizeMap,
  selectEvent,
  selectLayer,
  selectMap,
  selectPassageBrush,
  selectPage,
  selectTile,
  setMapName,
  setMapSheets,
  strokeEnd,
  strokeStart,
  toDenseUpper,
  updateSelectedEvent,
  updateSelectedPage,
  movePage,
  type EdgeBrush,
  type EditorState,
  type Layer,
  type NewMapOptions,
} from "../engine/model.ts";
import {
  loadProject,
  semanticEqual,
  serializeProjectPreservingSource,
  validateProject,
} from "../engine/document.ts";
import {
  EDIT_COMMANDS,
  type EditChange,
  type EditCommandName,
  type EditExecution,
  type EditFailure,
  type EditPatch,
  type EditSuccess,
  type PatchValue,
  type ProjectSummary,
} from "./types.ts";

const COMMAND_SET: ReadonlySet<string> = new Set(EDIT_COMMANDS);
const WRITE_COMMANDS: ReadonlySet<EditCommandName> = new Set([
  "update-map",
  "add-map",
  "duplicate-map",
  "delete-map",
  "paint-tile",
  "paint-rect",
  "fill-region",
  "paint-passage",
  "paint-cells",
  "paint-edges",
  "add-event",
  "update-event",
  "delete-event",
  "add-page",
  "update-page",
  "delete-page",
  "insert-command",
  "delete-command",
  "update-command",
  "save",
]);

const ARGUMENT_KEYS: Record<EditCommandName, readonly string[]> = {
  open: [],
  "list-maps": [],
  "list-events": ["map"],
  "list-pages": ["map", "event"],
  "list-commands": ["map", "event", "page"],
  "update-map": ["map", "changes"],
  "add-map": ["map", "name", "width", "height", "sheets", "fill", "after"],
  "duplicate-map": ["map"],
  "delete-map": ["map"],
  "paint-tile": ["map", "layer", "x", "y", "tile"],
  "paint-rect": ["map", "layer", "x", "y", "width", "height", "tile"],
  "fill-region": ["map", "layer", "x", "y", "tile"],
  "paint-passage": ["map", "x", "y", "value"],
  "paint-cells": ["map", "layer", "cells", "value"],
  "paint-edges": ["map", "cells", "brush"],
  "add-event": ["map", "event"],
  "update-event": ["map", "event", "changes"],
  "delete-event": ["map", "event"],
  "add-page": ["map", "event", "page", "index"],
  "update-page": ["map", "event", "page", "value"],
  "delete-page": ["map", "event", "page"],
  "insert-command": ["map", "event", "page", "address", "command"],
  "delete-command": ["map", "event", "page", "address"],
  "update-command": ["map", "event", "page", "address", "field", "value"],
  validate: [],
  save: ["patch", "direction"],
};

const EVENT_ID_RE = /^[A-Za-z0-9_-]+$/;

export class EditApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly path?: string,
    readonly expected?: unknown,
    readonly actual?: unknown,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "EditApiError";
  }
}

function fail(command: string | undefined, error: unknown): EditExecution {
  const known = error instanceof EditApiError
    ? error
    : new EditApiError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
  const response: EditFailure = {
    ok: false,
    ...(command === undefined ? {} : { command }),
    error: {
      code: known.code,
      message: known.message,
      ...(known.path === undefined ? {} : { path: known.path }),
      ...(known.expected === undefined ? {} : { expected: known.expected }),
      ...(known.actual === undefined ? {} : { actual: known.actual }),
      ...(known.details === undefined ? {} : { details: known.details }),
    },
  };
  return { response };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function own(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function argsRecord(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (!isRecord(args)) {
    throw new EditApiError("INVALID_ARGUMENT", "operation arguments must be a JSON object", "$", "object", args);
  }
  return args;
}

function assertKnownArgs(command: EditCommandName, args: Record<string, unknown>): void {
  const allowed = ARGUMENT_KEYS[command];
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new EditApiError(
      "INVALID_ARGUMENT",
      `unknown argument(s) for ${command}: ${unknown.join(", ")}; legal fields are: ${allowed.join(", ") || "(none)"}`,
      "$",
      allowed,
      unknown,
    );
  }
}

/** Shared wire-level command/argument gate used by inline and sharded hosts
 * before either implementation decides what document bytes it must load. */
export function validateEditOperationInput(
  commandValue: string,
  rawArgs: unknown = {},
): { command: EditCommandName; args: Record<string, unknown> } {
  if (!COMMAND_SET.has(commandValue)) {
    throw new EditApiError(
      "UNKNOWN_COMMAND",
      `unknown command ${JSON.stringify(commandValue)}; choose one of: ${EDIT_COMMANDS.join(", ")}`,
      "$.command",
      EDIT_COMMANDS,
      commandValue,
    );
  }
  const command = commandValue as EditCommandName;
  const args = argsRecord(rawArgs);
  assertKnownArgs(command, args);
  return { command, args };
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new EditApiError("INVALID_ARGUMENT", `${key} must be a non-empty string`, `$.${key}`, "non-empty string", value);
  }
  return value;
}

function integerArg(
  args: Record<string, unknown>,
  key: string,
  options: { min?: number; max?: number; optional?: boolean } = {},
): number | undefined {
  const value = args[key];
  if (value === undefined && options.optional) return undefined;
  if (!Number.isInteger(value)) {
    throw new EditApiError("INVALID_ARGUMENT", `${key} must be an integer`, `$.${key}`, "integer", value);
  }
  const number = value as number;
  if (options.min !== undefined && number < options.min) {
    throw new EditApiError("INVALID_ARGUMENT", `${key} must be at least ${options.min}`, `$.${key}`, `>= ${options.min}`, value);
  }
  if (options.max !== undefined && number > options.max) {
    throw new EditApiError("INVALID_ARGUMENT", `${key} must be at most ${options.max}`, `$.${key}`, `<= ${options.max}`, value);
  }
  return number;
}

function enumArg<T extends string>(
  args: Record<string, unknown>,
  key: string,
  values: readonly T[],
  fallback?: T,
): T {
  const value = args[key] ?? fallback;
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new EditApiError(
      "INVALID_ARGUMENT",
      `${key} must be one of ${values.join(", ")}`,
      `$.${key}`,
      values,
      value,
    );
  }
  return value as T;
}

function objectArg(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = args[key];
  if (!isRecord(value)) {
    throw new EditApiError("INVALID_ARGUMENT", `${key} must be a JSON object`, `$.${key}`, "object", value);
  }
  return value;
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function isInlineProject(project: ProjectSource): project is Project {
  return Array.isArray((project as Partial<Project>).maps);
}

function summaryOf(project: unknown): ProjectSummary {
  const record = isRecord(project) ? project : {};
  const maps = Array.isArray(record.maps) ? record.maps : null;
  const mapIndex = Array.isArray(record.mapIndex) ? record.mapIndex : null;
  const inline = maps !== null;
  const shell = !inline && mapIndex !== null;
  return {
    format: typeof record.format === "string" ? record.format : "unknown",
    title: typeof record.title === "string" ? record.title : "unknown",
    documentKind: shell ? "shell" : "inline",
    editable: inline,
    mapCount: maps?.length ?? mapIndex?.length ?? 0,
    revision: semanticHash(project),
  };
}

interface DocumentError {
  path: string;
  msg: string;
}

/** Invariants the JSON Schema cannot express but the runtime assumes. Also
 * reject duplicate ids so every advertised map/event address is unambiguous. */
function structuralErrors(project: ProjectSource): DocumentError[] {
  const errors: DocumentError[] = [];
  if (!isInlineProject(project)) {
    const seen = new Set<string>();
    project.mapIndex.forEach((map, index) => {
      if (seen.has(map.id)) errors.push({ path: `$.mapIndex[${index}].id`, msg: `duplicate map id ${JSON.stringify(map.id)}` });
      seen.add(map.id);
    });
    return errors;
  }
  const mapIds = new Set<string>();
  project.maps.forEach((map, mapIndex) => {
    try {
      validateMapDefStructure(map);
    } catch (error) {
      errors.push({ path: `$.maps[${mapIndex}]`, msg: error instanceof Error ? error.message : String(error) });
    }
    if (mapIds.has(map.id)) errors.push({ path: `$.maps[${mapIndex}].id`, msg: `duplicate map id ${JSON.stringify(map.id)}` });
    mapIds.add(map.id);
    const eventIds = new Set<string>();
    (map.events ?? []).forEach((event, eventIndex) => {
      if (eventIds.has(event.id)) errors.push({ path: `$.maps[${mapIndex}].events[${eventIndex}].id`, msg: `duplicate event id ${JSON.stringify(event.id)}` });
      eventIds.add(event.id);
      const w = event.w ?? 1;
      const h = event.h ?? 1;
      if (event.x < 0 || event.y < 0 || event.x + w > map.width || event.y + h > map.height) {
        errors.push({ path: `$.maps[${mapIndex}].events[${eventIndex}]`, msg: `event footprint (${event.x},${event.y}) ${w}x${h} is outside ${map.width}x${map.height}` });
      }
    });
  });
  if (!mapIds.has(project.start.map)) errors.push({ path: "$.start.map", msg: `unknown start map ${JSON.stringify(project.start.map)}` });
  else {
    const startMap = project.maps.find((map) => map.id === project.start.map)!;
    if (project.start.x < 0 || project.start.y < 0 || project.start.x >= startMap.width || project.start.y >= startMap.height) {
      errors.push({ path: "$.start", msg: `start (${project.start.x},${project.start.y}) is outside map ${startMap.id} ${startMap.width}x${startMap.height}` });
    }
  }
  return errors;
}

function loadValidProject(source: string): ProjectSource {
  const loaded = loadProject(source);
  const project = loaded.project as unknown as ProjectSource;
  const errors = loaded.errors.length === 0 ? structuralErrors(project) : loaded.errors;
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new EditApiError(
      "INVALID_DOCUMENT",
      `${first.path}: ${first.msg}`,
      first.path,
      first.msg,
      undefined,
      errors,
    );
  }
  return project;
}

function requireInline(project: ProjectSource): Project {
  if (!isInlineProject(project)) {
    throw new EditApiError(
      "READ_ONLY_PROJECT_SHELL",
      "executeEditOperation has no shard source; use executeShardedEditOperation or the file adapter for ProjectShell payload operations",
      "$.mapIndex",
      "inline project with $.maps",
    );
  }
  return project;
}

function findMap(project: Project, mapId: string): { map: MapDef; index: number } {
  const index = project.maps.findIndex((map) => map.id === mapId);
  if (index < 0) {
    throw new EditApiError(
      "MAP_NOT_FOUND",
      `map ${JSON.stringify(mapId)} does not exist; choose one of: ${project.maps.map((map) => map.id).join(", ")}`,
      "$.map",
      project.maps.map((map) => map.id),
      mapId,
    );
  }
  return { map: project.maps[index]!, index };
}

function findEvent(map: MapDef, eventId: string): { event: GameEvent; index: number } {
  const events = map.events ?? [];
  const index = events.findIndex((event) => event.id === eventId);
  if (index < 0) {
    throw new EditApiError(
      "EVENT_NOT_FOUND",
      `event ${JSON.stringify(eventId)} does not exist on map ${map.id}; choose one of: ${events.map((event) => event.id).join(", ") || "(none)"}`,
      "$.event",
      events.map((event) => event.id),
      eventId,
    );
  }
  return { event: events[index]!, index };
}

function findPage(event: GameEvent, pageIndex: number): Page {
  const page = event.pages[pageIndex];
  if (!page) {
    throw new EditApiError(
      "PAGE_NOT_FOUND",
      `page ${pageIndex} does not exist on event ${event.id}; valid indexes are 0..${event.pages.length - 1}`,
      "$.page",
      event.pages.map((_, index) => index),
      pageIndex,
    );
  }
  return page;
}

function mapAddress(mapId: string): string {
  return `map:${mapId}`;
}

function eventAddress(mapId: string, eventId: string): string {
  return `${mapAddress(mapId)}/event:${eventId}`;
}

function pageAddress(mapId: string, eventId: string, pageIndex: number): string {
  return `${eventAddress(mapId, eventId)}/page:${pageIndex}`;
}

function commandStableAddress(
  mapId: string,
  eventId: string,
  pageIndex: number,
  address: CommandAddress,
): string {
  return `${pageAddress(mapId, eventId, pageIndex)}/command:${commandAddressKey(address)}`;
}

function tileAddress(mapId: string, layer: Layer, x: number, y: number): string {
  return `${mapAddress(mapId)}/layer:${layer}/tile:${x},${y}`;
}

function editorAt(project: Project, mapIndex: number, eventId?: string, pageIndex?: number): EditorState {
  let state = createEditorState(project);
  state = selectMap(state, mapIndex);
  if (eventId !== undefined) {
    state = selectEvent(state, eventId, pageIndex ?? 0);
    if (state.selectedEventId !== eventId) {
      throw new EditApiError("EVENT_NOT_FOUND", `event ${JSON.stringify(eventId)} could not be selected`, "$.event");
    }
    if (pageIndex !== undefined && state.selectedPageIndex !== pageIndex) {
      throw new EditApiError("PAGE_NOT_FOUND", `page ${pageIndex} could not be selected`, "$.page");
    }
  }
  return state;
}

function assertEventBounds(map: MapDef, event: GameEvent, path: string): void {
  if (!Number.isInteger(event.x) || !Number.isInteger(event.y)) {
    throw new EditApiError("INVALID_ARGUMENT", "event x and y must be integers", path, "integer coordinates", { x: event.x, y: event.y });
  }
  const w = event.w ?? 1;
  const h = event.h ?? 1;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
    throw new EditApiError("INVALID_ARGUMENT", "event w and h must be positive integers", path, "positive integer footprint", { w, h });
  }
  if (event.x < 0 || event.y < 0 || event.x + w > map.width || event.y + h > map.height) {
    throw new EditApiError(
      "OUT_OF_BOUNDS",
      `event footprint (${event.x},${event.y}) ${w}x${h} does not fit map ${map.id} ${map.width}x${map.height}`,
      path,
      { x: `0..${map.width - w}`, y: `0..${map.height - h}`, w: `1..${map.width}`, h: `1..${map.height}` },
      { x: event.x, y: event.y, w, h },
    );
  }
}

function parseCommandPath(value: unknown, path = "$.address.path"): CommandListPath {
  if (!Array.isArray(value)) {
    throw new EditApiError("INVALID_ARGUMENT", "command path must be an array", path, "command path array", value);
  }
  return value.map((raw, index): CommandListPathSegment => {
    const at = `${path}[${index}]`;
    if (!isRecord(raw) || !Number.isInteger(raw.index) || (raw.index as number) < 0) {
      throw new EditApiError("INVALID_ARGUMENT", "each command path segment needs a non-negative integer index", at, "path segment", raw);
    }
    if (raw.kind === "if" && (raw.branch === "then" || raw.branch === "else")) {
      return { kind: "if", index: raw.index as number, branch: raw.branch };
    }
    if (raw.kind === "battle" && (raw.branch === "win" || raw.branch === "lose" || raw.branch === "escape")) {
      return { kind: "battle", index: raw.index as number, branch: raw.branch };
    }
    if (raw.kind === "scene" && (raw.branch === "done" || raw.branch === "cancel")) {
      return { kind: "scene", index: raw.index as number, branch: raw.branch };
    }
    if (raw.kind === "choices" && raw.branch === "cancel") {
      return { kind: "choices", index: raw.index as number, branch: "cancel" };
    }
    if (raw.kind === "choices" && raw.branch === "option" && Number.isInteger(raw.option) && (raw.option as number) >= 0) {
      return { kind: "choices", index: raw.index as number, branch: "option", option: raw.option as number };
    }
    throw new EditApiError(
      "INVALID_ARGUMENT",
      "invalid command path segment; expected an if, choices option/cancel, battle result, or scene result branch",
      at,
      ["if:then|else", "choices:option|cancel", "battle:win|lose|escape", "scene:done|cancel"],
      raw,
    );
  });
}

function parseCommandAddress(value: unknown): CommandAddress {
  if (!isRecord(value)) {
    throw new EditApiError("INVALID_ARGUMENT", "address must be an object with path and index", "$.address", "CommandAddress", value);
  }
  const index = integerArg(value, "index", { min: 0 })!;
  return { path: parseCommandPath(value.path ?? []), index };
}

function pointerEscape(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function pointerTokens(path: string): string[] {
  if (path === "") return [];
  if (!path.startsWith("/")) {
    throw new EditApiError("INVALID_PATCH", `patch path ${JSON.stringify(path)} is not an RFC 6901 JSON Pointer`, "$.patch.changes[].path");
  }
  return path.slice(1).split("/").map((part) => {
    if (/~(?:[^01]|$)/.test(part)) {
      throw new EditApiError("INVALID_PATCH", `patch path ${JSON.stringify(path)} contains an invalid JSON Pointer escape`, "$.patch.changes[].path");
    }
    return part.replace(/~1/g, "/").replace(/~0/g, "~");
  });
}

function present(value: unknown): PatchValue {
  assertJsonValue(value, "patch value");
  return { exists: true, value: cloneJson(value) };
}

const ABSENT: PatchValue = Object.freeze({ exists: false });

/** Deterministic, non-overlapping structural diff. Same-length arrays are
 * compared per element (tile edits stay small); a length change replaces the
 * array as one reversible unit (event/page/command insertion stays atomic). */
export function diffJson(before: unknown, after: unknown, path = ""): EditChange[] {
  if (semanticEqual(before, after)) return [];
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    return before.flatMap((value, index) => diffJson(value, after[index], `${path}/${index}`));
  }
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    const changes: EditChange[] = [];
    for (const key of keys) {
      const child = `${path}/${pointerEscape(key)}`;
      if (!own(before, key)) changes.push({ path: child, before: ABSENT, after: present(after[key]) });
      else if (!own(after, key)) changes.push({ path: child, before: present(before[key]), after: ABSENT });
      else changes.push(...diffJson(before[key], after[key], child));
    }
    return changes;
  }
  return [{ path, before: present(before), after: present(after) }];
}

export function semanticHash(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

function assertJsonValue(value: unknown, path: string, ancestors = new Set<object>()): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new EditApiError("INVALID_PATCH", `${path} contains a non-finite number`, path, "finite JSON number", value);
  }
  if (typeof value !== "object") {
    throw new EditApiError("INVALID_PATCH", `${path} contains a non-JSON value`, path, "JSON value", typeof value);
  }
  if (ancestors.has(value)) throw new EditApiError("INVALID_PATCH", `${path} contains a cycle`, path, "acyclic JSON value");
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, ancestors));
  } else {
    for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${path}.${key}`, ancestors);
  }
  ancestors.delete(value);
}

/** Build a reversible patch over any JSON semantic view. Inline projects use
 * the project object directly; sharded projects use ShardedEditDocument. */
export function createEditPatch(before: unknown, after: unknown): EditPatch {
  return {
    format: "rpgkit-edit/patch-v1",
    beforeHash: semanticHash(before),
    afterHash: semanticHash(after),
    changes: diffJson(before, after),
  };
}

function parsePatchSide(value: unknown, path: string): PatchValue {
  if (!isRecord(value) || typeof value.exists !== "boolean") {
    throw new EditApiError("INVALID_PATCH", "patch value must contain boolean exists", path, "{ exists: boolean, value?: JSON }", value);
  }
  if (!value.exists) return { exists: false };
  if (!own(value, "value")) {
    throw new EditApiError("INVALID_PATCH", "an existing patch value must include value", `${path}.value`, "JSON value");
  }
  assertJsonValue(value.value, `${path}.value`);
  return { exists: true, value: cloneJson(value.value) };
}

export function parseEditPatch(value: unknown): EditPatch {
  if (!isRecord(value) || value.format !== "rpgkit-edit/patch-v1") {
    throw new EditApiError("INVALID_PATCH", "patch format must be rpgkit-edit/patch-v1", "$.patch.format", "rpgkit-edit/patch-v1", isRecord(value) ? value.format : value);
  }
  if (typeof value.beforeHash !== "string" || !/^[0-9a-f]{64}$/.test(value.beforeHash)) {
    throw new EditApiError("INVALID_PATCH", "patch beforeHash must be a lowercase SHA-256", "$.patch.beforeHash");
  }
  if (typeof value.afterHash !== "string" || !/^[0-9a-f]{64}$/.test(value.afterHash)) {
    throw new EditApiError("INVALID_PATCH", "patch afterHash must be a lowercase SHA-256", "$.patch.afterHash");
  }
  if (!Array.isArray(value.changes)) {
    throw new EditApiError("INVALID_PATCH", "patch changes must be an array", "$.patch.changes", "array", value.changes);
  }
  const changes = value.changes.map((raw, index): EditChange => {
    if (!isRecord(raw) || typeof raw.path !== "string") {
      throw new EditApiError("INVALID_PATCH", "each patch change needs a JSON Pointer path", `$.patch.changes[${index}]`, "change", raw);
    }
    pointerTokens(raw.path);
    return {
      path: raw.path,
      before: parsePatchSide(raw.before, `$.patch.changes[${index}].before`),
      after: parsePatchSide(raw.after, `$.patch.changes[${index}].after`),
    };
  });
  return { format: value.format, beforeHash: value.beforeHash, afterHash: value.afterHash, changes };
}

export function patchSideAt(root: unknown, path: string): PatchValue {
  return sideAt(root, pointerTokens(path));
}

function sideAt(root: unknown, tokens: readonly string[]): PatchValue {
  if (tokens.length === 0) return present(root);
  let cursor: unknown = root;
  for (let index = 0; index < tokens.length - 1; index++) {
    const token = tokens[index]!;
    if (Array.isArray(cursor)) {
      if (!/^\d+$/.test(token) || Number(token) >= cursor.length) return ABSENT;
      cursor = cursor[Number(token)];
    } else if (isRecord(cursor) && own(cursor, token)) {
      cursor = cursor[token];
    } else {
      return ABSENT;
    }
  }
  const last = tokens[tokens.length - 1]!;
  if (Array.isArray(cursor)) {
    return /^\d+$/.test(last) && Number(last) < cursor.length ? present(cursor[Number(last)]) : ABSENT;
  }
  return isRecord(cursor) && own(cursor, last) ? present(cursor[last]) : ABSENT;
}

export function samePatchSide(a: PatchValue, b: PatchValue): boolean {
  return a.exists === b.exists && (!a.exists || (b.exists && semanticEqual(a.value, b.value)));
}

function setSide(root: unknown, tokens: readonly string[], side: PatchValue): unknown {
  if (tokens.length === 0) {
    if (!side.exists) throw new EditApiError("INVALID_PATCH", "a patch cannot remove the document root", "$.patch.changes[].after");
    return cloneJson(side.value);
  }
  let cursor = root as unknown;
  for (let index = 0; index < tokens.length - 1; index++) {
    const token = tokens[index]!;
    if (Array.isArray(cursor)) {
      const at = Number(token);
      if (!/^\d+$/.test(token) || at >= cursor.length) {
        throw new EditApiError("INVALID_PATCH", "patch path contains a missing array index", "$.patch.changes[].path", "existing array index", token);
      }
      cursor = cursor[at];
    } else if (isRecord(cursor) && own(cursor, token)) {
      cursor = cursor[token];
    } else {
      throw new EditApiError("INVALID_PATCH", "patch path contains a missing object property", "$.patch.changes[].path", "existing own property", token);
    }
  }
  const last = tokens[tokens.length - 1]!;
  if (Array.isArray(cursor)) {
    const at = Number(last);
    if (!Number.isInteger(at) || at < 0 || at >= cursor.length || !side.exists) {
      throw new EditApiError("INVALID_PATCH", "array patch entries must replace an existing index", "$.patch.changes[].path", "existing array index", last);
    }
    cursor[at] = cloneJson(side.value);
  } else if (isRecord(cursor)) {
    if (side.exists) {
      Object.defineProperty(cursor, last, {
        value: cloneJson(side.value),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    else delete cursor[last];
  } else {
    throw new EditApiError("INVALID_PATCH", "patch path parent is not a container", "$.patch.changes[].path");
  }
  return root;
}

export function applyEditPatch(
  project: Project,
  patchValue: unknown,
  direction: "forward" | "reverse" = "forward",
): Project {
  const next = applyEditPatchValue(project, patchValue, direction);
  validateEditedProject(next as Project);
  return next as Project;
}

/** Apply patch-v1 hash and per-change preconditions to an arbitrary JSON
 * semantic view. The caller owns domain validation of the result. */
export function applyEditPatchValue(
  value: unknown,
  patchValue: unknown,
  direction: "forward" | "reverse" = "forward",
): unknown {
  const patch = parseEditPatch(patchValue);
  const expectedHash = direction === "forward" ? patch.beforeHash : patch.afterHash;
  const resultHash = direction === "forward" ? patch.afterHash : patch.beforeHash;
  const actualHash = semanticHash(value);
  if (actualHash !== expectedHash) {
    throw new EditApiError(
      "PATCH_BASE_MISMATCH",
      `patch ${direction} base does not match this document`,
      "$.patch",
      expectedHash,
      actualHash,
    );
  }
  const next = applyEditChangesValue(value, patch.changes, direction);
  const actualResultHash = semanticHash(next);
  if (actualResultHash !== resultHash) {
    throw new EditApiError("INVALID_PATCH", "patch result hash does not match its declared result", "$.patch", resultHash, actualResultHash);
  }
  return next;
}

/** Apply a subset of reversible changes after checking every local before
 * value. Unlike applyEditPatch this deliberately has no whole-document hash
 * precondition, so independently clean proposal hunks can be rebased over
 * unrelated edits. The resulting project still passes every normal edit
 * validation gate. */
export function applyEditChanges(
  project: Project,
  rawChanges: readonly EditChange[],
  direction: "forward" | "reverse" = "forward",
): Project {
  // Reuse the strict wire parser instead of accepting richer in-memory
  // objects that could not have arrived through CLI/MCP JSON.
  const changes = parseEditPatch({
    format: "rpgkit-edit/patch-v1",
    beforeHash: "0".repeat(64),
    afterHash: "0".repeat(64),
    changes: rawChanges,
  }).changes;
  const next = applyEditChangesValue(project, changes, direction);
  validateEditedProject(next as Project);
  return next as Project;
}

function applyEditChangesValue(
  value: unknown,
  changes: readonly EditChange[],
  direction: "forward" | "reverse",
): unknown {
  let next: unknown = cloneJson(value);
  const ordered = direction === "forward" ? changes : [...changes].reverse();
  for (const change of ordered) {
    const tokens = pointerTokens(change.path);
    const expected = direction === "forward" ? change.before : change.after;
    const replacement = direction === "forward" ? change.after : change.before;
    const actual = sideAt(next, tokens);
    if (!samePatchSide(actual, expected)) {
      throw new EditApiError(
        "PATCH_CHANGE_MISMATCH",
        `patch precondition failed at ${change.path || "$"}`,
        change.path || "$",
        expected,
        actual,
      );
    }
    next = setSide(next, tokens, replacement);
  }
  return next;
}

export function validateEditedProject(project: Project): void {
  const errors = validateProject(project);
  if (errors.length === 0) errors.push(...structuralErrors(project));
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new EditApiError(
      "INVALID_EDIT",
      `edit would make the project invalid at ${first.path}: ${first.msg}`,
      first.path,
      first.msg,
      undefined,
      errors,
    );
  }
}

function selectTileBrush(
  state: EditorState,
  tile: unknown,
  key = "tile",
): { state: EditorState; tile: TileId } {
  if (tile !== null && typeof tile !== "string") {
    throw new EditApiError("INVALID_ARGUMENT", `${key} must be a tile id such as town.43, or null to erase`, `$.${key}`, "tile id or null", tile);
  }
  if (tile !== null && !canPaint(state, tile)) {
    const map = state.project.maps[state.mapIndex]!;
    throw new EditApiError(
      "INVALID_TILE",
      `tile ${JSON.stringify(tile)} is not paintable on map ${map.id}; it must name a declared sheet and an in-range cell`,
      `$.${key}`,
      map.sheets ?? [],
      tile,
    );
  }
  return { state: selectTile(state, tile as TileId), tile: tile as TileId };
}

function paintIndices(
  project: Project,
  mapIndex: number,
  layer: Layer,
  tile: unknown,
  indices: readonly number[],
  key = "tile",
): Project {
  let state = editorAt(project, mapIndex);
  state = selectLayer(state, layer);
  const brush = selectTileBrush(state, tile, key);
  state = brush.state;
  state = strokeStart(state, brush.tile === null);
  for (const index of indices) state = paintCell(state, index);
  state = strokeEnd(state);
  return exportProject(state);
}

function passageValueArg(args: Record<string, unknown>): "pass" | "block" | null {
  if (!own(args, "value")) {
    throw new EditApiError("INVALID_ARGUMENT", "value is required; pass null explicitly to clear", "$.value", "pass, block, or null");
  }
  const value = args.value;
  if (value !== null && value !== "pass" && value !== "block") {
    throw new EditApiError("INVALID_ARGUMENT", "value must be pass, block, or null", "$.value", ["pass", "block", null], value);
  }
  return value;
}

/** One passage stroke: a null value is the eraser (clears overrides). */
function paintPassageIndices(
  project: Project,
  mapIndex: number,
  value: "pass" | "block" | null,
  indices: readonly number[],
): Project {
  let state = editorAt(project, mapIndex);
  state = selectLayer(state, "passage");
  if (value !== null) state = selectPassageBrush(state, value);
  state = strokeStart(state, value === null);
  for (const index of indices) state = paintCell(state, index);
  state = strokeEnd(state);
  return exportProject(state);
}

interface CellList {
  /** Row-major indexes in request order; duplicates are kept (harmless). */
  indices: number[];
  /** Distinct cells in first-seen order, for addresses and counts. */
  distinct: { x: number; y: number }[];
}

/** Parse a free-form `[[x, y], ...]` brush path. Every cell must be in
 * bounds; the list is capped at one entry per map cell. */
function cellsArg(args: Record<string, unknown>, map: MapDef): CellList {
  const value = args.cells;
  const limit = map.width * map.height;
  if (!Array.isArray(value) || value.length === 0 || value.length > limit) {
    throw new EditApiError(
      "INVALID_ARGUMENT",
      `cells must be a non-empty array of at most ${limit} [x, y] pairs`,
      "$.cells",
      `1..${limit} [x, y] integer pairs`,
      Array.isArray(value) ? value.length : value,
    );
  }
  const indices: number[] = [];
  const distinct: { x: number; y: number }[] = [];
  const seen = new Uint8Array(limit);
  value.forEach((cell, at) => {
    const path = `$.cells[${at}]`;
    if (!Array.isArray(cell) || cell.length !== 2 || !Number.isInteger(cell[0]) || !Number.isInteger(cell[1])) {
      throw new EditApiError("INVALID_ARGUMENT", "each cell must be an [x, y] integer pair", path, "[x, y]", cell);
    }
    const [x, y] = cell as [number, number];
    if (x < 0 || y < 0 || x >= map.width || y >= map.height) {
      throw new EditApiError(
        "OUT_OF_BOUNDS",
        `cell (${x},${y}) is outside map ${map.id} ${map.width}x${map.height}`,
        path,
        { x: `0..${map.width - 1}`, y: `0..${map.height - 1}` },
        cell,
      );
    }
    const index = y * map.width + x;
    indices.push(index);
    if (!seen[index]) {
      seen[index] = 1;
      distinct.push({ x, y });
    }
  });
  return { indices, distinct };
}

const EDGE_DIRS: readonly Dir[] = ["up", "down", "left", "right"];

function edgeBrushArg(args: Record<string, unknown>): EdgeBrush {
  const brush = objectArg(args, "brush");
  const kinds = ["enter", "exit", "clear"] as const;
  const kind = brush.kind as (typeof kinds)[number];
  if (!kinds.includes(kind)) {
    throw new EditApiError("INVALID_ARGUMENT", `brush.kind must be one of ${kinds.join(", ")}`, "$.brush.kind", kinds, brush.kind);
  }
  const allowed = kind === "clear" ? ["kind"] : ["kind", "dir"];
  const unknown = Object.keys(brush).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new EditApiError("INVALID_ARGUMENT", `unsupported ${kind} brush field(s): ${unknown.join(", ")}`, "$.brush", allowed, unknown);
  }
  if (kind === "clear") return { kind };
  if (typeof brush.dir !== "string" || !EDGE_DIRS.includes(brush.dir as Dir)) {
    throw new EditApiError("INVALID_ARGUMENT", `brush.dir must be one of ${EDGE_DIRS.join(", ")}`, "$.brush.dir", EDGE_DIRS, brush.dir);
  }
  return { kind, dir: brush.dir as Dir };
}

function sheetAddress(sheetId: string, cell: string): string {
  return `sheet:${sheetId}/cell:${cell}`;
}

/** Sheet dirEdges entries whose value differs between two projects. */
function changedEdgeEntries(
  before: Project,
  after: Project,
): { sheet: string; cell: string; edges: JsonValue }[] {
  const changed: { sheet: string; cell: string; edges: JsonValue }[] = [];
  after.sheets.forEach((sheet, index) => {
    const old = before.sheets[index]?.dirEdges ?? {};
    const next = sheet.dirEdges ?? {};
    const cells = [...new Set([...Object.keys(old), ...Object.keys(next)])]
      .sort((a, b) => Number(a) - Number(b));
    for (const cell of cells) {
      if (semanticEqual(old[cell], next[cell])) continue;
      changed.push({ sheet: sheet.id, cell, edges: cloneJson((next[cell] ?? null) as JsonValue) });
    }
  });
  return changed;
}

/** Map a newMap refusal to the argument that caused it. */
function newMapErrorPath(error: string): string {
  if (error.startsWith("fill")) return "$.fill";
  if (error.includes("sheet")) return "$.sheets";
  if (error.startsWith("name")) return "$.name";
  return "$";
}

function pageArgs(project: Project, args: Record<string, unknown>): {
  mapId: string;
  map: MapDef;
  mapIndex: number;
  eventId: string;
  event: GameEvent;
  pageIndex: number;
  page: Page;
} {
  const mapId = stringArg(args, "map");
  const { map, index: mapIndex } = findMap(project, mapId);
  const eventId = stringArg(args, "event");
  const { event } = findEvent(map, eventId);
  const pageIndex = integerArg(args, "page", { min: 0 })!;
  return { mapId, map, mapIndex, eventId, event, pageIndex, page: findPage(event, pageIndex) };
}

function commandArgs(project: Project, args: Record<string, unknown>): ReturnType<typeof pageArgs> & { address: CommandAddress } {
  const selected = pageArgs(project, args);
  return { ...selected, address: parseCommandAddress(args.address) };
}

interface MutationResult {
  project: Project;
  addresses: string[];
  result: unknown;
}

function modelFailure(error: string, path: string): never {
  throw new EditApiError("INVALID_ARGUMENT", error, path);
}

function mutate(command: EditCommandName, project: Project, args: Record<string, unknown>): MutationResult {
  if (command === "update-map") {
    const mapId = stringArg(args, "map");
    const { map, index: mapIndex } = findMap(project, mapId);
    const changes = objectArg(args, "changes");
    const allowed = ["id", "name", "width", "height", "sheets"] as const;
    const unknown = Object.keys(changes).filter((key) => !allowed.includes(key as typeof allowed[number]));
    if (unknown.length > 0) {
      throw new EditApiError(
        "INVALID_ARGUMENT",
        `unsupported map field(s): ${unknown.join(", ")}`,
        "$.changes",
        allowed,
        unknown,
      );
    }
    let state = editorAt(project, mapIndex);
    let croppedEvents: string[] = [];
    if (own(changes, "id")) {
      if (typeof changes.id !== "string") {
        throw new EditApiError("INVALID_ARGUMENT", "map id must be a string", "$.changes.id", "string", changes.id);
      }
      const result = renameMap(state, changes.id);
      if (!result.ok) modelFailure(result.error, "$.changes.id");
      state = result.state;
    }
    if (own(changes, "name")) {
      if (typeof changes.name !== "string") {
        throw new EditApiError("INVALID_ARGUMENT", "map name must be a string", "$.changes.name", "string", changes.name);
      }
      const result = setMapName(state, changes.name);
      if (!result.ok) modelFailure(result.error, "$.changes.name");
      state = result.state;
    }
    if (own(changes, "width") || own(changes, "height")) {
      const width = integerArg(changes, "width", { min: 1, max: 256, optional: true }) ?? map.width;
      const height = integerArg(changes, "height", { min: 1, max: 256, optional: true }) ?? map.height;
      const result = resizeMap(state, width, height);
      if (!result.ok) modelFailure(result.error, own(changes, "width") ? "$.changes.width" : "$.changes.height");
      state = result.state;
      croppedEvents = result.croppedEvents;
    }
    if (own(changes, "sheets")) {
      if (!Array.isArray(changes.sheets) || changes.sheets.some((id) => typeof id !== "string" || id.length === 0)) {
        throw new EditApiError(
          "INVALID_ARGUMENT",
          "map sheets must be a non-empty array of non-empty strings",
          "$.changes.sheets",
          "non-empty string array",
          changes.sheets,
        );
      }
      const result = setMapSheets(state, changes.sheets as string[]);
      if (!result.ok) modelFailure(result.error, "$.changes.sheets");
      state = result.state;
    }
    const edited = exportProject(state);
    const updated = edited.maps[state.mapIndex]!;
    return {
      project: edited,
      addresses: updated.id === mapId ? [mapAddress(mapId)] : [mapAddress(mapId), mapAddress(updated.id)],
      result: { map: cloneJson(updated), croppedEvents },
    };
  }

  if (command === "add-map") {
    const options: NewMapOptions = {};
    if (args.map !== undefined) options.id = stringArg(args, "map");
    if (args.name !== undefined) {
      if (typeof args.name !== "string") {
        throw new EditApiError("INVALID_ARGUMENT", "name must be a string", "$.name", "string", args.name);
      }
      options.name = args.name;
    }
    const width = integerArg(args, "width", { min: 1, max: 256, optional: true });
    const height = integerArg(args, "height", { min: 1, max: 256, optional: true });
    if (width !== undefined) options.width = width;
    if (height !== undefined) options.height = height;
    if (args.sheets !== undefined) {
      if (!Array.isArray(args.sheets) || args.sheets.length === 0 ||
        args.sheets.some((id) => typeof id !== "string" || id.length === 0)) {
        throw new EditApiError("INVALID_ARGUMENT", "sheets must be a non-empty array of non-empty strings", "$.sheets", "non-empty string array", args.sheets);
      }
      options.sheets = args.sheets as string[];
    }
    if (args.fill !== undefined) {
      if (args.fill !== null && typeof args.fill !== "string") {
        throw new EditApiError("INVALID_ARGUMENT", "fill must be a tile id such as town.0, or null for void", "$.fill", "tile id or null", args.fill);
      }
      options.fill = args.fill;
    }
    // newMap inserts after the active map, so select the anchor first.
    const after = args.after === undefined
      ? project.maps.length - 1
      : findMap(project, stringArg(args, "after")).index;
    const result = newMap(editorAt(project, after), options);
    if (!result.ok) modelFailure(result.error, newMapErrorPath(result.error));
    const created = result.state.project.maps[result.state.mapIndex]!;
    return {
      project: exportProject(result.state),
      addresses: [mapAddress(created.id)],
      result: cloneJson(created),
    };
  }

  if (command === "duplicate-map") {
    const mapId = stringArg(args, "map");
    const { index: mapIndex } = findMap(project, mapId);
    const result = duplicateMap(editorAt(project, mapIndex));
    if (!result.ok) modelFailure(result.error, "$.map");
    const copy = result.state.project.maps[result.state.mapIndex]!;
    return {
      project: exportProject(result.state),
      addresses: [mapAddress(copy.id)],
      result: cloneJson(copy),
    };
  }

  if (command === "delete-map") {
    const mapId = stringArg(args, "map");
    const { map, index: mapIndex } = findMap(project, mapId);
    // Literal transfers into the deleted map are left in place (the visual
    // editor confirms the same way); report them so callers can retarget.
    const references = mapReferences(project, mapId);
    const result = deleteMap(editorAt(project, mapIndex), true);
    if (!result.ok) {
      throw new EditApiError(
        "MAP_DELETE_REFUSED",
        `map ${mapId} cannot be deleted: ${result.error}`,
        "$.map",
        "a map other than the start map, in a project with two or more maps",
        mapId,
        { references: result.references },
      );
    }
    return {
      project: exportProject(result.state),
      addresses: [mapAddress(mapId)],
      result: { deleted: cloneJson(map), references },
    };
  }

  if (command === "paint-passage") {
    const mapId = stringArg(args, "map");
    const { map, index: mapIndex } = findMap(project, mapId);
    const x = integerArg(args, "x", { min: 0, max: map.width - 1 })!;
    const y = integerArg(args, "y", { min: 0, max: map.height - 1 })!;
    const value = passageValueArg(args);
    return {
      project: paintPassageIndices(project, mapIndex, value, [y * map.width + x]),
      addresses: [tileAddress(mapId, "passage", x, y)],
      result: { map: mapId, x, y, value },
    };
  }

  if (command === "paint-cells") {
    const mapId = stringArg(args, "map");
    const { map, index: mapIndex } = findMap(project, mapId);
    const layer = enumArg(args, "layer", ["ground", "upper", "passage"] as const, "ground");
    const cells = cellsArg(args, map);
    let edited: Project;
    let value: unknown;
    if (layer === "passage") {
      value = passageValueArg(args);
      edited = paintPassageIndices(project, mapIndex, value as "pass" | "block" | null, cells.indices);
    } else {
      if (!own(args, "value")) {
        throw new EditApiError("INVALID_ARGUMENT", "value is required; pass null explicitly to erase", "$.value", "tile id or null");
      }
      value = args.value;
      edited = paintIndices(project, mapIndex, layer, value, cells.indices, "value");
    }
    return {
      project: edited,
      addresses: cells.distinct.map((cell) => tileAddress(mapId, layer, cell.x, cell.y)),
      result: { map: mapId, layer, value, cells: cells.distinct.length },
    };
  }

  if (command === "paint-edges") {
    const mapId = stringArg(args, "map");
    const { map, index: mapIndex } = findMap(project, mapId);
    const cells = cellsArg(args, map);
    const brush = edgeBrushArg(args);
    // dirEdges are sheet-level: each cell edits the entry of its ground
    // tile's sheet cell, and one stroke touches each sheet cell at most once.
    let state = editorAt(project, mapIndex);
    state = edgeStrokeStart(state, brush);
    for (const index of cells.indices) state = edgePaintCell(state, index);
    state = edgeStrokeEnd(state);
    const edited = exportProject(state);
    const changed = changedEdgeEntries(project, edited);
    return {
      project: edited,
      addresses: changed.map((entry) => sheetAddress(entry.sheet, entry.cell)),
      result: { map: mapId, brush, cells: cells.distinct.length, changed },
    };
  }

  if (command === "paint-tile" || command === "paint-rect" || command === "fill-region") {
    const mapId = stringArg(args, "map");
    const { map, index: mapIndex } = findMap(project, mapId);
    const layer = enumArg(args, "layer", ["ground", "upper"] as const, "ground");
    const x = integerArg(args, "x", { min: 0, max: map.width - 1 })!;
    const y = integerArg(args, "y", { min: 0, max: map.height - 1 })!;
    if (!own(args, "tile")) {
      throw new EditApiError("INVALID_ARGUMENT", "tile is required; pass null explicitly to erase", "$.tile", "tile id or null");
    }
    const tile = args.tile;
    let cells: { x: number; y: number }[] = [];
    if (command === "paint-tile") {
      cells = [{ x, y }];
    } else if (command === "paint-rect") {
      const width = integerArg(args, "width", { min: 1 })!;
      const height = integerArg(args, "height", { min: 1 })!;
      if (x + width > map.width || y + height > map.height) {
        throw new EditApiError(
          "OUT_OF_BOUNDS",
          `rectangle (${x},${y}) ${width}x${height} does not fit map ${map.id} ${map.width}x${map.height}`,
          "$",
          { maxWidth: map.width - x, maxHeight: map.height - y },
          { x, y, width, height },
        );
      }
      for (let py = y; py < y + height; py++) {
        for (let px = x; px < x + width; px++) cells.push({ x: px, y: py });
      }
    } else {
      const source = layer === "ground" ? map.ground : toDenseUpper(map);
      const origin = y * map.width + x;
      const target = source[origin];
      if (target !== tile) {
        const seen = new Uint8Array(source.length);
        const queue = [origin];
        seen[origin] = 1;
        for (let cursor = 0; cursor < queue.length; cursor++) {
          const index = queue[cursor]!;
          cells.push({ x: index % map.width, y: Math.floor(index / map.width) });
          const cx = index % map.width;
          const cy = Math.floor(index / map.width);
          const neighbors = [
            cx > 0 ? index - 1 : -1,
            cx + 1 < map.width ? index + 1 : -1,
            cy > 0 ? index - map.width : -1,
            cy + 1 < map.height ? index + map.width : -1,
          ];
          for (const neighbor of neighbors) {
            if (neighbor >= 0 && !seen[neighbor] && source[neighbor] === target) {
              seen[neighbor] = 1;
              queue.push(neighbor);
            }
          }
        }
      }
    }
    const edited = paintIndices(project, mapIndex, layer, tile, cells.map((cell) => cell.y * map.width + cell.x));
    return {
      project: edited,
      addresses: cells.map((cell) => tileAddress(mapId, layer, cell.x, cell.y)),
      result: { map: mapId, layer, tile, cells: cells.length },
    };
  }

  if (command === "add-event") {
    const mapId = stringArg(args, "map");
    const { map, index: mapIndex } = findMap(project, mapId);
    const raw = objectArg(args, "event");
    if (typeof raw.id !== "string" || !EVENT_ID_RE.test(raw.id)) {
      throw new EditApiError("INVALID_ARGUMENT", "event.id must match ^[A-Za-z0-9_-]+$", "$.event.id", "letters, digits, underscore, or hyphen", raw.id);
    }
    if ((map.events ?? []).some((event) => event.id === raw.id)) {
      throw new EditApiError("DUPLICATE_EVENT", `event ${JSON.stringify(raw.id)} already exists on map ${mapId}`, "$.event.id", "unique map-local id", raw.id);
    }
    if (!Array.isArray(raw.pages) || raw.pages.length === 0) {
      throw new EditApiError("INVALID_ARGUMENT", "event.pages must contain at least one page", "$.event.pages", "non-empty array", raw.pages);
    }
    const event = cloneJson(raw) as unknown as GameEvent;
    assertEventBounds(map, event, "$.event");
    let state = editorAt(project, mapIndex);
    state = createEventAt(state, event.x, event.y);
    state = updateSelectedEvent(state, () => event);
    const edited = exportProject(state);
    const inserted = edited.maps[mapIndex]!.events!.find((candidate) => candidate.id === event.id);
    if (!inserted) throw new EditApiError("INVALID_EDIT", "editor model could not create the requested event", "$.event");
    return { project: edited, addresses: [eventAddress(mapId, event.id)], result: cloneJson(inserted) };
  }

  if (command === "update-event") {
    const mapId = stringArg(args, "map");
    const { map, index: mapIndex } = findMap(project, mapId);
    const eventId = stringArg(args, "event");
    const { event } = findEvent(map, eventId);
    const changes = objectArg(args, "changes");
    const allowed = new Set(["id", "name", "x", "y", "w", "h"]);
    const unknown = Object.keys(changes).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
      throw new EditApiError("INVALID_ARGUMENT", `unsupported event field(s): ${unknown.join(", ")}`, "$.changes", [...allowed], unknown);
    }
    const candidate = cloneJson(event) as GameEvent & Record<string, unknown>;
    for (const [key, value] of Object.entries(changes)) {
      if (value === null && ["name", "w", "h"].includes(key)) delete candidate[key];
      else candidate[key] = cloneJson(value);
    }
    if (typeof candidate.id !== "string" || !EVENT_ID_RE.test(candidate.id)) {
      throw new EditApiError("INVALID_ARGUMENT", "event id must match ^[A-Za-z0-9_-]+$", "$.changes.id", "letters, digits, underscore, or hyphen", candidate.id);
    }
    if (candidate.id !== eventId && (map.events ?? []).some((item) => item.id === candidate.id)) {
      throw new EditApiError("DUPLICATE_EVENT", `event ${JSON.stringify(candidate.id)} already exists on map ${mapId}`, "$.changes.id", "unique map-local id", candidate.id);
    }
    assertEventBounds(map, candidate, "$.changes");
    let state = editorAt(project, mapIndex, eventId);
    state = updateSelectedEvent(state, () => candidate);
    const edited = exportProject(state);
    return {
      project: edited,
      addresses: [eventAddress(mapId, eventId), ...(candidate.id === eventId ? [] : [eventAddress(mapId, candidate.id)])],
      result: cloneJson(edited.maps[mapIndex]!.events!.find((item) => item.id === candidate.id)),
    };
  }

  if (command === "delete-event") {
    const mapId = stringArg(args, "map");
    const { map, index: mapIndex } = findMap(project, mapId);
    const eventId = stringArg(args, "event");
    const { event } = findEvent(map, eventId);
    let state = editorAt(project, mapIndex, eventId);
    state = deleteSelectedEvent(state);
    return { project: exportProject(state), addresses: [eventAddress(mapId, eventId)], result: { deleted: cloneJson(event) } };
  }

  if (command === "add-page") {
    const mapId = stringArg(args, "map");
    const { map, index: mapIndex } = findMap(project, mapId);
    const eventId = stringArg(args, "event");
    const { event } = findEvent(map, eventId);
    const page = cloneJson(objectArg(args, "page")) as unknown as Page;
    const requestedIndex = integerArg(args, "index", { min: 0, max: event.pages.length, optional: true }) ?? event.pages.length;
    let state = editorAt(project, mapIndex, eventId, 0);
    state = addPage(state, page);
    if (requestedIndex !== event.pages.length) state = movePage(state, requestedIndex);
    const edited = exportProject(state);
    return {
      project: edited,
      addresses: [pageAddress(mapId, eventId, requestedIndex)],
      result: cloneJson(edited.maps[mapIndex]!.events!.find((item) => item.id === eventId)!.pages[requestedIndex]),
    };
  }

  if (command === "update-page") {
    const selected = pageArgs(project, args);
    const replacement = cloneJson(objectArg(args, "value")) as unknown as Page;
    let state = editorAt(project, selected.mapIndex, selected.eventId, selected.pageIndex);
    state = updateSelectedPage(state, () => replacement);
    return {
      project: exportProject(state),
      addresses: [pageAddress(selected.mapId, selected.eventId, selected.pageIndex)],
      result: cloneJson(replacement),
    };
  }

  if (command === "delete-page") {
    const selected = pageArgs(project, args);
    if (selected.event.pages.length === 1) {
      throw new EditApiError("LAST_PAGE", `event ${selected.eventId} must retain at least one page`, "$.page", "event with two or more pages", selected.pageIndex);
    }
    let state = editorAt(project, selected.mapIndex, selected.eventId, selected.pageIndex);
    state = deletePage(state);
    return {
      project: exportProject(state),
      addresses: [pageAddress(selected.mapId, selected.eventId, selected.pageIndex)],
      result: { deleted: cloneJson(selected.page) },
    };
  }

  if (command === "insert-command") {
    const selected = commandArgs(project, args);
    const commandRecord = objectArg(args, "command");
    if (typeof commandRecord.op !== "string" || commandRecord.op.length === 0) {
      throw new EditApiError("INVALID_ARGUMENT", "command.op must be a non-empty string", "$.command.op", "command op", commandRecord.op);
    }
    // insertCommand deliberately preserves opaque runtime commands intact;
    // the whole-project schema gate below decides whether the payload is a
    // valid Command. Only field-level updates are limited to editor-owned ops.
    const commandValue = cloneJson(commandRecord) as unknown as Command;
    const list = getCommandList(selected.page.commands, selected.address.path);
    if (!list || selected.address.index > list.length) {
      throw new EditApiError("COMMAND_ADDRESS_NOT_FOUND", "command insertion address does not resolve to a list slot", "$.address", `index 0..${list?.length ?? 0}`, selected.address);
    }
    const commands = insertCommand(selected.page.commands, selected.address, commandValue);
    let state = editorAt(project, selected.mapIndex, selected.eventId, selected.pageIndex);
    state = updateSelectedPage(state, (page) => ({ ...page, commands }));
    return {
      project: exportProject(state),
      addresses: [commandStableAddress(selected.mapId, selected.eventId, selected.pageIndex, selected.address)],
      result: cloneJson(commandValue),
    };
  }

  if (command === "delete-command") {
    const selected = commandArgs(project, args);
    const before = getCommand(selected.page.commands, selected.address);
    if (!before) {
      throw new EditApiError("COMMAND_ADDRESS_NOT_FOUND", "command deletion address does not resolve to a command", "$.address", "existing command", selected.address);
    }
    const commands = deleteCommand(selected.page.commands, selected.address);
    let state = editorAt(project, selected.mapIndex, selected.eventId, selected.pageIndex);
    state = updateSelectedPage(state, (page) => ({ ...page, commands }));
    return {
      project: exportProject(state),
      addresses: [commandStableAddress(selected.mapId, selected.eventId, selected.pageIndex, selected.address)],
      result: { deleted: cloneJson(before) },
    };
  }

  if (command === "update-command") {
    const selected = commandArgs(project, args);
    const before = getCommand(selected.page.commands, selected.address);
    if (!before) {
      throw new EditApiError("COMMAND_ADDRESS_NOT_FOUND", "command update address does not resolve to a command", "$.address", "existing command", selected.address);
    }
    const beforeOp = before.op;
    if (!isEditableCommand(before as unknown)) {
      throw new EditApiError("READ_ONLY_COMMAND", `${beforeOp} commands are retained but cannot be field-edited`, "$.address", "editor-owned command", beforeOp);
    }
    const field = stringArg(args, "field");
    const value = args.value;
    if (typeof value !== "string") {
      throw new EditApiError("INVALID_ARGUMENT", "command field values use their editor text spelling", "$.value", "string", value);
    }
    const resources = eventEditorResources(project, selected.map);
    const editedField = editCommandField(before, field, value);
    if (!editedField.ok) {
      const fields = commandFields(before, resources).map((item) => item.key);
      throw new EditApiError(
        "INVALID_COMMAND_FIELD",
        `${field}: ${editedField.error}; legal fields for ${before.op}: ${fields.join(", ") || "(none)"}`,
        `$.command.${field}`,
        fields,
        value,
      );
    }
    const commands = updateCommand(selected.page.commands, selected.address, editedField.value);
    let state = editorAt(project, selected.mapIndex, selected.eventId, selected.pageIndex);
    state = updateSelectedPage(state, (page) => ({ ...page, commands }));
    return {
      project: exportProject(state),
      addresses: [commandStableAddress(selected.mapId, selected.eventId, selected.pageIndex, selected.address)],
      result: cloneJson(editedField.value),
    };
  }

  if (command === "save") {
    const direction = enumArg(args, "direction", ["forward", "reverse"] as const, "forward");
    const patch = parseEditPatch(args.patch);
    const edited = applyEditPatch(project, patch, direction);
    return {
      project: edited,
      addresses: patch.changes.map((change) => change.path || "$"),
      result: { direction, beforeHash: semanticHash(project), afterHash: semanticHash(edited) },
    };
  }

  throw new EditApiError("UNKNOWN_COMMAND", `unsupported modifying command ${command}`);
}

function readOperation(command: EditCommandName, project: ProjectSource, args: Record<string, unknown>): unknown {
  if (command === "open") {
    return {
      ...summaryOf(project),
      start: cloneJson(project.start),
      sheets: project.sheets.map((sheet) => ({ id: sheet.id, cols: sheet.cols, rows: sheet.rows })),
    };
  }
  if (command === "list-maps") {
    if (isInlineProject(project)) {
      return project.maps.map((map) => ({
        address: mapAddress(map.id),
        id: map.id,
        name: map.name,
        width: map.width,
        height: map.height,
        sheets: [...(map.sheets ?? [])],
        eventCount: map.events?.length ?? 0,
      }));
    }
    return (project as ProjectShell).mapIndex.map((map) => ({
      address: mapAddress(map.id),
      id: map.id,
      width: map.width,
      height: map.height,
      entry: map.entry,
      sha256: map.sha256,
    }));
  }
  const inline = requireInline(project);
  if (command === "list-events") {
    const mapId = stringArg(args, "map");
    const { map } = findMap(inline, mapId);
    return (map.events ?? []).map((event) => ({
      address: eventAddress(mapId, event.id),
      id: event.id,
      ...(event.name === undefined ? {} : { name: event.name }),
      x: event.x,
      y: event.y,
      w: event.w ?? 1,
      h: event.h ?? 1,
      pageCount: event.pages.length,
    }));
  }
  if (command === "list-pages") {
    const mapId = stringArg(args, "map");
    const { map } = findMap(inline, mapId);
    const eventId = stringArg(args, "event");
    const { event } = findEvent(map, eventId);
    return event.pages.map((page, index) => ({
      address: pageAddress(mapId, eventId, index),
      index,
      trigger: page.trigger,
      ...(page.condition === undefined ? {} : { condition: cloneJson(page.condition) }),
      ...(page.sprite === undefined ? {} : { sprite: page.sprite }),
      blocks: page.blocks ?? false,
      commandCount: flattenCommands(page.commands).length,
    }));
  }
  if (command === "list-commands") {
    const selected = pageArgs(inline, args);
    return flattenCommands(selected.page.commands).map((row) => ({
      address: commandStableAddress(selected.mapId, selected.eventId, selected.pageIndex, row.address),
      commandAddress: cloneJson(row.address),
      key: row.key,
      depth: row.depth,
      ...(row.branch === undefined ? {} : { branch: row.branch }),
      summary: row.summary,
      readOnly: row.readOnly,
      command: cloneJson(row.command),
    }));
  }
  throw new EditApiError("UNKNOWN_COMMAND", `unsupported read command ${command}`);
}

/** Execute one operation against source text. This function performs no file
 * I/O and is safe for tests, the CLI and MCP to share. */
export function executeEditOperation(
  source: string,
  commandValue: string,
  rawArgs: unknown = {},
): EditExecution {
  try {
    const { command, args } = validateEditOperationInput(commandValue, rawArgs);
    if (command === "validate") {
      const loaded = loadProject(source);
      const structural = loaded.errors.length === 0
        ? structuralErrors(loaded.project as unknown as ProjectSource)
        : [];
      const errors = [...loaded.errors, ...structural];
      const response: EditSuccess = {
        ok: true,
        command,
        project: summaryOf(loaded.project),
        changed: false,
        addresses: [],
        diff: [],
        result: { valid: errors.length === 0, errors },
      };
      return { response };
    }
    const project = loadValidProject(source);
    if (!WRITE_COMMANDS.has(command)) {
      const response: EditSuccess = {
        ok: true,
        command,
        project: summaryOf(project),
        changed: false,
        addresses: [],
        diff: [],
        result: readOperation(command, project, args),
      };
      return { response };
    }

    const inline = requireInline(project);
    const mutation = mutate(command, inline, args);
    validateEditedProject(mutation.project);
    const patch = createEditPatch(inline, mutation.project);
    const output = serializeProjectPreservingSource(source, inline, mutation.project);
    const response: EditSuccess = {
      ok: true,
      command,
      project: summaryOf(mutation.project),
      changed: patch.changes.length > 0,
      addresses: mutation.addresses,
      diff: patch.changes,
      patch,
      result: mutation.result,
    };
    return { response, output };
  } catch (error) {
    return fail(commandValue || undefined, error);
  }
}
