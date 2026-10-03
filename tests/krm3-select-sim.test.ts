// Built GameView proof for the KRM3 built-in select-item scene. Golden frames
// are paired with semantic pixel and node assertions so a stable but
// clipped/blank image cannot pass.

import { describe, expect, test } from "bun:test";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { fnv1a } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import type { SelectItemState } from "../src/engine/select-item.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import {
  bootGameWorld,
  installGameSimIsolation,
  type BoundGameWorld,
} from "./helpers/sim-session.ts";

const preflight = appPreflight("krm3-select");
if (!preflight.ok) console.warn(`KRM3 select-item sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

type Rgba = readonly [number, number, number, number];
const BACKDROP: Rgba = [0x05, 0x09, 0x14, 255];
const PANEL_BG: Rgba = [0x14, 0x1c, 0x30, 255];
const CURSOR: Rgba = [0xff, 0xe1, 0x7a, 255];

const FINAL_HASHES: Readonly<Record<string, string>> = {
  "picker.480x272": "",
  "picker.960x544": "",
};

function pump(world: BoundGameWorld, frames: number): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(0, 0x8080);
    for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  }
}

function rgbaAt(frame: Uint8Array, width: number, x: number, y: number): number[] {
  const i = (Math.round(y) * width + Math.round(x)) * 4;
  return [...frame.subarray(i, i + 4)];
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
  for (let y = Math.max(0, Math.round(y0)); y < Math.round(y0 + h); y++) {
    for (let x = Math.max(0, Math.round(x0)); x < Math.round(x0 + w); x++) {
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
  const url = new URL(`./goldens/krm3-select.${name}.png`, import.meta.url);
  if (process.env.KRM3_UPDATE_GOLDENS) await Bun.write(url, encodePNG(frame, width, height));
  const png = decodePng(new Uint8Array(await Bun.file(url).arrayBuffer()));
  expect(png.width).toBe(width);
  expect(png.height).toBe(height);
  expect(frame).toEqual(png.rgba);
  return fnv1a(frame);
}

simDescribe("KRM3 select-item visuals", () => {
  for (const viewport of [
    { width: 480, height: 272 },
    { width: 960, height: 544 },
  ] as const) {
    test(`renders an uncut item list at ${viewport.width}x${viewport.height}`, async () => {
      const world = await bootGameWorld(appBundle("krm3-select"), 60, undefined, undefined, viewport);
      pump(world, 10);

      const state = world.probes().state;
      expect(state.scene).toMatchObject({ kind: "scene", id: "rpgkit.selectItem" });
      const picker = state.scene!.state as unknown as SelectItemState;
      expect(picker.itemType).toBe("regular");
      // Potion, Hi-Potion, Ether, and the long-named item are regular.
      expect(picker.items.map((e) => e.name)).toContain("Potion");
      expect(picker.items.map((e) => e.name)).toContain("Hi-Potion");
      expect(picker.items.map((e) => e.name))
        .toContain("A very long item name that must wrap or scroll rather than be cut off");

      const frame = world.render().slice();
      const tree = JSON.stringify(world.getTree());
      expect(tree).toContain("rpgkit-select-item-panel");
      expect(tree).toContain("rpgkit-select-item-row-0");

      const scale = viewport.width / 480;
      const panelW = 300 * scale;
      const panelX = (viewport.width - panelW) / 2;
      // 4 regular items; the long name wraps to 2 lines -> 5 lines * 14px.
      // panelHeight = (TITLE 20 + PADDING 12*2 + 5 * 14) * scale = 114*scale
      const panelH = 114 * scale;
      const panelY = (viewport.height - panelH) / 2;
      // The full-screen backdrop owns the foreground.
      expect(rgbaAt(frame, viewport.width, 4 * scale, 4 * scale)).toEqual([...BACKDROP]);
      // The panel's top padding band (above the title) is the panel colour.
      expect(countColour(frame, viewport.width,
        panelX + 6 * scale, panelY + 4 * scale, panelW - 12 * scale, 8 * scale, PANEL_BG))
        .toBeGreaterThan(20);
      // The cursor row (row 0, below the title band) is the cursor colour.
      const rowY = panelY + (12 + 20) * scale;
      expect(countColour(frame, viewport.width,
        panelX + 14 * scale, rowY + 2 * scale, panelW - 28 * scale, 12 * scale, CURSOR))
        .toBeGreaterThan(100);

      // No row text may pass the panel's right border: count white row-text
      // pixels in the band to the right of the panel across its full height.
      // A layout that measures with a smaller font than it renders lets the
      // long name's last line spill past the border (the round-1 defect).
      const ROW_TEXT: Rgba = [0xff, 0xff, 0xff, 255];
      const outside = countColour(frame, viewport.width,
        panelX + panelW, panelY, viewport.width - (panelX + panelW), panelH, ROW_TEXT);
      expect(outside, `white pixels right of panel border: ${outside}`).toBe(0);

      const hash = await golden(`picker.${viewport.width}x${viewport.height}`, frame, viewport.width, viewport.height);
      if (!process.env.KRM3_UPDATE_GOLDENS && FINAL_HASHES[`picker.${viewport.width}x${viewport.height}`]) {
        expect(hash).toBe(FINAL_HASHES[`picker.${viewport.width}x${viewport.height}`]);
      }

      // Navigate down one row and confirm: the chosen item's numeric id is
      // written to the variable and the scene completes.
      world.frame(BTN.DOWN, 0x8080);
      for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
      world.frame(0, 0x8080);
      for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
      world.frame(BTN.CIRCLE, 0x8080);
      for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
      pump(world, 5);
      const after = world.probes().state;
      expect(after.scene).toBeNull();
      expect(after.sw.variables["pick"]).toBe(2); // item002 Hi-Potion
      expect(after.sw.switches["done"]).toBe(true);
    }, 30_000);
  }

  test("60/20/4 Hz open the same picker at the same virtual instant", async () => {
    const outcomes: Array<{ state: unknown; pixels: string }> = [];
    for (const hz of [60, 20, 4] as const) {
      const world = await bootGameWorld(appBundle("krm3-select"), hz);
      pump(world, hz / 2);
      const state = world.probes().state;
      const picker = state.scene?.state as unknown as SelectItemState | undefined;
      outcomes.push({
        state: {
          id: state.scene && "id" in state.scene ? state.scene.id : undefined,
          itemType: picker?.itemType,
          count: picker?.items.length,
          index: picker?.index,
        },
        pixels: fnv1a(world.render()),
      });
    }
    for (const outcome of outcomes.slice(1)) expect(outcome).toEqual(outcomes[0]);
  }, 30_000);
});
