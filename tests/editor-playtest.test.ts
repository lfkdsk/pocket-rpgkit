import { describe, expect, test } from "bun:test";
import {
  applyPlaytestCarry,
  buildPlaytestProject,
  capturePlaytestCarry,
  diagnosePlaytestProject,
  editPlaytestState,
  playtestDebugCatalog,
  playtestEventPages,
  playtestFibers,
  playtestSceneIds,
  playtestStartCell,
} from "../editor/engine/playtest.ts";
import {
  createEditorState,
  currentMap,
  paintCell,
  redo,
  selectMap,
  selectTile,
  strokeEnd,
  strokeStart,
  undo,
} from "../editor/engine/model.ts";
import { createSession, startSession, stepSession } from "../src/engine/session.ts";
import type { Command, Project } from "../src/engine/types.ts";
import { PLAYTEST_SCENE_RULES, playtestSceneRules } from "../editor/engine/playtest-view.ts";

function project(commands: Command[] = []): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Editor playtest",
    tileSize: 16,
    start: { map: "one", x: 0, y: 0, dir: "right" },
    initialGold: 7,
    sheets: [{ id: "tile", cols: 2, rows: 1, pak: "tiles" }],
    items: [
      { id: "potion", name: "Potion", sprite: "tile.1" },
      { id: "key", name: "Key", sprite: "tile.1" },
    ],
    maps: [
      {
        id: "one",
        name: "One",
        width: 4,
        height: 3,
        sheets: ["tile"],
        ground: new Array(12).fill("tile.0"),
        events: [
          {
            id: "gate",
            x: 2,
            y: 1,
            pages: [
              { trigger: "action", commands },
              { condition: { switch: "gate.open" }, trigger: "action", commands: [] },
            ],
          },
        ],
      },
      {
        id: "two",
        name: "Two",
        width: 2,
        height: 2,
        sheets: ["tile"],
        ground: new Array(4).fill("tile.0"),
        events: [],
      },
    ],
  };
}

function paintOne(state = createEditorState(project())) {
  state = selectTile(state, "tile.1");
  state = strokeStart(state);
  state = paintCell(state, 5);
  return strokeEnd(state);
}

describe("editor playtest document snapshot", () => {
  test("uses unsaved tiles and overrides only the disposable preview start", () => {
    let editor = paintOne();
    editor = selectMap(editor, 1);
    const history = structuredClone({ past: editor.past, future: editor.future });
    const authoredStart = structuredClone(editor.project.start);

    const preview = buildPlaytestProject(editor, { x: 1, y: 1 });

    expect(preview.maps[0]!.ground[5]).toBe("tile.1");
    expect(preview.start).toEqual({ map: "two", x: 1, y: 1, dir: "right" });
    expect(editor.project.start).toEqual(authoredStart);
    expect({ past: editor.past, future: editor.future }).toEqual(history);
    expect(editor.dirty).toBe(true);
  });

  test("falls back to the authored project start and leaves undo/redo usable", () => {
    const editor = paintOne();
    const beforeStop = structuredClone(editor);
    expect(buildPlaytestProject(editor, null).start).toEqual(project().start);

    expect(editor).toEqual(beforeStop);
    const undone = undo(editor);
    expect(currentMap(undone).ground[5]).toBe("tile.0");
    const redone = redo(undone);
    expect(currentMap(redone).ground[5]).toBe("tile.1");
  });

  test("rejects a selected cell outside the current map", () => {
    expect(() => buildPlaytestProject(createEditorState(project()), { x: 4, y: 0 }))
      .toThrow("outside map one");
  });

  test("falls back to the authored start when the remembered cell was cropped away", () => {
    const editor = createEditorState(project());
    const map = currentMap(editor);
    expect(playtestStartCell(editor, { mapId: map.id, x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(playtestStartCell(editor, { mapId: map.id, x: map.width, y: 0 })).toBeNull();
    expect(playtestStartCell(editor, { mapId: map.id, x: 0, y: map.height })).toBeNull();
    expect(playtestStartCell(editor, { mapId: "elsewhere", x: 0, y: 0 })).toBeNull();
    expect(playtestStartCell(editor, null)).toBeNull();
    // The fallback never reaches buildPlaytestProject's out-of-map error.
    expect(() => buildPlaytestProject(editor, playtestStartCell(editor, { mapId: map.id, x: map.width, y: 0 })))
      .not.toThrow();
  });
});

describe("editor playtest debug state", () => {
  test("edits a live switch bank immutably and page selection observes it", () => {
    const p = project();
    const session = createSession(p);
    let state = stepSession(session, startSession(p, session), { buttons: 0 });
    expect(state.chars.chars.gate?.pageIndex).toBe(0);
    const previous = state;

    state = editPlaytestState(state, { kind: "switch", id: "gate.open", value: true });
    expect(previous.sw.switches["gate.open"]).toBeUndefined();
    expect(state.sw).toBe(state.interp.sw);
    expect(state.sw.switches["gate.open"]).toBe(true);

    state = stepSession(session, state, { buttons: 0 });
    expect(state.chars.chars.gate?.pageIndex).toBe(1);
    expect(playtestEventPages(state)).toEqual([{ eventId: "gate", pageIndex: 1 }]);
  });

  test("edits variables, self switches, items and gold with engine normalization", () => {
    const p = project();
    const session = createSession(p);
    let state = startSession(p, session);
    state = editPlaytestState(state, { kind: "variable", id: "score", value: 3.9 });
    state = editPlaytestState(state, { kind: "selfSwitch", mapId: "one", eventId: "gate", value: "C" });
    state = editPlaytestState(state, { kind: "item", id: "potion", value: 2.8 });
    state = editPlaytestState(state, { kind: "gold", value: 19.7 });
    expect(state.sw).toBe(state.interp.sw);
    expect(state.sw.variables.score).toBe(3);
    expect(state.sw.self["one/gate"]).toBe("C");
    expect(state.sw.items.potion).toBe(2);
    expect(state.sw.gold).toBe(19);

    state = editPlaytestState(state, { kind: "selfSwitch", mapId: "one", eventId: "gate", value: undefined });
    state = editPlaytestState(state, { kind: "item", id: "potion", value: 0 });
    expect(state.sw.self["one/gate"]).toBeUndefined();
    expect(state.sw.items.potion).toBeUndefined();
  });

  test("LAST mode carries only switches and variables into a fresh session", () => {
    const p = project();
    const session = createSession(p);
    let ended = startSession(p, session);
    ended = editPlaytestState(ended, { kind: "switch", id: "gate.open", value: true });
    ended = editPlaytestState(ended, { kind: "variable", id: "chapter", value: "late" });
    ended = editPlaytestState(ended, { kind: "item", id: "key", value: 4 });
    ended = editPlaytestState(ended, { kind: "gold", value: 99 });
    const carry = capturePlaytestCarry(ended);

    const fresh = startSession(p, createSession(p));
    const resumed = applyPlaytestCarry(fresh, carry);
    expect(resumed.sw.switches).toEqual({ "gate.open": true });
    expect(resumed.sw.variables).toEqual({ chapter: "late" });
    expect(resumed.sw.items.key).toBeUndefined();
    expect(resumed.sw.gold).toBe(7);
    expect(resumed.sw.rng).toBe(fresh.sw.rng);
    expect(resumed.sw).toBe(resumed.interp.sw);
  });
});

describe("editor playtest diagnostics", () => {
  test("catalogs authored and live values including only current-map events", () => {
    const p = project([
      { op: "variable", id: "score", set: { op: "copy", from: "source" } },
      { op: "item", item: "hidden", set: "add", count: 1 },
    ]);
    const session = createSession(p);
    let state = startSession(p, session);
    state = editPlaytestState(state, { kind: "switch", id: "live.only", value: true });
    state = editPlaytestState(state, { kind: "variable", id: "live.var", value: 1 });
    state = editPlaytestState(state, { kind: "item", id: "live.item", value: 1 });
    expect(playtestDebugCatalog(p, state)).toEqual({
      switches: ["gate.open", "live.only"],
      variables: ["live.var", "score", "source"],
      items: ["hidden", "key", "live.item", "potion"],
      events: ["gate"],
    });
  });

  test("reports deterministic fallbacks for nested extensions, battles and backdrops", () => {
    const p = project([
      {
        op: "if",
        if: { kind: "ext", call: "quest.ready", args: null },
        then: [{ op: "ext", call: "quest.advance", args: { by: 1 } }],
      },
      { op: "extChoice", call: "party.pick", args: null, prompt: "Pick" },
      { op: "screenBackdrop", layer: "cutscene", variant: "arrival" },
      { op: "battle", setup: { foe: "slime" }, onWin: [{ op: "ext", call: "quest.win", args: null }] },
    ]);
    expect(diagnosePlaytestProject(p)).toEqual([
      {
        kind: "extension",
        key: "choice party.pick",
        message: "Preview fallback: unregistered extension choice party.pick is disabled.",
      },
      {
        kind: "extension",
        key: "command quest.advance",
        message: "Preview fallback: unregistered extension command quest.advance is disabled.",
      },
      {
        kind: "extension",
        key: "command quest.win",
        message: "Preview fallback: unregistered extension command quest.win is disabled.",
      },
      {
        kind: "extension",
        key: "condition quest.ready",
        message: "Preview fallback: unregistered extension condition quest.ready is disabled.",
      },
      {
        kind: "battle",
        key: "battle",
        message: "Preview fallback: battle uses the editor WIN / ESCAPE placeholder.",
      },
      {
        kind: "backdrop",
        key: "cutscene/arrival",
        message: "Preview fallback: screen backdrop cutscene/arrival uses a placeholder.",
      },
    ]);
    expect(() => createSession(p, 60, { extensions: { allowUnknown: true } }))
      .toThrow("no BattleRules were registered");
  });

  test("reports a scene fallback and routes confirm/cancel through the placeholder", () => {
    const p = project([
      {
        op: "scene",
        id: "game.pc",
        args: { box: 6 },
        onDone: [{ op: "switch", id: "gate.open", value: true }],
      },
    ]);
    p.maps[0]!.events![0]!.pages[0]!.trigger = "autorun";
    expect(diagnosePlaytestProject(p)).toContainEqual({
      kind: "scene",
      key: "game.pc",
      message: "Preview fallback: scene game.pc uses the editor OK / CANCEL placeholder.",
    });
    expect(playtestSceneIds(p)).toEqual(["game.pc"]);

    // Without the placeholder the engine refuses the session.
    expect(() => createSession(p, 60, { extensions: { allowUnknown: true } }))
      .toThrow("unregistered scene ids");

    // With the placeholder the session starts and confirm completes the
    // scene through its onDone branch.
    const session = createSession(p, 60, {
      extensions: { allowUnknown: true },
      scenes: playtestSceneRules(p),
    });
    let state = startSession(p, session);
    for (let guard = 0; state.scene === null && guard < 30; guard++) {
      state = stepSession(session, state, { buttons: 0 });
    }
    expect(state.scene?.kind).toBe("scene");
    state = stepSession(session, state, { buttons: 0, confirmEdge: true });
    // The completion resumes the parked fiber; onDone runs on the next tick.
    for (let guard = 0; guard < 30; guard++) {
      state = stepSession(session, state, { buttons: 0 });
      if (state.sw.switches["gate.open"] === true) break;
    }
    expect(state.scene).toBeNull();
    expect(state.sw.switches["gate.open"]).toBe(true);

    // The cancel edge completes as cancelled (onCancel, no writes).
    const start = PLAYTEST_SCENE_RULES.start(null, {}, 0, {
      ext: null,
      switches: {},
      variables: {},
      items: {},
      gold: 0,
      playerName: "",
    })!;
    const cancelled = PLAYTEST_SCENE_RULES.done(
      PLAYTEST_SCENE_RULES.step(start.state, { buttons: 0, cancelEdge: true }, 1),
    );
    expect(cancelled).toEqual({ ext: null, cancelled: true });
  });

  test("projects the active event page and every interpreter fiber address", () => {
    const p = project([{ op: "wait", seconds: 1 }]);
    p.maps[0]!.events![0]!.pages[0]!.trigger = "autorun";
    const session = createSession(p);
    const state = stepSession(session, startSession(p, session), { buttons: 0 });
    const fibers = playtestFibers(state);
    expect(fibers).toHaveLength(1);
    expect(fibers[0]).toMatchObject({
      key: "one/gate",
      eventId: "gate",
      pageIndex: 0,
      mode: "wait",
      parallel: false,
    });
    expect(fibers[0]!.frames[0]).toMatchObject({ depth: 0, pc: 0, length: 1, op: "wait" });
  });
});
