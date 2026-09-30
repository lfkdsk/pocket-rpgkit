import { describe, expect, test } from "bun:test";
import {
  loadProject,
  serializeProjectPreservingSource,
  validateProject,
} from "../editor/engine/document.ts";
import type { GameEvent, Project } from "../src/engine/types.ts";

const KEEP_EVENT = `{ "id" : "keep", "name" : "Odd spacing stays", "x" : 0, "y" : 0,
          "pages" : [ { "trigger" : "action", "commands" : [ { "op" : "text", "lines" : ["KEEP  punctuation"] } ] } ] }`;

const SOURCE = `{
 "format": "rpgkit-project/v1",
 "title": "Format preserving fixture", "tileSize": 16,
 "start": {"map":"m","x":0,"y":0,"dir":"down"},
 "sheets": [{"id":"s","pak":"chunks","cols":1,"rows":1}],
 "items": [],
 "maps": [{
   "id":"m", "name":"M", "width":2, "height":1,
   "sheets":["s"], "ground":["s.0","s.0"],
   "events": [
      ${KEEP_EVENT},
      {"id":"edit","name":"Before","x":1,"y":0,"pages":[{"trigger":"action","commands":[]}]}
   ]
 }]
}`;

describe("editor format-preserving document export", () => {
  test("an untouched host document returns the exact source bytes", () => {
    const loaded = loadProject(SOURCE);
    expect(loaded.errors).toEqual([]);
    expect(serializeProjectPreservingSource(SOURCE, loaded.project, loaded.project)).toBe(SOURCE);
  });

  test("editing one event leaves every byte of another event intact", () => {
    const loaded = loadProject(SOURCE);
    const edited = structuredClone(loaded.project);
    edited.maps[0]!.events![1]!.name = "After";
    edited.maps[0]!.events![1]!.pages[0]!.commands = [{ op: "text", lines: ["HELLO"] }];

    const text = serializeProjectPreservingSource(SOURCE, loaded.project, edited);
    expect(text).toContain(KEEP_EVENT);
    expect(JSON.parse(text)).toEqual(edited);
    expect(validateProject(JSON.parse(text) as Project)).toEqual([]);
  });

  test("adding and removing events reuses unchanged event source slices", () => {
    const loaded = loadProject(SOURCE);
    const added = structuredClone(loaded.project);
    const event: GameEvent = {
      id: "new-event",
      name: "New event",
      x: 1,
      y: 0,
      pages: [{ trigger: "action", sprite: null, commands: [{ op: "text", lines: ["NEW"] }] }],
    };
    added.maps[0]!.events!.push(event);
    const withAdded = serializeProjectPreservingSource(SOURCE, loaded.project, added);
    expect(withAdded).toContain(KEEP_EVENT);
    expect(JSON.parse(withAdded)).toEqual(added);

    const removed = structuredClone(loaded.project);
    removed.maps[0]!.events = [removed.maps[0]!.events![0]!];
    const withRemoved = serializeProjectPreservingSource(SOURCE, loaded.project, removed);
    expect(withRemoved).toContain(KEEP_EVENT);
    expect(withRemoved).not.toContain('"id":"edit"');
    expect(JSON.parse(withRemoved)).toEqual(removed);
  });
});
