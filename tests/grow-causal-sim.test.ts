// tests/grow-causal-sim.test.ts — the causal grow world through the BUILT
// "grow" bundle on the deterministic sim host (tools/grow-shots.ts renders
// the frames). The committed goldens are the byte-exact gate; the pixel
// assertions say what each frame must show:
//
//   biomes    each finished village (camera held on its founding place) has
//             dirt and paved roads; the grass and mud villages bridged their
//             stream; the abandoned snow village shows the most ruins, the
//             declining mud and sand villages a few of their own
//   timeline  the strip carries event markers in several families' colors
//   here      touching the snow village's plaza lists its last events
//
//   GROW_CAUSAL_UPDATE_GOLDENS=1 bun test tests/grow-causal-sim.test.ts

import { describe, expect, test } from "bun:test";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { captureGrowShots, type GrowShot } from "../tools/grow-shots.ts";
import { appPreflight } from "./helpers/boot.ts";

const preflight = appPreflight("grow");
if (!preflight.ok) console.warn(`grow causal sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

const golden = (name: string) => new URL(`./goldens/${name}.png`, import.meta.url);

/** Art colors as the PSM_4444 texture path presents them. */
const q = (rgb: readonly [number, number, number]) => rgb.map((c) => (c >> 4) * 17);
const PAVED = q([150, 148, 138]);
const DIRT = q([168, 153, 115]);
const PLANK = q([134, 101, 65]);
const RUIN_STONE = q([176, 170, 150]);
const RUIN_CHAR = q([66, 56, 46]);
const WORN_SNOW = q([163, 158, 138]);

function count(s: GrowShot, rgb: readonly number[], y1 = s.height - 16): number {
  let n = 0;
  for (let y = 0; y < y1; y++) for (let x = 0; x < s.width; x++) {
    const i = (y * s.width + x) * 4;
    if (s.rgba[i] === rgb[0] && s.rgba[i + 1] === rgb[1] && s.rgba[i + 2] === rgb[2]) n++;
  }
  return n;
}

simDescribe("causal grow — review frames", () => {
  test("frames match the goldens and show what the history did", async () => {
    const shots = await captureGrowShots();
    const by = new Map(shots.map((s) => [s.name, s]));
    for (const s of shots) {
      if (process.env.GROW_CAUSAL_UPDATE_GOLDENS) {
        await Bun.write(golden(s.name), encodePNG(s.rgba, s.width, s.height));
        continue;
      }
      const want = decodePng(new Uint8Array(await Bun.file(golden(s.name)).arrayBuffer()));
      expect([want.width, want.height], s.name).toEqual([s.width, s.height]);
      let differing = 0;
      for (let i = 0; i < s.rgba.length; i++) if (s.rgba[i] !== want.rgba[i]) differing++;
      expect(differing, `${s.name} differs from its golden`).toBe(0);
    }

    // Every village wore dirt roads and paved the busiest with its stone.
    for (const biome of ["grass", "mud", "sand", "snow"]) {
      const s = by.get(`grow-causal-${biome}`)!;
      expect(s.pub.tick).toBe(240);
      expect(count(s, DIRT), biome).toBeGreaterThan(3_000);
      expect(count(s, PAVED), biome).toBeGreaterThan(300);
    }
    // Feet crossing the streams of the grass and mud bands built bridges.
    expect(count(by.get("grow-causal-grass")!, PLANK)).toBeGreaterThan(150);
    expect(count(by.get("grow-causal-mud")!, PLANK)).toBeGreaterThan(150);
    // The snow village starved and was abandoned: its houses are ruins,
    // its label says so, and the caption at its place records it. The
    // thriving grass village shows no ruin stone at all; the declining mud
    // village shows only a house or two.
    const snow = by.get("grow-causal-snow")!;
    expect(count(snow, RUIN_STONE)).toBeGreaterThan(1_000);
    expect(count(snow, RUIN_CHAR)).toBeGreaterThan(200);
    expect(count(snow, WORN_SNOW)).toBeGreaterThan(1_000);
    expect(snow.pub.caption).toContain("ABANDONED");
    expect(count(by.get("grow-causal-grass")!, RUIN_STONE)).toBe(0);
    const mudRuins = count(by.get("grow-causal-mud")!, RUIN_STONE);
    expect(mudRuins).toBeGreaterThan(0);
    expect(mudRuins).toBeLessThan(1_000);

    // The timeline strip carries markers of several event families.
    const timeline = by.get("grow-causal-timeline")!;
    expect(timeline.pub.markers).toBeGreaterThan(20);
    const markerRow = new Set<string>();
    for (let x = 0; x < timeline.width; x++) {
      const i = ((timeline.height - 15) * timeline.width + x) * 4;
      markerRow.add(`${timeline.rgba[i]},${timeline.rgba[i + 1]},${timeline.rgba[i + 2]}`);
    }
    expect(markerRow.size).toBeGreaterThanOrEqual(6);

    // A touch on the snow village's plaza lists what happened there.
    const here = by.get("grow-causal-here")!;
    expect(here.pub.here?.lines).toHaveLength(3);
    expect(here.pub.here!.lines[0]).toContain("ABANDONED");
    expect(here.pub.here!.lines.some((l) => l.includes("FAMINE"))).toBe(true);
  }, 60_000);
});
