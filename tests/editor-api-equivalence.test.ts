// The PocketJS editor and Studio share one edit protocol (editor/api). The
// same edit sequence, driven through each editor's own edit layer (the
// PocketJS model's reducers; Studio's EditSession with the operations its
// canvas and inspector issue), must produce byte-identical patch-v1
// sequences after every step, the same undo/redo stacks, and the same final
// document bytes.

import { describe, expect, test } from "bun:test";
import { EditSession, type SessionOperation } from "../editor/api/session.ts";
import { createEditMemo, projectEditPatch } from "../editor/api/operations.ts";
import { loadProject, serializeProjectPreservingSource } from "../editor/engine/document.ts";
import { BUNDLED_PROJECTS } from "../editor/engine/projects.ts";
import {
  addPage,
  commitProjectReplacement,
  copyPage,
  createEditorState,
  createEventAt,
  currentMap,
  deleteMap,
  deletePage,
  deleteSelectedEvent,
  duplicateMap,
  duplicateSelectedEvent,
  edgePaintCell,
  edgeStrokeEnd,
  edgeStrokeStart,
  exportProject,
  historyPatches,
  movePage,
  moveSelectedEvent,
  newMap,
  paintCell,
  redo,
  renameMap,
  renameSelectedEvent,
  resizeMap,
  resizeSelectedEvent,
  selectEvent,
  selectLayer,
  selectPage,
  selectPassageBrush,
  selectTile,
  setMapName,
  setMapSheets,
  strokeEnd,
  strokeStart,
  toDensePassage,
  toDenseUpper,
  undo,
  updateSelectedPage,
  type EditorState,
  type EdgeBrush,
  type Layer,
} from "../editor/engine/model.ts";
import {
  addPageOp,
  insertCommandOp,
  pageCopyOp,
  pageDeleteOp,
  pageMoveOps,
  updatePageOp,
} from "../editor/studio/inspector-model.ts";
import type { GameEvent, Page, Project } from "../src/engine/types.ts";

const SOURCE = BUNDLED_PROJECTS.find((project) => project.id === "sunstone")!.json;

class Pair {
  pocket: EditorState;
  readonly studio: EditSession;
  readonly original: Project;
  steps = 0;

  constructor(readonly source: string) {
    this.original = loadProject(source).project;
    this.pocket = createEditorState(this.original);
    this.studio = EditSession.open(source);
  }

  map() {
    return currentMap(this.pocket);
  }

  event(): GameEvent {
    return this.map().events!.find((event) => event.id === this.pocket.selectedEventId)!;
  }

  pageRef() {
    return { map: this.map().id, event: this.pocket.selectedEventId!, page: this.pocket.selectedPageIndex };
  }

  run(command: SessionOperation["command"], args: Record<string, unknown>): void {
    const response = this.studio.run(command, args);
    expect(response.ok ? "ok" : response.error).toBe("ok");
  }

  transaction(operations: SessionOperation[]): void {
    const response = this.studio.transaction("transaction", operations);
    expect(response.ok ? "ok" : response.error).toBe("ok");
  }

  /** Both histories hold the same patches, byte for byte, and both editors
   *  show the same document. */
  check(label: string): void {
    this.steps++;
    expect(this.pocket.error, label).toBeNull();
    const pocketPast = JSON.stringify(historyPatches(this.pocket));
    const studioPast = JSON.stringify(this.studio.history().map((entry) => entry.patch));
    expect(pocketPast, label).toBe(studioPast);
    const memo = createEditMemo();
    const pocketFuture = JSON.stringify(this.pocket.future.map((entry) => projectEditPatch(entry.edit, memo)));
    const studioFuture = JSON.stringify(this.studio.future().map((entry) => entry.patch));
    expect(pocketFuture, label).toBe(studioFuture);
    expect(JSON.stringify(sorted(exportProject(this.pocket))), label).toBe(JSON.stringify(sorted(this.studio.project())));
    // What the canvas draws equals the committed revision.
    expect(JSON.stringify(this.pocket.project), label).toBe(JSON.stringify(this.pocket.committed));
    // The canvas draws upper/passage from dense caches; they must follow
    // every committed revision (including undo/redo and map insertions).
    expect(this.pocket.upperDense, label).toEqual(this.pocket.project.maps.map(toDenseUpper));
    expect(this.pocket.passageDense, label).toEqual(this.pocket.project.maps.map(toDensePassage));
  }

  /** The bytes the PocketJS editor's SAVE writes for the open document. */
  pocketText(): string {
    return serializeProjectPreservingSource(this.source, this.original, exportProject(this.pocket));
  }
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function stroke(pair: Pair, layer: Layer, cells: [number, number][], options: { tile?: string | null; passage?: "pass" | "block"; erase?: boolean }): void {
  let state = selectLayer(pair.pocket, layer);
  if (options.tile !== undefined) state = selectTile(state, options.tile);
  if (options.passage) state = selectPassageBrush(state, options.passage);
  state = strokeStart(state, options.erase ?? false);
  const width = currentMap(state).width;
  for (const [x, y] of cells) state = paintCell(state, y * width + x);
  pair.pocket = strokeEnd(state);
  const value = options.erase ? null : layer === "passage" ? options.passage : options.tile;
  pair.run("paint-cells", { map: pair.map().id, layer, cells, value });
}

function edges(pair: Pair, cells: [number, number][], brush: EdgeBrush): void {
  let state = edgeStrokeStart(pair.pocket, brush);
  const width = currentMap(state).width;
  for (const [x, y] of cells) state = edgePaintCell(state, y * width + x);
  pair.pocket = edgeStrokeEnd(state);
  pair.run("paint-edges", { map: pair.map().id, cells, brush });
}

describe("PocketJS editor and Studio share the edit protocol", () => {
  test("every edit category yields identical patch sequences and final bytes", () => {
    const pair = new Pair(SOURCE);
    const village = pair.map().id;

    // --- tiles, passage and one-way edges ---
    stroke(pair, "ground", [[1, 1], [2, 1], [3, 1], [2, 1]], { tile: "town.5" });
    pair.check("ground stroke");
    stroke(pair, "upper", [[4, 4], [5, 4]], { tile: "town.7" });
    pair.check("upper stroke");
    stroke(pair, "upper", [[4, 4]], { erase: true });
    pair.check("upper erase");
    stroke(pair, "passage", [[6, 6], [7, 6]], { passage: "block" });
    pair.check("passage stroke");
    stroke(pair, "passage", [[6, 6]], { erase: true });
    pair.check("passage erase");
    stroke(pair, "ground", [[0, 0]], { erase: true });
    pair.check("ground erase");
    pair.pocket = selectLayer(pair.pocket, "ground");
    edges(pair, [[1, 1], [2, 1], [3, 1]], { kind: "enter", dir: "up" });
    pair.check("edge stroke");
    edges(pair, [[1, 1]], { kind: "clear" });
    pair.check("edge clear");

    // --- events: create, move, resize, rename ---
    pair.pocket = createEventAt(pair.pocket, 10, 10);
    const created = pair.event();
    pair.run("add-event", { map: village, event: { id: created.id, x: 10, y: 10, pages: [{ trigger: "action", commands: [] }] } });
    pair.check("create event");
    pair.pocket = moveSelectedEvent(pair.pocket, 11, 10);
    pair.run("update-event", { map: village, event: created.id, changes: { x: 11 } });
    pair.check("move event");
    pair.pocket = resizeSelectedEvent(pair.pocket, 2, 1);
    pair.run("update-event", { map: village, event: created.id, changes: { w: 2, h: 1 } });
    pair.check("resize event");
    pair.pocket = renameSelectedEvent(pair.pocket, "Greeter");
    pair.run("update-event", { map: village, event: created.id, changes: { name: "Greeter" } });
    pair.check("rename event");

    // --- pages, conditions, commands ---
    const text = { op: "text" as const, lines: ["Welcome to the hollow."] };
    pair.pocket = updateSelectedPage(pair.pocket, (page) => ({ ...page, commands: [text] }));
    pair.transaction([insertCommandOp(pair.pageRef(), { path: [], index: 0 }, text)]);
    pair.check("insert command");
    const conditioned: Page = { ...pair.event().pages[0]!, condition: { selfSwitch: "A" } };
    pair.transaction([updatePageOp(pair.pageRef(), conditioned)]);
    pair.pocket = updateSelectedPage(pair.pocket, () => conditioned);
    pair.check("page condition");
    pair.transaction([addPageOp(village, created.id, pair.event().pages.length)]);
    pair.pocket = addPage(pair.pocket);
    pair.check("add page");
    pair.pocket = selectPage(pair.pocket, 0);
    pair.transaction([pageCopyOp(village, pair.event(), 0)!]);
    pair.pocket = copyPage(pair.pocket);
    pair.check("copy page");
    pair.transaction(pageMoveOps(village, pair.event(), 1, 2)!);
    pair.pocket = movePage(pair.pocket, 2);
    pair.check("move page");
    pair.transaction([pageDeleteOp(village, pair.event(), 2)!]);
    pair.pocket = deletePage(pair.pocket);
    pair.check("delete page");

    // --- duplicate and delete events ---
    pair.pocket = selectEvent(pair.pocket, "elder");
    const source = pair.event();
    const sourceIndex = pair.map().events!.indexOf(source);
    pair.pocket = duplicateSelectedEvent(pair.pocket);
    pair.run("add-event", { map: village, event: { ...structuredClone(source), id: `${source.id}-copy` }, index: sourceIndex + 1 });
    pair.check("duplicate event");
    expect(sourceIndex + 2).toBeLessThan(pair.map().events!.length); // not an append
    expect(pair.map().events![sourceIndex + 1]!.id).toBe(`${source.id}-copy`);
    pair.pocket = selectEvent(pair.pocket, "sign");
    pair.pocket = deleteSelectedEvent(pair.pocket);
    pair.run("delete-event", { map: village, event: "sign" });
    pair.check("delete event");

    // --- map properties and map management ---
    const named = setMapName(pair.pocket, "Village Square");
    expect(named.ok).toBe(true);
    if (named.ok) pair.pocket = named.state;
    pair.run("update-map", { map: village, changes: { name: "Village Square" } });
    pair.check("map name");
    const renamed = renameMap(pair.pocket, "square");
    expect(renamed.ok).toBe(true);
    if (renamed.ok) pair.pocket = renamed.state;
    pair.run("update-map", { map: village, changes: { id: "square" } });
    pair.check("map id (start and transfers follow)");
    const resized = resizeMap(pair.pocket, 22, 13);
    expect(resized.ok).toBe(true);
    if (resized.ok) pair.pocket = resized.state;
    pair.run("update-map", { map: "square", changes: { width: 22 } });
    pair.check("map resize");
    const sheets = setMapSheets(pair.pocket, ["town", "dun"]);
    expect(sheets.ok).toBe(true);
    if (sheets.ok) pair.pocket = sheets.state;
    pair.run("update-map", { map: "square", changes: { sheets: ["town", "dun"] } });
    pair.check("map sheets");
    const added = newMap(pair.pocket, { sheets: ["town"], fill: "town.0" });
    expect(added.ok).toBe(true);
    if (added.ok) pair.pocket = added.state;
    pair.run("add-map", { after: "square", sheets: ["town"], fill: "town.0" });
    pair.check("new map");
    const fresh = pair.map().id;
    const copied = duplicateMap(pair.pocket);
    expect(copied.ok).toBe(true);
    if (copied.ok) pair.pocket = copied.state;
    pair.run("duplicate-map", { map: fresh });
    pair.check("duplicate map");
    const removed = deleteMap(pair.pocket, true);
    expect(removed.ok).toBe(true);
    if (removed.ok) pair.pocket = removed.state;
    pair.run("delete-map", { map: `${fresh}-copy` });
    pair.check("delete map");

    // --- an accepted proposal replaces the project as one step ---
    const proposal = structuredClone(exportProject(pair.pocket));
    proposal.title = "The Sunstone of Bramble Hollow (revised)";
    proposal.maps[0]!.ground[5] = "town.9";
    pair.pocket = commitProjectReplacement(pair.pocket, proposal);
    expect(pair.studio.replaceInline("Accept proposal", proposal).ok).toBe(true);
    pair.check("accept proposal");

    // --- history: undo, undo, redo, then a new edit clears the redo branch ---
    pair.pocket = undo(pair.pocket);
    pair.studio.undo();
    pair.check("undo proposal");
    pair.pocket = undo(pair.pocket);
    pair.studio.undo();
    pair.check("undo delete map");
    pair.pocket = redo(pair.pocket);
    pair.studio.redo();
    pair.check("redo delete map");
    stroke(pair, "ground", [[3, 3]], { tile: "town.11" });
    pair.check("edit after undo");
    expect(pair.pocket.future).toHaveLength(0);

    // 27 edits, the proposal, two undos, one redo and a final edit.
    expect(pair.steps).toBe(32);
    expect(pair.pocket.past).toHaveLength(28);
    expect(pair.pocketText()).toBe(pair.studio.exportText());
  });

  test("undo all the way back restores the authored bytes in both editors", () => {
    const pair = new Pair(SOURCE);
    stroke(pair, "passage", [[2, 2]], { passage: "pass" });
    pair.pocket = createEventAt(pair.pocket, 5, 5);
    pair.run("add-event", { map: pair.map().id, event: { id: pair.event().id, x: 5, y: 5, pages: [{ trigger: "action", commands: [] }] } });
    pair.check("setup");
    while (pair.pocket.past.length > 0) {
      pair.pocket = undo(pair.pocket);
      pair.studio.undo();
      pair.check("undo");
    }
    expect(pair.pocketText()).toBe(SOURCE);
    expect(pair.studio.exportText()).toBe(SOURCE);
  });

  test("a refused operation changes neither editor", () => {
    const pair = new Pair(SOURCE);
    // Shrinking the start map below the start cell is invalid for both.
    const refused = resizeMap(pair.pocket, 5, 5);
    expect(refused.ok).toBe(false);
    const response = pair.studio.run("update-map", { map: pair.map().id, changes: { width: 5, height: 5 } });
    expect(response.ok).toBe(false);
    if (!refused.ok && !response.ok) expect(refused.error).toBe(response.error.message);
    pair.check("refused resize");
    expect(pair.pocket.past).toHaveLength(0);
  });
});
