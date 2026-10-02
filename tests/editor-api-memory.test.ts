// The in-memory protocol entry point (used by the PocketJS editor) must be
// indistinguishable from the text one (CLI, MCP, Studio): same refusals,
// same patches, for long chains of revisions whose validation and structure
// checks are served from identity caches and diff-guided array deltas.

import { describe, expect, test } from "bun:test";
import {
  applyProjectEdit,
  createEditMemo,
  diffJson,
  executeEditOperation,
  executeProjectOperation,
  projectEditPatch,
} from "../editor/api/operations.ts";
import { loadProject, serializeProject, validateProject } from "../editor/engine/document.ts";
import { BUNDLED_PROJECTS } from "../editor/engine/projects.ts";
import { createSchemaMemo, validateSchema } from "../src/engine/schema-validate.ts";
import type { Project } from "../src/engine/types.ts";

/** Deterministic PRNG (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sunstone = (): Project => loadProject(BUNDLED_PROJECTS.find((project) => project.id === "sunstone")!.json).project;

function randomOperation(project: Project, next: () => number): { command: string; args: Record<string, unknown> } {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const map = pick(project.maps);
  const cell = (): [number, number] => [Math.floor(next() * map.width), Math.floor(next() * map.height)];
  const sheet = pick(map.sheets ?? ["town"]);
  const tile = pick([`${sheet}.${Math.floor(next() * 20)}`, `${sheet}.${Math.floor(next() * 20)}`, null, "nosheet.1"]);
  const events = map.events ?? [];
  const event = events.length > 0 ? pick(events) : undefined;
  switch (Math.floor(next() * 8)) {
    case 0:
    case 1:
      return { command: "paint-cells", args: { map: map.id, layer: pick(["ground", "ground", "upper"]), cells: [cell(), cell(), cell()], value: tile } };
    case 2:
      return { command: "paint-cells", args: { map: map.id, layer: "passage", cells: [cell(), cell()], value: pick(["pass", "block", null]) } };
    case 3: {
      const [x, y] = cell();
      return { command: "fill-region", args: { map: map.id, layer: "ground", x, y, tile } };
    }
    case 4:
      return event
        ? { command: "update-event", args: { map: map.id, event: event.id, changes: { x: Math.floor(next() * (map.width + 3)) } } }
        : { command: "add-event", args: { map: map.id, event: { id: `e${Math.floor(next() * 1e6)}`, x: 0, y: 0, pages: [{ trigger: "action", commands: [] }] } } };
    case 5:
      // Valid and invalid page payloads (the schema decides).
      return event
        ? {
          command: "update-page",
          args: {
            map: map.id,
            event: event.id,
            page: 0,
            value: pick([
              { trigger: "action", commands: [{ op: "text", lines: ["hello"] }] },
              { trigger: "action", commands: [{ op: "text", lines: "not an array" }] },
              { trigger: "sometimes", commands: [] },
              { trigger: "playerTouch", commands: [{ op: "wait", seconds: 1 }] },
            ]),
          },
        }
        : { command: "list-maps", args: {} };
    case 6:
      return { command: "paint-edges", args: { map: map.id, cells: [cell(), cell()], brush: pick([{ kind: "enter", dir: "up" }, { kind: "exit", dir: "left" }, { kind: "clear" }]) } };
    default:
      return { command: "update-map", args: { map: map.id, changes: pick([{ name: `Map ${Math.floor(next() * 9)}` }, { width: map.width + pick([-1, 0, 1]) }, { sheets: [] }]) } };
  }
}

describe("in-memory editor/api revisions", () => {
  test("match the text protocol operation by operation, refusals included", () => {
    for (const seed of [1, 2, 3]) {
      const next = random(seed);
      const memo = createEditMemo();
      let project = sunstone();
      let text = serializeProject(project);
      let refused = 0;
      for (let step = 0; step < 60; step++) {
        const { command, args } = randomOperation(project, next);
        const label = `seed ${seed} step ${step} ${command} ${JSON.stringify(args)}`;
        const viaText = executeEditOperation(text, command, args);
        const inMemory = executeProjectOperation(project, command, args, memo);
        expect(inMemory.ok, label).toBe(viaText.response.ok);
        if (!viaText.response.ok || !inMemory.ok) {
          refused++;
          expect(inMemory as unknown, label).toEqual(viaText.response);
          continue;
        }
        expect(inMemory.changed, label).toBe(viaText.response.changed);
        if (!inMemory.changed) continue;
        expect(JSON.stringify(projectEditPatch(inMemory.edit, memo)), label).toBe(JSON.stringify(viaText.response.patch));
        // Both entry points share the diff shortcuts (cached deltas); a diff
        // of fresh copies walks every item and must agree.
        expect(JSON.stringify(inMemory.edit.changes), label)
          .toBe(JSON.stringify(diffJson(structuredClone(project), structuredClone(inMemory.project))));
        project = inMemory.project;
        text = viaText.output!;
      }
      expect(refused).toBeGreaterThan(5);
      expect(validateProject(project)).toEqual([]);
    }
  }, 60_000);

  test("undo and redo walk the revision chain and refuse a drifted document", () => {
    const memo = createEditMemo();
    const start = sunstone();
    const painted = executeProjectOperation(start, "paint-cells", { map: "village", layer: "ground", cells: [[1, 1]], value: "town.5" }, memo);
    expect(painted.ok).toBe(true);
    if (!painted.ok) return;
    const undone = applyProjectEdit(painted.project, painted.edit, "reverse");
    expect(undone).toEqual({ ok: true, project: start });
    const redone = applyProjectEdit(start, painted.edit, "forward");
    expect(redone).toEqual({ ok: true, project: painted.project });
    // The edit no longer applies once the cell it changed has drifted.
    const drifted = executeProjectOperation(painted.project, "paint-cells", { map: "village", layer: "ground", cells: [[1, 1]], value: "town.6" }, memo);
    if (!drifted.ok) throw new Error(drifted.error.message);
    expect(applyProjectEdit(drifted.project, painted.edit, "reverse")).toMatchObject({ ok: false, error: { code: "PATCH_CHANGE_MISMATCH" } });
    // Even the recorded revision is checked: one changed in place (against
    // the immutability contract) fails closed instead of being trusted.
    const tampered = structuredClone(painted);
    tampered.project.maps[0]!.ground[1 * tampered.project.maps[0]!.width + 1] = "town.7";
    const edit = { ...painted.edit, after: tampered.project };
    expect(applyProjectEdit(tampered.project, edit, "reverse")).toMatchObject({ ok: false, error: { code: "PATCH_CHANGE_MISMATCH" } });
  });
});

describe("schema memo", () => {
  const schema = {
    type: "object",
    properties: {
      cells: { type: "array", items: { oneOf: [{ type: "null" }, { type: "string", pattern: "^t\\.[0-9]+$" }] } },
      rows: { type: "array", items: { type: "object", required: ["n"], properties: { n: { type: "integer", minimum: 0 } } } },
    },
  };

  test("reports exactly the errors a fresh validation reports", () => {
    const next = random(7);
    const memo = createSchemaMemo();
    let value = { cells: Array.from({ length: 50 }, (_, i) => `t.${i % 4}`), rows: [{ n: 1 }, { n: 2 }] };
    for (let step = 0; step < 200; step++) {
      const cells = value.cells.slice();
      for (let k = 0; k < 3; k++) {
        const index = Math.floor(next() * cells.length);
        cells[index] = (["t.1", "t.22", "bad", null, 7] as unknown[])[Math.floor(next() * 5)] as string;
      }
      // As a diff reports them: ascending indexes whose items differ.
      const changed = cells.flatMap((cell, index) => cell === value.cells[index] ? [] : [index]);
      const rows = next() < 0.3 ? [...value.rows, { n: Math.floor(next() * 4) - 1 }] : value.rows;
      const candidate = { cells, rows };
      const deltas = new WeakMap<object, { base: unknown[]; changed: readonly number[] }>([[cells, { base: value.cells, changed }]]);
      const fresh = validateSchema(schema, candidate);
      expect(validateSchema(schema, candidate, schema, { ...memo, deltas }), `step ${step}`).toEqual(fresh);
      if (fresh.length === 0) value = candidate;
    }
  });
});
