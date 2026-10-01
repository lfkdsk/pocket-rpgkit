import { describe, expect, test } from "bun:test";
import {
  applyEditPatch,
  executeEditOperation,
  semanticHash,
} from "../editor/api/operations.ts";
import type { EditExecution, EditSuccess } from "../editor/api/types.ts";
import { serializeProject } from "../editor/engine/document.ts";
import type { Command, Project, ProjectShell } from "../src/engine/types.ts";

function fixture(): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Agent fixture",
    tileSize: 16,
    start: { map: "map", x: 0, y: 0, dir: "down" },
    sheets: [{ id: "s", pak: "chunks", cols: 2, rows: 2 }],
    items: [],
    maps: [{
      id: "map",
      name: "Map",
      width: 4,
      height: 3,
      sheets: ["s"],
      ground: [
        "s.0", "s.0", "s.1", "s.1",
        "s.0", "s.2", "s.1", "s.1",
        "s.3", "s.2", "s.2", "s.1",
      ],
      upper: [[0, "s.2"]],
      events: [{
        id: "npc",
        name: "Guide",
        x: 1,
        y: 1,
        pages: [
          {
            trigger: "action",
            commands: [
              { op: "text", lines: ["Hello"] },
              { op: "if", if: { kind: "switch", id: "gate" }, then: [{ op: "gold", set: "add", amount: 1 }] },
            ],
          },
          { condition: { selfSwitch: "A" }, trigger: "action", commands: [] },
        ],
      }],
    }],
  };
}

function success(execution: EditExecution): EditSuccess & { output: string } {
  if (!execution.response.ok) throw new Error(JSON.stringify(execution.response));
  expect(execution.output).toBeDefined();
  return Object.assign(execution.response, { output: execution.output! });
}

function readSuccess(execution: EditExecution): EditSuccess {
  if (!execution.response.ok) throw new Error(JSON.stringify(execution.response));
  return execution.response;
}

function editedProject(execution: EditExecution): Project {
  return JSON.parse(success(execution).output) as Project;
}

describe("rpgkit edit read operations", () => {
  test("opens and lists maps, events, pages and recursive commands with reusable addresses", () => {
    const source = serializeProject(fixture());
    const opened = readSuccess(executeEditOperation(source, "open"));
    expect(opened.result).toMatchObject({ documentKind: "inline", editable: true, mapCount: 1 });
    expect(opened.project.revision).toMatch(/^[0-9a-f]{64}$/);

    const maps = readSuccess(executeEditOperation(source, "list-maps")).result as any[];
    expect(maps).toEqual([expect.objectContaining({ address: "map:map", id: "map", eventCount: 1 })]);

    const events = readSuccess(executeEditOperation(source, "list-events", { map: "map" })).result as any[];
    expect(events).toEqual([expect.objectContaining({ address: "map:map/event:npc", id: "npc", pageCount: 2 })]);

    const pages = readSuccess(executeEditOperation(source, "list-pages", { map: "map", event: "npc" })).result as any[];
    expect(pages.map((item) => item.address)).toEqual([
      "map:map/event:npc/page:0",
      "map:map/event:npc/page:1",
    ]);

    const commands = readSuccess(executeEditOperation(source, "list-commands", { map: "map", event: "npc", page: 0 })).result as any[];
    expect(commands.map((item) => item.key)).toEqual(["root#0", "root#1", "i1:then#0"]);
    expect(commands[2]).toMatchObject({
      address: "map:map/event:npc/page:0/command:i1:then#0",
      commandAddress: { path: [{ kind: "if", index: 1, branch: "then" }], index: 0 },
      branch: "Then",
      readOnly: false,
    });
  });

  test("validate reports field paths without attempting an edit", () => {
    const valid = readSuccess(executeEditOperation(serializeProject(fixture()), "validate"));
    expect(valid.result).toEqual({ valid: true, errors: [] });

    const invalid = readSuccess(executeEditOperation('{"format":"wrong"}', "validate"));
    expect((invalid.result as any).valid).toBe(false);
    expect((invalid.result as any).errors[0]).toHaveProperty("path");
  });

  test("ProjectShell opens and lists its map index but rejects payload operations", () => {
    const base = fixture();
    const { maps: _, ...globals } = base;
    const shell: ProjectShell = {
      ...globals,
      mapIndex: [{ id: "map", width: 4, height: 3, entry: "maps/map.json", sha256: "0".repeat(64) }],
    };
    const source = serializeProject(shell as unknown as Project);
    expect(readSuccess(executeEditOperation(source, "open")).result).toMatchObject({ documentKind: "shell", editable: false });
    expect(readSuccess(executeEditOperation(source, "list-maps")).result).toEqual([
      expect.objectContaining({ address: "map:map", entry: "maps/map.json" }),
    ]);
    const rejected = executeEditOperation(source, "list-events", { map: "map" }).response;
    expect(rejected).toMatchObject({ ok: false, error: { code: "READ_ONLY_PROJECT_SHELL", path: "$.mapIndex" } });
  });
});

describe("rpgkit edit tile operations", () => {
  test("paints one tile and emits a small reversible diff", () => {
    const project = fixture();
    const edit = success(executeEditOperation(serializeProject(project), "paint-tile", {
      map: "map", layer: "ground", x: 0, y: 0, tile: "s.3",
    }));
    expect(edit.changed).toBe(true);
    expect(edit.addresses).toEqual(["map:map/layer:ground/tile:0,0"]);
    expect(edit.diff).toEqual([expect.objectContaining({ path: "/maps/0/ground/0" })]);
    const after = JSON.parse(edit.output) as Project;
    expect(after.maps[0]!.ground[0]).toBe("s.3");
    expect(applyEditPatch(after, edit.patch!, "reverse")).toEqual(project);
  });

  test("paints a rectangle as one validated operation", () => {
    const after = editedProject(executeEditOperation(serializeProject(fixture()), "paint-rect", {
      map: "map", layer: "ground", x: 2, y: 0, width: 2, height: 2, tile: "s.2",
    }));
    expect([2, 3, 6, 7].map((index) => after.maps[0]!.ground[index])).toEqual(["s.2", "s.2", "s.2", "s.2"]);
  });

  test("four-way fills only the connected source region", () => {
    const execution = executeEditOperation(serializeProject(fixture()), "fill-region", {
      map: "map", layer: "ground", x: 0, y: 0, tile: "s.3",
    });
    const result = success(execution);
    const after = JSON.parse(result.output) as Project;
    expect((result.result as any).cells).toBe(3);
    expect([0, 1, 4].map((index) => after.maps[0]!.ground[index])).toEqual(["s.3", "s.3", "s.3"]);
    expect(after.maps[0]!.ground[8]).toBe("s.3");
    expect(after.maps[0]!.ground[5]).toBe("s.2");
  });

  test("rejects unknown tile sheets with an actionable field error", () => {
    const rejected = executeEditOperation(serializeProject(fixture()), "paint-tile", {
      map: "map", x: 0, y: 0, tile: "other.0",
    }).response;
    expect(rejected).toMatchObject({ ok: false, error: { code: "INVALID_TILE", path: "$.tile", expected: ["s"] } });
  });

  test("requires an explicit tile so a misspelled field cannot erase a region", () => {
    const rejected = executeEditOperation(serializeProject(fixture()), "fill-region", {
      map: "map", x: 0, y: 0, titel: "s.3",
    }).response;
    expect(rejected).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT", path: "$" } });
    if (!rejected.ok) expect(rejected.error.message).toContain("titel");
  });

  test("paints sparse upper cells while retaining untouched duplicate authored pairs", () => {
    const project = fixture();
    project.maps[0]!.upper = [[0, "s.1"], [0, "s.2"], [3, "s.3"]];
    const after = editedProject(executeEditOperation(serializeProject(project), "paint-tile", {
      map: "map", layer: "upper", x: 1, y: 0, tile: "s.3",
    }));
    expect(after.maps[0]!.upper).toEqual([[0, "s.1"], [0, "s.2"], [3, "s.3"], [1, "s.3"]]);
  });
});

describe("rpgkit edit event and page operations", () => {
  test("adds, updates and deletes events through editor transactions", () => {
    const source = serializeProject(fixture());
    const added = success(executeEditOperation(source, "add-event", {
      map: "map",
      event: { id: "greeter", name: "Greeter", x: 3, y: 2, pages: [{ trigger: "action", commands: [] }] },
    }));
    const afterAdd = JSON.parse(added.output) as Project;
    expect(afterAdd.maps[0]!.events!.map((event) => event.id)).toEqual(["npc", "greeter"]);
    expect(applyEditPatch(afterAdd, added.patch!, "reverse")).toEqual(fixture());
    expect(applyEditPatch(fixture(), added.patch!, "forward")).toEqual(afterAdd);

    const updated = success(executeEditOperation(added.output, "update-event", {
      map: "map", event: "greeter", changes: { id: "gate-greeter", name: "Gate Greeter", x: 2 },
    }));
    expect((JSON.parse(updated.output) as Project).maps[0]!.events![1]).toMatchObject({ id: "gate-greeter", name: "Gate Greeter", x: 2 });

    const deleted = success(executeEditOperation(updated.output, "delete-event", { map: "map", event: "gate-greeter" }));
    expect((JSON.parse(deleted.output) as Project).maps[0]!.events!.map((event) => event.id)).toEqual(["npc"]);
    expect(deleted.result).toMatchObject({ deleted: { id: "gate-greeter" } });
  });

  test("rejects invalid event ids instead of silently normalizing response addresses", () => {
    const rejected = executeEditOperation(serializeProject(fixture()), "add-event", {
      map: "map",
      event: { id: "bad id", x: 0, y: 0, pages: [{ trigger: "action", commands: [] }] },
    }).response;
    expect(rejected).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT", path: "$.event.id" } });
  });

  test("adds at an index, replaces, and deletes pages without allowing an empty page list", () => {
    const source = serializeProject(fixture());
    const added = success(executeEditOperation(source, "add-page", {
      map: "map", event: "npc", index: 1,
      page: { condition: { switch: "middle" }, trigger: "autorun", commands: [{ op: "exit" }] },
    }));
    let pages = (JSON.parse(added.output) as Project).maps[0]!.events![0]!.pages;
    expect(pages.map((page) => page.trigger)).toEqual(["action", "autorun", "action"]);

    const updated = success(executeEditOperation(added.output, "update-page", {
      map: "map", event: "npc", page: 1,
      value: { condition: { switch: "middle" }, trigger: "parallel", commands: [{ op: "wait", seconds: 1 }] },
    }));
    pages = (JSON.parse(updated.output) as Project).maps[0]!.events![0]!.pages;
    expect(pages[1]).toMatchObject({ trigger: "parallel", commands: [{ op: "wait", seconds: 1 }] });

    const deleted = success(executeEditOperation(updated.output, "delete-page", { map: "map", event: "npc", page: 1 }));
    pages = (JSON.parse(deleted.output) as Project).maps[0]!.events![0]!.pages;
    expect(pages).toHaveLength(2);

    const single = fixture();
    single.maps[0]!.events![0]!.pages.splice(1);
    expect(executeEditOperation(serializeProject(single), "delete-page", { map: "map", event: "npc", page: 0 }).response)
      .toMatchObject({ ok: false, error: { code: "LAST_PAGE" } });
  });
});

describe("rpgkit edit command operations and patches", () => {
  test("inserts, field-updates and deletes commands at structured addresses", () => {
    const source = serializeProject(fixture());
    const selection = { map: "map", event: "npc", page: 0, address: { path: [], index: 1 } };
    const inserted = success(executeEditOperation(source, "insert-command", {
      ...selection, command: { op: "gold", set: "add", amount: 0 },
    }));
    let commands = (JSON.parse(inserted.output) as Project).maps[0]!.events![0]!.pages[0]!.commands;
    expect(commands[1]).toEqual({ op: "gold", set: "add", amount: 0 });

    const updated = success(executeEditOperation(inserted.output, "update-command", {
      ...selection, field: "amount", value: "10",
    }));
    commands = (JSON.parse(updated.output) as Project).maps[0]!.events![0]!.pages[0]!.commands;
    expect(commands[1]).toEqual({ op: "gold", set: "add", amount: 10 });

    const deleted = success(executeEditOperation(updated.output, "delete-command", selection));
    commands = (JSON.parse(deleted.output) as Project).maps[0]!.events![0]!.pages[0]!.commands;
    expect(commands.map((command) => command.op)).toEqual(["text", "if"]);
  });

  test("inserts opaque runtime commands intact but keeps their fields read-only", () => {
    const source = serializeProject(fixture());
    const selection = { map: "map", event: "npc", page: 0, address: { path: [], index: 0 } };
    const opaque: Command = { op: "ext", call: "game.agent", args: { nested: [1, { exact: true }] } };
    const inserted = success(executeEditOperation(source, "insert-command", { ...selection, command: opaque }));
    const commands = (JSON.parse(inserted.output) as Project).maps[0]!.events![0]!.pages[0]!.commands;
    expect(commands[0]).toEqual(opaque);
    expect(executeEditOperation(inserted.output, "update-command", { ...selection, field: "call", value: "other" }).response)
      .toMatchObject({ ok: false, error: { code: "READ_ONLY_COMMAND" } });
  });

  test("command field errors identify the field and legal alternatives", () => {
    const rejected = executeEditOperation(serializeProject(fixture()), "update-command", {
      map: "map", event: "npc", page: 0, address: { path: [], index: 0 }, field: "cps", value: "0",
    }).response;
    expect(rejected).toMatchObject({ ok: false, error: { code: "INVALID_COMMAND_FIELD", path: "$.command.cps" } });
    if (!rejected.ok) expect(rejected.error.message).toContain("cps");
  });

  test("save applies a dry-run patch forward and reverse and refuses a stale base", () => {
    const project = fixture();
    const source = serializeProject(project);
    const preview = success(executeEditOperation(source, "paint-tile", { map: "map", x: 0, y: 0, tile: "s.3" }));

    const forward = success(executeEditOperation(source, "save", { patch: preview.patch }));
    expect((JSON.parse(forward.output) as Project).maps[0]!.ground[0]).toBe("s.3");
    const reverse = success(executeEditOperation(forward.output, "save", { patch: preview.patch, direction: "reverse" }));
    expect(JSON.parse(reverse.output)).toEqual(project);

    const stale = fixture();
    stale.title = "Drifted";
    expect(executeEditOperation(serializeProject(stale), "save", { patch: preview.patch }).response)
      .toMatchObject({ ok: false, error: { code: "PATCH_BASE_MISMATCH", path: "$.patch" } });
  });

  test("patch traversal cannot reach Object.prototype and malformed escapes fail closed", () => {
    const project = fixture();
    const hash = semanticHash(project);
    const pollutionKey = "rpgkitEditPolluted";
    delete (Object.prototype as Record<string, unknown>)[pollutionKey];
    const malicious = {
      format: "rpgkit-edit/patch-v1",
      beforeHash: hash,
      afterHash: hash,
      changes: [{
        path: `/start/__proto__/${pollutionKey}`,
        before: { exists: false },
        after: { exists: true, value: true },
      }],
    };
    expect(() => applyEditPatch(project, malicious)).toThrow("missing object property");
    expect(({} as Record<string, unknown>)[pollutionKey]).toBeUndefined();

    const malformed = { ...malicious, changes: [{ ...malicious.changes[0], path: "/start/~2bad" }] };
    expect(() => applyEditPatch(project, malformed)).toThrow("invalid JSON Pointer escape");
  });

  test("the public patch helper refuses a self-consistent schema-invalid result", () => {
    const project = fixture();
    const patch = {
      format: "rpgkit-edit/patch-v1",
      beforeHash: semanticHash(project),
      afterHash: semanticHash(1),
      changes: [{ path: "", before: { exists: true, value: project }, after: { exists: true, value: 1 } }],
    };
    expect(() => applyEditPatch(project, patch)).toThrow("edit would make the project invalid");
  });

  test("schema-valid but structurally invalid maps and duplicate stable ids are rejected", () => {
    const short = fixture();
    short.maps[0]!.ground.pop();
    const invalidMap = readSuccess(executeEditOperation(serializeProject(short), "validate"));
    expect(invalidMap.result).toMatchObject({ valid: false, errors: [expect.objectContaining({ path: "$.maps[0]" })] });
    expect(executeEditOperation(serializeProject(short), "open").response).toMatchObject({ ok: false, error: { code: "INVALID_DOCUMENT" } });

    const duplicate = fixture();
    duplicate.maps[0]!.events!.push(structuredClone(duplicate.maps[0]!.events![0]!));
    expect(executeEditOperation(serializeProject(duplicate), "open").response)
      .toMatchObject({ ok: false, error: { code: "INVALID_DOCUMENT", path: "$.maps[0].events[1].id" } });
  });
});
