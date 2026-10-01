// tests/web-density-sim.test.ts — native-density browser rendering proof.
// tools/build-example.ts emits the same UI fixture at 1x, 2x and 3x. Each
// bundle is paired with a core at the matching raster density and rendered at
// that physical scale, exactly as tools/web/player.js does.

import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { bootWorld } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { DEFAULT_UI_THEME } from "../src/ui/theme.ts";
import type { FixtureScene } from "./fixtures/ui-theme/scenes.ts";

const ROOT = resolve(import.meta.dir, "..");
const WASM = join(ROOT, "vendor", "pocketjs", "hosts", "web", "pocketjs.wasm");
const DENSITIES = [1, 2, 3] as const;
const W = 480;
const H = 272;

interface DensityFrame {
  density: number;
  rgba: Uint8Array;
}

function bundle(name: "ui-theme" | "meadow", density: number): string {
  return density === 1
    ? join(ROOT, "dist", name)
    : join(ROOT, "dist", `density-${density}`, name);
}

const builtFiles = DENSITIES.flatMap((density) =>
  (["ui-theme", "meadow"] as const).flatMap((name) => [bundle(name, density) + ".js", bundle(name, density) + ".pak"]),
);
const missing = [WASM, ...builtFiles].filter((path) => !existsSync(path));
if (missing.length > 0) console.warn(`web density sim tests skipped: missing ${missing.join(", ")} — run \`bun run build:wasm && bun run build:example ui-theme meadow\``);
const simDescribe = missing.length === 0 ? describe : describe.skip;

const rgb = (hex: string): readonly [number, number, number] =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as unknown as readonly [number, number, number];
const sameRgb = (rgba: Uint8Array, at: number, color: ArrayLike<number>): boolean =>
  rgba[at] === color[0] && rgba[at + 1] === color[1] && rgba[at + 2] === color[2];

/** Edge samples are glyph pixels blended between the paper and full ink. */
function textCoverage(frame: DensityFrame): { solid: number; edge: number; edgeRatio: number } {
  const { density, rgba } = frame;
  const paper = rgb(DEFAULT_UI_THEME.paper);
  const ink = rgb(DEFAULT_UI_THEME.ink);
  let solid = 0;
  let edge = 0;
  for (let y = 182 * density; y < 216 * density; y++) {
    for (let x = 90 * density; x < 410 * density; x++) {
      const at = (y * W * density + x) * 4;
      if (sameRgb(rgba, at, paper)) continue;
      if (sameRgb(rgba, at, ink)) solid++;
      else if (
        rgba[at]! > paper[0] && rgba[at]! < ink[0] &&
        rgba[at + 1]! > paper[1] && rgba[at + 1]! < ink[1] &&
        rgba[at + 2]! > paper[2] && rgba[at + 2]! < ink[2]
      ) edge++;
    }
  }
  return { solid, edge, edgeRatio: edge / (solid + edge) };
}

async function renderDialog(density: number): Promise<DensityFrame> {
  const world = await bootWorld(
    bundle("ui-theme", density),
    60,
    undefined,
    undefined,
    { width: W, height: H, rasterDensity: density, renderScale: density },
  );
  world.frame(0);
  world.tick();
  const fixture = (globalThis as { __uiFixture?: { show(scene: FixtureScene): void } }).__uiFixture;
  if (!fixture) throw new Error("ui-theme fixture did not install __uiFixture");
  fixture.show({ modal: "speaker", faces: true });
  world.frame(0);
  world.tick();
  return { density, rgba: world.render().slice() };
}

async function renderMeadow(density: number): Promise<DensityFrame> {
  const world = await bootWorld(
    bundle("meadow", density),
    60,
    undefined,
    undefined,
    { width: W, height: H, rasterDensity: density, renderScale: density },
  );
  world.frame(0);
  world.tick();
  return { density, rgba: world.render().slice() };
}

simDescribe("web raster density", () => {
  const frames = new Map<number, DensityFrame>();
  const meadow = new Map<number, DensityFrame>();

  beforeAll(async () => {
    for (const density of DENSITIES) {
      frames.set(density, await renderDialog(density));
      meadow.set(density, await renderMeadow(density));
    }
  });

  test("the same dialog has committed 1x, 2x and 3x native-density goldens", async () => {
    for (const density of DENSITIES) {
      const frame = frames.get(density)!;
      expect(frame.rgba.length).toBe(W * density * H * density * 4);
      const url = new URL(`./goldens/web-density-dialog-${density}x.png`, import.meta.url);
      if (process.env.WEB_DENSITY_UPDATE_GOLDENS) {
        await Bun.write(url, encodePNG(frame.rgba, W * density, H * density));
      }
      const png = decodePng(new Uint8Array(await Bun.file(url).arrayBuffer()));
      expect([png.width, png.height], `${density}x dimensions`).toEqual([W * density, H * density]);
      let mismatchedBytes = Math.abs(frame.rgba.length - png.rgba.length);
      const compared = Math.min(frame.rgba.length, png.rgba.length);
      for (let i = 0; i < compared; i++) if (frame.rgba[i] !== png.rgba[i]) mismatchedBytes++;
      expect(mismatchedBytes, `${density}x framebuffer/golden byte mismatches`).toBe(0);
    }
  });

  test("higher-density text spends a smaller share of its ink on gray edge samples", () => {
    const one = textCoverage(frames.get(1)!);
    const two = textCoverage(frames.get(2)!);
    const three = textCoverage(frames.get(3)!);
    expect(one.solid).toBeGreaterThan(100);
    expect(one.edge).toBeGreaterThan(100);
    expect(two.solid).toBeGreaterThan(one.solid * 3);
    expect(two.edge).toBeGreaterThan(100);
    expect(three.solid).toBeGreaterThan(one.solid * 7);
    expect(three.edge).toBeGreaterThan(100);
    expect(two.edgeRatio).toBeLessThan(one.edgeRatio * 0.7);
    expect(three.edgeRatio).toBeLessThan(one.edgeRatio * 0.6);
  });

  test("the 1x portrait remains nearest-neighbour pixel art at 2x and 3x", () => {
    const one = frames.get(1)!.rgba;
    for (const density of [2, 3]) {
      const high = frames.get(density)!.rgba;
      let mismatchedChannels = 0;
      // Portrait content is x=18..81, y=182..245; every 1x texel must become
      // one uniform density×density block with the exact source RGBA value.
      for (let y = 182; y < 246; y++) {
        for (let x = 18; x < 82; x++) {
          const source = (y * W + x) * 4;
          for (let sy = 0; sy < density; sy++) {
            for (let sx = 0; sx < density; sx++) {
              const target = ((y * density + sy) * W * density + x * density + sx) * 4;
              for (let channel = 0; channel < 4; channel++) {
                if (high[target + channel] !== one[source + channel]) mismatchedChannels++;
              }
            }
          }
        }
      }
      expect(mismatchedChannels, `${density}x portrait channel mismatches`).toBe(0);
    }
  });

  test("Meadow tile edges remain exact nearest-neighbour blocks", () => {
    const one = meadow.get(1)!.rgba;
    let hardEdges = 0;
    for (let y = 40; y < 120; y++) {
      for (let x = 80; x < 400; x++) {
        const source = (y * W + x) * 4;
        if (x + 1 < 400) {
          const right = (y * W + x + 1) * 4;
          if (!sameRgb(one, source, one.subarray(right, right + 3))) hardEdges++;
        }
      }
    }
    expect(hardEdges).toBeGreaterThan(100);
    for (const density of [2, 3]) {
      const high = meadow.get(density)!.rgba;
      let mismatchedChannels = 0;
      for (let y = 40; y < 120; y++) {
        for (let x = 80; x < 400; x++) {
          const source = (y * W + x) * 4;
          for (let sy = 0; sy < density; sy++) {
            for (let sx = 0; sx < density; sx++) {
              const target = ((y * density + sy) * W * density + x * density + sx) * 4;
              for (let channel = 0; channel < 4; channel++) {
                if (high[target + channel] !== one[source + channel]) mismatchedChannels++;
              }
            }
          }
        }
      }
      expect(mismatchedChannels, `${density}x tile channel mismatches`).toBe(0);
    }
  });
});
