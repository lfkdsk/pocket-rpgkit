// tests/editor-map-model.test.ts — structural editor model: map properties
// (name/resize/sheets), map management (new/duplicate/delete/rename with
// transfer reference updates), passage override strokes, and sheet dirEdges
// strokes. Every operation is one undo step; exports validate and keep
// untouched maps byte-stable.

import { describe, expect, test } from "bun:test";
import type { Command, Project } from "../src/engine/types.ts";
import {
  createEditorState,
  currentMap,
  deleteMap,
  duplicateMap,
  edgePaintCell,
  edgeStrokeEnd,
  edgeStrokeStart,
  exportProject,
  mapReferences,
  newMap,
  paintCell,
  redo,
  renameMap,
  resizeMap,
  selectLayer,
  selectMap,
  selectPassageBrush,
  selectTile,
  setMapName,
  setMapSheets,
  strokeEnd,
  strokeStart,
  undo,
  type EditorState,
} from "../editor/engine/model.ts";
import { serializeProject, validateProject } from "../editor/engine/document.ts";

const transferTo = (map: string): Command => ({
  op: "transfer",
  map,
  x: 1,
  y: 2,
  dir: "up",
});

function makeProject(): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Map Model Fixture",
    tileSize: 16,
    start: { map: "a", x: 0, y: 0, dir: "down" },
    sheets: [
      { id: "town", cols: 12, rows: 11, pak: "chunks" },
      { id: "dun", cols: 12, rows: 11, pak: "chunks" },
    ],
    items: [],
    maps: [
      {
        id: "a",
        name: "First",
        width: 4,
        height: 4,
        sheets: ["town"],
        ground: new Array(16).fill("town.0"),
        upper: [[5, "town.9"]] as [number, string][],
        events: [
          {
            id: "evt",
            x: 1,
            y: 1,
            w: 2,
            h: 2,
            pages: [
              {
                trigger: "action",
                commands: [
                  transferTo("b"),
                  {
                    op: "if",
                    if: { kind: "switch", id: "s", value: true },
                    then: [transferTo("b")],
                    else: [transferTo("c")],
                  },
                  {
                    op: "choices",
                    prompt: "?",
                    options: [
                      { text: "go", commands: [transferTo("b")] },
                      { text: "stay", commands: [] },
                    ],
                    cancel: { commands: [transferTo("b")] },
                  },
                  {
                    op: "battle",
                    setup: { kind: "test" },
                    onWin: [transferTo("b")],
                  },
                ],
              },
            ],
          },
          { id: "edge", x: 3, y: 3, pages: [{ trigger: "action", commands: [] }] },
        ],
      },
      {
        id: "b",
        name: "Second",
        width: 3,
        height: 3,
        sheets: ["town"],
        ground: new Array(9).fill("town.1"),
        events: [],
      },
      {
        id: "c",
        name: "Third",
        width: 2,
        height: 2,
        sheets: ["dun"],
        ground: new Array(4).fill("dun.2"),
        events: [],
      },
    ],
    commonEvents: [
      { id: "ce", trigger: "none", commands: [transferTo("b")] },
    ],
  };
}

function paint(s: EditorState, indices: number[], erase = false): EditorState {
  s = strokeStart(s, erase);
  for (const i of indices) s = paintCell(s, i);
  return strokeEnd(s);
}

function expectValid(s: EditorState): void {
  const exported = exportProject(s);
  expect(validateProject(exported)).toEqual([]);
}

// --- passage overrides -------------------------------------------------------

describe("passage override strokes", () => {
  test("paint pass/block overrides and clear them; one undo step per stroke", () => {
    let s = createEditorState(makeProject());
    s = selectLayer(s, "passage");
    s = selectPassageBrush(s, "block");
    s = paint(s, [0, 1, 2]);
    expect(currentMap(s).passage).toBeUndefined(); // sparse only at export
    expect(s.passageDense[0]!.slice(0, 3)).toEqual(["block", "block", "block"]);
    expect(exportProject(s).maps[0]!.passage).toEqual([[0, "block"], [1, "block"], [2, "block"]]);
    // erase clears
    s = paint(s, [1], true);
    expect(exportProject(s).maps[0]!.passage).toEqual([[0, "block"], [2, "block"]]);
    // switch brush to pass
    s = selectPassageBrush(s, "pass");
    s = paint(s, [1]);
    expect(exportProject(s).maps[0]!.passage).toEqual([[0, "block"], [1, "pass"], [2, "block"]]);
    // undo the pass stroke, then the erase, then the block stroke
    s = undo(s);
    expect(exportProject(s).maps[0]!.passage).toEqual([[0, "block"], [2, "block"]]);
    s = undo(s);
    expect(exportProject(s).maps[0]!.passage).toEqual([[0, "block"], [1, "block"], [2, "block"]]);
    s = undo(s);
    expect(exportProject(s).maps[0]!.passage).toEqual([]);
    s = redo(s);
    expect(exportProject(s).maps[0]!.passage).toEqual([[0, "block"], [1, "block"], [2, "block"]]);
    expectValid(s);
  });

  test("untouched maps keep their passage arrays byte-for-byte", () => {
    const project = makeProject();
    project.maps[1]!.passage = [[4, "pass"]];
    let s = createEditorState(project);
    s = selectLayer(s, "passage");
    s = selectPassageBrush(s, "block");
    s = paint(s, [0]);
    const exported = exportProject(s);
    expect(exported.maps[1]!.passage).toEqual([[4, "pass"]]);
    // serialize: untouched map b's passage line is byte-stable
    const text = serializeProject(exported);
    expect(text).toContain('"passage": [\n        [\n          4,\n          "pass"\n        ]\n      ]');
  });

  test("erasing every override leaves an empty passage array", () => {
    let s = createEditorState(makeProject());
    s = selectLayer(s, "passage");
    s = selectPassageBrush(s, "block");
    s = paint(s, [0]);
    s = paint(s, [0], true);
    const exported = exportProject(s);
    expect(exported.maps[0]!.passage).toEqual([]);
    expectValid(s);
  });
});

// --- resize ------------------------------------------------------------------

describe("resizeMap", () => {
  test("expansion fills new cells with void and keeps events", () => {
    let s = createEditorState(makeProject());
    const r = resizeMap(s, 6, 5);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    s = r.state;
    const map = currentMap(s);
    expect([map.width, map.height]).toEqual([6, 5]);
    expect(map.ground).toHaveLength(30);
    expect(map.ground[0]).toBe("town.0"); // kept
    expect(map.ground[29]).toBeNull(); // new cell
    // upper pair re-indexed: index 5 in a 4-wide map is (1,1) -> 1*6+1 = 7
    expect(exportProject(s).maps[0]!.upper).toEqual([[7, "town.9"]]);
    // both events survive
    expect(map.events!.map((e) => e.id).sort()).toEqual(["edge", "evt"]);
    expectValid(s);
  });

  test("cropping drops out-of-range tiles and crops fully-outside events", () => {
    let s = createEditorState(makeProject());
    const r = resizeMap(s, 3, 3);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.croppedEvents).toEqual(["edge"]); // top-left (3,3) is outside 3x3
    s = r.state;
    const map = currentMap(s);
    expect(map.ground).toHaveLength(9);
    expect(map.events!.map((e) => e.id)).toEqual(["evt"]);
    // evt's 2x2 footprint at (1,1) clamps to 2x... width-1=2 => nw=min(2,2)=2
    expect(map.events![0]).toMatchObject({ x: 1, y: 1, w: 2, h: 2 });
    expectValid(s);
  });

  test("a partially outside event keeps its top-left and shrinks", () => {
    const project = makeProject();
    project.maps[0]!.events!.push({
      id: "partial",
      x: 2,
      y: 2,
      w: 3,
      h: 3,
      pages: [{ trigger: "action", commands: [] }],
    });
    let s = createEditorState(project);
    const r = resizeMap(s, 4, 4); // no size change -> no-op
    expect(r.ok && r.state).toBe(s);
    const r2 = resizeMap(s, 3, 4);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    s = r2.state;
    const partial = currentMap(s).events!.find((e) => e.id === "partial")!;
    expect(partial).toMatchObject({ x: 2, y: 2, w: 1, h: 2 });
  });

  test("resize is one undo step that restores tiles, events and size", () => {
    let s = createEditorState(makeProject());
    const before = serializeProject(exportProject(s));
    const r = resizeMap(s, 2, 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    s = r.state;
    expect(s.past).toHaveLength(1);
    s = undo(s);
    expect([currentMap(s).width, currentMap(s).height]).toEqual([4, 4]);
    expect(currentMap(s).events!.map((e) => e.id)).toContain("edge");
    expect(serializeProject(exportProject(s))).toBe(before);
    s = redo(s);
    expect([currentMap(s).width, currentMap(s).height]).toEqual([2, 2]);
  });

  test("resize after an upper stroke keeps the stroke's effect through undo", () => {
    let s = createEditorState(makeProject());
    s = selectLayer(s, "upper");
    s = selectTile(s, "town.0");
    s = paint(s, [10]); // upper cell on map a
    expect(exportProject(s).maps[0]!.upper).toContainEqual([10, "town.0"]);
    const r = resizeMap(s, 5, 5);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    s = r.state;
    // the flushed resize project carries the stroked upper cell, re-indexed
    // for the 5-wide map: (2,2) -> 2*5+2 = 12
    expect(exportProject(s).maps[0]!.upper).toContainEqual([12, "town.0"]);
    // undo resize: stroke effect preserved (flushed into the snapshot)
    s = undo(s);
    expect(exportProject(s).maps[0]!.upper).toContainEqual([10, "town.0"]);
    // undo the stroke itself: cell 10 returns to its authored state
    s = undo(s);
    expect(exportProject(s).maps[0]!.upper).toEqual([[5, "town.9"]]);
  });

  test("resize preserves an explicit empty events array", () => {
    let s = selectMap(createEditorState(makeProject()), 1);
    const expanded = resizeMap(s, 4, 3);
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;
    s = expanded.state;
    expect(currentMap(s).events).toEqual([]);
    s = undo(s);
    expect(currentMap(s).events).toEqual([]);
    s = redo(s);
    expect(currentMap(s).events).toEqual([]);

    const project = makeProject();
    project.maps[0]!.events = [project.maps[0]!.events![1]!];
    const cropped = resizeMap(createEditorState(project), 3, 3);
    expect(cropped.ok).toBe(true);
    if (!cropped.ok) return;
    expect(cropped.croppedEvents).toEqual(["edge"]);
    expect(currentMap(cropped.state).events).toEqual([]);
    expect(redo(undo(cropped.state)).project.maps[0]!.events).toEqual([]);
  });

  test("rejects non-integer and out-of-range sizes", () => {
    const s = createEditorState(makeProject());
    expect(resizeMap(s, 0, 4).ok).toBe(false);
    expect(resizeMap(s, 257, 4).ok).toBe(false);
    expect(resizeMap(s, 2.5, 4).ok).toBe(false);
    expect(resizeMap(s, Number.NaN, 4).ok).toBe(false);
  });
});

// --- map properties ----------------------------------------------------------

describe("map property edits", () => {
  test("renameMap updates start.map and every transfer reference", () => {
    let s = createEditorState(makeProject());
    s = selectMap(s, 1); // map b
    const r = renameMap(s, "b-two");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    s = r.state;
    const exported = exportProject(s);
    expect(exported.maps[1]!.id).toBe("b-two");
    expect(exported.start.map).toBe("a"); // start was on a, unchanged
    // rename a (the start map) instead
    s = selectMap(s, 0);
    const r2 = renameMap(s, "a-one");
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    s = r2.state;
    const exported2 = exportProject(s);
    expect(exported2.start.map).toBe("a-one");
    // no transfer targets a anymore
    expect(mapReferences(exported2, "a")).toEqual([]);
    // all six transfers that named b now name b-two (root + if.then +
    // choices.option + choices.cancel + battle.onWin + common; if.else targets c)
    const refs = mapReferences(exported2, "b-two");
    expect(refs.map((ref) => ref.eventId).sort()).toEqual(
      ["ce", "evt", "evt", "evt", "evt", "evt"].sort(),
    );
    expectValid(s);
  });

  test("renameMap refuses bad patterns, duplicates and no-ops", () => {
    const s = createEditorState(makeProject());
    expect(renameMap(s, "HAS SPACES").ok).toBe(false);
    expect(renameMap(s, "b").ok).toBe(false); // duplicate
    const same = renameMap(s, "a");
    expect(same.ok && same.state).toBe(s);
  });

  test("rename is undoable and restores references", () => {
    let s = createEditorState(makeProject());
    s = selectMap(s, 1); // map b
    const r = renameMap(s, "b-two");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    s = undo(r.state);
    const exported = exportProject(s);
    expect(exported.maps[1]!.id).toBe("b");
    expect(mapReferences(exported, "b").length).toBeGreaterThan(0);
    expect(mapReferences(exported, "b-two")).toEqual([]);
  });

  test("setMapName validates and is one undo step", () => {
    let s = createEditorState(makeProject());
    expect(setMapName(s, "  ").ok).toBe(false);
    expect(setMapName(s, "x".repeat(41)).ok).toBe(false);
    const r = setMapName(s, "Renamed");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(currentMap(r.state).name).toBe("Renamed");
    s = undo(r.state);
    expect(currentMap(s).name).toBe("First");
  });

  test("the first property edit leaves the loaded project and prior state as the save baseline", () => {
    const loaded = makeProject();
    const baseline = serializeProject(loaded);
    const before = createEditorState(loaded);
    const r = setMapName(before, "Renamed");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(serializeProject(loaded)).toBe(baseline);
    expect(serializeProject(exportProject(before))).toBe(baseline);
    expect(serializeProject(exportProject(r.state))).not.toBe(baseline);
    expect(r.state.project).not.toBe(before.project);
    expect(r.state.project.maps[0]).not.toBe(before.project.maps[0]);
  });

  test("deep structural transforms do not mutate transfer commands or map arrays in old states", () => {
    const renamedProject = makeProject();
    const renamedBaseline = serializeProject(renamedProject);
    const renamedState = selectMap(createEditorState(renamedProject), 1);
    const renamed = renameMap(renamedState, "b-two");
    expect(renamed.ok).toBe(true);
    expect(serializeProject(renamedProject)).toBe(renamedBaseline);
    expect(serializeProject(exportProject(renamedState))).toBe(renamedBaseline);

    const resizedProject = makeProject();
    const resizedBaseline = serializeProject(resizedProject);
    const resizedState = createEditorState(resizedProject);
    const resized = resizeMap(resizedState, 2, 2);
    expect(resized.ok).toBe(true);
    expect(serializeProject(resizedProject)).toBe(resizedBaseline);
    expect(serializeProject(exportProject(resizedState))).toBe(resizedBaseline);
  });

  test("setMapSheets refuses unknown sheets and dedupes", () => {
    let s = createEditorState(makeProject());
    expect(setMapSheets(s, []).ok).toBe(false);
    expect(setMapSheets(s, ["nope"]).ok).toBe(false);
    const r = setMapSheets(s, ["town", "dun", "town"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(currentMap(r.state).sheets).toEqual(["town", "dun"]);
    expectValid(r.state);
    // existing ground tiles from a removed sheet are preserved as data
    const r2 = setMapSheets(r.state, ["dun"]);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(currentMap(r2.state).ground[0]).toBe("town.0");
    expectValid(r2.state);
  });

  test("rename follows transfers in every page and battle onLose/onEscape", () => {
    const project = makeProject();
    const evt = project.maps[0]!.events![0]!;
    evt.pages.push({ trigger: "action", commands: [transferTo("b")] });
    const battle = evt.pages[0]!.commands.find((c) => c.op === "battle") as Extract<Command, { op: "battle" }>;
    battle.onLose = [transferTo("b")];
    battle.onEscape = [transferTo("b")];
    expect(mapReferences(project, "b")).toHaveLength(9);
    let s = createEditorState(project);
    s = selectMap(s, 1); // map b, the transfer target
    const r = renameMap(s, "b2");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(mapReferences(exportProject(r.state), "b")).toEqual([]);
    expect(mapReferences(exportProject(r.state), "b2")).toHaveLength(9);
  });

  test("rename follows transfers inside scene onDone/onCancel", () => {
    // B6: scene result branches are command containers; a transfer inside
    // them must both block map deletion (mapReferences) and be rewritten on
    // rename, exactly like battle result branches.
    const project = makeProject();
    const evt = project.maps[0]!.events![0]!;
    evt.pages[0]!.commands.push({
      op: "scene",
      id: "game.pc",
      onDone: [transferTo("b")],
      onCancel: [transferTo("b")],
    });
    const refs = mapReferences(project, "b");
    expect(refs.filter((ref) => ref.command.startsWith("s4:")).map((ref) => ref.command)).toEqual([
      "s4:done#0",
      "s4:cancel#0",
    ]);
    let s = createEditorState(project);
    s = selectMap(s, 1); // map b, the transfer target
    const r = renameMap(s, "b2");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const exported = exportProject(r.state);
    expect(mapReferences(exported, "b")).toEqual([]);
    const scene = exported.maps[0]!.events![0]!.pages[0]!.commands.find((c) => c.op === "scene") as
      Extract<Command, { op: "scene" }>;
    expect((scene.onDone![0] as Extract<Command, { op: "transfer" }>).map).toBe("b2");
    expect((scene.onCancel![0] as Extract<Command, { op: "transfer" }>).map).toBe("b2");
  });

  test("mapReferences identifies every same-page and common transfer by stable command address", () => {
    const refs = mapReferences(makeProject(), "b");
    expect(refs).toEqual([
      { mapId: "a", eventId: "evt", page: 0, command: "root#0" },
      { mapId: "a", eventId: "evt", page: 0, command: "i1:then#0" },
      { mapId: "a", eventId: "evt", page: 0, command: "c2:option:0#0" },
      { mapId: "a", eventId: "evt", page: 0, command: "c2:cancel#0" },
      { mapId: "a", eventId: "evt", page: 0, command: "b3:win#0" },
      { mapId: "(common)", eventId: "ce", page: 0, command: "root#0" },
    ]);
    expect(new Set(refs.slice(0, 5).map((ref) => ref.command)).size).toBe(5);
  });
});

// --- map management -----------------------------------------------------------

describe("map management", () => {
  test("newMap creates an empty map after the active one and selects it", () => {
    let s = createEditorState(makeProject());
    const r = newMap(s, { width: 5, height: 6, fill: "town.3" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    s = r.state;
    expect(s.project.maps).toHaveLength(4);
    expect(s.mapIndex).toBe(1); // inserted after map a
    const map = s.project.maps[1]!;
    expect([map.id, map.width, map.height]).toEqual(["map", 5, 6]);
    expect(map.ground).toHaveLength(30);
    expect(map.ground.every((t) => t === "town.3")).toBe(true);
    expect(map.events).toEqual([]);
    expectValid(s);
    // a second new map gets a unique id
    const r2 = newMap(s, {});
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.state.project.maps[2]!.id).toBe("map-2");
  });

  test("newMap refuses a fill tile outside the map's sheets", () => {
    const s = createEditorState(makeProject());
    expect(newMap(s, { fill: "dun.0" }).ok).toBe(false); // inherits town sheets
    expect(newMap(s, { fill: "town.999" }).ok).toBe(false);
    expect(newMap(s, { sheets: ["town"], fill: "town.0" }).ok).toBe(true);
  });

  test("duplicateMap copies the map with a unique id and keeps event ids", () => {
    let s = createEditorState(makeProject());
    const r = duplicateMap(s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    s = r.state;
    expect(s.mapIndex).toBe(1);
    const copy = s.project.maps[1]!;
    expect(copy.id).toBe("a-copy");
    expect(copy.name).toBe("First");
    // event ids kept verbatim (map-local uniqueness preserved)
    expect(copy.events!.map((e) => e.id)).toEqual(["evt", "edge"]);
    // the copy is a deep copy: mutating it leaves the original alone
    copy.ground[0] = "town.9";
    expect(s.project.maps[0]!.ground[0]).toBe("town.0");
    expectValid(s);
    // undo removes the copy
    s = undo(s);
    expect(s.project.maps).toHaveLength(3);
    expect(s.mapIndex).toBe(0);
  });

  test("duplicateMap copies flushed upper and passage caches through undo and redo", () => {
    let s = createEditorState(makeProject());
    s = selectLayer(s, "upper");
    s = selectTile(s, "town.2");
    s = paint(s, [10]);
    s = selectLayer(s, "passage");
    s = selectPassageBrush(s, "block");
    s = paint(s, [6]);

    const r = duplicateMap(s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    s = r.state;
    let exported = exportProject(s);
    expect(exported.maps[0]!.upper).toContainEqual([10, "town.2"]);
    expect(exported.maps[1]!.upper).toContainEqual([10, "town.2"]);
    expect(exported.maps[0]!.passage).toContainEqual([6, "block"]);
    expect(exported.maps[1]!.passage).toContainEqual([6, "block"]);

    s = undo(s);
    expect(s.project.maps).toHaveLength(3);
    expect(exportProject(s).maps[0]!.passage).toContainEqual([6, "block"]);
    s = redo(s);
    exported = exportProject(s);
    expect(exported.maps).toHaveLength(4);
    expect(exported.maps[1]!.upper).toContainEqual([10, "town.2"]);
    expect(exported.maps[1]!.passage).toContainEqual([6, "block"]);
  });

  test("deleteMap refuses the only map and the start map", () => {
    const one = makeProject();
    one.maps = [one.maps[0]!];
    const s = createEditorState(one);
    expect(deleteMap(s).ok).toBe(false);
    // map a is the start map
    const s2 = createEditorState(makeProject());
    const r = deleteMap(s2);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected refusal");
    expect(r.error).toContain("start map");
  });

  test("deleteMap lists transfer references and needs a confirm", () => {
    let s = createEditorState(makeProject());
    s = selectMap(s, 1); // map b: six transfers target it
    const r = deleteMap(s);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected refusal");
    expect(r.references.length).toBe(6);
    expect(r.references.map((ref) => ref.mapId)).toContain("(common)");
    // unconfirmed delete changes nothing
    expect(s.project.maps).toHaveLength(3);
    // confirmed delete proceeds
    const r2 = deleteMap(s, true);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.state.project.maps).toHaveLength(2);
    expect(r2.state.mapIndex).toBe(1); // clamped to the new last index
    expectValid(r2.state);
    // undo restores the map and its references
    const restored = undo(r2.state);
    expect(restored.project.maps).toHaveLength(3);
    expect(restored.project.maps[1]!.id).toBe("b");
    expect(mapReferences(exportProject(restored), "b").length).toBe(6);
  });

  test("deleteMap on an unreferenced map deletes without a confirm", () => {
    let s = createEditorState(makeProject());
    s = selectMap(s, 2); // map c: one transfer (if.else) targets it
    const r = deleteMap(s);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected refusal");
    expect(r.references).toHaveLength(1);
    // a map nobody transfers to deletes immediately
    const project = makeProject();
    project.maps[0]!.events = [];
    (project.commonEvents![0]!.commands as Command[]) = [];
    s = createEditorState(project);
    s = selectMap(s, 1);
    const r2 = deleteMap(s);
    expect(r2.ok).toBe(true);
  });
});

// --- sheet dirEdges strokes ---------------------------------------------------

describe("dirEdges strokes", () => {
  test("toggling enter/exit edges on a cell's tile sheet", () => {
    const project = makeProject();
    // dirEdges is keyed by TILE cell, so give map cells 0 and 1 distinct tiles
    project.maps[0]!.ground[1] = "town.1";
    let s = createEditorState(project);
    s = edgeStrokeStart(s, { kind: "enter", dir: "left" });
    s = edgePaintCell(s, 0); // town.0
    s = edgeStrokeEnd(s);
    const town = exportProject(s).sheets.find((sheet) => sheet.id === "town")!;
    expect(town.dirEdges).toEqual({ "0": { enter: ["left"] } });
    // toggle the same edge again -> removed
    s = edgeStrokeStart(s, { kind: "enter", dir: "left" });
    s = edgePaintCell(s, 0);
    s = edgeStrokeEnd(s);
    const town2 = exportProject(s).sheets.find((sheet) => sheet.id === "town")!;
    expect(town2.dirEdges).toBeUndefined();
    // add exit up on two DIFFERENT tiles in one stroke
    s = edgeStrokeStart(s, { kind: "exit", dir: "up" });
    s = edgePaintCell(s, 0); // town.0
    s = edgePaintCell(s, 1); // town.1
    s = edgeStrokeEnd(s);
    const town3 = exportProject(s).sheets.find((sheet) => sheet.id === "town")!;
    expect(town3.dirEdges).toEqual({ "0": { exit: ["up"] }, "1": { exit: ["up"] } });
    expectValid(s);
    // undo the whole stroke
    s = undo(s);
    expect(exportProject(s).sheets.find((sheet) => sheet.id === "town")!.dirEdges).toBeUndefined();
    s = redo(s);
    expect(exportProject(s).sheets.find((sheet) => sheet.id === "town")!.dirEdges).toEqual({
      "0": { exit: ["up"] },
      "1": { exit: ["up"] },
    });
  });

  test("clear brush removes the cell's dirEdges entry", () => {
    let s = createEditorState(makeProject());
    s = edgeStrokeStart(s, { kind: "enter", dir: "down" });
    s = edgePaintCell(s, 0);
    s = edgeStrokeEnd(s);
    s = edgeStrokeStart(s, { kind: "clear" });
    s = edgePaintCell(s, 0);
    s = edgeStrokeEnd(s);
    expect(exportProject(s).sheets.find((sheet) => sheet.id === "town")!.dirEdges).toBeUndefined();
  });

  test("void cells and cross-map painting are no-ops; one history step per drag", () => {
    const project = makeProject();
    project.maps[0]!.ground[0] = null;
    let s = createEditorState(project);
    s = edgeStrokeStart(s, { kind: "enter", dir: "left" });
    s = edgePaintCell(s, 0); // void
    s = edgePaintCell(s, -1);
    s = edgePaintCell(s, 999);
    s = edgeStrokeEnd(s);
    expect(s.past).toHaveLength(0);
    // painting on map b edits the town sheet too (shared sheet)
    s = selectMap(s, 1);
    s = edgeStrokeStart(s, { kind: "enter", dir: "left" });
    s = edgePaintCell(s, 0); // town.1 on map b
    s = edgeStrokeEnd(s);
    expect(s.past).toHaveLength(1);
    expect(exportProject(s).sheets.find((sheet) => sheet.id === "town")!.dirEdges).toEqual({
      "1": { enter: ["left"] },
    });
  });

  test("one stroke processes each normalized sheet cell only once", () => {
    const project = makeProject();
    project.maps[0]!.ground[0] = "town.0";
    project.maps[0]!.ground[1] = "town.0";
    project.maps[0]!.ground[2] = "town.00";
    let s = createEditorState(project);

    s = edgeStrokeStart(s, { kind: "enter", dir: "left" });
    for (const index of [0, 0, 1, 2]) s = edgePaintCell(s, index);
    s = edgeStrokeEnd(s);
    expect(exportProject(s).sheets.find((sheet) => sheet.id === "town")!.dirEdges).toEqual({
      "0": { enter: ["left"] },
    });
    expect(s.past).toHaveLength(1);

    s = edgeStrokeStart(s, { kind: "enter", dir: "left" });
    for (const index of [2, 1, 0, 0]) s = edgePaintCell(s, index);
    s = edgeStrokeEnd(s);
    expect(exportProject(s).sheets.find((sheet) => sheet.id === "town")!.dirEdges).toBeUndefined();
    expect(s.past).toHaveLength(2);
    s = undo(s);
    expect(exportProject(s).sheets.find((sheet) => sheet.id === "town")!.dirEdges).toEqual({
      "0": { enter: ["left"] },
    });
  });
});

// --- history integration ------------------------------------------------------

describe("structural history integration", () => {
  test("structural ops refuse while a stroke is open", () => {
    let s = createEditorState(makeProject());
    s = strokeStart(s);
    expect(resizeMap(s, 8, 8).ok).toBe(false);
    expect(renameMap(s, "z").ok).toBe(false);
    expect(newMap(s).ok).toBe(false);
    expect(duplicateMap(s).ok).toBe(false);
    expect(deleteMap(s).ok).toBe(false);
    s = strokeEnd(s);
    expect(resizeMap(s, 8, 8).ok).toBe(true);
  });

  test("a tile stroke refuses to open while an edge stroke is active", () => {
    let s = createEditorState(makeProject());
    s = edgeStrokeStart(s, { kind: "enter", dir: "left" });
    // a tile stroke cannot start mid-edge-stroke
    expect(strokeStart(s)).toBe(s);
    // and structural ops stay refused too
    expect(resizeMap(s, 8, 8).ok).toBe(false);
    s = edgeStrokeEnd(s);
    expect(strokeStart(s)).not.toBe(s);
  });

  test("undo after a structural op restores the selection", () => {
    let s = createEditorState(makeProject());
    s = selectMap(s, 1);
    const r = resizeMap(s, 5, 5);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    s = undo(r.state);
    expect(s.mapIndex).toBe(1);
    expect(s.selectedEventId).toBeNull();
  });

  test("switching layer or map mid-stroke ends the stroke with history", () => {
    let s = createEditorState(makeProject());
    s = selectLayer(s, "passage");
    s = selectPassageBrush(s, "block");
    s = strokeStart(s);
    s = paintCell(s, 5);
    // switching layer mid-stroke commits it (one history entry, cells kept)
    s = selectLayer(s, "ground");
    expect(s.past).toHaveLength(1);
    expect(exportProject(s).maps[0]!.passage).toContainEqual([5, "block"]);
    // same for a map switch
    s = selectLayer(s, "passage");
    s = strokeStart(s);
    s = paintCell(s, 6);
    s = selectMap(s, 1);
    expect(s.past).toHaveLength(2);
    s = selectMap(s, 0);
    expect(exportProject(s).maps[0]!.passage).toContainEqual([6, "block"]);
  });

  test("undo of an edge stroke keeps earlier unflushed passage paints", () => {
    let s = createEditorState(makeProject());
    s = selectLayer(s, "passage");
    s = selectPassageBrush(s, "pass");
    s = paint(s, [5]); // unflushed passage paint
    s = edgeStrokeStart(s, { kind: "enter", dir: "left" });
    s = edgePaintCell(s, 0);
    s = edgeStrokeEnd(s);
    // undo the edge stroke: the passage paint must survive
    s = undo(s);
    expect(exportProject(s).maps[0]!.passage).toContainEqual([5, "pass"]);
    expect(exportProject(s).sheets.find((sheet) => sheet.id === "town")!.dirEdges).toBeUndefined();
  });
});
