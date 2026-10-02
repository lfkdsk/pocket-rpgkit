// editor/engine/model.ts — the PocketJS editor's edit model: selection, the
// live paint preview, and an undo/redo log capped at HISTORY_LIMIT steps.
//
// Every document change is an editor/api operation (the same operations
// Studio and rpgkit-edit run), executed on the committed in-memory revision.
// A history step is that operation's reversible edit, whose patch-v1 value
// (projectEditPatch) is byte-identical to the one the text protocol reports.
// Undo applies the edit's inverse and redo the edit itself, through the API.
// A paint or edge stroke previews cell by cell with the shared edit rules and
// commits as one `paint-cells` / `paint-edges` operation when it ends.
// No host APIs: sim tests and the UI share this file.

import type { GameEvent, MapDef, Page, Project, TileId } from "../../src/engine/types.ts";
import {
  applyProjectEdit,
  createEditMemo,
  createEditPatch,
  executeProjectOperation,
  executeProjectTransaction,
  projectEditPatch,
  type EditMemo,
  type ProjectEdit,
  type ProjectOperation,
  type ProjectOperationResult,
} from "../api/operations.ts";
import type { EditPatch } from "../api/types.ts";
import * as rules from "./edit-rules.ts";
import type { EdgeBrush, Layer, MapReference, NewMapOptions } from "./edit-rules.ts";

export {
  canPaint,
  compactPassage,
  compactUpper,
  currentMap,
  eventMarkers,
  fromDensePassage,
  fromDenseUpper,
  mapReferences,
  paletteTiles,
  slotForTile,
  toDensePassage,
  toDenseUpper,
  uniqueEventId,
  uniqueMapId,
  type DensePassage,
  type DenseUpper,
  type EdgeBrush,
  type Layer,
  type MapReference,
  type NewMapOptions,
  type PassageValue,
} from "./edit-rules.ts";

export const HISTORY_LIMIT = 64; // spec: undo/redo for at least 32 steps

interface EventSelection {
  selectedEventId: string | null;
  selectedPageIndex: number;
}

/** What a history step restores besides the document: a tile stroke returns
 *  to its map and layer, an event edit to its selection, a structural edit
 *  to its map and selection. */
export type HistoryKind = "tile" | "events" | "project";

export interface HistoryEntry {
  kind: HistoryKind;
  /** The operation (or transaction) that produced the step. */
  label: string;
  edit: ProjectEdit;
  layer: Layer;
  beforeMapIndex: number;
  afterMapIndex: number;
  beforeSelection: EventSelection;
  afterSelection: EventSelection;
}

export interface EditorState extends rules.EditRulesState {
  /** The current editor/api revision; every operation runs on it. `project`
   *  is what views draw: equal in content to `committed` except while an
   *  open stroke previews its cells (after a ground stroke it keeps the
   *  preview's map object, so the canvas does not redraw an equal map). */
  committed: Project;
  past: HistoryEntry[];
  future: HistoryEntry[];
  dirty: boolean;
  /** `dirty` when the open stroke started; a refused stroke restores it. */
  dirtyAtStroke: boolean;
  /** The last operation the protocol refused (a fresh object per refusal,
   *  so a view can report each one once); null after a successful edit. */
  error: { message: string } | null;
}

export type StructuralResult =
  | { ok: true; state: EditorState }
  | { ok: false; error: string };

export type ResizeResult =
  | { ok: true; state: EditorState; croppedEvents: string[] }
  | { ok: false; error: string };

export type DeleteMapResult =
  | { ok: true; state: EditorState }
  | { ok: false; error: string; references: MapReference[] };

/** The project must be a valid revision (a validated load). */
export function createEditorState(project: Project): EditorState {
  return {
    ...rules.createEditorState(project),
    committed: project,
    past: [],
    future: [],
    dirty: false,
    dirtyAtStroke: false,
    error: null,
  };
}

export function canUndo(state: EditorState): boolean {
  return state.past.length > 0;
}
export function canRedo(state: EditorState): boolean {
  return state.future.length > 0;
}

/** The patch-v1 value of every applied step, oldest first. */
export function historyPatches(state: EditorState): EditPatch[] {
  return state.past.map((entry) => projectEditPatch(entry.edit, memo));
}

/** Identity caches (validation, hashes) shared by every revision this
 *  model commits. Revisions are immutable, so one module-level memo serves
 *  all documents and keeps EditorState plain, cloneable data. */
const memo: EditMemo = createEditMemo();

const asState = (state: rules.EditRulesState): EditorState => state as EditorState;

function selectionOf(state: EditorState): EventSelection {
  return { selectedEventId: state.selectedEventId, selectedPageIndex: state.selectedPageIndex };
}

function sameSelection(state: EditorState): EventSelection {
  return selectionOf(state);
}

function pushHistory(past: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  const next = [...past, entry];
  return next.length > HISTORY_LIMIT ? next.slice(-HISTORY_LIMIT) : next;
}

/** Install a revision. A map's dense upper/passage cache is kept when no
 *  preview touched it and the revision kept that map's sparse layer and size
 *  (a ground stroke on a 100x100 map rebuilds nothing); otherwise it is
 *  rebuilt from the revision. */
function withRevision(
  state: EditorState,
  project: Project,
  mapIndex: number,
  selection: EventSelection,
): EditorState {
  const previous = state.committed.maps;
  const aligned = previous.length === project.maps.length;
  const sameShape = (map: MapDef, index: number) =>
    aligned && previous[index]!.width === map.width && previous[index]!.height === map.height;
  const keepUpper = (map: MapDef, index: number) =>
    sameShape(map, index) && previous[index]!.upper === map.upper && !state.upperTouched[index];
  const keepPassage = (map: MapDef, index: number) =>
    sameShape(map, index) && previous[index]!.passage === map.passage && !state.passageTouched[index];
  return {
    ...state,
    project,
    committed: project,
    mapIndex,
    selectedEventId: selection.selectedEventId,
    selectedPageIndex: selection.selectedPageIndex,
    upperDense: project.maps.map((map, index) => keepUpper(map, index) ? state.upperDense[index]! : rules.toDenseUpper(map)),
    passageDense: project.maps.map((map, index) => keepPassage(map, index) ? state.passageDense[index]! : rules.toDensePassage(map)),
    upperTouched: project.maps.map(() => false),
    passageTouched: project.maps.map(() => false),
    groundTouched: project.maps.map(() => false),
    stroke: null,
    edgeStroke: null,
  };
}

/** Drop an uncommitted preview (a refused stroke). */
function revertPreview(state: EditorState): EditorState {
  const previewing = state.stroke !== null || state.edgeStroke !== null
    || state.upperTouched.includes(true) || state.passageTouched.includes(true);
  if (!previewing) return state;
  return withRevision(state, state.committed, state.mapIndex, selectionOf(state));
}

/** After a ground stroke commits, keep drawing the preview's map object: it
 *  started as the committed map and changed exactly the stroke's cells, so
 *  when the edit changed exactly those cells to the same values the two maps
 *  are equal and the canvas has nothing to redraw. */
function keepShownMap(next: EditorState, preview: EditorState, stroke: NonNullable<EditorState["stroke"]>): EditorState {
  const last = next.past[next.past.length - 1];
  const shown = preview.project.maps[stroke.mapIndex];
  if (!last || last.edit.after !== next.committed || !shown || next.mapIndex !== preview.mapIndex) return next;
  const prefix = `/maps/${stroke.mapIndex}/ground/`;
  const changes = last.edit.changes;
  if (changes.length !== stroke.cells.length) return next;
  for (const change of changes) {
    if (!change.path.startsWith(prefix) || !change.after.exists) return next;
    const index = Number(change.path.slice(prefix.length));
    if (!Number.isInteger(index) || shown.ground[index] !== change.after.value) return next;
  }
  const maps = next.project.maps.slice();
  maps[stroke.mapIndex] = shown;
  return { ...next, project: { ...next.project, maps } };
}

interface Step {
  kind: HistoryKind;
  label: string;
  layer?: Layer;
  /** The map the step happened on (tile strokes: the stroke's map). */
  beforeMapIndex?: number;
  mapIndex: number;
  selection: EventSelection;
}

/** Record a protocol result as one history step. A refusal leaves the
 *  document and history alone (dropping any preview) and keeps the message;
 *  an unchanged result is no step at all. */
function commit(state: EditorState, response: ProjectOperationResult, step: Step): EditorState {
  if (!response.ok) {
    const dirty = state.stroke || state.edgeStroke ? state.dirtyAtStroke : state.dirty;
    return { ...revertPreview(state), dirty, error: { message: response.error.message } };
  }
  if (!response.changed) return revertPreview(state);
  const entry: HistoryEntry = {
    kind: step.kind,
    label: step.label,
    edit: response.edit,
    layer: step.layer ?? state.layer,
    beforeMapIndex: step.beforeMapIndex ?? state.mapIndex,
    afterMapIndex: step.mapIndex,
    beforeSelection: selectionOf(state),
    afterSelection: { ...step.selection },
  };
  const next = withRevision(state, response.project, step.mapIndex, step.selection);
  return { ...next, past: pushHistory(state.past, entry), future: [], dirty: true, error: null };
}

function run(state: EditorState, command: ProjectOperation["command"], args: Record<string, unknown>): ProjectOperationResult {
  return executeProjectOperation(state.committed, command, args, memo);
}

function transaction(state: EditorState, operations: ProjectOperation[]): ProjectOperationResult {
  return executeProjectTransaction(state.committed, operations, memo);
}

function committedMap(state: EditorState, mapIndex = state.mapIndex): MapDef {
  return state.committed.maps[mapIndex]!;
}

function cellPairs(map: MapDef, indices: readonly number[]): [number, number][] {
  return indices.map((index) => [index % map.width, Math.floor(index / map.width)]);
}

// --- selection (no history) --------------------------------------------------

export function selectTile(state: EditorState, tile: TileId): EditorState {
  return asState(rules.selectTile(state, tile));
}

export function selectPassageBrush(state: EditorState, brush: "pass" | "block"): EditorState {
  return asState(rules.selectPassageBrush(state, brush));
}

export function selectLayer(state: EditorState, layer: Layer): EditorState {
  if (state.layer === layer) return state;
  // A switch mid-stroke commits it (one history step) rather than dropping
  // its already-previewed cells without an undo entry.
  if (state.stroke) state = strokeEnd(state);
  if (state.edgeStroke) state = edgeStrokeEnd(state);
  return asState(rules.selectLayer(state, layer));
}

export function selectMap(state: EditorState, mapIndex: number): EditorState {
  if (mapIndex === state.mapIndex || mapIndex < 0 || mapIndex >= state.project.maps.length) {
    return state;
  }
  if (state.stroke) state = strokeEnd(state);
  if (state.edgeStroke) state = edgeStrokeEnd(state);
  return asState(rules.selectMap(state, mapIndex));
}

export function selectEvent(
  state: EditorState,
  selectedEventId: string | null,
  selectedPageIndex = 0,
): EditorState {
  return asState(rules.selectEvent(state, selectedEventId, selectedPageIndex));
}

export function selectPage(state: EditorState, pageIndex: number): EditorState {
  return asState(rules.selectPage(state, pageIndex));
}

// --- tile strokes ----------------------------------------------------------------

/** Begin a drag stroke on the active map/layer. `erase` selects the eraser
 *  brush for this stroke regardless of the palette selection. */
export function strokeStart(state: EditorState, erase = false): EditorState {
  const next = rules.strokeStart(state, erase);
  return next === state ? state : { ...asState(next), dirtyAtStroke: state.dirty };
}

/** Preview one cell of the open stroke (no protocol work per cell). */
export function paintCell(state: EditorState, index: number): EditorState {
  const next = rules.paintCell(state, index);
  return next === state ? state : { ...asState(next), dirty: true };
}

/** Close the stroke: its changed cells commit as one `paint-cells`
 *  operation, one history step. A stroke that changed nothing records no
 *  history (e.g. a press on an out-of-range cell). */
export function strokeEnd(state: EditorState): EditorState {
  const stroke = state.stroke;
  if (!stroke) return state;
  const cells = stroke.cells;
  if (cells.length === 0) return asState(rules.strokeEnd(state)); // painted nothing
  const map = committedMap(state, stroke.mapIndex);
  const response = run(state, "paint-cells", {
    map: map.id,
    layer: stroke.layer,
    cells: cellPairs(map, cells),
    value: stroke.brush,
  });
  const next = commit(state, response, {
    kind: "tile",
    label: "paint-cells",
    layer: stroke.layer,
    beforeMapIndex: stroke.mapIndex,
    mapIndex: state.mapIndex,
    selection: sameSelection(state),
  });
  return next.error === null && stroke.layer === "ground" ? keepShownMap(next, state, stroke) : next;
}

// --- sheet dirEdges strokes (PASS mode edge tools) ---------------------------------

/** Begin a stroke that toggles one-sided passage edges on the SHEET of the
 *  painted cell's ground tile. */
export function edgeStrokeStart(state: EditorState, brush: EdgeBrush): EditorState {
  const next = rules.edgeStrokeStart(state, brush);
  return next === state ? state : { ...asState(next), dirtyAtStroke: state.dirty };
}

export function edgePaintCell(state: EditorState, index: number): EditorState {
  const next = rules.edgePaintCell(state, index);
  if (next === state) return state;
  return next.project === state.project ? asState(next) : { ...asState(next), dirty: true };
}

/** Close an edge stroke: the cells that toggled commit as one `paint-edges`
 *  operation. A stroke that changed nothing records no history. */
export function edgeStrokeEnd(state: EditorState): EditorState {
  const stroke = state.edgeStroke;
  if (!stroke) return state;
  if (stroke.cells.length === 0) return revertPreview(state);
  const map = committedMap(state);
  const response = run(state, "paint-edges", {
    map: map.id,
    cells: cellPairs(map, stroke.cells),
    brush: stroke.brush,
  });
  return commit(state, response, {
    kind: "project",
    label: "paint-edges",
    mapIndex: state.mapIndex,
    selection: sameSelection(state),
  });
}

// --- history -----------------------------------------------------------------

function viewAfter(state: EditorState, entry: HistoryEntry, undoing: boolean): {
  mapIndex: number;
  layer: Layer;
  selection: EventSelection;
} {
  const mapIndex = undoing ? entry.beforeMapIndex : entry.afterMapIndex;
  if (entry.kind === "tile") {
    const switchedMap = state.mapIndex !== mapIndex;
    return {
      mapIndex,
      layer: entry.layer,
      selection: switchedMap ? { selectedEventId: null, selectedPageIndex: 0 } : selectionOf(state),
    };
  }
  return {
    mapIndex,
    layer: state.layer,
    selection: { ...(undoing ? entry.beforeSelection : entry.afterSelection) },
  };
}

export function undo(state: EditorState): EditorState {
  const entry = state.past[state.past.length - 1];
  if (!entry || state.stroke || state.edgeStroke) return state;
  const applied = applyProjectEdit(state.committed, entry.edit, "reverse");
  if (!applied.ok) return { ...state, error: { message: applied.error.message } };
  const view = viewAfter(state, entry, true);
  return {
    ...withRevision(state, applied.project, view.mapIndex, view.selection),
    layer: view.layer,
    past: state.past.slice(0, -1),
    future: [...state.future, entry],
    dirty: true,
    error: null,
  };
}

export function redo(state: EditorState): EditorState {
  const entry = state.future[state.future.length - 1];
  if (!entry || state.stroke || state.edgeStroke) return state;
  const applied = applyProjectEdit(state.committed, entry.edit, "forward");
  if (!applied.ok) return { ...state, error: { message: applied.error.message } };
  const view = viewAfter(state, entry, false);
  return {
    ...withRevision(state, applied.project, view.mapIndex, view.selection),
    layer: view.layer,
    past: [...state.past, entry],
    future: state.future.slice(0, -1),
    dirty: true,
    error: null,
  };
}

// --- event/page editing ----------------------------------------------------------

function selectedEventIndex(state: EditorState): number {
  if (state.selectedEventId === null) return -1;
  return (committedMap(state).events ?? []).findIndex((event) => event.id === state.selectedEventId);
}

function eventStep(state: EditorState, label: string, selection: EventSelection): Step {
  return { kind: "events", label, mapIndex: state.mapIndex, selection };
}

function pagesEqual(a: Page, b: Page): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Protocol operations turning event `before` into `after` (same map). */
function eventOperations(mapId: string, before: GameEvent, after: GameEvent): ProjectOperation[] | null {
  const known = new Set(["id", "name", "x", "y", "w", "h", "pages"]);
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!known.has(key) && JSON.stringify((before as unknown as Record<string, unknown>)[key]) !== JSON.stringify((after as unknown as Record<string, unknown>)[key])) {
      return null;
    }
  }
  const operations: ProjectOperation[] = [];
  const event = before.id;
  const shared = Math.min(before.pages.length, after.pages.length);
  for (let page = 0; page < shared; page++) {
    if (!pagesEqual(before.pages[page]!, after.pages[page]!)) {
      operations.push({ command: "update-page", args: { map: mapId, event, page, value: after.pages[page] } });
    }
  }
  for (let page = shared; page < after.pages.length; page++) {
    operations.push({ command: "add-page", args: { map: mapId, event, page: after.pages[page], index: page } });
  }
  for (let page = before.pages.length - 1; page >= after.pages.length; page--) {
    operations.push({ command: "delete-page", args: { map: mapId, event, page } });
  }
  const changes: Record<string, unknown> = {};
  for (const key of ["id", "name", "x", "y", "w", "h"] as const) {
    const was = before[key];
    const now = after[key];
    if (was === now) continue;
    changes[key] = now === undefined ? null : now;
  }
  if (Object.keys(changes).length > 0) {
    operations.push({ command: "update-event", args: { map: mapId, event, changes } });
  }
  return operations;
}

/** Apply one event-level transaction. The callback receives a deep copy; the
 *  result is normalized by the shared edit rules (unique id, in-bounds
 *  footprint, at least one page) and committed through the protocol. */
export function updateSelectedEvent(
  state: EditorState,
  update: (event: GameEvent) => GameEvent,
): EditorState {
  const index = selectedEventIndex(state);
  if (index < 0 || state.stroke || state.edgeStroke) return state;
  const map = committedMap(state);
  const before = map.events![index]!;
  const scratch = rules.updateSelectedEvent(state, update);
  if (scratch === state) return state;
  const after = rules.currentMap(scratch).events![index]!;
  const operations = eventOperations(map.id, before, after);
  if (operations === null) {
    return { ...state, error: { message: "only id, name, position, size and pages of an event can be edited" } };
  }
  if (operations.length === 0) return state;
  const response = transaction(state, operations);
  return commit(state, response, eventStep(state, "update-event", {
    selectedEventId: after.id,
    selectedPageIndex: scratch.selectedPageIndex,
  }));
}

/** Apply one page-level transaction to the selected page (`update-page`). */
export function updateSelectedPage(
  state: EditorState,
  update: (page: Page) => Page,
): EditorState {
  const index = selectedEventIndex(state);
  if (index < 0 || state.stroke || state.edgeStroke) return state;
  const map = committedMap(state);
  const event = map.events![index]!;
  const pageIndex = state.selectedPageIndex;
  if (pageIndex < 0 || pageIndex >= event.pages.length) return state;
  const page = update(JSON.parse(JSON.stringify(event.pages[pageIndex])) as Page);
  const response = run(state, "update-page", { map: map.id, event: event.id, page: pageIndex, value: page });
  return commit(state, response, eventStep(state, "update-page", sameSelection(state)));
}

/** Create a 1x1 event with one empty action page and select it. */
export function createEventAt(state: EditorState, x: number, y: number): EditorState {
  if (state.stroke || state.edgeStroke) return state;
  const map = committedMap(state);
  const event: GameEvent = {
    id: rules.uniqueEventId(map.events ?? []),
    x: rules.clampInteger(x, 0, map.width - 1),
    y: rules.clampInteger(y, 0, map.height - 1),
    pages: [rules.emptyActionPage()],
  };
  const response = run(state, "add-event", { map: map.id, event });
  return commit(state, response, eventStep(state, "add-event", { selectedEventId: event.id, selectedPageIndex: 0 }));
}

function updateEventFields(state: EditorState, changes: Record<string, unknown>): EditorState {
  const index = selectedEventIndex(state);
  if (index < 0 || state.stroke || state.edgeStroke) return state;
  const map = committedMap(state);
  const event = map.events![index]!;
  const response = run(state, "update-event", { map: map.id, event: event.id, changes });
  return commit(state, response, eventStep(state, "update-event", sameSelection(state)));
}

/** Move the selected event's top-left corner, preserving its effective size. */
export function moveSelectedEvent(state: EditorState, x: number, y: number): EditorState {
  const index = selectedEventIndex(state);
  if (index < 0) return state;
  const map = committedMap(state);
  const event = map.events![index]!;
  const width = rules.clampInteger(event.w ?? 1, 1, map.width);
  const height = rules.clampInteger(event.h ?? 1, 1, map.height);
  return updateEventFields(state, {
    x: rules.clampInteger(x, 0, map.width - width),
    y: rules.clampInteger(y, 0, map.height - height),
  });
}

/** Resize the selected event within the space remaining from its top-left. */
export function resizeSelectedEvent(state: EditorState, w: number, h: number): EditorState {
  const index = selectedEventIndex(state);
  if (index < 0) return state;
  const map = committedMap(state);
  const event = map.events![index]!;
  const x = rules.clampInteger(event.x, 0, map.width - 1);
  const y = rules.clampInteger(event.y, 0, map.height - 1);
  return updateEventFields(state, {
    x,
    y,
    w: rules.clampInteger(w, 1, map.width - x),
    h: rules.clampInteger(h, 1, map.height - y),
  });
}

/** Rename the selected event's optional human-readable label (not its id). */
export function renameSelectedEvent(state: EditorState, name: string): EditorState {
  return updateEventFields(state, { name });
}

/** Duplicate beside the source in array order and select the copy. */
export function duplicateSelectedEvent(state: EditorState): EditorState {
  const index = selectedEventIndex(state);
  if (index < 0 || state.stroke || state.edgeStroke) return state;
  const map = committedMap(state);
  const events = map.events ?? [];
  const copy = JSON.parse(JSON.stringify(events[index])) as GameEvent;
  copy.id = rules.uniqueEventId(events, `${rules.schemaSafeEventId(copy.id)}-copy`);
  const response = run(state, "add-event", { map: map.id, event: copy, index: index + 1 });
  return commit(state, response, eventStep(state, "add-event", {
    selectedEventId: copy.id,
    selectedPageIndex: rules.clampInteger(state.selectedPageIndex, 0, copy.pages.length - 1),
  }));
}

/** Delete the selected event and select the adjacent surviving event. */
export function deleteSelectedEvent(state: EditorState): EditorState {
  const index = selectedEventIndex(state);
  if (index < 0 || state.stroke || state.edgeStroke) return state;
  const map = committedMap(state);
  const remaining = (map.events ?? []).filter((_, at) => at !== index);
  const adjacent = remaining[Math.min(index, remaining.length - 1)];
  const response = run(state, "delete-event", { map: map.id, event: state.selectedEventId });
  return commit(state, response, eventStep(state, "delete-event", {
    selectedEventId: adjacent?.id ?? null,
    selectedPageIndex: adjacent ? rules.clampInteger(state.selectedPageIndex, 0, adjacent.pages.length - 1) : 0,
  }));
}

/** Append a page (an empty action page by default) and select it. */
export function addPage(state: EditorState, page: Page = rules.emptyActionPage()): EditorState {
  const index = selectedEventIndex(state);
  if (index < 0 || state.stroke || state.edgeStroke) return state;
  const map = committedMap(state);
  const event = map.events![index]!;
  const response = run(state, "add-page", { map: map.id, event: event.id, page });
  return commit(state, response, eventStep(state, "add-page", {
    selectedEventId: event.id,
    selectedPageIndex: event.pages.length,
  }));
}

/** Delete the selected page. Events must retain at least one page. */
export function deletePage(state: EditorState): EditorState {
  const index = selectedEventIndex(state);
  if (index < 0 || state.stroke || state.edgeStroke) return state;
  const map = committedMap(state);
  const event = map.events![index]!;
  if (event.pages.length <= 1) return state;
  const pageIndex = state.selectedPageIndex;
  const response = run(state, "delete-page", { map: map.id, event: event.id, page: pageIndex });
  return commit(state, response, eventStep(state, "delete-page", {
    selectedEventId: event.id,
    selectedPageIndex: Math.min(pageIndex, event.pages.length - 2),
  }));
}

/** Move the selected page to an absolute page index and keep it selected. */
export function movePage(state: EditorState, toIndex: number): EditorState {
  const index = selectedEventIndex(state);
  if (index < 0 || state.stroke || state.edgeStroke) return state;
  const map = committedMap(state);
  const event = map.events![index]!;
  const fromIndex = state.selectedPageIndex;
  const target = rules.clampInteger(toIndex, 0, event.pages.length - 1);
  if (target === fromIndex) return state;
  const page = event.pages[fromIndex]!;
  const response = transaction(state, [
    { command: "delete-page", args: { map: map.id, event: event.id, page: fromIndex } },
    { command: "add-page", args: { map: map.id, event: event.id, page, index: target } },
  ]);
  return commit(state, response, eventStep(state, "move-page", { selectedEventId: event.id, selectedPageIndex: target }));
}

/** Insert a deep copy of the selected page immediately after it. */
export function copyPage(state: EditorState): EditorState {
  const index = selectedEventIndex(state);
  if (index < 0 || state.stroke || state.edgeStroke) return state;
  const map = committedMap(state);
  const event = map.events![index]!;
  const pageIndex = state.selectedPageIndex;
  const response = run(state, "add-page", {
    map: map.id,
    event: event.id,
    page: event.pages[pageIndex],
    index: pageIndex + 1,
  });
  return commit(state, response, eventStep(state, "add-page", { selectedEventId: event.id, selectedPageIndex: pageIndex + 1 }));
}

// --- export ------------------------------------------------------------------------

/** The document as shown: the committed revision, or — while a stroke is
 *  open — the committed revision with the stroke's preview compacted in by
 *  the same edit rules its commit will run. Views read this every frame, so
 *  it never runs a protocol operation; strokeEnd commits. */
export function exportProject(state: EditorState): Project {
  if (!state.stroke && !state.edgeStroke) return state.committed;
  return rules.exportProject(state);
}

export function markSaved(state: EditorState): EditorState {
  return { ...state, dirty: false };
}

// --- structural edits (map properties + map management) --------------------
//
// Every structural edit is ONE "project" history step: one update-map,
// add-map, duplicate-map or delete-map operation. Open strokes are refused.

const STROKE_OPEN = "finish the current stroke first";

/** Argument errors win over an open stroke, and a no-op succeeds, as they
 *  did before map edits ran through the protocol. */
function structural(
  state: EditorState,
  response: ProjectOperationResult,
  label: string,
  view: (project: Project) => { mapIndex: number; selection: EventSelection },
): StructuralResult {
  if (!response.ok) return { ok: false, error: response.error.message };
  if (!response.changed) return { ok: true, state };
  if (state.stroke || state.edgeStroke) return { ok: false, error: STROKE_OPEN };
  const after = view(response.project);
  return {
    ok: true,
    state: commit(state, response, { kind: "project", label, mapIndex: after.mapIndex, selection: after.selection }),
  };
}

const keepView = (state: EditorState) => () => ({ mapIndex: state.mapIndex, selection: selectionOf(state) });
const clearedSelection = (): EventSelection => ({ selectedEventId: null, selectedPageIndex: 0 });

/** Rename the active map's id. The start position and every transfer
 *  command that names the old id follow (`update-map`). One undo step. */
export function renameMap(state: EditorState, rawId: string): StructuralResult {
  const map = committedMap(state);
  if (!map) return { ok: false, error: "no map selected" };
  const response = run(state, "update-map", { map: map.id, changes: { id: rawId } });
  return structural(state, response, "update-map", keepView(state));
}

/** Rename the active map's display name (`update-map`). One undo step. */
export function setMapName(state: EditorState, rawName: string): StructuralResult {
  const map = committedMap(state);
  const response = run(state, "update-map", { map: map.id, changes: { name: rawName } });
  return structural(state, response, "update-map", keepView(state));
}

/** Resize the active map (`update-map`); see the edit rules for cropping.
 *  One undo step. */
export function resizeMap(state: EditorState, rawW: number, rawH: number): ResizeResult {
  const map = committedMap(state);
  if (!map) return { ok: false, error: "no map selected" };
  if (!Number.isFinite(rawW) || rawW !== Math.trunc(rawW) || rawW < 1 || rawW > 256) {
    return { ok: false, error: "width must be an integer from 1 to 256" };
  }
  if (!Number.isFinite(rawH) || rawH !== Math.trunc(rawH) || rawH < 1 || rawH > 256) {
    return { ok: false, error: "height must be an integer from 1 to 256" };
  }
  if (rawW === map.width && rawH === map.height) return { ok: true, state, croppedEvents: [] };
  if (state.stroke || state.edgeStroke) return { ok: false, error: STROKE_OPEN };
  const response = run(state, "update-map", { map: map.id, changes: { width: rawW, height: rawH } });
  const result = structural(state, response, "update-map", (project) => {
    const events = project.maps[state.mapIndex]!.events ?? [];
    const survives = state.selectedEventId !== null && events.some((event) => event.id === state.selectedEventId);
    return {
      mapIndex: state.mapIndex,
      selection: survives ? selectionOf(state) : clearedSelection(),
    };
  });
  if (!result.ok) return result;
  const croppedEvents = response.ok
    ? ((response.result as { croppedEvents?: string[] }).croppedEvents ?? [])
    : [];
  return { ok: true, state: result.state, croppedEvents };
}

/** Replace the active map's sheet list (`update-map`). One undo step. */
export function setMapSheets(state: EditorState, sheets: string[]): StructuralResult {
  if (sheets.length === 0) return { ok: false, error: "a map needs at least one sheet" };
  const unknown = sheets.find((id) => !state.committed.sheets.some((sheet) => sheet.id === id));
  if (unknown !== undefined) return { ok: false, error: `unknown sheet "${unknown}"` };
  const map = committedMap(state);
  const response = run(state, "update-map", { map: map.id, changes: { sheets } });
  return structural(state, response, "update-map", keepView(state));
}

/** Create an empty map after the active one and select it (`add-map`). One
 *  undo step. */
export function newMap(state: EditorState, options: NewMapOptions = {}): StructuralResult {
  const project = state.committed;
  const sheets = options.sheets
    ?? project.maps[state.mapIndex]?.sheets
    ?? project.sheets.slice(0, 1).map((sheet) => sheet.id);
  if (sheets.length === 0) return { ok: false, error: "no sheets available for a new map" };
  const args: Record<string, unknown> = { after: project.maps[state.mapIndex]!.id, sheets };
  if (options.id !== undefined) args.map = options.id;
  if (options.name !== undefined) args.name = options.name;
  if (options.width !== undefined) args.width = rules.clampInteger(options.width, 1, 256);
  if (options.height !== undefined) args.height = rules.clampInteger(options.height, 1, 256);
  if (options.fill !== undefined) args.fill = options.fill;
  const response = run(state, "add-map", args);
  const created = response.ok ? (response.result as MapDef).id : "";
  return structural(state, response, "add-map", (next) => ({
    mapIndex: next.maps.findIndex((candidate) => candidate.id === created),
    selection: clearedSelection(),
  }));
}

/** Duplicate the active map directly after it and select the copy
 *  (`duplicate-map`; event ids stay, the map id gets a `-copy` suffix). One
 *  undo step. */
export function duplicateMap(state: EditorState): StructuralResult {
  const map = committedMap(state);
  if (!map) return { ok: false, error: "no map selected" };
  const response = run(state, "duplicate-map", { map: map.id });
  const copy = response.ok ? (response.result as MapDef).id : "";
  return structural(state, response, "duplicate-map", (next) => ({
    mapIndex: next.maps.findIndex((candidate) => candidate.id === copy),
    selection: clearedSelection(),
  }));
}

/** Delete the active map (`delete-map`). Refuses the only map and the start
 *  map. When transfers reference the map and `confirm` is false, returns the
 *  references so the UI can list them and ask for a second confirmation;
 *  with `confirm: true` the map is deleted anyway. One undo step. */
export function deleteMap(state: EditorState, confirm = false): DeleteMapResult {
  const project = state.committed;
  const map = project.maps[state.mapIndex];
  if (!map) return { ok: false, error: "no map selected", references: [] };
  if (project.maps.length <= 1) return { ok: false, error: "cannot delete the only map", references: [] };
  if (project.start.map === map.id) {
    return { ok: false, error: "cannot delete the start map", references: [] };
  }
  const references = rules.mapReferences(project, map.id);
  if (references.length > 0 && !confirm) {
    return { ok: false, error: `${references.length} transfer(s) target this map`, references };
  }
  if (state.stroke || state.edgeStroke) return { ok: false, error: STROKE_OPEN, references: [] };
  const response = run(state, "delete-map", { map: map.id });
  const result = structural(state, response, "delete-map", (next) => ({
    mapIndex: Math.max(0, Math.min(state.mapIndex, next.maps.length - 1)),
    selection: clearedSelection(),
  }));
  return result.ok ? result : { ...result, references: [] };
}

/** Commit an already-validated whole-project replacement (an accepted agent
 *  proposal) as exactly one undo step: a `save` of the patch from the current
 *  revision, the way Studio's session replaces a project. The active map and
 *  event are retained by stable id when possible. */
export function commitProjectReplacement(state: EditorState, project: Project): EditorState {
  if (state.stroke || state.edgeStroke) return state;
  let patch: EditPatch;
  try {
    patch = createEditPatch(state.committed, project);
  } catch (error) {
    return { ...state, error: { message: error instanceof Error ? error.message : String(error) } };
  }
  const response = run(state, "save", { patch, direction: "forward" });
  if (!response.ok || !response.changed) return commit(state, response, { kind: "project", label: "save", mapIndex: state.mapIndex, selection: selectionOf(state) });
  const next = response.project;
  const activeMapId = committedMap(state).id;
  let mapIndex = next.maps.findIndex((map) => map.id === activeMapId);
  if (mapIndex < 0) mapIndex = Math.max(0, Math.min(state.mapIndex, next.maps.length - 1));
  const activeEventId = state.selectedEventId;
  const event = activeEventId === null
    ? undefined
    : (next.maps[mapIndex]!.events ?? []).find((candidate) => candidate.id === activeEventId);
  return commit(state, response, {
    kind: "project",
    label: "save",
    mapIndex,
    selection: {
      selectedEventId: event?.id ?? null,
      selectedPageIndex: event ? rules.clampInteger(state.selectedPageIndex, 0, event.pages.length - 1) : 0,
    },
  });
}

