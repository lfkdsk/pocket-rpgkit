// tests/editor-model.test.ts — pure editor core (editor/engine): edit
// reducer, document gate, geometry and buttons-mode cursor, plus the
// generated editor assets against the example sources. No host, no bundle.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canPaint,
  canRedo,
  canUndo,
  createEditorState,
  currentMap,
  eventMarkers,
  exportProject,
  HISTORY_LIMIT,
  paintCell,
  paletteTiles,
  redo,
  selectLayer,
  selectMap,
  selectTile,
  strokeEnd,
  strokeStart,
  toDenseUpper,
  undo,
  type EditorState,
} from "../editor/engine/model.ts";
import { loadProject, semanticEqual, serializeProject, validateProject } from "../editor/engine/document.ts";
import { BUNDLED_PROJECTS, PROJECT_SCHEMA } from "../editor/engine/projects.ts";
import {
  canvasFrame,
  fittedView,
  FRAME_H,
  FRAME_W,
  compactHeader,
  headerButtons,
  hitTest,
  mapOffset,
  PAL_W,
  clampCam,
  TILE,
} from "../editor/engine/layout.ts";
import { initialCursor, stepCursor, HEADER_ORDER } from "../editor/engine/cursor.ts";
import { SHEETS } from "../editor/engine/sheets.ts";
import { TILE_SRC } from "../editor/engine/tile-keys.ts";
import { EDITOR_SOURCES } from "../editor/sources.ts";
import type { Command, Condition, Project } from "../src/engine/types.ts";
import { createSession, startSession, stepSession } from "../src/engine/session.ts";
import { loadTileCells } from "../tools/lib/bake.ts";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";

const ROOT = join(import.meta.dir, "..");

function bundled(id: string): Project {
  const doc = BUNDLED_PROJECTS.find((d) => d.id === id)!;
  return JSON.parse(doc.json) as Project;
}

// --- generated assets -------------------------------------------------------

describe("editor generated assets", () => {
  test("the generated editor schema equals the normative project schema", () => {
    const normative = JSON.parse(readFileSync(join(ROOT, "src/data/schema.json"), "utf8"));
    expect(PROJECT_SCHEMA).toEqual(normative);
  });

  test("the bundled documents are the example data files byte for byte", () => {
    // Stale after an example's project changed (or a document was saved
    // over in place): re-run `bun editor/gen-assets.ts`.
    expect(BUNDLED_PROJECTS.map((d) => d.id)).toEqual(EDITOR_SOURCES.map((s) => s.id));
    for (const doc of BUNDLED_PROJECTS) {
      expect({ id: doc.id, same: readFileSync(join(ROOT, doc.file), "utf8") === doc.json }).toEqual({ id: doc.id, same: true });
    }
  });

  test("every baked tile cell is the example sheet's cell, pixel for pixel", async () => {
    for (const sheet of SHEETS) {
      const cells = await loadTileCells(join(ROOT, sheet.source), sheet.cols, sheet.rows, sheet.tile);
      for (let cell = 0; cell < sheet.cols * sheet.rows; cell++) {
        const src = TILE_SRC[`${sheet.id}.${cell}`];
        expect(src).toBe(`assets/tile-${sheet.id}-${cell}.png`);
        const png = decodePng(new Uint8Array(readFileSync(join(ROOT, "editor", src!))));
        expect({ w: png.width, h: png.height }).toEqual({ w: 16, h: 16 });
        if (Buffer.compare(Buffer.from(png.rgba), Buffer.from(cells.cell(cell))) !== 0) {
          throw new Error(`${src} differs from ${sheet.source} cell ${cell}`);
        }
      }
    }
  });

  test("every palette tile of every bundled map has baked art", () => {
    for (const doc of BUNDLED_PROJECTS) {
      let s = createEditorState(bundled(doc.id));
      for (let m = 0; m < s.project.maps.length; m++) {
        s = selectMap(s, m);
        const missing = paletteTiles(s).filter((t) => t !== null && !TILE_SRC[t]);
        expect({ doc: doc.id, map: m, missing }).toEqual({ doc: doc.id, map: m, missing: [] });
      }
    }
  });

  test("a sheet id shared by two examples comes from byte-identical files", () => {
    const byId = new Map<string, Buffer>();
    for (const src of EDITOR_SOURCES) {
      for (const [id, file] of Object.entries(src.sheets)) {
        const bytes = readFileSync(join(ROOT, file));
        const seen = byId.get(id);
        if (seen) expect(seen.equals(bytes)).toBe(true);
        else byId.set(id, bytes);
      }
    }
    expect([...byId.keys()].sort()).toEqual(["dun", "town"]);
  });
});

// --- document gate ----------------------------------------------------------

describe("editor document gate", () => {
  test("both bundled documents parse with zero schema errors", () => {
    for (const doc of BUNDLED_PROJECTS) {
      const { project, errors } = loadProject(doc.json);
      expect({ id: doc.id, errors }).toEqual({ id: doc.id, errors: [] });
      expect(project.format).toBe("rpgkit-project/v1");
    }
  });

  test("untouched re-serialization is byte-for-byte identical", () => {
    for (const doc of BUNDLED_PROJECTS) {
      const { project } = loadProject(doc.json);
      expect(serializeProject(project)).toBe(doc.json);
      // ... and so is an export through the editor state with no edits
      expect(serializeProject(exportProject(createEditorState(project)))).toBe(doc.json);
    }
  });

  test("semanticEqual ignores formatting but catches field changes", () => {
    const sunstone = BUNDLED_PROJECTS[0]!.json;
    const compact = JSON.stringify(JSON.parse(sunstone));
    expect(semanticEqual(JSON.parse(sunstone), JSON.parse(compact))).toBe(true);
    const changed = JSON.parse(sunstone) as Project;
    changed.maps[0]!.ground[0] = "town.1";
    expect(semanticEqual(JSON.parse(sunstone), changed)).toBe(false);
    const retitled = JSON.parse(sunstone) as Project;
    retitled.title = "Other";
    expect(semanticEqual(JSON.parse(sunstone), retitled)).toBe(false);
  });

  test("invalid JSON and schema violations are reported, not thrown", () => {
    const bad = loadProject("{not json");
    expect(bad.errors[0]!.path).toBe("$");
    const { project } = loadProject(BUNDLED_PROJECTS[0]!.json);
    const broken = structuredClone(project);
    (broken.maps[0]!.ground as unknown[])[0] = "bogus!!";
    expect(loadProject(JSON.stringify(broken)).errors.length).toBeGreaterThan(0);
  });

  test("accepts audio declarations, commands and BGM conditions at their schema boundaries", () => {
    const project = bundled("meadow");
    project.audio = {
      field: "audio:wav.field",
      rain: "audio:qoa.weather.rain",
    };
    const commands: Command[] = [
      { op: "playBgm", id: "field", volume: 0, pitch: 50 },
      { op: "fadeoutBgm", duration: 0 },
      { op: "stopBgm" },
      { op: "pauseBgm" },
      { op: "resumeBgm" },
      { op: "playBgs", id: "rain", volume: 100, pitch: 150 },
      { op: "fadeoutBgs", duration: 1.25 },
      { op: "playMe", id: "victory", duration: 3 },
      { op: "playSe", id: "door" },
      { op: "saveBgm" },
      { op: "replayBgm" },
      { op: "if", if: { kind: "bgmPlaying", id: "field", negate: true }, then: [] },
    ];
    project.maps[0]!.events = [{
      id: "audio",
      x: 0,
      y: 0,
      pages: [{
        condition: { all: [{ kind: "bgmPlaying" }] },
        trigger: "action",
        commands,
      }],
    }];
    expect(validateProject(project)).toEqual([]);

    const badPakKey = structuredClone(project);
    badPakKey.audio!.field = "sounds/field.wav";
    expect(validateProject(badPakKey).length).toBeGreaterThan(0);

    const emptyCommandId = structuredClone(project);
    (emptyCommandId.maps[0]!.events![0]!.pages[0]!.commands[0] as Extract<Command, { op: "playBgm" }>).id = "";
    expect(validateProject(emptyCommandId).length).toBeGreaterThan(0);

    const emptyConditionId = structuredClone(project);
    const condition = emptyConditionId.maps[0]!.events![0]!.pages[0]!.commands[11] as Extract<Command, { op: "if" }>;
    (condition.if as Extract<Condition, { kind: "bgmPlaying" }>).id = "";
    expect(validateProject(emptyConditionId).length).toBeGreaterThan(0);

    const badVolume = structuredClone(project);
    (badVolume.maps[0]!.events![0]!.pages[0]!.commands[0] as Extract<Command, { op: "playBgm" }>).volume = 101;
    expect(validateProject(badVolume).length).toBeGreaterThan(0);

    const badPitch = structuredClone(project);
    (badPitch.maps[0]!.events![0]!.pages[0]!.commands[5] as Extract<Command, { op: "playBgs" }>).pitch = 49;
    expect(validateProject(badPitch).length).toBeGreaterThan(0);

    const badDuration = structuredClone(project);
    (badDuration.maps[0]!.events![0]!.pages[0]!.commands[6] as Extract<Command, { op: "fadeoutBgs" }>).duration = -0.01;
    expect(validateProject(badDuration).length).toBeGreaterThan(0);
  });

  test("prototype-named event and switch ids play, load in the editor, and export", () => {
    for (const id of ["toString", "hasOwnProperty", "valueOf", "constructor", "__proto__x"]) {
      const project: Project = {
        format: "rpgkit-project/v1",
        title: "Tricky ids",
        tileSize: 16,
        start: { map: "m", x: 0, y: 0, dir: "right" },
        sheets: [{ id: "town", cols: 12, rows: 11, pak: "chunks" }],
        items: [],
        maps: [
          {
            id: "m",
            name: "M",
            width: 3,
            height: 3,
            sheets: ["town"],
            ground: new Array(9).fill("town.0"),
            events: [
              {
                id,
                name: id,
                x: 1,
                y: 0,
                pages: [
                  {
                    trigger: "action",
                    sprite: null,
                    commands: [
                      { op: "text", lines: ["HALT"] },
                      { op: "switch", id, value: true },
                      { op: "variable", id, set: { op: "set", value: 1 } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };
      const text = serializeProject(project);
      const loaded = loadProject(text);
      expect(loaded.errors).toEqual([]);

      const session = createSession(loaded.project, 60);
      let state = startSession(loaded.project, session);
      state = stepSession(session, state, { buttons: 0 });
      state = stepSession(session, state, { buttons: 0, confirmEdge: true });
      expect(state.interp.modal).toMatchObject({ kind: "text", lines: ["HALT"] });
      state = stepSession(session, state, { buttons: 0, confirmEdge: true });
      state = stepSession(session, state, { buttons: 0, confirmEdge: true });
      expect(state.sw.switches[id]).toBe(true);
      expect(state.sw.variables[id]).toBe(1);

      let s = createEditorState(loaded.project);
      s = selectTile(s, "town.43");
      s = paintStroke(s, [4]);
      const exported = exportProject(s);
      expect(validateProject(exported)).toEqual([]);
      expect(exported.maps[0]!.ground[4]).toBe("town.43");
      expect(exported.maps[0]!.events![0]!.id).toBe(id);
      expect(exported.maps[0]!.events![0]!.pages[0]!.commands.slice(-2)).toEqual([
        { op: "switch", id, value: true },
        { op: "variable", id, set: { op: "set", value: 1 } },
      ]);
    }
  });
});

// --- save-time schema refusal ------------------------------------------------

describe("save-time schema refusal", () => {
  test("an untouched export validates and corruptions are refused with string paths", () => {
    // The app's save gate is exactly validateProject(exportProject(state)).
    const exported = exportProject(createEditorState(bundled("sunstone")));
    expect(validateProject(exported)).toEqual([]);

    // (ii) a ground cell that is neither a tile id nor null
    const bogusCell = structuredClone(exported);
    (bogusCell.maps[0]!.ground as unknown[])[0] = "bogus!!";
    const bogusErrors = validateProject(bogusCell);
    expect(bogusErrors.length).toBeGreaterThan(0);
    expect(bogusErrors.every((e) => typeof e.path === "string")).toBe(true);

    // (iii) an event whose pages array is empty
    const noPages = structuredClone(exported);
    expect(noPages.maps[0]!.events!.length).toBeGreaterThan(0);
    noPages.maps[0]!.events![0]!.pages = [];
    const noPagesErrors = validateProject(noPages);
    expect(noPagesErrors.length).toBeGreaterThan(0);
    expect(noPagesErrors.every((e) => typeof e.path === "string")).toBe(true);
  });

  test("a ground array shorter than width*height is NOT refused by the schema", () => {
    // The v1 schema states the width*height ground length only in the ground
    // property description; it carries no minItems, so the save gate accepts
    // a shortened ground. This pins that gap so any future semantic check in
    // the gate (or a schema constraint) is a deliberate change.
    const exported = exportProject(createEditorState(bundled("sunstone")));
    const shortened = structuredClone(exported);
    const map = shortened.maps[0]!;
    expect(map.ground.length).toBe(map.width * map.height);
    map.ground = map.ground.slice(0, 1);
    expect(validateProject(shortened)).toEqual([]);
  });
});

// --- edit reducer -----------------------------------------------------------

function paintStroke(s: EditorState, indices: number[]): EditorState {
  s = strokeStart(s);
  for (const i of indices) s = paintCell(s, i);
  return strokeEnd(s);
}

describe("editor tile edit reducer", () => {
  test("single stroke paints ground cells and records one undo step", () => {
    let s = createEditorState(bundled("sunstone"));
    s = selectTile(s, "town.43");
    const before = currentMap(s).ground[5]!;
    s = paintStroke(s, [5, 6, 7]);
    const map = currentMap(s);
    expect(map.ground[5]).toBe("town.43");
    expect(map.ground[6]).toBe("town.43");
    expect(map.ground[7]).toBe("town.43");
    expect(canUndo(s)).toBe(true);
    expect(canRedo(s)).toBe(false);
    expect(s.dirty).toBe(true);
    // drag painting is ONE history entry
    const undone = undo(s);
    expect(currentMap(undone).ground[5]).toBe(before);
    expect(currentMap(undone).ground[6]).toBe(before);
    expect(canRedo(undone)).toBe(true);
    const redone = redo(undone);
    expect(currentMap(redone).ground[5]).toBe("town.43");
  });

  test("a large stroke copies its layer once and keeps the pre-stroke project immutable", () => {
    const project = bundled("sunstone");
    const map = project.maps[0]!;
    const large = structuredClone(project);
    large.maps[0] = {
      ...structuredClone(map),
      width: 100,
      height: 100,
      ground: new Array(10_000).fill("town.0"),
      upper: [],
      events: [],
    };
    const originalGround = large.maps[0]!.ground;
    let state = selectTile(createEditorState(large), "town.43");
    const open = strokeStart(state);
    state = paintCell(open, 0);
    state = paintCell(state, 1);
    state = paintCell(state, 2);
    expect(currentMap(state).ground).not.toBe(originalGround);
    expect(originalGround.slice(0, 3)).toEqual(["town.0", "town.0", "town.0"]);
    expect(currentMap(state).ground.slice(0, 3)).toEqual(["town.43", "town.43", "town.43"]);
    expect(state.stroke!.working).toBe(currentMap(state).ground);
    state = strokeEnd(state);
    expect(currentMap(undo(state)).ground.slice(0, 3)).toEqual(["town.0", "town.0", "town.0"]);
  });

  test("eraser (tile null) clears a ground cell to null", () => {
    let s = createEditorState(bundled("sunstone"));
    s = selectTile(s, null);
    s = paintStroke(s, [0]);
    expect(currentMap(s).ground[0]).toBeNull();
  });

  test("strokeStart(e, true) erases even while a paint tile is selected", () => {
    let s = createEditorState(bundled("sunstone"));
    s = selectTile(s, "town.43");
    s = strokeStart(s, true);
    s = paintCell(s, 0);
    s = strokeEnd(s);
    expect(currentMap(s).ground[0]).toBeNull();
    // the palette selection itself is unchanged (right click is a one-shot
    // erase brush, not a selection switch)
    expect(s.tile).toBe("town.43");
  });

  test("upper layer paints sparsely: untouched maps keep their original pairs", () => {
    const project = bundled("sunstone");
    const EMPTY = 9; // no star-layer cell on the village
    let s = createEditorState(project);
    s = selectLayer(s, "upper");
    s = selectTile(s, "town.104");
    s = paintStroke(s, [EMPTY]);
    const exported = exportProject(s);
    expect(exported.maps[0]!.upper).toContainEqual([EMPTY, "town.104"]);
    // untouched maps serialize the SAME content and order
    expect(exported.maps[1]!.upper).toEqual(project.maps[1]!.upper);
    expect(exported.maps[2]!.upper).toEqual(project.maps[2]!.upper);
    // dense<->sparse round trip: the new cell is present, both authored
    // pairs at the (legally duplicated) index 104 survive in authored order,
    // and the dense form shows the last pair (the runtime's rule).
    const dense = toDenseUpper(exported.maps[0]!);
    expect(dense[EMPTY]).toBe("town.104");
    expect(dense[104]).toBe("town.85");
    const pairsAt104 = exported.maps[0]!.upper!.filter(([i]) => i === 104);
    expect(pairsAt104).toEqual([[104, "town.68"], [104, "town.85"]]);
    expect(exported.maps[0]!.upper!.at(-1)).toEqual([EMPTY, "town.104"]);
  });

  test("erasing an authored upper cell drops every pair at that index", () => {
    let s = createEditorState(bundled("sunstone"));
    s = selectLayer(s, "upper");
    s = selectTile(s, null);
    s = paintStroke(s, [104]);
    const exported = exportProject(s);
    expect(exported.maps[0]!.upper!.filter(([i]) => i === 104)).toEqual([]);
    expect(validateProject(exported)).toEqual([]);
  });

  test("out-of-range cells, cross-sheet tiles and bad ids are rejected", () => {
    let s = createEditorState(bundled("sunstone"));
    expect(canPaint(s, "town.43")).toBe(true);
    expect(canPaint(s, "town.9999")).toBe(false);
    expect(canPaint(s, "dun.24")).toBe(false); // village draws only town
    expect(canPaint(s, "nope.1")).toBe(false);
    s = selectTile(s, "nope.1");
    expect(s.tile).toBeNull();
    s = selectTile(s, "town.0");
    s = paintStroke(s, [-1, 99999]);
    expect(canUndo(s)).toBe(false);
    // dungeon sheet allowed on the cave map
    s = selectMap(s, 2);
    expect(canPaint(s, "dun.24")).toBe(true);
    // meadow declares only the town sheet
    const meadow = createEditorState(bundled("meadow"));
    expect(canPaint(meadow, "town.43")).toBe(true);
    expect(canPaint(meadow, "dun.24")).toBe(false);
    expect(paletteTiles(meadow)).toHaveLength(1 + 12 * 11);
  });

  test("history caps at HISTORY_LIMIT and keeps the newest steps", () => {
    let s = createEditorState(bundled("sunstone"));
    // Erase DISTINCT cells so every stroke actually changes the layer.
    s = selectTile(s, null);
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) {
      s = paintStroke(s, [100 + i]);
    }
    expect(s.past.length).toBe(HISTORY_LIMIT);
    // the oldest steps are gone: unwind all remaining steps without error
    let n = 0;
    while (canUndo(s)) {
      s = undo(s);
      n++;
    }
    expect(n).toBe(HISTORY_LIMIT);
  });

  test("undo switches back to the stroke's map and layer", () => {
    let s = createEditorState(bundled("sunstone"));
    s = selectTile(s, "town.43");
    s = paintStroke(s, [1]); // village ground cell 1 starts town.0
    s = selectLayer(s, "upper");
    s = selectMap(s, 1);
    s = selectTile(s, "town.3");
    s = paintStroke(s, [2]); // forest upper cell 2 starts town.6
    expect(s.mapIndex).toBe(1);
    expect(s.layer).toBe("upper");
    s = undo(s);
    expect(s.mapIndex).toBe(1);
    expect(s.layer).toBe("upper");
    s = undo(s);
    expect(s.mapIndex).toBe(0);
    expect(s.layer).toBe("ground");
  });

  test("exported documents validate against the v1 schema", () => {
    for (const id of ["sunstone", "meadow"]) {
      let s = createEditorState(bundled(id));
      s = selectTile(s, "town.43");
      s = paintStroke(s, [0, 1]);
      const exported = exportProject(s);
      const { errors } = loadProject(serializeProject(exported));
      expect({ id, errors }).toEqual({ id, errors: [] });
    }
  });

  test("event markers list positions in stable order", () => {
    const s = createEditorState(bundled("sunstone"));
    const markers = eventMarkers(currentMap(s));
    const elder = markers.find((m) => m.id === "elder")!;
    expect({ x: elder.x, y: elder.y }).toEqual({ x: 9, y: 5 });
    const ys = markers.map((m) => m.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    const meadow = eventMarkers(currentMap(createEditorState(bundled("meadow"))));
    expect(meadow.map((m) => m.id)).toEqual(["chest", "signpost", "flowerbed", "brook"]);
  });
});

// --- geometry ---------------------------------------------------------------

describe("editor layout geometry", () => {
  test("fitted view: 14 rows without banner, 12 with it at 480x272", () => {
    const noBanner = fittedView(480, 272, false);
    expect(noBanner.cols).toBe(20);
    expect(noBanner.rows).toBe(14);
    expect(noBanner.frame).toEqual({ x: PAL_W + 10, y: 25, w: FRAME_W, h: FRAME_H });
    const withBanner = fittedView(480, 272, true);
    expect(withBanner.cols).toBe(20);
    expect(withBanner.rows).toBe(12);
    expect(withBanner.frame.w).toBe(FRAME_W);
    expect(withBanner.frame.h).toBe(12 * 16);
    expect(withBanner.frame.y + withBanner.frame.h).toBeLessThanOrEqual(272 - 18);
    // the default desktop window (720x480) gets the full 20x14 cell window
    const desktop = fittedView(720, 480, false);
    expect({ c: desktop.cols, r: desktop.rows }).toEqual({ c: 20, r: 14 });
  });

  test("canvasFrame matches fittedView's frame", () => {
    expect(canvasFrame(480, 272, false)).toEqual(fittedView(480, 272, false).frame);
  });

  test("header buttons partition the top strip and never overlap", () => {
    const bs = headerButtons(480);
    expect(bs.map((b) => b.id)).toEqual([
      "layer", "map", "proposals", "play", "more", "undo", "redo", "save",
    ]);
    expect(headerButtons(480, true).map((b) => b.id)).toEqual([
      "more", "doc", "mapprev", "mapnext", "state",
    ]);
    expect(headerButtons(400, true).map((b) => b.id)).toEqual([
      "more", "doc", "mapprev", "mapnext", "state", "undo", "redo",
    ]);
    expect(compactHeader(480)).toBe(true);
    expect(compactHeader(720)).toBe(false);
    expect(headerButtons(720).map((b) => b.id)).toEqual([
      "layer", "doc", "mapprev", "mapnext", "map", "proposals", "play", "state", "undo", "redo", "save",
    ]);
    expect(bs.find((b) => b.id === "layer")).toMatchObject({ x: 4, w: 64 });

    for (const width of [400, 480, 720, 960]) {
      for (const row of [headerButtons(width), ...(compactHeader(width) ? [headerButtons(width, true)] : [])]) {
        for (let i = 1; i < row.length; i++) {
          expect(row[i]!.x).toBeGreaterThanOrEqual(row[i - 1]!.x + row[i - 1]!.w);
        }
        for (const button of row) {
          expect(button.w * button.h).toBeGreaterThan(40);
          expect(button.x).toBeGreaterThanOrEqual(0);
          expect(button.x + button.w).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  test("hit-test partitions header, palette and cells", () => {
    const vp = { w: 480, h: 272 };
    const f = fittedView(vp.w, vp.h, false).frame;
    expect(hitTest(20, 10, vp.w, vp.h, f, 0, 0, 100, 0)?.kind).toBe("button");
    // palette slot 1 center (one right of the eraser): panel starts at
    // HEADER_H=20, first thumbnail row is panel-relative y 33.
    const pal = hitTest(3 + 13 + 6, 20 + 33 + 6, vp.w, vp.h, f, 0, 0, 100, 0);
    expect(pal).toEqual({ kind: "palette", slot: 1 });
    const cell = hitTest(f.x + 8, f.y + 8, vp.w, vp.h, f, 3, 2, 100, 0);
    expect(cell).toEqual({ kind: "cell", tx: 3, ty: 2 });
    // dead gutter between strips is nothing
    expect(hitTest(PAL_W - 2, 100, vp.w, vp.h, f, 0, 0, 100, 0)).toBeNull();
  });

  test("hit-test follows the letterbox of a map smaller than the window", () => {
    const vp = { w: 720, h: 480 };
    const f = fittedView(vp.w, vp.h, false).frame; // 20x14 window
    // meadow 20x12 draws one row down; the forest 18x14 one column right
    const meadow = { w: 20, h: 12 };
    const forest = { w: 18, h: 14 };
    const at = (x: number, y: number, map: { w: number; h: number }) =>
      hitTest(x, y, vp.w, vp.h, f, 0, 0, 133, 0, map);
    expect(at(f.x + 8, f.y + TILE + 8, meadow)).toEqual({ kind: "cell", tx: 0, ty: 0 });
    expect(at(f.x + 4 * TILE + 8, f.y + 5 * TILE + 8, meadow)).toEqual({ kind: "cell", tx: 4, ty: 4 });
    expect(at(f.x + 8, f.y + 8, meadow)).toBeNull(); // top letterbox band
    expect(at(f.x + 8, f.y + 13 * TILE + 8, meadow)).toBeNull(); // bottom band
    expect(at(f.x + TILE + 8, f.y + 8, forest)).toEqual({ kind: "cell", tx: 0, ty: 0 });
    expect(at(f.x + 8, f.y + 8, forest)).toBeNull(); // left band
    expect(at(f.x + 19 * TILE + 8, f.y + 8, forest)).toBeNull(); // right band
  });

  test("camera clamps and small maps letterbox with a floor-split offset", () => {
    expect(clampCam(50, 64, 20)).toBe(44);
    expect(clampCam(-5, 20, 20)).toBe(0);
    expect(mapOffset(13, 14)).toBe(0);
    expect(mapOffset(12, 14)).toBe(1);
    expect(mapOffset(18, 20)).toBe(1);
    expect(mapOffset(20, 14)).toBe(0);
  });
});

// --- buttons cursor ---------------------------------------------------------

describe("editor buttons-mode cursor", () => {
  const world = {
    mapW: 20,
    mapH: 13,
    viewCols: 20,
    viewRows: 14,
    camX: 0,
    camY: 0,
    paletteSize: 133,
    headerSize: HEADER_ORDER.length,
  };

  test("up on the top row enters the header; down returns to the same column band", () => {
    const cur = initialCursor(9, 0);
    let r = stepCursor(cur, 2, world); // up -> header
    expect(r.cursor.zone).toBe("header");
    r = stepCursor(r.cursor, 0, { ...world, ...r }); // down
    expect(r.cursor.zone).toBe("canvas");
    expect(Math.abs(r.cursor.tx - 9)).toBeLessThanOrEqual(2);
    expect(r.cursor.ty).toBe(0);
  });

  test("left at canvas col 0 enters the palette and right returns", () => {
    let r = stepCursor(initialCursor(0, 3), 1, world);
    expect(r.cursor.zone).toBe("palette");
    r = stepCursor(r.cursor, 3, { ...world, ...r });
    expect(r.cursor.zone).toBe("canvas");
    expect(r.cursor.tx).toBe(0);
  });

  test("header L/R wraps around the button row", () => {
    const cur = initialCursor(0, 0);
    let r = stepCursor(cur, 2, world);
    r = stepCursor(r.cursor, 1, { ...world, ...r });
    expect(r.cursor.button).toBe(HEADER_ORDER.length - 1);
  });

  test("on a big map the cursor pans the camera at the window edge", () => {
    const big = { ...world, mapW: 64, mapH: 64 };
    const r = stepCursor(initialCursor(19, 0), 3, big); // right at edge
    expect(r.camX).toBe(1);
    expect(r.cursor.tx).toBe(19);
  });
});
