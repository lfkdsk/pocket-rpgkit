// tests/kg1-name-input-ui-sim.test.ts — the built-in name-input scene
// rendered through the real GameView -> scene pipeline on the deterministic
// wasm sim host. Semantic pixel assertions at 480×272 and 960×544, plus
// golden PNGs. The scene opens on frame 1 (autorun) with a prefilled
// buffer; the test types a char, walks to OK, and commits.

import { describe, expect, test } from "bun:test";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { fnv1a } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import {
  bootGameWorld,
  installGameSimIsolation,
  type BoundGameWorld,
} from "./helpers/sim-session.ts";

const preflight = appPreflight("kg1-name-input");
if (!preflight.ok) console.warn(`kg1 name input ui sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

type Rgba = readonly [number, number, number, number];
const PANEL_BG: Rgba = [0x14, 0x1c, 0x30, 255];
const TITLE: Rgba = [0xff, 0xe1, 0x7a, 255];
const EDIT_BG: Rgba = [0x0b, 0x16, 0x26, 255];
const BUFFER: Rgba = [0xff, 0xff, 0xff, 255];
const CURSOR: Rgba = [0xff, 0xe1, 0x7a, 255];
const CELL: Rgba = [0xc8, 0xd4, 0xf0, 255];

const FINAL_HASHES: Readonly<Record<string, string>> = {
  "480x272": "ce866975",
  "960x544": "6b08aafd",
};

function pump(world: BoundGameWorld, frames: number, buttons = 0): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(buttons, 0x8080);
    for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  }
}

function tap(world: BoundGameWorld, buttons: number): void {
  pump(world, 1, buttons);
  pump(world, 1);
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

function countColour(
  frame: Uint8Array,
  width: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  colour: Rgba,
): number {
  let count = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const pixel = rgbaAt(frame, width, x, y);
      if (pixel.every((value, channel) => value === colour[channel])) count++;
    }
  }
  return count;
}

async function golden(
  name: string,
  frame: Uint8Array,
  width: number,
  height: number,
): Promise<string> {
  const url = new URL(`./goldens/${name}.png`, import.meta.url);
  if (process.env.KG1_UPDATE_GOLDENS) await Bun.write(url, encodePNG(frame, width, height));
  const bytes = new Uint8Array(await Bun.file(url).arrayBuffer());
  expect(frame).toEqual(decodePng(bytes).rgba);
  return fnv1a(frame);
}

simDescribe("KG1 name input scene visuals", () => {
  for (const viewport of [
    { width: 480, height: 272 },
    { width: 960, height: 544 },
  ] as const) {
    test(`renders the panel, edit box and charset grid at ${viewport.width}x${viewport.height}`, async () => {
      const world = await bootGameWorld(
        appBundle("kg1-name-input"),
        60,
        { __kg1NameArgs: { variable: "player.nick", default: "Hero", maxLength: 8 } },
        undefined,
        viewport,
      );
      pump(world, 1);
      const s = viewport.width / 480; // 1 or 2
      const frame = world.render().slice();

      // Panel frame and paper.
      expectPixel(frame, viewport.width, 25 * s, 15 * s, PANEL_BG);
      // Title caption in the accent colour.
      expect(countColour(frame, viewport.width, 32 * s, 16 * s, 48 * s, 18 * s, TITLE)).toBeGreaterThan(10);
      // Edit box paper.
      expectPixel(frame, viewport.width, 33 * s, 39 * s, EDIT_BG);
      // Prefilled buffer "Hero" in white.
      expect(countColour(frame, viewport.width, 40 * s, 43 * s, 64 * s, 20 * s, BUFFER)).toBeGreaterThan(10);
      // Cursor sits on charset cell 0 ('A'): solid accent block.
      expectPixel(frame, viewport.width, 42 * s, 82 * s, CURSOR);
      expectPixel(frame, viewport.width, 78 * s, 98 * s, CURSOR);
      // A non-cursor charset cell ('B') renders its glyph in the cell colour.
      expect(countColour(frame, viewport.width, 80 * s, 80 * s, 40 * s, 20 * s, CELL)).toBeGreaterThan(0);

      // Type 'B': right moves the cursor to cell 1, confirm appends.
      tap(world, BTN.RIGHT);
      tap(world, BTN.CIRCLE);
      const typed = world.render().slice();
      expect(countColour(typed, viewport.width, 40 * s, 43 * s, 80 * s, 20 * s, BUFFER)).toBeGreaterThan(
        countColour(frame, viewport.width, 40 * s, 43 * s, 80 * s, 20 * s, BUFFER),
      );

      // Walk the cursor to OK (entry 68): 67 rights from cell 1, then commit.
      for (let i = 0; i < 67; i++) tap(world, BTN.RIGHT);
      const onOk = world.render().slice();
      // OK cell (row 6, col 8) is the cursor now.
      expectPixel(onOk, viewport.width, 362 * s, 202 * s, CURSOR);
      const hash = await golden(`kg1-name-input.${viewport.width}x${viewport.height}`, onOk, viewport.width, viewport.height);
      expect(hash).toBe(FINAL_HASHES[`${viewport.width}x${viewport.height}`]);

      tap(world, BTN.CIRCLE);
      pump(world, 3);
      const state = world.probes().state;
      expect(state.scene).toBeNull();
      expect(state.sw.variables["player.nick"]).toBe("HeroB");
    }, 30_000);
  }

  test("keeps the map mounted but hidden under the scene, keeps the scene mounted after close, restores the map", async () => {
    const world = await bootGameWorld(
      appBundle("kg1-name-input"),
      60,
      { __kg1NameArgs: { variable: "player.nick", default: "Hero", maxLength: 8 } },
      undefined,
      { width: 480, height: 272 },
    );
    pump(world, 1);
    expect(world.probes().state.scene?.kind).toBe("scene");

    // KB6 parity: the world subtree stays mounted across the scene, hidden
    // with display:none, and the scene view is mounted on top of it.
    let tree = JSON.stringify(world.getTree());
    expect(tree).toContain("rpgkit-world-frame");
    expect(tree).toContain("rpgkit-scene-rpgkit.nameInput");
    const during = world.render().slice();
    // The scene panel paints over the parked world.
    expectPixel(during, 480, 25, 15, PANEL_BG);

    // Commit with the default buffer: walk to OK (68 rights) and confirm.
    for (let i = 0; i < 68; i++) tap(world, BTN.RIGHT);
    tap(world, BTN.CIRCLE);
    pump(world, 3);
    expect(world.probes().state.scene).toBeNull();

    // The scene view stays mounted (hidden) after closing, so the next
    // entry pays no mount cost; the world is visible again.
    tree = JSON.stringify(world.getTree());
    expect(tree).toContain("rpgkit-scene-rpgkit.nameInput");
    expect(tree).toContain("rpgkit-world-frame");
    const after = world.render();
    expect(rgbaAt(after, 480, 25, 15)).not.toEqual([...PANEL_BG]);
    // The scene is gone: no panel paper pixel anywhere in its frame.
    expect(countColour(after, 480, 20, 10, 440, 252, PANEL_BG)).toBe(0);
  }, 30_000);
});
