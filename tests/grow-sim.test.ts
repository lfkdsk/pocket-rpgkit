// tests/rpgkit-grow-sim.test.ts — D3 end to end through the BUILT "grow"
// bundle on the deterministic wasm sim host. The pure rule semantics live
// in rpgkit-grow.test.ts and the format in rpgkit-grow-project.test.ts;
// here the same rules run through GrowView and the pixels are asserted for
// meaning, not just hash equality:
//
//   grow     tick plate, timeline strip and fill widen with ticks; a hut
//            roof color exists once huts exist; the world is mostly grass
//            early and filled later
//   scrub    a touch on the timeline strip seeks to that tick and pauses;
//            the same contact at another x moves it again
//   seed     SQUARE swaps the seed; plate text changes and the world hash
//            differs
//   play     CIRCLE at done hands off to the normal session (mode "play",
//            map "settlement"); d-pad walks; SELECT returns to grow
//
// Golden PNGs (rpgkit-grow.*) carry the byte-exact gate; this file is the
// semantic layer over those same frames.

import { describe, expect, test } from "bun:test";
import { bootWorld } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { __packTouch } from "../vendor/pocketjs/framework/src/touch.ts";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { biomeBoundaryX, DEFAULT_PARAMS, growToTick, tickEveryFrames, totalTicks, worldSummary } from "../examples/grow/grow.ts";
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
  cameraX: number;
  frontierX: number;
  mounted: number;
  visibleX0: number;
  visibleX1: number;
  scrub?: {
    seekCount: number; timelineStepCalls: number; timelineSeeks: number;
  };
}
interface SimWorld {
  frame: (b: number, a?: number, t?: readonly number[]) => void;
  tick: () => void;
  render: () => Uint8Array;
  resizeViewport: (width: number, height: number) => void;
}

const TOTAL = totalTicks(DEFAULT_PARAMS);
const PERIOD = tickEveryFrames(DEFAULT_PARAMS, 60); // virtual frames/action at 60 Hz
const DONE_FRAME = TOTAL * PERIOD; // last action lands here

function count(fb: Uint8Array, pred: (r: number, g: number, b: number) => boolean, x0 = 0, x1 = 480, y0 = 0, y1 = 272, stride = 480): number {
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * stride + x) * 4;
      if (pred(fb[i]!, fb[i + 1]!, fb[i + 2]!)) n++;
    }
  }
  return n;
}

// Timeline strip: dark navy band in rows 256..271 and the blue
// (#4a90d9-ish) progress fill on row 263.
const stripDark = (fb: Uint8Array): number =>
  count(fb, (r, g, b) => b >= 30 && b <= 60 && r <= 24 && g <= 34, 0, 480, 257, 271);
const fillBlueAt = (fb: Uint8Array, x: number): boolean => {
  const i = (263 * 480 + x) * 4;
  const [r, g, b] = [fb[i]!, fb[i + 1]!, fb[i + 2]!];
  return b > 180 && r < 110 && g > 120;
};
// Ninja Adventure road/field earth: high red, warm midtone.
const dirtTan = (fb: Uint8Array, y0 = 0, y1 = 256): number =>
  count(fb, (r, g, b) => r === 170 && g === 153 && b === 119, 0, 480, y0, y1);
// Ninja abandoned-village roof: red-brown, r dominant.
const roofRed = (fb: Uint8Array): number =>
  count(fb, (r, g, b) => r > 150 && g < 110 && b < 90, 16, 464, 0, 256);
const exactRgb = (fb: Uint8Array, rgb: readonly [number, number, number]): number =>
  count(fb, (r, g, b) => r === rgb[0] && g === rgb[1] && b === rgb[2], 0, 480, 0, 256);

async function boot(width = 480, height = 272): Promise<SimWorld> {
  return (await bootWorld(appBundle("grow"), 60, undefined, undefined, { width, height })) as unknown as SimWorld;
}
const pub = (): GrowPub => (globalThis as { __rpgGrowState?: GrowPub }).__rpgGrowState!;

simDescribe("D3 grow — timeline HUD semantics", () => {
  test("early frame: grass field, dark strip, fill at ~tick fraction", async () => {
    const w = await boot();
    for (let f = 0; f < 60; f++) {
      w.frame(0);
      w.tick();
    }
    const fb = w.render();
    const st = pub();
    expect(st.mode).toBe("grow");
    expect(st.tick).toBe(5);
    // The strip occupies the bottom 15 rows.
    expect(stripDark(fb)).toBeGreaterThan(1500);
    // Fill at x=0 is blue; fill past the fraction is not.
    const fillWidth = (st.tick / st.total) * 480;
    expect(fillBlueAt(fb, Math.max(2, Math.floor(fillWidth) - 4))).toBe(true);
    expect(fillBlueAt(fb, Math.min(478, Math.ceil(fillWidth) + 8))).toBe(false);
  });

  test("roads appear over time; the settled frame is far less empty grass", async () => {
    const w = await boot();
    for (let f = 0; f < 6 * PERIOD; f++) {
      w.frame(0);
      w.tick();
    }
    const early = dirtTan(w.render());
    for (let f = 0; f < DONE_FRAME - 6 * PERIOD + 4; f++) {
      w.frame(0);
      w.tick();
    }
    const late = dirtTan(w.render());
    expect(late).toBeGreaterThan(early * 3);
    expect(roofRed(w.render())).toBeGreaterThan(400); // huts exist
  });

  test("after the camera scrolls, authored content remains beside the 60-percent frontier", async () => {
    const w = await boot(960, 544);
    // The causal camera follows the director's focus column (roadFrontierX),
    // which pans toward each new event's place. Sample a boundary where the
    // focus rests (it did not move on this tick) after the camera scrolled.
    let at = 60;
    while (growToTick(DEFAULT_PARAMS, at).roadFrontierX !== growToTick(DEFAULT_PARAMS, at - 1).roadFrontierX
      || growToTick(DEFAULT_PARAMS, at).cameraX < 600) at++;
    for (let frame = 0; frame < at * PERIOD; frame++) {
      w.frame(0);
      w.tick();
    }
    const state = pub();
    const canonical = growToTick(DEFAULT_PARAMS, at);
    expect(state.tick).toBe(at);
    expect(state.cameraX).toBe(canonical.cameraX);
    expect(state.frontierX).toBe(canonical.roadFrontierX);
    expect(state.cameraX).toBeGreaterThan(0);
    expect(state.visibleX0).toBeGreaterThan(0);
    expect(state.frontierX).toBeGreaterThanOrEqual(state.visibleX0);
    expect(state.frontierX).toBeLessThanOrEqual(state.visibleX1);
    // visibleX0 includes one overscan column. The frontier tile's right
    // edge therefore lands at (frontier - x0) * 16 = 60% of 960px.
    const frontierFraction = ((state.frontierX - state.visibleX0) * 16) / 960;
    expect(frontierFraction).toBe(0.6);
    // Mutation proof: retaining the PSP's fixed 288px lead at desktop size
    // would place the frontier at 30%, which this semantic guard rejects.
    expect(288 / 960).not.toBe(0.6);
    const screenFrontier = (state.frontierX - state.visibleX0 - 1) * 16;
    const fb = w.render();
    const authoredPixels = count(
      fb,
      (r, g, b) => (r > 150 && g < 200 && b < 150) || (g > 100 && g - r > 5 && g - b > 30),
      screenFrontier - 32, screenFrontier + 32, 48, 496, 960,
    );
    expect(authoredPixels).toBeGreaterThan(4_500);
  });

  test("the rendered biome seam follows its different seeded x on each row", async () => {
    const palette = async (biome: number): Promise<Set<string>> => {
      const png = decodePng(new Uint8Array(await Bun.file(
        new URL(`../examples/grow/assets/grow-terrain-${biome}-fill.png`, import.meta.url),
      ).arrayBuffer()));
      const colors = new Set<string>();
      for (let i = 0; i < png.rgba.length; i += 4) {
        colors.add(`${png.rgba[i]},${png.rgba[i + 1]},${png.rgba[i + 2]},${png.rgba[i + 3]}`);
      }
      return colors;
    };
    for (const biome of [1, 2, 3]) {
      const transition = decodePng(new Uint8Array(await Bun.file(
        new URL(`../examples/grow/assets/grow-terrain-${biome}-transition.png`, import.meta.url),
      ).arrayBuffer()));
      const allowed = new Set([...(await palette(biome - 1)), ...(await palette(biome))]);
      const colors = new Set<string>();
      for (let i = 0; i < transition.rgba.length; i += 4) {
        colors.add(`${transition.rgba[i]},${transition.rgba[i + 1]},${transition.rgba[i + 2]},${transition.rgba[i + 3]}`);
      }
      expect(colors.size).toBe(6);
      expect([...colors].every((color) => allowed.has(color))).toBe(true);
    }

    // Assert row-dependent geometry after real pak decode + PSM_4444 wasm
    // render. The first seam is wholly visible in a 960px initial window.
    const w = await boot(960, 544);
    w.frame(0);
    w.tick();
    const fb = w.render();
    const quantized = (colors: Set<string>): Set<string> => new Set(
      [...colors].map((color) => color.split(",").slice(0, 3)
        .map((channel) => (Number(channel) >> 4) * 17).join(",")),
    );
    const oldFill = quantized(await palette(0));
    const newFill = quantized(await palette(1));
    const renderedSeams: number[] = [];
    for (let row = 0; row < DEFAULT_PARAMS.height; row++) {
      const seamX = biomeBoundaryX(DEFAULT_PARAMS, 1, row);
      const rendered = new Set<string>();
      for (let y = row * 16; y < row * 16 + 16; y++) {
        for (let x = seamX * 16; x < seamX * 16 + 16; x++) {
          const i = (y * 960 + x) * 4;
          rendered.add(`${fb[i]},${fb[i + 1]},${fb[i + 2]}`);
        }
      }
      expect([...rendered].some((color) => oldFill.has(color)), `row ${row} keeps old biome`).toBe(true);
      expect([...rendered].some((color) => newFill.has(color)), `row ${row} introduces new biome`).toBe(true);
      renderedSeams.push(seamX);
    }
    expect(new Set(renderedSeams).size).toBeGreaterThanOrEqual(4);
  });
});

simDescribe("D3 scrub — touch seeks the timeline", () => {
  test("coalesces four desktop pointer lines per frame and folds each tick at most once", async () => {
    const incoming: string[] = [];
    let frameMounts = 0, frameUnmounts = 0, maxFrameMounts = 0, maxFrameUnmounts = 0;
    const w = (await bootWorld(appBundle("grow"), 60, undefined, (ops) => {
      ops.svcPoll = () => incoming.splice(0).join("\n") || undefined;
      const createNode = ops.createNode as (...args: unknown[]) => unknown;
      const destroyNode = ops.destroyNode as (...args: unknown[]) => unknown;
      ops.createNode = (...args: unknown[]) => { frameMounts++; return createNode(...args); };
      ops.destroyNode = (...args: unknown[]) => { frameUnmounts++; return destroyNode(...args); };
    }, { width: 960, height: 544 })) as unknown as SimWorld;
    w.frame(0); w.tick();
    for (let frame = 0; frame < 120; frame++) {
      frameMounts = 0; frameUnmounts = 0;
      for (let event = 0; event < 4; event++) {
        const ordinal = frame * 4 + event;
        incoming.push(JSON.stringify({
          t: "mouse", x: ordinal / (120 * 4 - 1) * 960, y: 536, d: true,
        }));
      }
      w.frame(0); w.tick();
      maxFrameMounts = Math.max(maxFrameMounts, frameMounts);
      maxFrameUnmounts = Math.max(maxFrameUnmounts, frameUnmounts);
    }
    const st = pub();
    const scrub = st.scrub!;
    expect(st.tick).toBe(st.total);
    expect(scrub.seekCount).toBe(120);
    expect(scrub.timelineStepCalls).toBeLessThanOrEqual(st.total + 1);
    // One timeline lookup per rendered drag frame. The prefill happens at
    // mount and does not inflate drag accounting.
    expect(scrub.timelineSeeks).toBe(120);
    // D6e's dense wilderness can replace most upper nodes when a scrub
    // jumps between biomes. Bound work to one visible scene, never world
    // history, while the performance gate measures elapsed frame time.
    expect(maxFrameMounts).toBeLessThanOrEqual(450);
    expect(maxFrameUnmounts).toBeLessThanOrEqual(450);
  });

  // Jumps hand departing image nodes to arriving cells and park the rest
  // without a texture. Whatever sequence of jumps led there, the frame must
  // be the one live growth draws when paused on the same action boundary.
  for (const [width, height, target] of [[960, 544, 90], [480, 272, 37]] as const) {
    test(`recycled jump nodes draw the paused live frame (${width}x${height}, tick ${target})`, async () => {
      const incoming: string[] = [];
      let created = 0, destroyed = 0;
      const jumper = (await bootWorld(appBundle("grow"), 60, undefined, (ops) => {
        ops.svcPoll = () => incoming.splice(0).join("\n") || undefined;
        const createNode = ops.createNode as (...args: unknown[]) => unknown;
        const destroyNode = ops.destroyNode as (...args: unknown[]) => unknown;
        ops.createNode = (...args: unknown[]) => { created++; return createNode(...args); };
        ops.destroyNode = (...args: unknown[]) => { destroyed++; return destroyNode(...args); };
      }, { width, height })) as unknown as SimWorld;
      for (let f = 0; f < DONE_FRAME + 2; f++) { jumper.frame(0); jumper.tick(); }
      expect(pub().tick).toBe(TOTAL);
      // A click on the strip: press and release land in one frame.
      const jump = (tick: number) => {
        const x = (tick / TOTAL) * width;
        incoming.push(JSON.stringify({ t: "mouse", x, y: height - 8, d: true }));
        incoming.push(JSON.stringify({ t: "mouse", x, y: height - 8, d: false }));
        jumper.frame(0); jumper.tick();
        expect(pub().tick).toBe(tick);
      };
      const tour = [0, 140, 20, TOTAL, 64, 3, 120, target];
      // A jump's node demand depends on the scene it leaves (cells both
      // scenes show keep their nodes), so the pool can still grow on the
      // second tour; by the third every jump finds a parked node for every
      // cell: no node is created or destroyed.
      for (const tick of tour) jump(tick);
      for (const tick of tour) jump(tick);
      created = 0; destroyed = 0;
      for (const tick of tour) jump(tick);
      expect({ created, destroyed }).toEqual({ created: 0, destroyed: 0 });
      jumper.frame(0); jumper.tick();
      const jumped = jumper.render().slice();
      const jumpedPub = { ...pub() };

      // Live growth paused with TRIANGLE on the frame the target action lands.
      const live = await boot(width, height);
      for (let f = 0; f < target * PERIOD; f++) { live.frame(0); live.tick(); }
      live.frame(BTN.TRIANGLE); live.tick();
      live.frame(0); live.tick();
      const paused = pub();
      expect(paused.auto).toBe(false);
      expect(paused.tick).toBe(target);
      expect(jumpedPub).toMatchObject({
        tick: paused.tick, cameraX: paused.cameraX, hash: paused.hash, mounted: paused.mounted,
      });
      const frame = live.render();
      let differing = 0;
      for (let i = 0; i < frame.length; i++) if (frame[i] !== jumped[i]) differing++;
      expect(differing).toBe(0);
    }, 30_000);
  }

  test("a held contact scrubs to its x tick and pauses growth", async () => {
    const w = await boot();
    // Let it grow a little first.
    for (let f = 0; f < 60; f++) {
      w.frame(0);
      w.tick();
    }
    expect(pub().tick).toBe(5);
    const targetX = 300; // round(300/480*total)
    const wantTick = Math.round((targetX / 480) * TOTAL);
    const contact = __packTouch(0, targetX, 264);
    for (let f = 0; f < 5; f++) {
      w.frame(0, 0x8080, [contact]);
      w.tick();
    }
    const st = pub();
    expect(st.auto).toBe(false);
    expect(st.tick).toBe(wantTick);
    // Holding still keeps the world at that tick (paused, not regrowing).
    for (let f = 0; f < 30; f++) {
      w.frame(0, 0x8080, [contact]);
      w.tick();
    }
    expect(pub().tick).toBe(wantTick);
    // Releasing leaves it paused at the scrubbed tick.
    for (let f = 0; f < 10; f++) {
      w.frame(0);
      w.tick();
    }
    expect(pub().tick).toBe(wantTick);
  });

  test("scrubbing backward removes grown content (pixels)", async () => {
    const w = await boot();
    for (let f = 0; f < DONE_FRAME + 2; f++) {
      w.frame(0);
      w.tick();
    }
    // Scrub to tick 20, where the first village has houses, and copy the
    // pixels of one wholly on screen (the camera rests on that village
    // through tick 20) by world position. Then rewind to tick 1 (the village
    // founded, no house yet): the same world cells must differ.
    const grownTick = 20;
    const grownState = growToTick(DEFAULT_PARAMS, grownTick);
    expect(grownState.cameraX).toBe(growToTick(DEFAULT_PARAMS, 1).cameraX);
    const house = grownState.houses.find((h) => h.x0! * 16 - grownState.cameraX >= 0 && h.x0! * 16 + 48 - grownState.cameraX <= 480
      && h.top! * 16 - 136 >= 0 && h.top! * 16 + 48 - 136 <= 256)!;
    expect(house).toBeDefined();
    expect(growToTick(DEFAULT_PARAMS, 1).houses).toHaveLength(0);
    const footprint = (fb: Uint8Array): number[] | undefined => {
      const camX = pub().cameraX, camY = 136; // 33 rows centered in 256 px
      const x0 = house.x0! * 16 - camX, y0 = house.top! * 16 - camY;
      if (x0 < 0 || x0 + 48 > 480 || y0 < 0 || y0 + 48 > 256) return undefined;
      const out: number[] = [];
      for (let y = y0; y < y0 + 48; y++) for (let x = x0; x < x0 + 48; x++) {
        const i = (y * 480 + x) * 4;
        out.push((fb[i]! << 16) | (fb[i + 1]! << 8) | fb[i + 2]!);
      }
      return out;
    };
    const seek = (tick: number) => {
      const contact = __packTouch(0, Math.max(1, Math.round((tick / TOTAL) * 480)), 264);
      for (let f = 0; f < 3; f++) { w.frame(0, 0x8080, [contact]); w.tick(); }
      expect(pub().tick).toBe(tick);
    };
    seek(grownTick);
    const grown = footprint(w.render());
    seek(1);
    const rewound = footprint(w.render());
    expect(grown).toBeDefined();
    expect(rewound).toBeDefined();
    let differing = 0;
    for (let i = 0; i < grown!.length; i++) if (grown![i] !== rewound![i]) differing++;
    // A 3x3 or 4x3 house covers most of its 3x3-cell sample.
    expect(differing).toBeGreaterThan(grown!.length * 0.6);
  });

  test("resuming after a far scrub waits one period for the next action", async () => {
    const w = await boot();
    for (let f = 0; f < 60; f++) {
      w.frame(0);
      w.tick();
    }
    expect(pub().tick).toBe(5);
    // Scrub far ahead to tick 40, then unpause with TRIANGLE.
    const contact = __packTouch(0, Math.round((40 / TOTAL) * 480), 264);
    for (let f = 0; f < 3; f++) {
      w.frame(0, 0x8080, [contact]);
      w.tick();
    }
    expect(pub().tick).toBe(40);
    expect(pub().auto).toBe(false);
    w.frame(BTN.TRIANGLE);
    w.tick();
    expect(pub().auto).toBe(true);
    // One period (12 frames at 60 Hz) later the next action lands — the
    // scrubbed frame clock resumes at tick 40's deadline, it does not
    // re-walk 40 periods.
    for (let f = 0; f < PERIOD; f++) {
      w.frame(0);
      w.tick();
    }
    expect(pub().tick).toBe(41);
  });

  test("pressing the current tick snaps an in-flight camera to its boundary", async () => {
    const w = await boot();
    const target = 30;
    for (let f = 0; f < target * PERIOD + Math.floor(PERIOD / 2); f++) {
      w.frame(0); w.tick();
    }
    expect(pub().tick).toBe(target);
    w.frame(BTN.TRIANGLE); w.tick();
    w.frame(0); w.tick();
    const canonical = growToTick(DEFAULT_PARAMS, target);
    expect(pub().cameraX).not.toBe(canonical.cameraX);
    const x = Math.round((target / TOTAL) * 480);
    w.frame(0, 0x8080, [__packTouch(0, x, 264)]); w.tick();
    expect(pub().tick).toBe(target);
    expect(pub().cameraX).toBe(canonical.cameraX);
    expect(pub().hash).toBe(worldSummary(canonical).hash);
  });
});

simDescribe("D3 seed — determinism and seed change", () => {
  test("two boots at the same tick publish the same hash", async () => {
    const a = await boot();
    for (let f = 0; f < 240; f++) {
      a.frame(0);
      a.tick();
    }
    const hashA = pub().hash;
    const b = await boot();
    for (let f = 0; f < 240; f++) {
      b.frame(0);
      b.tick();
    }
    expect(pub().hash).toBe(hashA);
  });

  test("SQUARE changes the seed and, as it grows, the world hash", async () => {
    const w = await boot();
    for (let f = 0; f < DONE_FRAME + 2; f++) {
      w.frame(0);
      w.tick();
    }
    const settledHash = pub().hash;
    w.frame(BTN.SQUARE); // press edge
    w.tick();
    w.frame(0);
    w.tick();
    const st = pub();
    expect(st.seed).not.toBe(DEFAULT_PARAMS.seed);
    expect(st.tick).toBe(0);
    // Grow the new seed to a few ticks; its world already differs.
    for (let f = 0; f < 60; f++) {
      w.frame(0);
      w.tick();
    }
    expect(pub().hash).not.toBe(settledHash);
  });

  test("SQUARE replaces the scrub timeline with the new seed", async () => {
    const w = await boot();
    w.frame(BTN.SQUARE); w.tick();
    w.frame(0); w.tick();
    const changed = pub();
    const target = 40;
    const x = Math.round((target / changed.total) * 480);
    w.frame(0, 0x8080, [__packTouch(0, x, 264)]); w.tick();
    const expected = growToTick({ ...DEFAULT_PARAMS, seed: changed.seed }, target);
    expect(pub().tick).toBe(target);
    expect(pub().cameraX).toBe(expected.cameraX);
    expect(pub().hash).toBe(worldSummary(expected).hash);
  });
});

simDescribe("D3 handoff — walk into the grown village", () => {
  test("CIRCLE at done enters play; the session plays the generated map", async () => {
    const w = await boot();
    for (let f = 0; f < DONE_FRAME + 2; f++) {
      w.frame(0);
      w.tick();
    }
    expect(pub().mode).toBe("grow");
    expect(pub().tick).toBe(TOTAL);
    w.frame(BTN.CIRCLE); // press edge
    w.tick();
    w.frame(0);
    w.tick();
    expect(pub().mode).toBe("play");
    type PlayPub = { mapId: string; move: { tx: number; ty: number }; interp: { error?: { message: string } } };
    const session0 = (globalThis as { __rpgSessionState?: PlayPub }).__rpgSessionState!;
    expect(session0.mapId).toBe("settlement");
    const x0 = session0.move.tx;
    // Walk left: this road segment is clear of the seed plaque and proves
    // the exported settlement is traversable through the normal session.
    for (let f = 0; f < 16; f++) {
      w.frame(BTN.LEFT);
      w.tick();
    }
    const s1 = (globalThis as { __rpgSessionState?: PlayPub }).__rpgSessionState!;
    expect(s1.move.tx).toBeLessThan(x0);
    expect(s1.interp.error).toBeUndefined();
    // SELECT returns to the growth screen.
    w.frame(BTN.SELECT);
    w.tick();
    w.frame(0);
    w.tick();
    expect(pub().mode).toBe("grow");
  });
});

simDescribe("D6e live desktop viewport", () => {
  test("a 960x544 scene fills the top and bottom eight rows with world or timeline pixels", async () => {
    const w = await boot(960, 544);
    w.frame(0);
    w.tick();
    const fb = w.render();
    expect(fb.length).toBe(960 * 544 * 4);
    const rgb = (x: number, y: number): [number, number, number] => {
      const i = (y * 960 + x) * 4;
      return [fb[i]!, fb[i + 1]!, fb[i + 2]!];
    };
    let edgeBlack = 0;
    for (const y of [...Array.from({ length: 8 }, (_, i) => i), ...Array.from({ length: 8 }, (_, i) => 536 + i)]) {
      for (let x = 0; x < 960; x++) if (rgb(x, y).every((channel) => channel === 0)) edgeBlack++;
    }
    expect(edgeBlack).toBe(0);
    // Mutation proof: a one-row letterbox changes this same semantic count.
    const letterboxed = fb.slice();
    letterboxed.fill(0, 0, 960 * 4);
    let mutantBlack = 0;
    for (let x = 0; x < 960; x++) if (letterboxed[x * 4] === 0 && letterboxed[x * 4 + 1] === 0 && letterboxed[x * 4 + 2] === 0) mutantBlack++;
    expect(mutantBlack).toBeGreaterThan(0);
    // Grove stamps cover four cells with one art each and meadows are sparser
    // than D6e's tuft carpet, so a full desktop window mounts ~770 nodes.
    expect(pub().mounted).toBeGreaterThan(600);
    expect(pub().mounted).toBeLessThan(1_600);
  });
});

simDescribe("D6e maintained golden semantics", () => {
  test("the four reviewed growth frames retain their biome story", async () => {
    const frames = await Promise.all([120, 720, 1320, 2028].map(async (frame) =>
      decodePng(new Uint8Array(await Bun.file(
        new URL(`./goldens/grow.${frame}.png`, import.meta.url),
      ).arrayBuffer())).rgba));

    // Grass begins with dense broadleaf groves; mud replaces that palette,
    // then sand and snow each dominate their later authored milestone.
    expect(exactRgb(frames[0]!, [153, 170, 119])).toBeGreaterThan(1_000);
    expect(exactRgb(frames[1]!, [153, 153, 119])).toBeGreaterThan(50_000);
    expect(exactRgb(frames[2]!, [204, 187, 136])).toBeGreaterThan(50_000);
    expect(exactRgb(frames[3]!, [187, 204, 204])).toBeGreaterThan(50_000);
    for (const frame of frames) expect(roofRed(frame)).toBeGreaterThan(50);
    const scrubFrames = await Promise.all([20, 45].map(async (frame) => decodePng(new Uint8Array(await Bun.file(
      new URL(`./goldens/grow-scrub.${frame}.png`, import.meta.url),
    ).arrayBuffer())).rgba));
    // Before the first house, the crossroad is bare; seeking to tick 21 shows
    // both residential rows. These assertions consume both scrub fixtures.
    // Inspect the first north-row cottage (an orange-roof lot west of the
    // plaza), away from the orange roots of the grove stamps.
    const facade = (fb: Uint8Array) => count(fb, (r, g, b) => r > 130 && g < 110 && b < 100, 80, 112, 64, 96);
    expect(facade(scrubFrames[0]!)).toBeLessThan(10);
    expect(facade(scrubFrames[1]!)).toBeGreaterThan(20);
    // Mutation proof: the former flat grass-only frame cannot satisfy the
    // later sand or snow dominance predicates.
    expect(exactRgb(frames[0]!, [204, 187, 136])).toBeLessThan(1_000);
    expect(exactRgb(frames[0]!, [187, 204, 204])).toBe(0);
  });
});
