// tests/ka1-render-sim.test.ts — KA1: rendered map animations.
//
// Boots the ka1-anim fixture on the wasm sim host at two resolutions and
// asserts semantic pixels: the autorun pulse advances its frames on the
// reference clock, a one-shot wait parks and resumes, a target-bound aura
// follows the player, stopAnim removes an instance, and the node pool gains
// no nodes during steady playback. 60/30/20/4 Hz render the same pixels at
// the same virtual time.

import { describe, expect, test } from "bun:test";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { fnv1a } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { centerOffset } from "../src/engine/viewport.ts";
import { TILE } from "../src/engine/tiles.ts";
import type { MapAnimStats } from "../src/ui/MapAnimLayer.tsx";
import {
  BURST_TILE,
  KA1_MAP_SIZE,
  ONCE_TILE,
  PLAYER_START,
  RING_TILE,
  TALL_TILE,
  TRAIL_BIND_TILE,
  TRAIL_LAST_TILE,
  TRAIL_MOVER_TILE,
} from "./fixtures/ka1-anim/fixture-data.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import {
  bootGameWorld,
  installGameSimIsolation,
  type BoundGameWorld,
} from "./helpers/sim-session.ts";

const preflight = appPreflight("ka1-anim");
if (!preflight.ok) console.warn(`ka1-anim sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

type Rgba = readonly [number, number, number, number];

const VIEWPORT = { width: 480, height: 272 } as const;
const WIDE = { width: 960, height: 544 } as const;

// pulse frames (fixture gen-assets): red, green, blue, white.
const PULSE: readonly Rgba[] = [
  [226, 62, 62, 255],
  [72, 200, 96, 255],
  [64, 120, 240, 255],
  [236, 236, 244, 255],
];
// ring frames: yellow, orange.
const RING: readonly Rgba[] = [
  [246, 188, 58, 255],
  [236, 128, 48, 255],
];
// tower frames (32x64, dragonbirth-class height): purple, teal.
const TOWER: readonly Rgba[] = [
  [172, 64, 192, 255],
  [52, 184, 184, 255],
];
const GROUND: Rgba = [10, 14, 22, 255];

interface Ka1Stats {
  below?: MapAnimStats;
  above?: MapAnimStats;
}

const stats = (): Ka1Stats =>
  structuredClone((globalThis as { __ka1Stats?: Ka1Stats }).__ka1Stats ?? {});

function pump(world: BoundGameWorld, frames: number, buttons = 0): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(buttons, 0x8080);
    for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  }
}

function rgbaAt(frame: Uint8Array, width: number, x: number, y: number): number[] {
  const i = (Math.round(y) * width + Math.round(x)) * 4;
  return [...frame.subarray(i, i + 4)];
}

function expectPixel(
  frame: Uint8Array,
  width: number,
  x: number,
  y: number,
  colour: Rgba,
): void {
  expect(rgbaAt(frame, width, x, y), `pixel (${x},${y})`).toEqual([...colour]);
}

/** Screen position of a tile's center: the world frame centers an
 *  undersized map, and the world node translates by the follow camera. */
function tileCenter(
  vp: { width: number; height: number },
  tx: number,
  ty: number,
  camera: { x: number; y: number },
): [number, number] {
  const off = centerOffset(
    { w: KA1_MAP_SIZE.width * TILE, h: KA1_MAP_SIZE.height * TILE },
    { w: vp.width, h: vp.height },
  );
  return [off.x + tx * TILE - camera.x + 8, off.y + ty * TILE - camera.y + 8];
}

/** Screen position of an arbitrary world-space pixel (same centering and
 *  camera as tileCenter). */
function screenOf(
  vp: { width: number; height: number },
  wx: number,
  wy: number,
  camera: { x: number; y: number },
): [number, number] {
  const off = centerOffset(
    { w: KA1_MAP_SIZE.width * TILE, h: KA1_MAP_SIZE.height * TILE },
    { w: vp.width, h: vp.height },
  );
  return [off.x + wx - camera.x, off.y + wy - camera.y];
}

function countColour(frame: Uint8Array, width: number, height: number, colour: Rgba): number {
  let n = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (frame[i] === colour[0] && frame[i + 1] === colour[1] && frame[i + 2] === colour[2]) n++;
    }
  }
  return n;
}

async function boot(
  hz = 60,
  vp: { width: number; height: number } = VIEWPORT,
): Promise<BoundGameWorld> {
  return bootGameWorld(appBundle("ka1-anim"), hz, undefined, undefined, vp);
}

simDescribe("KA1 map animation rendering", () => {
  test("the autorun pulse advances frames on the reference clock at 480x272", async () => {
    const world = await boot();
    pump(world, 1);
    let frame = world.render();
    let [cx, cy] = tileCenter(VIEWPORT, BURST_TILE.x, BURST_TILE.y, world.probes().camera);
    expectPixel(frame, VIEWPORT.width, cx, cy, PULSE[0]!);
    // 0.25s/frame at 60 Hz = 15 ticks per frame.
    pump(world, 15);
    frame = world.render();
    expectPixel(frame, VIEWPORT.width, cx, cy, PULSE[1]!);
    pump(world, 15);
    frame = world.render();
    expectPixel(frame, VIEWPORT.width, cx, cy, PULSE[2]!);
    // The ground just outside the animation tile is untouched.
    expectPixel(frame, VIEWPORT.width, cx - 16, cy, GROUND);
  });

  test("a frame taller than one tile anchors half its height above the tile (Tuxemon parity)", async () => {
    // Tuxemon's dragonbirth is 48x64 (pak textures must be pow2, so this
    // fixture frame is 32x64 — the anchor depends only on the height); the
    // map view shifts a frame taller than one tile up by height // 2
    // (tuxemon/map/view.py), so the tower spans [ty*16-32, ty*16+32). The
    // edge/interior probes below are mutation-sensitive: deleting the h>>1
    // shift moves the span to [ty*16, ty*16+64) and flips every expectation.
    const world = await boot();
    pump(world, 1);
    const cam = world.probes().camera;
    const wx = TALL_TILE.x * TILE + 16;
    // The frame's first row sits exactly 32 px above the tile top.
    let [sx, sy] = screenOf(VIEWPORT, wx, TALL_TILE.y * TILE - 32, cam);
    expectPixel(world.render(), VIEWPORT.width, sx, sy, TOWER[0]!);
    // 40 px above the tile top is ground: the frame does not extend past
    // its shifted top edge.
    [sx, sy] = screenOf(VIEWPORT, wx, TALL_TILE.y * TILE - 40, cam);
    expectPixel(world.render(), VIEWPORT.width, sx, sy, GROUND);
    // 24 px above the tile top: inside the shifted frame, ground without it.
    [sx, sy] = screenOf(VIEWPORT, wx, TALL_TILE.y * TILE - 24, cam);
    expectPixel(world.render(), VIEWPORT.width, sx, sy, TOWER[0]!);
    // 48 px below the tile top: outside the shifted frame (ground), inside
    // an unshifted 64 px frame.
    [sx, sy] = screenOf(VIEWPORT, wx, TALL_TILE.y * TILE + 48, cam);
    expectPixel(world.render(), VIEWPORT.width, sx, sy, GROUND);
    // 0.5 s/frame at 60 Hz = 30 ticks: the tower advances to frame 1.
    pump(world, 30);
    [sx, sy] = screenOf(VIEWPORT, wx, TALL_TILE.y * TILE - 24, cam);
    expectPixel(world.render(), VIEWPORT.width, sx, sy, TOWER[1]!);
  });

  test("the same virtual instant renders the same pixels at 960x544", async () => {
    const world = await boot(60, WIDE);
    pump(world, 1);
    const frame = world.render();
    const [cx, cy] = tileCenter(WIDE, BURST_TILE.x, BURST_TILE.y, world.probes().camera);
    expectPixel(frame, WIDE.width, cx, cy, PULSE[0]!);
    // The map (640x400) is letterboxed at 960x544 and keeps native 16px
    // tiles: the 12x12 inner block is 100 px of the frame colour.
    expect(countColour(frame, WIDE.width, WIDE.height, PULSE[0]!)).toBe(10 * 10);
  });

  test("a one-shot wait parks the fiber, plays once, then resumes and vanishes", async () => {
    const world = await boot();
    pump(world, 1);
    // Step up onto the "once" event and confirm into it.
    pump(world, 12, BTN.UP);
    expect(world.probes().state.move.tx).toBe(PLAYER_START.x);
    expect(world.probes().state.move.ty).toBe(PLAYER_START.y - 1);
    pump(world, 1, BTN.CIRCLE);
    let state = world.probes().state;
    expect(state.sw.switches["once-done"]).toBeUndefined();
    let frame = world.render();
    let [cx, cy] = tileCenter(VIEWPORT, ONCE_TILE.x, ONCE_TILE.y, world.probes().camera);
    expectPixel(frame, VIEWPORT.width, cx, cy, PULSE[0]!);
    // 4 frames * 0.25s = 1s: the playthrough completes, the fiber resumes.
    pump(world, 60);
    state = world.probes().state;
    expect(state.sw.switches["once-done"]).toBe(true);
    frame = world.render();
    expectPixel(frame, VIEWPORT.width, cx, cy, GROUND);
  });

  test("a target-bound aura follows the player, in the above band", async () => {
    const world = await boot();
    pump(world, 1);
    // Step down exactly one tile onto the "follow" event and confirm.
    pump(world, 8, BTN.DOWN);
    expect(world.probes().state.move.ty).toBe(PLAYER_START.y + 1);
    pump(world, 1, BTN.CIRCLE);
    const aura = (world.probes().state.interp.anims ?? []).find((a) => a.id === "aura");
    expect(aura?.target).toBe("player");
    // The aura paints over the player, anchored at the player's pixel
    // position (Tuxemon tile-top anchor for a 16 px frame).
    let state = world.probes().state;
    let [ax, ay] = screenOf(VIEWPORT, state.move.px + 8, state.move.py + 8, world.probes().camera);
    expectPixel(world.render(), VIEWPORT.width, ax, ay, RING[0]!);
    // Walk right one tile; the aura follows onto the new tile.
    pump(world, 8, BTN.RIGHT);
    const move = world.probes().state.move;
    expect(move.tx).toBe(PLAYER_START.x + 1);
    [ax, ay] = screenOf(VIEWPORT, move.px + 8, move.py + 8, world.probes().camera);
    expectPixel(world.render(), VIEWPORT.width, ax, ay, RING[0]!);
    // The old tile is ground again.
    const [ox, oy] = tileCenter(VIEWPORT, PLAYER_START.x, PLAYER_START.y + 1, world.probes().camera);
    expectPixel(world.render(), VIEWPORT.width, ox, oy, GROUND);
  });

  test("a following animation tracks the player's interpolated pixels every frame", async () => {
    const world = await boot();
    pump(world, 1);
    // Step down exactly one tile (8 ticks at 2 px/tick) onto the "follow"
    // event and confirm, so the walk starts from a tile boundary.
    pump(world, 8, BTN.DOWN);
    expect(world.probes().state.move.ty).toBe(PLAYER_START.y + 1);
    pump(world, 1, BTN.CIRCLE);
    // Walk right one tile; on every frame the ring's rendered center must
    // sit on the player's center within 1 px. The ring's yellow interior is
    // offset half a pixel from the node center (10 px interior in a 16 px
    // frame), so the bound is exactly 1 px; pixelOf resolves the character's
    // live px/py with 0 px deviation. A tile-bound follow (the review's B1
    // bug) lagged up to 14 px mid-step and jumped 16 px at the seam.
    let interpolated = 0;
    let prevCenter: [number, number] | null = null;
    for (let f = 0; f < 8; f++) {
      pump(world, 1, BTN.RIGHT);
      const state = world.probes().state;
      const aura = (state.interp.anims ?? []).find((a) => a.id === "aura");
      expect(aura?.target).toBe("player");
      if (state.move.px % TILE !== 0) interpolated++;
      const frame = world.render();
      // The ring's yellow interior (RING[0]) bounding box, in screen px.
      let minX: number = VIEWPORT.width, maxX = -1, minY: number = VIEWPORT.height, maxY = -1;
      for (let y = 0; y < VIEWPORT.height; y++) {
        for (let x = 0; x < VIEWPORT.width; x++) {
          const i = (y * VIEWPORT.width + x) * 4;
          if (frame[i] === RING[0]![0] && frame[i + 1] === RING[0]![1] && frame[i + 2] === RING[0]![2]) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      expect(maxX, "the ring is on screen").toBeGreaterThanOrEqual(0);
      const center: [number, number] = [(minX + maxX) / 2, (minY + maxY) / 2];
      const [pcx, pcy] = screenOf(VIEWPORT, state.move.px + 8, state.move.py + 8, world.probes().camera);
      expect(Math.abs(center[0] - pcx), `frame ${f}: ring center x`).toBeLessThanOrEqual(1);
      expect(Math.abs(center[1] - pcy), `frame ${f}: ring center y`).toBeLessThanOrEqual(1);
      // No full-tile jump between consecutive frames.
      if (prevCenter) {
        expect(Math.abs(center[0] - prevCenter[0]), `frame ${f}: no x jump`).toBeLessThanOrEqual(4);
        expect(Math.abs(center[1] - prevCenter[1]), `frame ${f}: no y jump`).toBeLessThanOrEqual(4);
      }
      prevCenter = center;
    }
    expect(interpolated, "the walk covered mid-step interpolation frames").toBeGreaterThan(0);
    expect(world.probes().state.move.tx).toBe(PLAYER_START.x + 1);
  });

  test("the below-band ring paints under the actor plane at its fixed tile", async () => {
    const world = await boot();
    pump(world, 1);
    // Step right onto the "ring" event and confirm.
    pump(world, 8, BTN.RIGHT);
    expect(world.probes().state.move.tx).toBe(PLAYER_START.x + 1);
    pump(world, 1, BTN.CIRCLE);
    const [rx, ry] = tileCenter(VIEWPORT, RING_TILE.x, RING_TILE.y, world.probes().camera);
    expectPixel(world.render(), VIEWPORT.width, rx, ry, RING[0]!);
    expect(stats().below?.mounted).toBe(1);
  });

  test("a below-band animation is occluded by the player standing on it", async () => {
    const world = await boot();
    pump(world, 1);
    // Walk right onto the "ring" event and confirm: the below-band ring
    // starts on the player's own tile.
    pump(world, 8, BTN.RIGHT);
    expect(world.probes().state.move.tx).toBe(PLAYER_START.x + 1);
    pump(world, 1, BTN.CIRCLE);
    const state = world.probes().state;
    // The player (facing right, blue body) stands on the ring's tile; the
    // below band paints under the actor plane, so the player's body covers
    // the ring at the overlap. A ring that painted above would show yellow.
    const [px, py] = screenOf(VIEWPORT, state.move.px + 8, state.move.py + 8, world.probes().camera);
    const frame = world.render();
    const i = (Math.round(py) * VIEWPORT.width + Math.round(px)) * 4;
    const colour = [frame[i], frame[i + 1], frame[i + 2]];
    expect(colour, "player body occludes the below ring").not.toEqual([...RING[0]!].slice(0, 3));
    expect(stats().below?.mounted).toBe(1);
  });

  test("stopAnim removes the instance and its pixels", async () => {
    const world = await boot();
    pump(world, 1);
    let [bx, by] = tileCenter(VIEWPORT, BURST_TILE.x, BURST_TILE.y, world.probes().camera);
    expectPixel(world.render(), VIEWPORT.width, bx, by, PULSE[0]!);
    // Step left onto the "stop" event and confirm.
    pump(world, 12, BTN.LEFT);
    pump(world, 1, BTN.CIRCLE);
    expect((world.probes().state.interp.anims ?? []).find((a) => a.id === "burst")).toBeUndefined();
    // The camera followed the player west; recompute the burst tile.
    [bx, by] = tileCenter(VIEWPORT, BURST_TILE.x, BURST_TILE.y, world.probes().camera);
    expectPixel(world.render(), VIEWPORT.width, bx, by, GROUND);
    expect(stats().above?.mounted).toBe(1);
  });

  test("the node pool gains no nodes during steady playback", async () => {
    const world = await boot();
    pump(world, 1);
    const before = stats().above?.created ?? 0;
    expect(stats().above?.mounted).toBe(2);
    // 90 frames of pure playback (6 frame cycles): no instance set change.
    pump(world, 90);
    expect(stats().above?.created).toBe(before);
    expect(stats().above?.mounted).toBe(2);
  });

  test("steady playback performs zero structural node operations", async () => {
    // The created-count alone cannot detect a node that is detached and
    // reinserted every frame. Count the host's structural ops directly:
    // 90 frames of pure playback must not create, insert, remove, or
    // destroy any node (only src/translate/style prop updates).
    const counts = { createNode: 0, insertBefore: 0, removeChild: 0, destroyNode: 0 };
    const world = await bootGameWorld(
      appBundle("ka1-anim"),
      60,
      undefined,
      (ops) => {
        for (const key of Object.keys(counts) as (keyof typeof counts)[]) {
          const original = ops[key] as (...args: unknown[]) => unknown;
          ops[key] = (...args: unknown[]) => {
            counts[key]++;
            return original(...args);
          };
        }
      },
      VIEWPORT,
    );
    pump(world, 1);
    const baseline = { ...counts };
    expect(stats().above?.mounted).toBe(2);
    pump(world, 90);
    expect(counts.createNode).toBe(baseline.createNode);
    expect(counts.insertBefore).toBe(baseline.insertBefore);
    expect(counts.removeChild).toBe(baseline.removeChild);
    expect(counts.destroyNode).toBe(baseline.destroyNode);
  });

  test("60/30/20/4 Hz render identical pixels at the same virtual time", async () => {
    const hashes: string[] = [];
    for (const hz of [60, 30, 20, 4] as const) {
      const world = await boot(hz);
      // 0.5 virtual seconds: the instance started on tick 1, so elapsed is
      // 29 ticks at every rate -> pulse frame 1 (green).
      const frames = Math.round(0.5 * hz);
      pump(world, frames);
      const [cx, cy] = tileCenter(VIEWPORT, BURST_TILE.x, BURST_TILE.y, world.probes().camera);
      expectPixel(world.render(), VIEWPORT.width, cx, cy, PULSE[1]!);
      hashes.push(fnv1a(world.render()));
    }
    expect(hashes).toEqual([hashes[0], hashes[0], hashes[0], hashes[0]]);
  });

  test("a following animation pins to the target's last live cell after the target moves and leaves", async () => {
    // Bind a ring to an invisible mover, walk the player onto the bind event
    // and confirm, then let the mover walk two tiles east and erase itself.
    // The ring must stay on the mover's LAST live cell (TRAIL_LAST_TILE),
    // not jump back to the cell where it was bound (TRAIL_MOVER_TILE).
    const world = await boot();
    pump(world, 1);
    // Two tiles east onto the trail-bind event (the ring event at
    // PLAYER_START+1 is action-triggered, so walking over it does not fire).
    pump(world, 16, BTN.RIGHT);
    expect(world.probes().state.move.tx).toBe(TRAIL_BIND_TILE.x);
    pump(world, 1, BTN.CIRCLE); // confirm: bind the ring, flip trail-move
    // The mover walks two tiles (16 ticks) plus a page switch and erase;
    // 40 ticks is enough for it to reach TRAIL_LAST_TILE and despawn.
    pump(world, 40);
    const cam = world.probes().camera;
    // The ring pinned to the last live cell: its center shows a ring frame.
    const [lx, ly] = tileCenter(VIEWPORT, TRAIL_LAST_TILE.x, TRAIL_LAST_TILE.y, cam);
    const lastPx = rgbaAt(world.render(), VIEWPORT.width, lx, ly);
    expect(
      RING.some((c) => c[0] === lastPx[0] && c[1] === lastPx[1] && c[2] === lastPx[2]),
      `last-live cell (${TRAIL_LAST_TILE.x},${TRAIL_LAST_TILE.y}) shows a ring frame, got [${lastPx}]`,
    ).toBe(true);
    // The bind cell is ground again: the ring did not jump back to it.
    const [bx, by] = tileCenter(VIEWPORT, TRAIL_MOVER_TILE.x, TRAIL_MOVER_TILE.y, cam);
    expectPixel(world.render(), VIEWPORT.width, bx, by, GROUND);
  });

  test("golden frames at both resolutions", async () => {
    const golden = async (name: string, vp: { width: number; height: number }): Promise<string> => {
      const world = await boot(60, vp);
      pump(world, 16); // mid frame-1 of the pulse (green), boot settled
      const frame = world.render();
      const url = new URL(`./goldens/${name}.png`, import.meta.url);
      if (process.env.KA1_UPDATE_GOLDENS) {
        await Bun.write(url, encodePNG(frame, vp.width, vp.height));
      }
      const bytes = new Uint8Array(await Bun.file(url).arrayBuffer());
      expect(frame).toEqual(decodePng(bytes).rgba);
      return fnv1a(frame);
    };
    expect(await golden("ka1-anim.480", VIEWPORT)).toBe("d8125bf5");
    expect(await golden("ka1-anim.960", WIDE)).toBe("6c930d75");
  });
});
