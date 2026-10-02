// tests/rpgkit-grow-project.test.ts — D3 generator output is a real
// rpgkit-project/v1 document:
//
//   1. SCHEMA    the generated project passes engine/schema-validate.ts
//                against data/schema.json, for several seeds
//   2. ROUNDTRIP generate -> JSON.stringify -> parse -> validate -> deep
//                equal (the document is the save artifact, nothing else)
//   3. PLAY      the normal loader path (createSession/startSession +
//                stepSession) plays the loaded document: the mover walks a
//                road and every grown villager's repeat route keeps its
//                body on a road cell for hundreds of frames; no interpreter
//                error
//   4. CONSIST. a project reloaded from JSON plays identically to one used
//                in memory (per-frame mover/NPC state equal on a fixed tape)
//
// This is the "generate leg pairs the editor" gate: a grown village is a
// legal game, not a demo-only data structure.

import { describe, expect, test } from "bun:test";
import { validateSchema, type VError } from "../src/engine/schema-validate.ts";
import { generateProject } from "../examples/grow/grow-project.ts";
import { DEFAULT_PARAMS, growToDone, STAMP_PARAMS, type GrowParams } from "../examples/grow/grow.ts";
import {
  createSession,
  startSession,
  stepSession,
  type SessionState,
} from "../src/engine/session.ts";
import type { Project } from "../src/engine/types.ts";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";

const schema = await Bun.file(
  new URL("../src/data/schema.json", import.meta.url),
).json();

function seedParams(seed: number): GrowParams {
  return { ...DEFAULT_PARAMS, seed: seed >>> 0 };
}

function roadGrid(params: GrowParams): Int8Array {
  return new Int8Array(growToDone(params).road);
}

describe("grown project: schema", () => {
  test("passes the v1 schema for multiple seeds", () => {
    for (const seed of [1, 42, 0x5eed_0001, 0x1234_5678, 0xffff_ffff]) {
      const project = generateProject(seedParams(seed));
      const errors: VError[] = validateSchema(schema, project as unknown as Record<string, unknown>);
      expect(errors, `seed ${seed}: ${errors.map((e) => `${e.path} ${e.msg}`).join("; ")}`).toEqual([]);
      expect(project.format).toBe("rpgkit-project/v1");
      expect(project.maps).toHaveLength(1);
    }
  });

  test("different seeds yield different documents", () => {
    const a = JSON.stringify(generateProject(seedParams(11)));
    const b = JSON.stringify(generateProject(seedParams(22)));
    expect(a).not.toBe(b);
  });
});

describe("grown project: JSON round-trip", () => {
  test("stringify -> parse validates and deep-equals the generated document", () => {
    const project = generateProject(seedParams(0x7777_7777));
    const text = JSON.stringify(project, null, 2);
    const reloaded = JSON.parse(text) as Project;
    expect(validateSchema(schema, reloaded as unknown as Record<string, unknown>)).toEqual([]);
    expect(reloaded).toEqual(project);
  });
});

describe("grown project: walkable canopy decor", () => {
  test("planted canopy renders on the upper layer but carries no block", () => {
    // Settled decor is a stamp-rule step; causal villages plant none.
    const params = { ...STAMP_PARAMS, seed: 0x5eed_0001 };
    const done = growToDone(params);
    const project = generateProject(params);
    const map = project.maps[0]!;
    expect(done.decor.length).toBeGreaterThan(0);
    expect(map.upper).toBeDefined();
    expect(map.passage).toBeDefined();
    const upperIdx = new Set((map.upper ?? []).map(([i]) => i));
    const blockIdx = new Set(
      (map.passage ?? []).map(([i, flag]) => (flag === "block" ? i : -1)),
    );
    for (const i of done.decor) {
      const x = i % done.params.width;
      const y = Math.floor(i / done.params.width);
      const outIndex = y * map.width + x;
      // The canopy art is on the star layer (so it occludes a body)…
      expect(upperIdx.has(outIndex)).toBe(true);
      // …but the tile is walkable (no block override).
      expect(blockIdx.has(outIndex)).toBe(false);
    }
    // A hut/fence/tree is still solid; only reducer-tagged decor is canopy.
    expect((map.passage ?? []).length).toBeGreaterThan(0);
  });
});

describe("grown project: playable through the normal loader", () => {
  function play(project: Project, frames: number, buttons: (f: number) => number): SessionState[] {
    const session = createSession(project, 60);
    let state = startSession(project, session);
    const out: SessionState[] = [];
    let prev = 0;
    for (let f = 0; f < frames; f++) {
      const mask = buttons(f);
      const pressed = mask & ~prev;
      prev = mask;
      state = stepSession(session, state, {
        buttons: mask,
        confirmEdge: !!(pressed & BTN.CIRCLE),
        cancelEdge: false,
        upEdge: false,
        downEdge: false,
      });
      out.push(state);
    }
    return out;
  }

  test("the mover starts on a road cell and can walk it", () => {
    const project = generateProject(seedParams(0x5eed_0001));
    const map = project.maps[0]!;
    const start = project.start;
    expect(map.ground[start.y * map.width + start.x]).toMatch(/^ninja\./);
    // Walk toward the first open neighbor (no blocking art, no event): the
    // grown layout decides which side of the plaza is free.
    const blocked = new Set((map.passage ?? []).map(([i]) => i));
    for (const e of map.events ?? []) blocked.add(e.y * map.width + e.x);
    const ways = [
      { button: BTN.RIGHT, dx: 1, dy: 0 }, { button: BTN.LEFT, dx: -1, dy: 0 },
      { button: BTN.DOWN, dx: 0, dy: 1 }, { button: BTN.UP, dx: 0, dy: -1 },
    ];
    const way = ways.find((w) => !blocked.has((start.y + w.dy) * map.width + start.x + w.dx))!;
    expect(way).toBeDefined();
    const states = play(project, 240, (f) => (f % 8 < 6 ? way.button : 0));
    // Walking that way moves the mover in px.
    const end = states[states.length - 1]!;
    expect((end.move.px - start.x * 16) * way.dx + (end.move.py - start.y * 16) * way.dy).toBeGreaterThan(0);
    // No interpreter error ever appears.
    for (const s of states) expect(s.interp.error).toBeUndefined();
  });

  test("every villager stays on a road/plaza cell for 600 frames", () => {
    const params = seedParams(0x5eed_0001);
    const project = generateProject(params);
    const map = project.maps[0]!;
    const road = roadGrid(params);
    const villagerIds = (map.events ?? [])
      .filter((e) => e.id.startsWith("villager-"))
      .map((e) => e.id);
    expect(villagerIds.length).toBeGreaterThan(0);
    const states = play(project, 600, () => 0);
    for (let f = 0; f < states.length; f += 17) {
      const s = states[f]!;
      for (const id of villagerIds) {
        const ch = s.chars.chars[id];
        expect(ch, `${id} missing at f${f}`).toBeDefined();
        // Tile-anchored cells only (routes end steps on boundaries).
        if (ch!.px % 16 === 0 && ch!.py % 16 === 0) {
          const i = (ch!.py / 16) * params.width + ch!.px / 16;
          expect(road[i], `${id} off-road at f${f} (${ch!.px},${ch!.py})`).toBe(1);
        }
      }
      expect(s.interp.error).toBeUndefined();
    }
  });

  test("a JSON-reloaded project plays identically to the in-memory one", () => {
    const generated = generateProject(seedParams(0xabcd_1234));
    const reloaded = JSON.parse(JSON.stringify(generated)) as Project;
    const tape = Array.from({ length: 300 }, (_, f) =>
      f < 80 ? BTN.DOWN : f < 160 ? BTN.LEFT : f < 240 ? BTN.UP : BTN.RIGHT,
    );
    const a = play(generated, tape.length, (f) => tape[f]!);
    const b = play(reloaded, tape.length, (f) => tape[f]!);
    for (let f = 0; f < tape.length; f++) {
      const sa = a[f]!;
      const sb = b[f]!;
      expect(sb.move.px).toBe(sa.move.px);
      expect(sb.move.py).toBe(sa.move.py);
      expect(sb.move.facing).toBe(sa.move.facing);
      for (const id of Object.keys(sa.chars.chars)) {
        expect(sb.chars.chars[id]?.px).toBe(sa.chars.chars[id]!.px);
        expect(sb.chars.chars[id]?.py).toBe(sa.chars.chars[id]!.py);
      }
    }
  });
});
