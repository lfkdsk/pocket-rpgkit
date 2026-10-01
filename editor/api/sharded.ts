// editor/api/sharded.ts — ProjectShell editing as a bounded logical document.
//
// Host adapters decide which entry bytes to read. This module validates those
// bytes and presents the existing inline reducers with either one target map
// or (only for validation and id renames) the complete map set.

import type {
  MapDef,
  MapIndexEntry,
  Project,
  ProjectShell,
  ProjectSource,
} from "../../src/engine/types.ts";
import {
  MAP_SCHEMA_HASH,
  canonicalMapJson,
  mapManifestHash,
  resolveMapManifestHash,
  sha256Text,
  validateMapDef,
  validateMapIndex,
} from "../../src/engine/map-repository.ts";
import { loadProject, semanticEqual } from "../engine/document.ts";
import { eventCountProblem, MAX_SHARD_BYTES, shardProblem, utf8Bytes } from "./limits.ts";
import {
  EditApiError,
  applyEditPatchValue,
  createEditPatch,
  executeEditOperation,
  parseEditPatch,
  semanticHash,
  validateEditOperationInput,
} from "./operations.ts";
import type {
  EditFailure,
  EditResponse,
  EditSuccess,
  ProjectSummary,
  ShardedEditDocument,
  ShardedEditExecution,
} from "./types.ts";

export const SHARDED_DOCUMENT_KIND = "rpgkit-edit/sharded-document-v1" as const;

const NO_SHARD_COMMANDS = new Set(["open", "list-maps"]);

/** Commands that cannot be expressed over a shell in patch-v1. Map
 * add/duplicate/delete would add or remove mapIndex entries, which patch-v1
 * keeps stable so a reverse patch can reacquire the same physical shards.
 * Sheet dirEdges are project-global shell data, while a single-map edit
 * only writes back its shard and index metadata, so edge strokes fail closed
 * instead of silently dropping the sheet change. */
const SHELL_UNSUPPORTED_COMMANDS: ReadonlyMap<string, string> = new Map([
  ["add-map", "adding a map would add a mapIndex entry; patch-v1 keeps ProjectShell mapIndex entries stable"],
  ["duplicate-map", "duplicating a map would add a mapIndex entry; patch-v1 keeps ProjectShell mapIndex entries stable"],
  ["delete-map", "deleting a map would remove a mapIndex entry; patch-v1 keeps ProjectShell mapIndex entries stable"],
  ["paint-edges", "sheet dirEdges are project-global; edit them in an inline project"],
]);

function assertShellSupported(command: string): void {
  const reason = SHELL_UNSUPPORTED_COMMANDS.get(command);
  if (reason === undefined) return;
  throw new EditApiError(
    "UNSUPPORTED_FOR_SHELL",
    `${command} is not supported for a sharded ProjectShell: ${reason}`,
    "$.command",
    "an inline project with $.maps",
    command,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function own(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function failure(command: string | undefined, error: unknown): ShardedEditExecution {
  const known = error instanceof EditApiError
    ? error
    : new EditApiError("INVALID_DOCUMENT", error instanceof Error ? error.message : String(error));
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

function invalidDocument(path: string, message: string, details?: unknown): never {
  throw new EditApiError("INVALID_DOCUMENT", `${path}: ${message}`, path, message, undefined, details);
}

/** Cheap routing predicate. Validation remains the responsibility of
 * loadValidatedProjectShell, so malformed shells still get useful errors. */
export function sourceDeclaresProjectShell(source: string): boolean {
  try {
    const parsed = JSON.parse(source) as unknown;
    return isRecord(parsed) && own(parsed, "mapIndex") && !own(parsed, "maps");
  } catch {
    return false;
  }
}

/** Validate the shell schema, index uniqueness/content identity, schema
 * identity and start-map metadata without touching a shard. */
export function loadValidatedProjectShell(source: string): ProjectShell {
  const loaded = loadProject(source);
  if (loaded.errors.length > 0) {
    const first = loaded.errors[0]!;
    invalidDocument(first.path, first.msg, loaded.errors);
  }
  const value = loaded.project as unknown as ProjectSource;
  if (!("mapIndex" in value) || "maps" in value) {
    invalidDocument("$", "expected a ProjectShell with mapIndex and without maps");
  }
  const shell = value as ProjectShell;
  let index: Map<string, MapIndexEntry>;
  try {
    index = validateMapIndex(shell.mapIndex);
  } catch (error) {
    invalidDocument("$.mapIndex", error instanceof Error ? error.message : String(error));
  }
  if (shell.mapSchemaHash !== undefined && shell.mapSchemaHash !== MAP_SCHEMA_HASH) {
    invalidDocument("$.mapSchemaHash", "map schema hash does not match this RPG Kit build");
  }
  try {
    // Missing hashes retain the ProjectShell runtime's documented computed
    // fallback. A declared hash is always recomputed and checked here.
    resolveMapManifestHash(shell, shell.mapManifestHash !== undefined);
  } catch (error) {
    invalidDocument("$.mapManifestHash", error instanceof Error ? error.message : String(error));
  }
  const start = index.get(shell.start.map);
  if (!start) invalidDocument("$.start.map", `unknown start map ${JSON.stringify(shell.start.map)}`);
  if (shell.start.x >= start.width || shell.start.y >= start.height) {
    invalidDocument(
      "$.start",
      `start (${shell.start.x},${shell.start.y}) is outside map ${start.id} ${start.width}x${start.height}`,
    );
  }
  return shell;
}

function pointerTokens(path: string): string[] {
  if (!path.startsWith("/")) {
    throw new EditApiError("INVALID_PATCH", "sharded patch paths must start with /shell or /shards", "$.patch.changes[].path");
  }
  return path.slice(1).split("/").map((part) => {
    if (/~(?:[^01]|$)/.test(part)) {
      throw new EditApiError("INVALID_PATCH", `invalid JSON Pointer escape in ${JSON.stringify(path)}`, "$.patch.changes[].path");
    }
    return part.replace(/~1/g, "/").replace(/~0/g, "~");
  });
}

/** Determine the exact shard set a file adapter must load. Ordinary map
 * operations return one entry; open/list return zero; validate and a real id
 * rename return all. save derives its set solely from logical patch paths. */
export function shardEntriesForOperation(
  shell: ProjectShell,
  command: string,
  rawArgs: unknown = {},
): string[] {
  const { args } = validateEditOperationInput(command, rawArgs);
  // Refuse before any shard selection: add-map has no map argument at all.
  assertShellSupported(command);
  if (NO_SHARD_COMMANDS.has(command)) return [];
  if (command === "validate") return shell.mapIndex.map((meta) => meta.entry);
  if (command === "save") {
    const patch = parseEditPatch(args.patch);
    const entries = new Set<string>();
    const available = new Set(shell.mapIndex.map((meta) => meta.entry));
    for (const change of patch.changes) {
      const tokens = pointerTokens(change.path);
      if (tokens[0] === "shell" && tokens.length >= 2) continue;
      if (tokens[0] !== "shards" || tokens.length < 3) {
        throw new EditApiError(
          "INVALID_PATCH",
          "ProjectShell patches may change only /shell/... and /shards/<entry>/...",
          change.path || "$",
        );
      }
      const entry = tokens[1]!;
      if (!available.has(entry)) {
        throw new EditApiError("INVALID_PATCH", `patch refers to unknown shard entry ${JSON.stringify(entry)}`, change.path);
      }
      entries.add(entry);
    }
    return [...entries];
  }
  if (typeof args.map !== "string" || args.map.length === 0) {
    throw new EditApiError("INVALID_ARGUMENT", "map must be a non-empty string", "$.map", "non-empty string", args.map);
  }
  const meta = shell.mapIndex.find((item) => item.id === args.map);
  if (!meta) {
    throw new EditApiError(
      "MAP_NOT_FOUND",
      `map ${JSON.stringify(args.map)} does not exist; choose one of: ${shell.mapIndex.map((item) => item.id).join(", ")}`,
      "$.map",
      shell.mapIndex.map((item) => item.id),
      args.map,
    );
  }
  if (command === "update-map" && isRecord(args.changes) &&
    typeof args.changes.id === "string" && args.changes.id !== meta.id) {
    return shell.mapIndex.map((item) => item.entry);
  }
  return [meta.entry];
}

function shardError(entry: string, message: string): never {
  invalidDocument(`$.shards[${JSON.stringify(entry)}]`, message);
}

function validateMapSemantics(map: MapDef, fail: (message: string) => never): void {
  const eventIds = new Set<string>();
  for (const [eventIndex, event] of (map.events ?? []).entries()) {
    if (eventIds.has(event.id)) fail(`duplicate event id ${JSON.stringify(event.id)}`);
    eventIds.add(event.id);
    const width = event.w ?? 1;
    const height = event.h ?? 1;
    if (event.x + width > map.width || event.y + height > map.height) {
      fail(`event ${eventIndex} footprint is outside ${map.id} ${map.width}x${map.height}`);
    }
  }
}

/** Full-schema, raw-checksum and metadata validation for one entry. */
export function loadValidatedMapShard(shell: ProjectShell, entry: string, source: string): MapDef {
  const meta = shell.mapIndex.find((item) => item.entry === entry);
  if (!meta) shardError(entry, "entry is absent from mapIndex");
  const path = `$.shards[${JSON.stringify(entry)}]`;
  const tooBig = shardProblem(entry, utf8Bytes(source, MAX_SHARD_BYTES));
  if (tooBig !== null) throw new EditApiError("TOO_LARGE", tooBig, path);
  if (sha256Text(source) !== meta.sha256) shardError(entry, `checksum mismatch for ${meta.id}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    shardError(entry, `invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (isRecord(parsed) && Array.isArray(parsed.events)) {
    const tooMany = eventCountProblem(meta.id, parsed.events.length);
    if (tooMany !== null) throw new EditApiError("TOO_LARGE", tooMany, `${path}.events`);
  }
  try {
    validateMapDef(parsed);
  } catch (error) {
    shardError(entry, error instanceof Error ? error.message : String(error));
  }
  const map = parsed as MapDef;
  if (map.id !== meta.id || map.width !== meta.width || map.height !== meta.height) {
    shardError(
      entry,
      `metadata mismatch: index has ${meta.id} ${meta.width}x${meta.height}, shard has ${map.id} ${map.width}x${map.height}`,
    );
  }
  validateMapSemantics(map, (message) => shardError(entry, message));
  return map;
}

function loadedMaps(
  shell: ProjectShell,
  sources: Readonly<Record<string, string>>,
  entries: readonly string[],
): Map<string, MapDef> {
  const maps = new Map<string, MapDef>();
  for (const entry of entries) {
    if (!own(sources, entry)) shardError(entry, "required shard source was not loaded");
    maps.set(entry, loadValidatedMapShard(shell, entry, sources[entry]!));
  }
  return maps;
}

function projectFromMaps(shell: ProjectShell, maps: readonly MapDef[], exactStart: boolean): Project {
  const {
    mapIndex: _index,
    mapManifestHash: _manifest,
    mapSchemaHash: _schema,
    ...globals
  } = shell;
  let start = globals.start;
  if (!exactStart && !maps.some((map) => map.id === start.map)) {
    const map = maps[0]!;
    start = { ...start, map: map.id, x: 0, y: 0 };
  }
  return { ...cloneJson(globals), start: cloneJson(start), maps: maps.map(cloneJson) };
}

function shardedView(shell: ProjectShell, maps: ReadonlyMap<string, MapDef>): ShardedEditDocument {
  const shards = Object.create(null) as Record<string, MapDef>;
  for (const [entry, map] of maps) shards[entry] = cloneJson(map);
  return { kind: SHARDED_DOCUMENT_KIND, shell: cloneJson(shell), shards };
}

function summary(shell: ProjectShell, view: ShardedEditDocument): ProjectSummary {
  return {
    format: shell.format,
    title: shell.title,
    documentKind: "shell",
    editable: true,
    mapCount: shell.mapIndex.length,
    revision: semanticHash(view),
  };
}

function shellRead(
  shell: ProjectShell,
  command: "open" | "list-maps",
): ShardedEditExecution {
  const view = shardedView(shell, new Map());
  const project = summary(shell, view);
  const result = command === "open"
    ? {
        ...project,
        start: cloneJson(shell.start),
        sheets: shell.sheets.map((sheet) => ({ id: sheet.id, cols: sheet.cols, rows: sheet.rows })),
      }
    : shell.mapIndex.map((map) => ({
        address: `map:${map.id}`,
        id: map.id,
        width: map.width,
        height: map.height,
        entry: map.entry,
        sha256: map.sha256,
      }));
  return {
    response: {
      ok: true,
      command,
      project,
      changed: false,
      addresses: [],
      diff: [],
      result,
    },
  };
}

function withProject(response: EditResponse, project: ProjectSummary): EditResponse {
  return response.ok ? { ...response, project } : response;
}

function updateShell(
  shell: ProjectShell,
  edited: Project,
  beforeByEntry: ReadonlyMap<string, MapDef>,
  allMapsLoaded: boolean,
): { shell: ProjectShell; changed: Map<string, MapDef>; texts: Record<string, string> } {
  const changed = new Map<string, MapDef>();
  const texts = Object.create(null) as Record<string, string>;
  const oldEntries = shell.mapIndex;
  const editedByOldEntry = new Map<string, MapDef>();
  const loadedEntries = [...beforeByEntry.keys()];
  edited.maps.forEach((map, index) => editedByOldEntry.set(loadedEntries[index]!, map));
  for (const entry of loadedEntries) {
    const before = beforeByEntry.get(entry)!;
    const after = editedByOldEntry.get(entry)!;
    if (!semanticEqual(before, after)) {
      changed.set(entry, after);
      texts[entry] = canonicalMapJson(after);
    }
  }
  if (changed.size === 0) return { shell, changed, texts };

  let next: ProjectShell;
  if (allMapsLoaded) {
    const { maps: _maps, ...globals } = edited;
    next = { ...globals, mapIndex: oldEntries.map((meta) => ({ ...meta })) };
  } else {
    next = { ...cloneJson(shell), mapIndex: oldEntries.map((meta) => ({ ...meta })) };
  }
  next.mapIndex = next.mapIndex.map((meta) => {
    const map = changed.get(meta.entry);
    return map === undefined
      ? meta
      : {
          id: map.id,
          width: map.width,
          height: map.height,
          entry: meta.entry,
          sha256: sha256Text(texts[meta.entry]!),
        };
  });
  next.mapSchemaHash = MAP_SCHEMA_HASH;
  delete next.mapManifestHash;
  next.mapManifestHash = mapManifestHash(next);
  return { shell: next, changed, texts };
}

function serializeShell(shell: ProjectShell): string {
  return `${JSON.stringify(shell, null, 2)}\n`;
}

function assertLogicalResult(
  current: ShardedEditDocument,
  value: unknown,
): ShardedEditDocument {
  if (!isRecord(value) || value.kind !== SHARDED_DOCUMENT_KIND || !isRecord(value.shell) || !isRecord(value.shards)) {
    throw new EditApiError(
      "INVALID_PATCH",
      `sharded patch result must be exactly {kind:${JSON.stringify(SHARDED_DOCUMENT_KIND)},shell,shards}`,
      "$.patch",
    );
  }
  const keys = Object.keys(value).sort();
  if (!semanticEqual(keys, ["kind", "shards", "shell"])) {
    throw new EditApiError("INVALID_PATCH", "sharded patch cannot add logical-document fields", "$.patch");
  }
  const shards = value.shards as Record<string, unknown>;
  if (!semanticEqual(Object.keys(shards).sort(), Object.keys(current.shards).sort())) {
    throw new EditApiError("INVALID_PATCH", "sharded patch cannot add, remove, or rename shard entry keys", "$.patch");
  }
  return value as unknown as ShardedEditDocument;
}

function validateLogicalResult(current: ShardedEditDocument, next: ShardedEditDocument): void {
  // Validate shell through the same strict gate, including its recomputed
  // manifest. Entry strings are immutable in patch-v1 so reverse patches can
  // always reacquire the same physical shards.
  const shell = loadValidatedProjectShell(JSON.stringify(next.shell));
  const beforeEntries = current.shell.mapIndex.map((meta) => meta.entry);
  const afterEntries = shell.mapIndex.map((meta) => meta.entry);
  if (!semanticEqual(beforeEntries, afterEntries)) {
    throw new EditApiError("INVALID_PATCH", "sharded patches must keep every mapIndex entry key stable", "/shell/mapIndex");
  }
  for (let index = 0; index < shell.mapIndex.length; index++) {
    const before = current.shell.mapIndex[index]!;
    const after = shell.mapIndex[index]!;
    if (!semanticEqual(before, after) && !own(current.shards, before.entry)) {
      throw new EditApiError(
        "INVALID_PATCH",
        `mapIndex metadata changed without loading its shard ${JSON.stringify(before.entry)}`,
        `/shell/mapIndex/${index}`,
      );
    }
  }
  for (const [entry, map] of Object.entries(next.shards)) {
    const meta = shell.mapIndex.find((item) => item.entry === entry);
    if (!meta) throw new EditApiError("INVALID_PATCH", `result shell no longer indexes ${JSON.stringify(entry)}`, `/shards/${entry}`);
    try {
      validateMapDef(map);
    } catch (error) {
      throw new EditApiError("INVALID_PATCH", error instanceof Error ? error.message : String(error), `/shards/${entry}`);
    }
    validateMapSemantics(map, (message) => {
      throw new EditApiError("INVALID_PATCH", message, `/shards/${entry}`);
    });
    const text = canonicalMapJson(map);
    if (sha256Text(text) !== meta.sha256 || map.id !== meta.id || map.width !== meta.width || map.height !== meta.height) {
      throw new EditApiError("INVALID_PATCH", `result shard metadata/checksum mismatch for ${JSON.stringify(entry)}`, `/shards/${entry}`);
    }
  }
}

function executeSave(
  shell: ProjectShell,
  maps: ReadonlyMap<string, MapDef>,
  args: unknown,
): ShardedEditExecution {
  const record = isRecord(args) ? args : {};
  const direction = record.direction === undefined ? "forward" : record.direction;
  if (direction !== "forward" && direction !== "reverse") {
    throw new EditApiError("INVALID_ARGUMENT", "direction must be one of forward, reverse", "$.direction", ["forward", "reverse"], direction);
  }
  const supplied = parseEditPatch(record.patch);
  // shardEntriesForOperation already enforces the sharded path namespace;
  // repeat it for direct callers that bypass the file adapter.
  const expectedEntries = shardEntriesForOperation(shell, "save", record);
  if (!semanticEqual([...maps.keys()].sort(), [...expectedEntries].sort())) {
    throw new EditApiError("INVALID_PATCH", "loaded shards do not match the entries inferred from patch paths", "$.patch");
  }
  const before = shardedView(shell, maps);
  const applied = applyEditPatchValue(before, supplied, direction);
  const after = assertLogicalResult(before, applied);
  validateLogicalResult(before, after);
  const patch = createEditPatch(before, after);
  const changed = patch.changes.length > 0;
  const shardOutputs = Object.create(null) as Record<string, string>;
  if (changed) {
    for (const [entry, map] of Object.entries(after.shards)) {
      if (!semanticEqual(before.shards[entry], map)) shardOutputs[entry] = canonicalMapJson(map);
    }
  }
  const response: EditSuccess = {
    ok: true,
    command: "save",
    project: summary(after.shell, after),
    changed,
    addresses: supplied.changes.map((change) => change.path || "$"),
    diff: patch.changes,
    patch,
    result: {
      direction,
      beforeHash: semanticHash(before),
      afterHash: semanticHash(after),
    },
  };
  return {
    response,
    ...(changed ? { output: { shell: serializeShell(after.shell), shards: shardOutputs } } : {}),
  };
}

function validationErrors(error: unknown): { path: string; msg: string }[] {
  if (error instanceof EditApiError) {
    if (Array.isArray(error.details)) return error.details as { path: string; msg: string }[];
    return [{ path: error.path ?? "$", msg: error.message }];
  }
  return [{ path: "$", msg: error instanceof Error ? error.message : String(error) }];
}

/** Execute a ProjectShell operation over exactly the shard sources selected
 * by shardEntriesForOperation. Pure inline executeEditOperation remains
 * unchanged and continues to reject shells without a host shard source. */
export function executeShardedEditOperation(
  shellSource: string,
  shardSources: Readonly<Record<string, string>>,
  commandValue: string,
  rawArgs: unknown = {},
): ShardedEditExecution {
  try {
    const shell = loadValidatedProjectShell(shellSource);
    const entries = shardEntriesForOperation(shell, commandValue, rawArgs);
    if (commandValue === "open" || commandValue === "list-maps") {
      return shellRead(shell, commandValue);
    }
    const maps = loadedMaps(shell, shardSources, entries);
    if (commandValue === "validate") {
      const project = projectFromMaps(shell, shell.mapIndex.map((meta) => maps.get(meta.entry)!), true);
      const inline = executeEditOperation(JSON.stringify(project), "validate");
      const view = shardedView(shell, maps);
      return { response: withProject(inline.response, summary(shell, view)) };
    }
    if (commandValue === "save") return executeSave(shell, maps, rawArgs);

    const orderedMaps = entries.map((entry) => maps.get(entry)!);
    // Only a real id rename asks for all maps. This exact project lets the
    // model rewrite start/common-event/all-shard literal transfer refs.
    const allMapsLoaded = entries.length === shell.mapIndex.length;
    const project = projectFromMaps(shell, orderedMaps, allMapsLoaded);
    const inline = executeEditOperation(JSON.stringify(project), commandValue, rawArgs);
    if (!inline.response.ok) return { response: inline.response };
    const beforeView = shardedView(shell, maps);
    if (inline.output === undefined) {
      return { response: withProject(inline.response, summary(shell, beforeView)) };
    }
    const edited = JSON.parse(inline.output) as Project;
    const derived = updateShell(shell, edited, maps, allMapsLoaded);
    const changedBefore = new Map<string, MapDef>();
    for (const entry of derived.changed.keys()) changedBefore.set(entry, maps.get(entry)!);
    const before = shardedView(shell, changedBefore);
    const after = shardedView(derived.shell, derived.changed);
    const patch = createEditPatch(before, after);
    const changed = patch.changes.length > 0;
    const response: EditSuccess = {
      ...inline.response,
      project: summary(derived.shell, after),
      changed,
      diff: patch.changes,
      patch,
    };
    return {
      response,
      ...(changed ? { output: { shell: serializeShell(derived.shell), shards: derived.texts } } : {}),
    };
  } catch (error) {
    if (commandValue === "validate") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(shellSource);
      } catch {
        parsed = {};
      }
      const record = isRecord(parsed) ? parsed : {};
      const project: ProjectSummary = {
        format: typeof record.format === "string" ? record.format : "unknown",
        title: typeof record.title === "string" ? record.title : "unknown",
        documentKind: "shell",
        editable: true,
        mapCount: Array.isArray(record.mapIndex) ? record.mapIndex.length : 0,
        revision: semanticHash(parsed),
      };
      return {
        response: {
          ok: true,
          command: "validate",
          project,
          changed: false,
          addresses: [],
          diff: [],
          result: { valid: false, errors: validationErrors(error) },
        },
      };
    }
    return failure(commandValue || undefined, error);
  }
}
