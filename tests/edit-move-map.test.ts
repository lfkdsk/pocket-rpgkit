// move-map: reorders an inline project's maps as one reversible patch-v1
// edit. Ids never change, so the start map and transfers are untouched; a
// sharded ProjectShell refuses it because patch-v1 keeps mapIndex in place.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { executeEditOperation, semanticHash } from "../editor/api/operations.ts";
import { executeShardedEditOperation } from "../editor/api/sharded.ts";
import type { EditExecution, EditSuccess } from "../editor/api/types.ts";
import type { Project } from "../src/engine/types.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";

const ROOT = resolve(import.meta.dir, "..");
const SOURCE = readFileSync(join(ROOT, "examples/sunstone/data/sunstone.json"), "utf8");
const ORIGINAL = JSON.parse(SOURCE) as Project;

function success(execution: EditExecution): EditSuccess & { output: string } {
  if (!execution.response.ok) throw new Error(JSON.stringify(execution.response));
  expect(execution.output).toBeDefined();
  return Object.assign(execution.response, { output: execution.output! });
}

function failure(execution: EditExecution): { code: string; path?: string } {
  if (execution.response.ok) throw new Error(`expected failure: ${JSON.stringify(execution.response.result)}`);
  expect(execution.output).toBeUndefined();
  return execution.response.error;
}

/** The source text with its map objects' original bytes put in `order`:
 * everything outside the maps array, and every map's own text, unchanged. */
function reorderedSource(order: string[]): string {
  const text = (map: Project["maps"][number]): string => {
    const spelled = JSON.stringify(map, null, 2).replaceAll("\n", "\n    ");
    expect(SOURCE.includes(spelled)).toBe(true);
    return spelled;
  };
  const first = text(ORIGINAL.maps[0]!);
  const last = text(ORIGINAL.maps.at(-1)!);
  const start = SOURCE.indexOf(first);
  const end = SOURCE.indexOf(last) + last.length;
  const byId = new Map(ORIGINAL.maps.map((map) => [map.id, text(map)]));
  return SOURCE.slice(0, start) + order.map((id) => byId.get(id)!).join(",\n    ") + SOURCE.slice(end);
}

describe("move-map", () => {
  test("the example has three maps in a known order", () => {
    expect(ORIGINAL.maps.map((map) => map.id)).toEqual(["village", "forest", "cave"]);
  });

  for (const [name, mapId, index, from, order, slots] of [
    ["moves a map backward", "cave", 0, 2, ["cave", "village", "forest"], ["/maps/0", "/maps/1", "/maps/2"]],
    ["moves a map forward", "village", 2, 0, ["forest", "cave", "village"], ["/maps/0", "/maps/1", "/maps/2"]],
    ["moves a map one step", "forest", 0, 1, ["forest", "village", "cave"], ["/maps/0", "/maps/1"]],
  ] as const) {
    test(`${name}, keeping every untouched byte`, () => {
      const edited = success(executeEditOperation(SOURCE, "move-map", { map: mapId, index }));
      expect(edited.changed).toBe(true);
      expect(edited.addresses).toEqual([`map:${mapId}`]);
      expect(edited.result).toEqual({ map: mapId, from, to: index });
      // Each slot whose map changed is replaced whole, so replay keeps
      // every map's own property order.
      expect(edited.diff.map((change) => change.path)).toEqual([...slots]);
      const project = JSON.parse(edited.output) as Project;
      expect(project.maps.map((map) => map.id)).toEqual([...order]);
      expect(project.start).toEqual(ORIGINAL.start);
      expect(edited.output).toBe(reorderedSource([...order]));
    });

    test(`${name}: the patch reverses to the original bytes and replays`, () => {
      const edited = success(executeEditOperation(SOURCE, "move-map", { map: mapId, index }));
      const reversed = success(executeEditOperation(edited.output, "save", { patch: edited.patch, direction: "reverse" }));
      expect(reversed.output).toBe(SOURCE);
      expect(semanticHash(JSON.parse(reversed.output))).toBe(edited.patch!.beforeHash);
      const replayed = success(executeEditOperation(SOURCE, "save", { patch: edited.patch, direction: "forward" }));
      expect(replayed.output).toBe(edited.output);
    });
  }

  test("moving a map to its own position is a successful no-op", () => {
    const same = success(executeEditOperation(SOURCE, "move-map", { map: "forest", index: 1 }));
    expect(same.changed).toBe(false);
    expect(same.diff).toEqual([]);
    expect(same.result).toEqual({ map: "forest", from: 1, to: 1 });
    expect(same.output).toBe(SOURCE);
  });

  test("an out-of-range or non-integer index is INVALID_ARGUMENT", () => {
    for (const index of [-1, 3, 1.5, "0", undefined]) {
      expect(failure(executeEditOperation(SOURCE, "move-map", { map: "forest", index })))
        .toMatchObject({ code: "INVALID_ARGUMENT", path: "$.index" });
    }
  });

  test("an unknown map is MAP_NOT_FOUND", () => {
    expect(failure(executeEditOperation(SOURCE, "move-map", { map: "nowhere", index: 0 })))
      .toMatchObject({ code: "MAP_NOT_FOUND", path: "$.map" });
  });

  test("a sharded ProjectShell refuses it before reading a shard", () => {
    const split = splitProjectMaps(ORIGINAL);
    const sources = Object.fromEntries(split.entries.map((entry) => [entry.path, entry.text]));
    for (const shards of [{}, sources]) {
      const execution = executeShardedEditOperation(split.shellText, shards, "move-map", { map: "cave", index: 0 });
      expect(execution.output).toBeUndefined();
      expect(execution.response).toMatchObject({ ok: false, command: "move-map", error: { code: "UNSUPPORTED_FOR_SHELL" } });
    }
  });
});
