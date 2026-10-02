// tests/rpgkit-grow-hz.test.ts — D3 hz portability and play-layer order,
// through the BUILT "grow" bundle on the deterministic wasm sim host.
//
// Acceptance for review task 1395's two blockers:
//
//   1. HZ     one virtual moment (frame/hz + seed) holds the same grown
//             world and the same framebuffer at 60/30/20/4 Hz; growth no
//             longer advances on a raw guest-frame count. In play mode L
//             rewinds exactly three virtual seconds at every rate and
//             lands cross-rate runs on the same world.
//   2. ORDER  NPCs and the player mount BETWEEN ground and the upper star
//             cells, like ui/GameView.tsx, so Ninja foliage/roofs paint over
//             a body. Semantic pixel fixture: the player walks under known
//             grown foliage and its canopy covers the sprite.
//
// Plus the top-right help plate's semantic bounds: its text nodes stay
// inside the plate and never run into the right screen border.

import { describe, expect, test } from "bun:test";
import { bootWorld, fnv1a } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { cameraXForState, DEFAULT_PARAMS, growToDone, liveFrameAtTick, totalTicks, worldSummary } from "../examples/grow/grow.ts";
import { generateProject } from "../examples/grow/grow-project.ts";
import { stampOfCell } from "../examples/grow/grow-stamps.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";

// Without the built bundle/wasm these host tests cannot boot; register
// them as skips with the build command printed once.
const preflight = appPreflight("grow");
if (!preflight.ok) console.warn(`grow sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

interface GrowPub {
  mode: "grow" | "play";
  tick: number;
  total: number;
  auto: boolean;
  seed: number;
  hash: string;
}

type SimWorld = {
  frame: (b: number, a?: number, t?: readonly number[]) => void;
  tick: () => void;
  render: () => Uint8Array;
  getTree: () => unknown;
  ticksPerFrame: number;
};

async function boot(hz: number): Promise<SimWorld> {
  return (await bootWorld(appBundle("grow"), hz)) as unknown as SimWorld;
}

function pump(w: SimWorld, frames: number, mask = 0): void {
  for (let f = 0; f < frames; f++) {
    w.frame(mask);
    for (let t = 0; t < w.ticksPerFrame; t++) w.tick();
  }
}

const growPub = (): GrowPub =>
  structuredClone((globalThis as { __rpgGrowState: GrowPub }).__rpgGrowState);

const HZ_RATES = [60, 30, 20, 4] as const;
const SETTLED_SECONDS = Math.ceil(totalTicks(DEFAULT_PARAMS) * DEFAULT_PARAMS.tickSeconds) + 1;

simDescribe("D3 growth cadence is hz-portable", () => {
  for (const seconds of [5, 10]) {
    test(`grown state and framebuffer agree at 60/30/20/4 Hz after ${seconds} virtual seconds`, async () => {
      const refs: { pub: GrowPub; hash: string }[] = [];
      for (const hz of HZ_RATES) {
        const w = await boot(hz);
        pump(w, Math.round(seconds * hz));
        refs.push({ pub: growPub(), hash: fnv1a(w.render()) });
      }
      // Same virtual time: same action count (25 at 5 s — one action every
      // 0.2 virtual s), same world hash, same framebuffer, every rate.
      for (const r of refs) {
        expect(r.pub).toEqual(refs[0]!.pub);
        expect(r.hash).toBe(refs[0]!.hash);
      }
    }, 15_000);
  }

  test("a coarse 4 Hz frame can land several crossed actions at once", async () => {
    const w = await boot(4);
    pump(w, 20); // 5 virtual seconds
    expect(growPub().tick).toBe(25);
  });

  test("camera easing spans the same virtual fraction at every hz", () => {
    const state = growToDone(DEFAULT_PARAMS);
    const from = Math.max(0, state.cameraFromX - 96);
    const sample = (hz: number) => {
      const frame = liveFrameAtTick(DEFAULT_PARAMS, hz, state.tick) + DEFAULT_PARAMS.tickSeconds * hz / 2;
      const view = { ...state, hz, frame, cameraFromX: from };
      return cameraXForState(view);
    };
    // At 4 Hz the 0.2 s action interval is shorter than one host frame, so
    // cameraXForState clamps the easing span to that single frame. The other
    // supported rates can represent the same half-interval exactly.
    const easingRates = [60, 30, 20] as const;
    const values = easingRates.map(sample);
    expect(new Set(values).size).toBe(1);
    expect(values[0]).toBeGreaterThan(from);
    expect(values[0]).toBeLessThan(state.cameraX);
    // Mutation guard: a fixed twelve-frame span would put 4 Hz at the start
    // while 60 Hz is halfway through the same virtual interval.
    const fixed = (hz: number) => {
      const elapsed = DEFAULT_PARAMS.tickSeconds * hz / 2;
      const t = Math.max(0, Math.min(1, elapsed / 12));
      const eased = t * t * (3 - 2 * t);
      return Math.round((from + (state.cameraX - from) * eased) * 1000) / 1000;
    };
    expect(new Set(easingRates.map(fixed)).size).toBeGreaterThan(1);
  });

  test("every rate reaches the same done world", async () => {
    const done = growToDone(DEFAULT_PARAMS);
    const doneHash = worldSummary(done).hash;
    for (const hz of HZ_RATES) {
      const w = await boot(hz);
      pump(w, Math.round(SETTLED_SECONDS * hz));
      const p = growPub();
      expect(p.tick).toBe(done.tick);
      expect(p.hash).toBe(doneHash);
    }
  }, 30_000);
});

simDescribe("D3 play rewind means the same virtual time at every rate", () => {
  async function walkThenRewind(hz: number): Promise<{
    rewoundFrames: number;
    virtualSeconds: number;
    frame: number;
    px: number;
    py: number;
  }> {
    const w = await boot(hz);
    pump(w, SETTLED_SECONDS * hz);
    w.frame(BTN.CIRCLE);
    for (let t = 0; t < w.ticksPerFrame; t++) w.tick();
    pump(w, 1);
    // Walk exactly 3 virtual seconds holding RIGHT.
    pump(w, 3 * hz, BTN.RIGHT);
    const before = (globalThis as { __rpgSessionState: { frame: number } }).__rpgSessionState.frame;
    w.frame(BTN.LTRIGGER);
    for (let t = 0; t < w.ticksPerFrame; t++) w.tick();
    const s = (globalThis as { __rpgSessionState: {
      frame: number;
      move: { px: number; py: number };
    } }).__rpgSessionState;
    return {
      rewoundFrames: before - s.frame,
      virtualSeconds: (before - s.frame) / hz,
      frame: s.frame,
      px: s.move.px,
      py: s.move.py,
    };
  }

  test("L rewinds 180/90/60 guest frames = 3 virtual seconds, to the same world", async () => {
    const at60 = await walkThenRewind(60);
    const at30 = await walkThenRewind(30);
    const at20 = await walkThenRewind(20);
    const start = generateProject(DEFAULT_PARAMS).start;
    expect(at60.rewoundFrames).toBe(180);
    expect(at30.rewoundFrames).toBe(90);
    expect(at20.rewoundFrames).toBe(60);
    for (const r of [at60, at30, at20]) {
      expect(r.virtualSeconds).toBe(3);
      expect(r.frame).toBe(1); // play frame 1, the clean world
      expect(r.px).toBe(start.x * 16); // the generated start tile at every rate
      expect(r.py).toBe(start.y * 16);
    }
  }, 30_000);
});

// --- tree order + semantic pixel occlusion --------------------------------

function findNode(tree: unknown, name: string): any {
  const n = tree as { n?: string; k?: any[] };
  if (n?.n === name) return n;
  for (const child of n?.k ?? []) {
    const result = findNode(child, name);
    if (result) return result;
  }
  return undefined;
}

/**
 * The nearest walkable bottom-row cell of a wild 2x2 grove tree in the
 * generated map, and a path to it from the start that keeps off the roads
 * the villagers walk where it can.
 */
function canopyWalk(): { target: { x: number; y: number }; path: { x: number; y: number }[] } {
  const project = generateProject(DEFAULT_PARAMS);
  const map = project.maps[0]!;
  const W = map.width, H = map.height;
  const blocked = new Set((map.passage ?? []).map(([i]) => i));
  for (const e of map.events ?? []) blocked.add(e.y * W + e.x);
  const upper = new Map((map.upper ?? []).map(([i, t]) => [i, Number(String(t).slice("ninja.".length))]));
  const treePart = (i: number) => {
    const cell = upper.get(i);
    const owner = cell === undefined ? undefined : stampOfCell(cell);
    return owner && owner.stamp.w === 2 && owner.stamp.h === 2 && owner.stamp.key.startsWith("tree") ? owner : undefined;
  };
  const isRoad = (i: number) => /^ninja\.(1|83|7)$/.test(String(map.ground[i]));
  const dist = new Map<number, number>(), prev = new Map<number, number>();
  const s0 = project.start.y * W + project.start.x;
  const queue: [number, number][] = [[0, s0]];
  dist.set(s0, 0);
  let found = -1;
  while (queue.length) {
    queue.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const [d, i] = queue.shift()!;
    if (d !== dist.get(i)) continue;
    const part = treePart(i);
    if (part && part.dy === 1 && treePart(i - W)?.dy === 0) { found = i; break; }
    const x = i % W, y = (i - x) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, ny = y + dy, n = ny * W + nx;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || blocked.has(n)) continue;
      const nd = d + (isRoad(n) ? 8 : 1);
      if (nd < (dist.get(n) ?? Infinity)) { dist.set(n, nd); prev.set(n, i); queue.push([nd, n]); }
    }
  }
  if (found < 0) throw new Error("no reachable grove tree in the generated map");
  const path: { x: number; y: number }[] = [];
  for (let i = found; i !== s0; i = prev.get(i)!) path.unshift({ x: i % W, y: Math.floor(i / W) });
  return { target: { x: found % W, y: Math.floor(found / W) }, path };
}

async function enterPlayAndWalkUnderCanopy(): Promise<SimWorld> {
  const w = await boot(60);
  pump(w, SETTLED_SECONDS * 60);
  w.frame(BTN.CIRCLE);
  w.tick();
  pump(w, 1);
  // Walk the searched path one tile at a time, holding each direction until
  // the tile is reached (bounded; the world is deterministic, and the tx/ty
  // assertions catch a blocked walk).
  const move = () => (globalThis as { __rpgSessionState: { move: { tx: number; ty: number } } }).__rpgSessionState.move;
  for (const step of canopyWalk().path) {
    const m = move();
    const button = step.x > m.tx ? BTN.RIGHT : step.x < m.tx ? BTN.LEFT : step.y > m.ty ? BTN.DOWN : BTN.UP;
    for (let f = 0; f < 60 && (move().tx !== step.x || move().ty !== step.y); f++) pump(w, 1, button);
  }
  pump(w, 8);
  return w;
}

simDescribe("D3 play entities paint between ground and the upper layer", () => {
  test("tree order: NPCs and the player precede every upper star cell", async () => {
    const w = await enterPlayAndWalkUnderCanopy();
    const camera = findNode(w.getTree(), "rpgkit-grow-camera");
    const children = camera.k as { n?: string; t?: string }[];
    const upperLayer = children.findIndex((node) => node.n === "rpgkit-grow-upper-layer");
    const firstEntity = children.findIndex(
      (node) => node.n === "rpgkit-grow-npc" || (!node.n && node.t === "image"),
    );
    const lastEntity = children.map((node) => node.n).lastIndexOf("rpgkit-grow-npc");
    expect(upperLayer).toBeGreaterThan(firstEntity);
    expect(upperLayer).toBeGreaterThan(lastEntity);
  }, 15_000);

  test("pixel fixture: Ninja foliage canopy covers the player sprite", async () => {
    const w = await enterPlayAndWalkUnderCanopy();
    // The player stands on the bottom row of a walkable 2x2 grove tree.
    // The stamp's top row is canopy: its green pixels occupy the tile above
    // the walker's feet and cover the walker's head.
    const { target } = canopyWalk();
    const session = (globalThis as { __rpgSessionState: { move: { tx: number; ty: number } } })
      .__rpgSessionState;
    expect(session.move.tx).toBe(target.x);
    expect(session.move.ty).toBe(target.y);
    const cam = (globalThis as { __rpgGrowState: { play?: { cameraX: number; cameraY: number } } }).__rpgGrowState.play!;
    const sx = target.x * 16 - Math.round(cam.cameraX), sy = (target.y - 1) * 16 - Math.round(cam.cameraY);
    expect(sx >= 0 && sx + 16 <= 480 && sy >= 0 && sy + 16 <= 272).toBe(true);
    const fb = w.render();
    const isFoliageGreen = (x: number, y: number): boolean => {
      const i = (y * 480 + x) * 4;
      return fb[i + 1]! > 100 && fb[i + 1]! - fb[i]! > 5 && fb[i + 1]! - fb[i + 2]! > 30;
    };
    let green = 0;
    for (let y = sy; y < sy + 16; y++) for (let x = sx; x < sx + 16; x++) {
      if (isFoliageGreen(x, y)) green++;
    }
    expect(green).toBeGreaterThanOrEqual(100);
  }, 15_000);
});

simDescribe("D3 grow help plate stays inside the right margin", () => {
  async function boundsAt(settled: boolean): Promise<void> {
    const w = await boot(60);
    pump(w, settled ? SETTLED_SECONDS * 60 : 8);
    const tree = w.getTree() as { i?: number } | null;
    const textIds = new Set<number>();
    (function collect(n: any): void {
      if (n?.t === "text") textIds.add(n.i as number);
      for (const c of n?.k ?? []) collect(c);
    })(tree);
    const ops = (globalThis as { ui?: { hitTestBounds?: (x: number, y: number) => number } }).ui;
    expect(ops?.hitTestBounds).toBeDefined();
    // Rows through all three help lines; the six-pixel margin after the
    // plate's right edge must never report a help text node.
    for (const y of [8, 20, 32]) {
      for (let x = 468; x < 474; x++) {
        expect(textIds.has(ops!.hitTestBounds!(x, y))).toBe(false);
      }
    }
  }

  test("help text stays inside its plate while growing", () => boundsAt(false));
  test("help text stays inside its plate on the finished ENTER row", () => boundsAt(true), 15_000);
});
