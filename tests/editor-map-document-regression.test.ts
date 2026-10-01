import { describe, expect, test } from "bun:test";
import {
  loadProject,
  serializeProjectPreservingSource,
  validateProject,
} from "../editor/engine/document.ts";
import {
  createEditorState,
  exportProject,
  redo,
  renameMap,
  resizeMap,
  setMapName,
  setMapSheets,
  undo,
  type EditorState,
  type ResizeResult,
  type StructuralResult,
} from "../editor/engine/model.ts";
import type { MapDef, Project } from "../src/engine/types.ts";

const MAP_A = `{ "events" : [], "ground" : ["s.0"], "sheets" : [ "s" ], "height" : 1, "width" : 1, "name" : "A odd", "id" : "a" }`;
const MAP_B = `{ "name" : "KEEP   B exact", "id" : "b", "height" : 1, "width" : 1, "ground" : [ "s.0" ], "events" : [], "sheets" : ["s"] }`;
const MAP_C = `{ "width" : 1, "id" : "c", "events" : [], "name" : "KEEP C exact", "ground" : ["s.0"], "height" : 1, "sheets" : [ "s" ] }`;

const SOURCE = `{
 "format":"rpgkit-project/v1", "title" : "Odd  map spacing", "tileSize":16,
 "start":{"map":"b","x":0,"y":0,"dir":"down"},
 "sheets":[{"id":"s","pak":"chunks","cols":1,"rows":1},{"rows":1,"cols":1,"pak":"chunks","id":"t"}], "items" : [],
 "maps" : [
${MAP_A},
    ${MAP_B},
 ${MAP_C}
 ]
}
`;

function loadedFixture(): { source: string; project: Project } {
  const loaded = loadProject(SOURCE);
  expect(loaded.errors).toEqual([]);
  return { source: SOURCE, project: loaded.project };
}

function newMap(id: string, name: string): MapDef {
  return {
    id,
    name,
    width: 1,
    height: 1,
    sheets: ["s"],
    ground: ["s.0"],
    events: [],
  };
}

function expectValidSave(text: string, candidate: Project): void {
  const reparsed = JSON.parse(text) as Project;
  expect(reparsed).toEqual(candidate);
  expect(validateProject(reparsed)).toEqual([]);
}

describe("map-array format-preserving export regressions", () => {
  test("NEW preserves every pre-existing map slice across shifted indexes", () => {
    const { source, project } = loadedFixture();
    const candidate = structuredClone(project);
    candidate.maps.splice(1, 0, newMap("new-map", "New map"));

    const saved = serializeProjectPreservingSource(source, project, candidate);

    expect(saved).toContain(MAP_A);
    expect(saved).toContain(MAP_B);
    expect(saved).toContain(MAP_C);
    expectValidSave(saved, candidate);
  });

  test("DUP preserves old map slices while serializing only the new id", () => {
    const { source, project } = loadedFixture();
    const candidate = structuredClone(project);
    const copy = structuredClone(candidate.maps[1]!);
    copy.id = "b-copy";
    copy.name = "KEEP   B exact copy";
    candidate.maps.splice(2, 0, copy);

    const saved = serializeProjectPreservingSource(source, project, candidate);

    expect(saved).toContain(MAP_A);
    expect(saved).toContain(MAP_B);
    expect(saved).toContain(MAP_C);
    expect(saved).toContain('"id": "b-copy"');
    expectValidSave(saved, candidate);
  });

  test("DEL reuses surviving map slices by id rather than their old indexes", () => {
    const { source, project } = loadedFixture();
    const candidate = structuredClone(project);
    candidate.maps.splice(0, 1);

    const saved = serializeProjectPreservingSource(source, project, candidate);

    expect(saved).not.toContain(MAP_A);
    expect(saved).toContain(MAP_B);
    expect(saved).toContain(MAP_C);
    expectValidSave(saved, candidate);
  });
});

type PropertyResult = StructuralResult | ResizeResult;

const PROPERTY_EDITS: { name: string; apply: (state: EditorState) => PropertyResult }[] = [
  { name: "name", apply: (state) => setMapName(state, "A after") },
  { name: "id", apply: (state) => renameMap(state, "a-renamed") },
  { name: "width", apply: (state) => resizeMap(state, 2, 1) },
  { name: "sheets", apply: (state) => setMapSheets(state, ["s", "t"]) },
];

describe("property-save baseline isolation", () => {
  for (const propertyEdit of PROPERTY_EDITS) {
    test(`${propertyEdit.name} keeps the loaded baseline pristine through save and history`, () => {
      const { source, project: baseline } = loadedFixture();
      const baselineSnapshot = structuredClone(baseline);
      const result = propertyEdit.apply(createEditorState(baseline));
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const candidate = exportProject(result.state);
      expect(baseline).toEqual(baselineSnapshot);

      const saved = serializeProjectPreservingSource(source, baseline, candidate);
      expect(saved).not.toBe(source);
      expect(saved).toContain(MAP_B);
      expect(saved).toContain(MAP_C);
      expectValidSave(saved, candidate);

      const undone = undo(result.state);
      expect(exportProject(undone)).toEqual(baselineSnapshot);
      expect(exportProject(redo(undone))).toEqual(candidate);
      expect(baseline).toEqual(baselineSnapshot);
    });
  }
});
