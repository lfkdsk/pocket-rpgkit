import { describe, expect, test } from "bun:test";
import {
  HISTORY_LIMIT,
  addPage,
  copyPage,
  createEditorState,
  createEventAt,
  currentMap,
  deletePage,
  deleteSelectedEvent,
  duplicateSelectedEvent,
  eventMarkers,
  movePage,
  moveSelectedEvent,
  paintCell,
  redo,
  renameSelectedEvent,
  resizeSelectedEvent,
  selectEvent,
  selectMap,
  selectPage,
  selectTile,
  strokeEnd,
  strokeStart,
  undo,
  uniqueEventId,
  updateSelectedEvent,
  updateSelectedPage,
  type EditorState,
} from "../editor/engine/model.ts";
import { validateProject } from "../editor/engine/document.ts";
import type { GameEvent, Project } from "../src/engine/types.ts";

const action = (text: string) => ({
  trigger: "action" as const,
  commands: [{ op: "text" as const, lines: [text] }],
});

function project(): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Event editing",
    tileSize: 16,
    start: { map: "one", x: 0, y: 0, dir: "down" },
    sheets: [{ id: "tile", pak: "tiles", cols: 2, rows: 1 }],
    items: [],
    maps: [
      {
        id: "one",
        name: "One",
        width: 5,
        height: 4,
        sheets: ["tile"],
        ground: new Array(20).fill("tile.0"),
        events: [
          {
            id: "event",
            name: "First",
            x: 0,
            y: 0,
            pages: [action("one"), { trigger: "playerTouch", commands: [] }],
          },
          {
            id: "target",
            name: "Target",
            x: 3,
            y: 2,
            w: 2,
            h: 2,
            pages: [action("target")],
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

function selectedEvent(state: EditorState): GameEvent {
  return currentMap(state).events!.find((event) => event.id === state.selectedEventId)!;
}

function expectValid(state: EditorState): void {
  expect(validateProject(state.project)).toEqual([]);
}

describe("editor event selection and creation", () => {
  test("selects an event/page without history and clears selection on a map switch", () => {
    let state = createEditorState(project());
    const initial = state;
    state = selectEvent(state, "missing");
    expect(state).toBe(initial);
    state = selectEvent(state, "event", 99);
    expect({ id: state.selectedEventId, page: state.selectedPageIndex }).toEqual({ id: "event", page: 1 });
    expect(state.past).toHaveLength(0);
    state = selectPage(state, -4);
    expect(state.selectedPageIndex).toBe(0);
    state = selectMap(state, 1);
    expect({ id: state.selectedEventId, page: state.selectedPageIndex }).toEqual({ id: null, page: 0 });
    expect(state.past).toHaveLength(0);
  });

  test("creates a clamped event with one empty action page and restores both selections", () => {
    let state = selectEvent(createEditorState(project()), "event", 1);
    state = createEventAt(state, 999, -20);
    expect(state.past).toHaveLength(1);
    expect(state.future).toHaveLength(0);
    expect(state.selectedEventId).toBe("event-2");
    expect(selectedEvent(state)).toEqual({
      id: "event-2",
      x: 4,
      y: 0,
      pages: [{ trigger: "action", commands: [] }],
    });
    expectValid(state);

    state = undo(state);
    expect(currentMap(state).events!.map((event) => event.id)).toEqual(["event", "target"]);
    expect({ id: state.selectedEventId, page: state.selectedPageIndex }).toEqual({ id: "event", page: 1 });
    state = redo(state);
    expect({ id: state.selectedEventId, page: state.selectedPageIndex }).toEqual({ id: "event-2", page: 0 });
    expectValid(state);
  });
});

describe("editor event operations", () => {
  test("moves, resizes, and renames in bounded one-step transactions", () => {
    let state = selectEvent(createEditorState(project()), "target");
    state = moveSelectedEvent(state, 999, -5);
    expect(selectedEvent(state)).toMatchObject({ x: 3, y: 0, w: 2, h: 2 });
    expect(state.past).toHaveLength(1);

    state = resizeSelectedEvent(state, 99, 99);
    expect(selectedEvent(state)).toMatchObject({ x: 3, y: 0, w: 2, h: 4 });
    expect(state.past).toHaveLength(2);

    state = renameSelectedEvent(state, "Gatekeeper");
    expect(selectedEvent(state).name).toBe("Gatekeeper");
    expect(state.past).toHaveLength(3);
    const unchanged = renameSelectedEvent(state, "Gatekeeper");
    expect(unchanged).toBe(state);
    expectValid(state);

    state = undo(state);
    expect(selectedEvent(state).name).toBe("Target");
    state = redo(state);
    expect(selectedEvent(state).name).toBe("Gatekeeper");
  });

  test("generic event updates are immutable and sanitize/uniquify changed ids", () => {
    let state = selectEvent(createEditorState(project()), "target");
    const oldEvent = selectedEvent(state);
    state = updateSelectedEvent(state, (event) => {
      event.id = "event"; // already used by the first event
      event.name = "Changed";
      event.x = -10;
      event.w = 99;
      return event;
    });
    expect(oldEvent).toMatchObject({ id: "target", name: "Target", x: 3, w: 2 });
    expect(selectedEvent(state)).toMatchObject({ id: "event-2", name: "Changed", x: 0, w: 5 });
    expect(state.past).toHaveLength(1);
    expectValid(state);

    state = undo(state);
    expect({ id: state.selectedEventId, page: state.selectedPageIndex }).toEqual({ id: "target", page: 0 });
    state = redo(state);
    expect(state.selectedEventId).toBe("event-2");
    expectValid(state);
  });

  test("duplicates deeply with a unique id, then deletes to the adjacent event", () => {
    let state = selectEvent(createEditorState(project()), "event", 1);
    state = duplicateSelectedEvent(state);
    const duplicate = selectedEvent(state);
    expect(duplicate.id).toBe("event-copy");
    expect(duplicate).toEqual({ ...currentMap(state).events![0]!, id: "event-copy" });
    expect(duplicate.pages).not.toBe(currentMap(state).events![0]!.pages);
    expect({ page: state.selectedPageIndex, history: state.past.length }).toEqual({ page: 1, history: 1 });

    state = deleteSelectedEvent(state);
    expect(currentMap(state).events!.map((event) => event.id)).toEqual(["event", "target"]);
    expect(state.selectedEventId).toBe("target");
    expect(state.past).toHaveLength(2);
    state = undo(state);
    expect(state.selectedEventId).toBe("event-copy");
    state = redo(state);
    expect(state.selectedEventId).toBe("target");
    expectValid(state);
  });

  test("deleting the final event clears selection", () => {
    const only = project();
    only.maps[0]!.events = [only.maps[0]!.events![0]!];
    let state = selectEvent(createEditorState(only), "event", 1);
    state = deleteSelectedEvent(state);
    expect(currentMap(state).events).toEqual([]);
    expect({ id: state.selectedEventId, page: state.selectedPageIndex }).toEqual({ id: null, page: 0 });
    state = undo(state);
    expect({ id: state.selectedEventId, page: state.selectedPageIndex }).toEqual({ id: "event", page: 1 });
  });

  test("every event mutator is an identity no-op without a selection", () => {
    const state = createEditorState(project());
    const mutations = [
      (s: EditorState) => moveSelectedEvent(s, 1, 1),
      (s: EditorState) => resizeSelectedEvent(s, 2, 2),
      (s: EditorState) => renameSelectedEvent(s, "Nope"),
      (s: EditorState) => duplicateSelectedEvent(s),
      (s: EditorState) => deleteSelectedEvent(s),
      (s: EditorState) => updateSelectedEvent(s, (event) => event),
      (s: EditorState) => updateSelectedPage(s, (page) => page),
      (s: EditorState) => addPage(s),
      (s: EditorState) => deletePage(s),
      (s: EditorState) => movePage(s, 1),
      (s: EditorState) => copyPage(s),
    ];
    for (const mutate of mutations) expect(mutate(state)).toBe(state);
  });
});

describe("editor event pages", () => {
  test("adds, updates, copies, moves, and deletes pages with one undo step each", () => {
    let state = selectEvent(createEditorState(project()), "event", 1);
    state = addPage(state);
    expect(selectedEvent(state).pages).toHaveLength(3);
    expect(selectedEvent(state).pages[2]).toEqual({ trigger: "action", commands: [] });
    expect({ page: state.selectedPageIndex, history: state.past.length }).toEqual({ page: 2, history: 1 });
    state = undo(state);
    expect({ pages: selectedEvent(state).pages.length, page: state.selectedPageIndex }).toEqual({ pages: 2, page: 1 });
    state = redo(state);
    expect({ pages: selectedEvent(state).pages.length, page: state.selectedPageIndex }).toEqual({ pages: 3, page: 2 });

    state = updateSelectedPage(state, (page) => ({
      ...page,
      trigger: "parallel",
      commands: [{ op: "wait", seconds: 0.25 }],
    }));
    expect(selectedEvent(state).pages[2]).toEqual({
      trigger: "parallel",
      commands: [{ op: "wait", seconds: 0.25 }],
    });
    expect(state.past).toHaveLength(2);

    state = copyPage(state);
    expect({ pages: selectedEvent(state).pages.length, page: state.selectedPageIndex }).toEqual({ pages: 4, page: 3 });
    expect(selectedEvent(state).pages[3]).toEqual(selectedEvent(state).pages[2]);
    expect(selectedEvent(state).pages[3]).not.toBe(selectedEvent(state).pages[2]);
    expect(state.past).toHaveLength(3);

    state = movePage(state, 0);
    expect(state.selectedPageIndex).toBe(0);
    expect(selectedEvent(state).pages[0]!.trigger).toBe("parallel");
    expect(state.past).toHaveLength(4);

    state = deletePage(state);
    expect({ pages: selectedEvent(state).pages.length, page: state.selectedPageIndex }).toEqual({ pages: 3, page: 0 });
    expect(state.past).toHaveLength(5);
    state = undo(state);
    expect({ pages: selectedEvent(state).pages.length, page: state.selectedPageIndex }).toEqual({ pages: 4, page: 0 });
    state = redo(state);
    expect({ pages: selectedEvent(state).pages.length, page: state.selectedPageIndex }).toEqual({ pages: 3, page: 0 });
    expectValid(state);
  });

  test("does not delete an event's sole page or record unchanged page JSON", () => {
    let state = selectEvent(createEditorState(project()), "target");
    expect(deletePage(state)).toBe(state);
    expect(updateSelectedPage(state, (page) => page)).toBe(state);
    expect(movePage(state, 12)).toBe(state);
  });
});

describe("event history and markers", () => {
  test("tile and event entries share ordered undo/redo without breaking tile edits", () => {
    let state = createEditorState(project());
    state = selectTile(state, "tile.1");
    state = strokeStart(state);
    state = paintCell(state, 0);
    state = strokeEnd(state);
    state = selectEvent(state, "event", 1);
    state = renameSelectedEvent(state, "Renamed");
    expect(state.past).toHaveLength(2);

    state = undo(state);
    expect(selectedEvent(state).name).toBe("First");
    expect({ id: state.selectedEventId, page: state.selectedPageIndex }).toEqual({ id: "event", page: 1 });
    state = undo(state);
    expect(currentMap(state).ground[0]).toBe("tile.0");
    state = redo(state);
    expect(currentMap(state).ground[0]).toBe("tile.1");
    state = redo(state);
    expect(selectedEvent(state).name).toBe("Renamed");
  });

  test("event history is capped at the shared 64-step limit", () => {
    let state = selectEvent(createEditorState(project()), "event");
    for (let index = 0; index < HISTORY_LIMIT + 9; index++) {
      state = renameSelectedEvent(state, `Name ${index}`);
    }
    expect(state.past).toHaveLength(HISTORY_LIMIT);
    let count = 0;
    while (state.past.length) {
      state = undo(state);
      count++;
    }
    expect(count).toBe(HISTORY_LIMIT);
  });

  test("ids are schema safe/unique and event markers expose defaulted rectangles", () => {
    const events = currentMap(createEditorState(project())).events!;
    expect(uniqueEventId(events, "bad id!?")).toBe("bad-id-");
    expect(uniqueEventId(events, "event")).toBe("event-2");
    expect(eventMarkers(currentMap(createEditorState(project())))).toEqual([
      { id: "event", x: 0, y: 0, w: 1, h: 1 },
      { id: "target", x: 3, y: 2, w: 2, h: 2 },
    ]);
  });
});
