// editor/engine/model.ts — pure tile/event edit model: selection, one mutable
// tile stroke, transactional event/page edits, and an undo/redo log capped at
// HISTORY_LIMIT steps. No host APIs: sim tests and the UI share this file.

import type { GameEvent, MapDef, Page, Project, TileId } from "../../src/engine/types.ts";

export type Layer = "ground" | "upper";
export const HISTORY_LIMIT = 64; // spec: undo/redo for at least 32 steps

/** Dense upper layer, length width*height: null = no star-layer cell. */
export type DenseUpper = (TileId | null)[];

interface TileHistoryEntry {
  kind: "tile";
  mapIndex: number;
  layer: Layer;
  /** Layer array snapshots around the stroke (structural sharing: arrays
   *  are replaced, never mutated). */
  before: TileId[];
  after: TileId[];
}

interface EventSelection {
  selectedEventId: string | null;
  selectedPageIndex: number;
}

interface EventHistoryEntry {
  kind: "events";
  mapIndex: number;
  before: GameEvent[] | undefined;
  after: GameEvent[] | undefined;
  beforeSelection: EventSelection;
  afterSelection: EventSelection;
}

type HistoryEntry = TileHistoryEntry | EventHistoryEntry;

interface OpenStroke {
  mapIndex: number;
  layer: Layer;
  /** Tile painted by this stroke; null = an erase stroke. Fixed at press
   *  time so changing the palette selection mid-drag cannot mix brushes. */
  brush: TileId;
  before: TileId[];
}

export interface EditorState {
  project: Project;
  mapIndex: number;
  layer: Layer;
  /** Selected paint tile ("town.43"); null = eraser. */
  tile: TileId;
  /** Event/page selection belongs to the active map. A map switch clears it. */
  selectedEventId: string | null;
  selectedPageIndex: number;
  /** Per-map dense upper caches; a map enters the touched set the first
   *  time its upper layer is painted, and export compacts ONLY touched
   *  maps back to sparse pairs — untouched maps serialize their original
   *  [index, tile] ordering byte-for-byte. */
  upperDense: DenseUpper[];
  upperTouched: boolean[];
  groundTouched: boolean[];
  stroke: OpenStroke | null;
  past: HistoryEntry[];
  future: HistoryEntry[];
  dirty: boolean;
}

export function toDenseUpper(map: MapDef): DenseUpper {
  const dense: DenseUpper = new Array(map.width * map.height).fill(null);
  for (const [index, tile] of map.upper ?? []) {
    if (index >= 0 && index < dense.length) dense[index] = tile;
  }
  return dense;
}

export function fromDenseUpper(dense: DenseUpper): [number, TileId][] {
  const pairs: [number, TileId][] = [];
  dense.forEach((tile, index) => {
    if (tile !== null) pairs.push([index, tile]);
  });
  return pairs;
}

export function createEditorState(project: Project): EditorState {
  return {
    project,
    mapIndex: 0,
    layer: "ground",
    tile: null,
    selectedEventId: null,
    selectedPageIndex: 0,
    upperDense: project.maps.map(toDenseUpper),
    upperTouched: project.maps.map(() => false),
    groundTouched: project.maps.map(() => false),
    stroke: null,
    past: [],
    future: [],
    dirty: false,
  };
}

export function currentMap(state: EditorState): MapDef {
  return state.project.maps[state.mapIndex]!;
}

export function canUndo(state: EditorState): boolean {
  return state.past.length > 0;
}
export function canRedo(state: EditorState): boolean {
  return state.future.length > 0;
}

const TILE_RE = /^([a-z0-9_-]+)\.(\d+)$/;

/** A tile paints on a map only when its sheet is one of that map's sheets
 *  and the cell index is inside the sheet grid (src/data/schema.json patterns
 *  catch the shape; this catches cross-sheet references the schema cannot). */
export function canPaint(state: EditorState, tile: string): boolean {
  const m = TILE_RE.exec(tile);
  if (!m) return false;
  const map = currentMap(state);
  const sheetId = m[1]!;
  if (!(map.sheets ?? []).includes(sheetId)) return false;
  const sheet = state.project.sheets.find((s) => s.id === sheetId);
  if (!sheet) return false;
  const cell = Number(m[2]!);
  return cell >= 0 && cell < sheet.cols * sheet.rows;
}

function layerArray(state: EditorState, mapIndex: number, layer: Layer): TileId[] {
  const map = state.project.maps[mapIndex]!;
  return layer === "ground" ? map.ground : state.upperDense[mapIndex]!;
}

export function selectTile(state: EditorState, tile: TileId): EditorState {
  if (tile === null) return { ...state, tile: null };
  if (!TILE_RE.test(tile) || !canPaint(state, tile)) return state;
  return { ...state, tile };
}

export function selectLayer(state: EditorState, layer: Layer): EditorState {
  if (state.layer === layer) return state;
  // A switch mid-stroke commits nothing: the pointer-up model guarantees
  // the stroke closed, but stay defensive so history cannot wedge.
  return { ...state, layer, stroke: state.stroke ? null : state.stroke };
}

export function selectMap(state: EditorState, mapIndex: number): EditorState {
  if (mapIndex === state.mapIndex || mapIndex < 0 || mapIndex >= state.project.maps.length) {
    return state;
  }
  return {
    ...state,
    mapIndex,
    selectedEventId: null,
    selectedPageIndex: 0,
    stroke: null,
  };
}

function withLayer(state: EditorState, mapIndex: number, layer: Layer, next: TileId[]): EditorState {
  if (layer === "ground") {
    const maps = state.project.maps.slice();
    maps[mapIndex] = { ...maps[mapIndex]!, ground: next as (string | null)[] };
    const groundTouched = state.groundTouched.slice();
    groundTouched[mapIndex] = true;
    return { ...state, project: { ...state.project, maps }, groundTouched };
  }
  const upperDense = state.upperDense.slice();
  upperDense[mapIndex] = next as DenseUpper;
  const upperTouched = state.upperTouched.slice();
  upperTouched[mapIndex] = true;
  return { ...state, upperDense, upperTouched };
}

/** Begin a drag stroke on the active map/layer. `erase` selects the eraser
 *  brush for this stroke regardless of the palette selection (right button
 *  / modifier). The pre-stroke array is captured once for the undo log. */
export function strokeStart(state: EditorState, erase = false): EditorState {
  if (state.stroke) return state;
  const brush = erase ? null : state.tile;
  return {
    ...state,
    stroke: {
      mapIndex: state.mapIndex,
      layer: state.layer,
      brush,
      before: layerArray(state, state.mapIndex, state.layer).slice(),
    },
  };
}

/** Paint (or erase, when the stroke's brush is null) one cell. Cells outside
 *  the map and non-eraser strokes with an unselected tile are no-ops. */
export function paintCell(state: EditorState, index: number): EditorState {
  const stroke = state.stroke;
  if (!stroke || stroke.mapIndex !== state.mapIndex || stroke.layer !== state.layer) return state;
  const map = state.project.maps[stroke.mapIndex]!;
  if (index < 0 || index >= map.width * map.height) return state;
  const layer = stroke.layer;
  const current = layerArray(state, stroke.mapIndex, layer).slice();
  const next = stroke.brush;
  if (next !== null && !canPaint(state, next)) return state;
  if (current[index] === next) return state;
  current[index] = next;
  return { ...withLayer(state, stroke.mapIndex, layer, current), dirty: true };
}

/** Close the stroke: push one history entry covering every cell the drag
 *  touched and clear the redo branch. A stroke that changed nothing records
 *  no history (e.g. a press on an out-of-range cell). */
export function strokeEnd(state: EditorState): EditorState {
  const stroke = state.stroke;
  if (!stroke) return state;
  const after = layerArray(state, stroke.mapIndex, stroke.layer);
  let changed = after.length !== stroke.before.length;
  for (let i = 0; !changed && i < after.length; i++) {
    if (after[i] !== stroke.before[i]) changed = true;
  }
  if (!changed) return { ...state, stroke: null };
  const entry: HistoryEntry = {
    kind: "tile",
    mapIndex: stroke.mapIndex,
    layer: stroke.layer,
    before: stroke.before,
    after: after.slice(),
  };
  const past = [...state.past, entry];
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
  return { ...state, stroke: null, past, future: [] };
}

function applyTileHistory(state: EditorState, entry: TileHistoryEntry): EditorState {
  return withLayer(state, entry.mapIndex, entry.layer, entry.before.slice());
}

function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as T;
  if (value !== null && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copy[key] = cloneJson(item);
    return copy as T;
  }
  return value;
}

function withEvents(
  state: EditorState,
  mapIndex: number,
  events: GameEvent[] | undefined,
): EditorState {
  const maps = state.project.maps.slice();
  const map: MapDef = { ...maps[mapIndex]! };
  if (events === undefined) delete map.events;
  else map.events = cloneJson(events);
  maps[mapIndex] = map;
  return { ...state, project: { ...state.project, maps } };
}

function applyEventHistory(
  state: EditorState,
  entry: EventHistoryEntry,
  events: GameEvent[] | undefined,
  selection: EventSelection,
): EditorState {
  const restored = withEvents(state, entry.mapIndex, events);
  return {
    ...restored,
    mapIndex: entry.mapIndex,
    selectedEventId: selection.selectedEventId,
    selectedPageIndex: selection.selectedPageIndex,
  };
}

export function undo(state: EditorState): EditorState {
  const entry = state.past[state.past.length - 1];
  if (!entry || state.stroke) return state;
  if (entry.kind === "events") {
    const restored = applyEventHistory(state, entry, entry.before, entry.beforeSelection);
    return {
      ...restored,
      past: state.past.slice(0, -1),
      future: [...state.future, cloneJson(entry)],
      dirty: true,
    };
  }
  const restored = applyTileHistory(state, entry);
  const switchedMap = state.mapIndex !== entry.mapIndex;
  return {
    ...restored,
    past: state.past.slice(0, -1),
    future: [...state.future, { ...entry, before: entry.before.slice(), after: entry.after.slice() }],
    mapIndex: entry.mapIndex,
    layer: entry.layer,
    selectedEventId: switchedMap ? null : state.selectedEventId,
    selectedPageIndex: switchedMap ? 0 : state.selectedPageIndex,
    dirty: true,
  };
}

export function redo(state: EditorState): EditorState {
  const entry = state.future[state.future.length - 1];
  if (!entry || state.stroke) return state;
  if (entry.kind === "events") {
    const reapplied = applyEventHistory(state, entry, entry.after, entry.afterSelection);
    return {
      ...reapplied,
      past: [...state.past, cloneJson(entry)],
      future: state.future.slice(0, -1),
      dirty: true,
    };
  }
  const reapplied = withLayer(state, entry.mapIndex, entry.layer, entry.after.slice());
  const switchedMap = state.mapIndex !== entry.mapIndex;
  return {
    ...reapplied,
    past: [...state.past, { ...entry, before: entry.before.slice(), after: entry.after.slice() }],
    future: state.future.slice(0, -1),
    mapIndex: entry.mapIndex,
    layer: entry.layer,
    selectedEventId: switchedMap ? null : state.selectedEventId,
    selectedPageIndex: switchedMap ? 0 : state.selectedPageIndex,
    dirty: true,
  };
}

// --- event/page editing ----------------------------------------------------

const EVENT_ID_RE = /^[A-Za-z0-9_-]+$/;

function emptyActionPage(): Page {
  return { trigger: "action", commands: [] };
}

function clampInteger(value: number, min: number, max: number): number {
  const integer = Number.isFinite(value) ? Math.trunc(value) : min;
  return Math.max(min, Math.min(max, integer));
}

function schemaSafeEventId(value: string): string {
  if (EVENT_ID_RE.test(value)) return value;
  const safe = value.replace(/[^A-Za-z0-9_-]+/g, "-");
  return safe || "event";
}

/** Return a map-local, schema-safe id, retaining `preferred` when possible. */
export function uniqueEventId(
  events: readonly GameEvent[],
  preferred = "event",
): string {
  const base = schemaSafeEventId(preferred);
  const used = new Set(events.map((event) => event.id));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

function selectionOf(state: EditorState): EventSelection {
  return {
    selectedEventId: state.selectedEventId,
    selectedPageIndex: state.selectedPageIndex,
  };
}

function eventIndex(state: EditorState): number {
  if (state.selectedEventId === null) return -1;
  return (currentMap(state).events ?? []).findIndex((event) => event.id === state.selectedEventId);
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

function pushHistory(state: EditorState, entry: HistoryEntry): HistoryEntry[] {
  const past = [...state.past, entry];
  return past.length > HISTORY_LIMIT ? past.slice(-HISTORY_LIMIT) : past;
}

function commitEvents(
  state: EditorState,
  events: GameEvent[],
  selection: EventSelection,
): EditorState {
  if (state.stroke) return state;
  const before = currentMap(state).events;
  if (jsonEqual(before, events)) return state;
  const entry: EventHistoryEntry = {
    kind: "events",
    mapIndex: state.mapIndex,
    before: before === undefined ? undefined : cloneJson(before),
    after: cloneJson(events),
    beforeSelection: selectionOf(state),
    afterSelection: { ...selection },
  };
  const updated = withEvents(state, state.mapIndex, events);
  return {
    ...updated,
    selectedEventId: selection.selectedEventId,
    selectedPageIndex: selection.selectedPageIndex,
    past: pushHistory(state, entry),
    future: [],
    dirty: true,
  };
}

function normalizeEvent(
  map: MapDef,
  events: readonly GameEvent[],
  event: GameEvent,
  replacingIndex: number,
): GameEvent {
  const otherEvents = events.filter((_, index) => index !== replacingIndex);
  const normalized = cloneJson(event);
  normalized.id = uniqueEventId(otherEvents, normalized.id);
  if (!normalized.pages.length) normalized.pages = [emptyActionPage()];

  const width = clampInteger(normalized.w ?? 1, 1, map.width);
  const height = clampInteger(normalized.h ?? 1, 1, map.height);
  normalized.x = clampInteger(normalized.x, 0, map.width - width);
  normalized.y = clampInteger(normalized.y, 0, map.height - height);
  if (normalized.w !== undefined) normalized.w = width;
  if (normalized.h !== undefined) normalized.h = height;
  return normalized;
}

/** Select an event and one of its pages. Invalid ids are ignored; null
 * clears selection. Selection changes are deliberately not undo steps. */
export function selectEvent(
  state: EditorState,
  selectedEventId: string | null,
  selectedPageIndex = 0,
): EditorState {
  if (selectedEventId === null) {
    if (state.selectedEventId === null && state.selectedPageIndex === 0) return state;
    return { ...state, selectedEventId: null, selectedPageIndex: 0 };
  }
  const event = (currentMap(state).events ?? []).find((candidate) => candidate.id === selectedEventId);
  if (!event) return state;
  const pageIndex = clampInteger(selectedPageIndex, 0, event.pages.length - 1);
  if (state.selectedEventId === selectedEventId && state.selectedPageIndex === pageIndex) return state;
  return { ...state, selectedEventId, selectedPageIndex: pageIndex };
}

/** Change only the selected page within the selected event. */
export function selectPage(state: EditorState, pageIndex: number): EditorState {
  const index = eventIndex(state);
  if (index < 0) return state;
  const event = currentMap(state).events![index]!;
  const next = clampInteger(pageIndex, 0, event.pages.length - 1);
  if (next === state.selectedPageIndex) return state;
  return { ...state, selectedPageIndex: next };
}

/** Apply one event-level transaction. The callback receives a deep copy,
 * so accidental callback mutation cannot mutate the current/history state. */
export function updateSelectedEvent(
  state: EditorState,
  update: (event: GameEvent) => GameEvent,
): EditorState {
  const index = eventIndex(state);
  if (index < 0 || state.stroke) return state;
  const map = currentMap(state);
  const events = map.events ?? [];
  const proposed = update(cloneJson(events[index]!));
  const nextEvent = normalizeEvent(map, events, proposed, index);
  const nextEvents = events.slice();
  nextEvents[index] = nextEvent;
  return commitEvents(state, nextEvents, {
    selectedEventId: nextEvent.id,
    selectedPageIndex: clampInteger(state.selectedPageIndex, 0, nextEvent.pages.length - 1),
  });
}

/** Apply one page-level transaction to the selected page. */
export function updateSelectedPage(
  state: EditorState,
  update: (page: Page) => Page,
): EditorState {
  const index = eventIndex(state);
  if (index < 0 || state.stroke) return state;
  const event = currentMap(state).events![index]!;
  if (state.selectedPageIndex < 0 || state.selectedPageIndex >= event.pages.length) return state;
  const page = update(cloneJson(event.pages[state.selectedPageIndex]!));
  return updateSelectedEvent(state, (nextEvent) => {
    nextEvent.pages[state.selectedPageIndex] = cloneJson(page);
    return nextEvent;
  });
}

function withTransactionPageSelection(
  previous: EditorState,
  next: EditorState,
  selectedPageIndex: number,
): EditorState {
  if (next === previous) return previous;
  const past = next.past.slice();
  const entry = past[past.length - 1];
  if (!entry || entry.kind !== "events") return next;
  past[past.length - 1] = {
    ...entry,
    afterSelection: { ...entry.afterSelection, selectedPageIndex },
  };
  return { ...next, selectedPageIndex, past };
}

/** Create a 1x1 event with one empty action page and select it. */
export function createEventAt(state: EditorState, x: number, y: number): EditorState {
  if (state.stroke) return state;
  const map = currentMap(state);
  const events = map.events ?? [];
  const event: GameEvent = {
    id: uniqueEventId(events),
    x: clampInteger(x, 0, map.width - 1),
    y: clampInteger(y, 0, map.height - 1),
    pages: [emptyActionPage()],
  };
  return commitEvents(state, [...events, event], {
    selectedEventId: event.id,
    selectedPageIndex: 0,
  });
}

/** Move the selected event's top-left corner, preserving its effective size. */
export function moveSelectedEvent(state: EditorState, x: number, y: number): EditorState {
  const index = eventIndex(state);
  if (index < 0) return state;
  const map = currentMap(state);
  const event = map.events![index]!;
  const width = clampInteger(event.w ?? 1, 1, map.width);
  const height = clampInteger(event.h ?? 1, 1, map.height);
  return updateSelectedEvent(state, (next) => ({
    ...next,
    x: clampInteger(x, 0, map.width - width),
    y: clampInteger(y, 0, map.height - height),
  }));
}

/** Resize the selected event within the space remaining from its top-left. */
export function resizeSelectedEvent(state: EditorState, w: number, h: number): EditorState {
  const index = eventIndex(state);
  if (index < 0) return state;
  const map = currentMap(state);
  const event = map.events![index]!;
  const x = clampInteger(event.x, 0, map.width - 1);
  const y = clampInteger(event.y, 0, map.height - 1);
  return updateSelectedEvent(state, (next) => ({
    ...next,
    x,
    y,
    w: clampInteger(w, 1, map.width - x),
    h: clampInteger(h, 1, map.height - y),
  }));
}

/** Rename the selected event's optional human-readable label (not its id). */
export function renameSelectedEvent(state: EditorState, name: string): EditorState {
  return updateSelectedEvent(state, (event) => ({ ...event, name }));
}

/** Duplicate beside the source in array order and select the copy. */
export function duplicateSelectedEvent(state: EditorState): EditorState {
  const index = eventIndex(state);
  if (index < 0 || state.stroke) return state;
  const events = currentMap(state).events ?? [];
  const copy = cloneJson(events[index]!);
  copy.id = uniqueEventId(events, `${schemaSafeEventId(copy.id)}-copy`);
  const nextEvents = events.slice();
  nextEvents.splice(index + 1, 0, copy);
  return commitEvents(state, nextEvents, {
    selectedEventId: copy.id,
    selectedPageIndex: clampInteger(state.selectedPageIndex, 0, copy.pages.length - 1),
  });
}

/** Delete the selected event and select the adjacent surviving event. */
export function deleteSelectedEvent(state: EditorState): EditorState {
  const index = eventIndex(state);
  if (index < 0 || state.stroke) return state;
  const events = (currentMap(state).events ?? []).slice();
  events.splice(index, 1);
  const adjacent = events[Math.min(index, events.length - 1)];
  return commitEvents(state, events, {
    selectedEventId: adjacent?.id ?? null,
    selectedPageIndex: adjacent
      ? clampInteger(state.selectedPageIndex, 0, adjacent.pages.length - 1)
      : 0,
  });
}

/** Append a page (an empty action page by default) and select it. */
export function addPage(state: EditorState, page: Page = emptyActionPage()): EditorState {
  const index = eventIndex(state);
  if (index < 0) return state;
  const selectedPageIndex = currentMap(state).events![index]!.pages.length;
  const nextState = updateSelectedEvent(state, (event) => {
    event.pages.push(cloneJson(page));
    return event;
  });
  return withTransactionPageSelection(state, nextState, selectedPageIndex);
}

/** Delete the selected page. Events must retain at least one page. */
export function deletePage(state: EditorState): EditorState {
  const index = eventIndex(state);
  if (index < 0) return state;
  const event = currentMap(state).events![index]!;
  if (event.pages.length <= 1) return state;
  const pageIndex = state.selectedPageIndex;
  const nextState = updateSelectedEvent(state, (nextEvent) => {
    nextEvent.pages.splice(pageIndex, 1);
    return nextEvent;
  });
  return withTransactionPageSelection(
    state,
    nextState,
    Math.min(pageIndex, event.pages.length - 2),
  );
}

/** Move the selected page to an absolute page index and keep it selected. */
export function movePage(state: EditorState, toIndex: number): EditorState {
  const index = eventIndex(state);
  if (index < 0) return state;
  const event = currentMap(state).events![index]!;
  const fromIndex = state.selectedPageIndex;
  const target = clampInteger(toIndex, 0, event.pages.length - 1);
  if (target === fromIndex) return state;
  const nextState = updateSelectedEvent(state, (nextEvent) => {
    const [page] = nextEvent.pages.splice(fromIndex, 1);
    nextEvent.pages.splice(target, 0, page!);
    return nextEvent;
  });
  return withTransactionPageSelection(state, nextState, target);
}

/** Insert a deep copy of the selected page immediately after it. */
export function copyPage(state: EditorState): EditorState {
  const index = eventIndex(state);
  if (index < 0) return state;
  const event = currentMap(state).events![index]!;
  const pageIndex = state.selectedPageIndex;
  const nextState = updateSelectedEvent(state, (nextEvent) => {
    nextEvent.pages.splice(pageIndex + 1, 0, cloneJson(event.pages[pageIndex]!));
    return nextEvent;
  });
  return withTransactionPageSelection(state, nextState, pageIndex + 1);
}

/** Compact one touched upper layer back to sparse pairs. The runtime's
 *  dense rule is "the last pair at an index wins", so an UNEDITED index can
 *  legitimately hold several authored pairs (the village fences do): keep
 *  every one of those pairs verbatim. An edited index drops its authored
 *  pairs and emits the single new pair; an erased index emits nothing.
 *  Brand-new cells append in row-major order. */
export function compactUpper(original: [number, TileId][] | undefined, dense: DenseUpper): [number, TileId][] {
  const originalIndices = new Set<number>();
  const lastOriginal = new Map<number, TileId>();
  for (const [index, tile] of original ?? []) {
    originalIndices.add(index);
    lastOriginal.set(index, tile);
  }
  const pairs: [number, TileId][] = [];
  // 1. authored pairs: untouched indices keep every pair verbatim (duplicate
  //    indices are legal; the last pair is what the runtime paints).
  for (const [index, tile] of original ?? []) {
    if (dense[index] === lastOriginal.get(index)) pairs.push([index, tile]);
  }
  // 2. edited indices emit their single new pair (erased = null, nothing).
  for (const index of originalIndices) {
    const tile = dense[index];
    if (tile !== null && tile !== lastOriginal.get(index)) pairs.push([index, tile]);
  }
  // 3. brand-new cells append in row-major order.
  dense.forEach((tile, index) => {
    if (tile !== null && !originalIndices.has(index)) pairs.push([index, tile]);
  });
  return pairs;
}

/** Export form: only touched upper maps compact (preserving authored pair
 *  order); untouched maps keep their original arrays. The result is then
 *  validated by engine/document.ts before leaving the editor. */
export function exportProject(state: EditorState): Project {
  if (state.stroke) state = strokeEnd(state);
  const maps = state.project.maps.map((map, i) => {
    if (state.upperTouched[i]) return { ...map, upper: compactUpper(map.upper, state.upperDense[i]!) };
    return map;
  });
  return { ...state.project, maps };
}

export function markSaved(state: EditorState): EditorState {
  return { ...state, dirty: false };
}

/** Event rectangles the canvas overlays, sorted for stable z-order. */
export function eventMarkers(map: MapDef): { id: string; x: number; y: number; w: number; h: number }[] {
  return (map.events ?? [])
    .map((e) => ({ id: e.id, x: e.x, y: e.y, w: e.w ?? 1, h: e.h ?? 1 }))
    .sort((a, b) => (a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1)));
}

/** Palette contents for a map: eraser (null) first, then every cell of
 *  every sheet the map draws from, in sheet/grid order. Slot 0 is always
 *  the eraser; slot n maps to paletteTiles(state)[n]. */
export function paletteTiles(state: EditorState): TileId[] {
  const map = currentMap(state);
  const tiles: TileId[] = [null];
  for (const sheetId of map.sheets ?? []) {
    const sheet = state.project.sheets.find((s) => s.id === sheetId);
    if (!sheet) continue;
    for (let cell = 0; cell < sheet.cols * sheet.rows; cell++) tiles.push(`${sheetId}.${cell}`);
  }
  return tiles;
}

/** Palette slot holding a tile id, or -1 when it is not in the current
 *  map's palette (map switch made the selection stale). */
export function slotForTile(tiles: TileId[], tile: TileId): number {
  if (tile === null) return 0;
  const i = tiles.indexOf(tile);
  return i >= 0 ? i : -1;
}
