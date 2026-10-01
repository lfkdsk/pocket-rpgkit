// tests/ka1-assets.test.ts — KA1: the animation-sheet cooker and its
// GameAssets manifest emission.

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { sliceAnimationSheet, loadAnimationSheet } from "../tools/lib/anim-sheet.ts";
import { gameManifestSource } from "../tools/lib/chunks.ts";
import type { SheetImage } from "../tools/lib/bake.ts";
import { TILE } from "../src/engine/tiles.ts";

type Rgba = readonly [number, number, number, number];

/** A 4x1 sheet of 16x16 cells, one solid colour per cell. */
function sheet(colours: readonly Rgba[]): SheetImage {
  const w = colours.length * TILE;
  const h = TILE;
  const rgba = new Uint8Array(w * h * 4);
  colours.forEach((colour, index) => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < TILE; x++) rgba.set(colour, (y * w + index * TILE + x) * 4);
    }
  });
  return { width: w, height: h, rgba };
}

const RED: Rgba = [226, 62, 62, 255];
const GREEN: Rgba = [72, 200, 96, 255];
const BLUE: Rgba = [64, 120, 240, 255];
const WHITE: Rgba = [236, 236, 244, 255];

describe("sliceAnimationSheet", () => {
  test("slices authored frames in play order", () => {
    const cooked = sliceAnimationSheet(sheet([RED, GREEN, BLUE, WHITE]), {
      id: "pulse",
      count: 4,
    });
    expect(cooked.w).toBe(TILE);
    expect(cooked.h).toBe(TILE);
    expect(cooked.frames).toHaveLength(4);
    const pixels = cooked.frames.map((png) => {
      const decoded = decodePng(new Uint8Array(png));
      return [...decoded.rgba.subarray(0, 4)];
    });
    expect(pixels).toEqual([[...RED], [...GREEN], [...BLUE], [...WHITE]]);
  });

  test("a frames list reorders and repeats sheet cells", () => {
    const cooked = sliceAnimationSheet(sheet([RED, GREEN, BLUE]), {
      id: "pulse",
      frames: [2, 0, 2, 1],
    });
    const pixels = cooked.frames.map((png) => [...decodePng(new Uint8Array(png)).rgba.subarray(0, 4)]);
    expect(pixels).toEqual([[...BLUE], [...RED], [...BLUE], [...GREEN]]);
  });

  test("is byte-stable across runs", () => {
    const def = { id: "pulse", count: 4 } as const;
    const a = sliceAnimationSheet(sheet([RED, GREEN, BLUE, WHITE]), def);
    const b = sliceAnimationSheet(sheet([RED, GREEN, BLUE, WHITE]), def);
    expect(a.frames.map((f) => f.toString("hex"))).toEqual(b.frames.map((f) => f.toString("hex")));
  });

  test("rejects an out-of-range frame index and a missing frame list", () => {
    expect(() => sliceAnimationSheet(sheet([RED, GREEN]), { id: "p", frames: [5] })).toThrow(/outside/);
    expect(() => sliceAnimationSheet(sheet([RED]), { id: "p" })).toThrow(/frames or count/);
    expect(() => sliceAnimationSheet(sheet([RED]), { id: "p", count: 0 })).toThrow(/frames or count/);
  });

  test("rejects a declared grid wider than the sheet", () => {
    // A 16x16 image declaring two 16 px columns used to pass and silently
    // truncate the out-of-bounds frame.
    const one: SheetImage = { width: TILE, height: TILE, rgba: new Uint8Array(TILE * TILE * 4) };
    expect(() => sliceAnimationSheet(one, { id: "p", cols: 2, count: 2 })).toThrow(/exceed/);
  });

  test("rejects a sheet height that is not a whole number of frames", () => {
    // 20 px tall with 16 px frames: the last row is incomplete and used to
    // be padded by a silent subarray truncation.
    const partial: SheetImage = { width: TILE, height: 20, rgba: new Uint8Array(TILE * 20 * 4) };
    expect(() => sliceAnimationSheet(partial, { id: "p", count: 1 })).toThrow(/whole number/);
  });

  test("a missing sheet file is a build error", async () => {
    // A unique path under the system temp dir: no host-specific path in the
    // source, and a name no other process can have created.
    const missing = join(tmpdir(), `rpgkit-ka1-missing-${randomUUID()}.png`);
    await expect(loadAnimationSheet(missing, { id: "p", count: 1 }))
      .rejects.toThrow();
  });

  test("supports non-square frames with an explicit grid", () => {
    // One 16x32 frame in a 1x1 sheet of 16x32.
    const w = 16;
    const h = 32;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) rgba.set(GREEN, i * 4);
    const cooked = sliceAnimationSheet({ width: w, height: h, rgba }, {
      id: "tall",
      frameW: 16,
      frameH: 32,
      cols: 1,
      count: 1,
    });
    expect([cooked.w, cooked.h]).toEqual([16, 32]);
    expect(decodePng(new Uint8Array(cooked.frames[0]!)).rgba.length).toBe(16 * 32 * 4);
  });
});

describe("gameManifestSource anims", () => {
  const base = {
    generator: "test",
    typesImport: "../../../src/ui/game-assets.ts",
    maps: [{ id: "m", width: 8, height: 8, events: [] }],
    npcSrc: [] as readonly (readonly [string, string])[],
    player: {
      idle: ["a", "b", "c", "d"],
      walkL: ["a", "b", "c", "d"],
      walkR: ["a", "b", "c", "d"],
    },
  };

  test("emits ANIM_FRAMES and wires it into GAME_ASSETS only when anims are given", () => {
    const withAnims = gameManifestSource({
      ...base,
      anims: [["pulse", { frames: ["assets/anim-pulse-0.png", "assets/anim-pulse-1.png"], w: 16, h: 16 }]],
    });
    expect(withAnims).toContain("export const ANIM_FRAMES");
    expect(withAnims).toContain('"pulse": { frames: ["assets/anim-pulse-0.png","assets/anim-pulse-1.png"], w: 16, h: 16 }');
    expect(withAnims).toContain("  anims: ANIM_FRAMES,\n");

    const without = gameManifestSource(base);
    expect(without).not.toContain("ANIM_FRAMES");
    expect(without).not.toContain("anims:");
  });

  test("the manifest text is byte-stable for a fixed input", () => {
    const opts = {
      ...base,
      anims: [["pulse", { frames: ["assets/anim-pulse-0.png"], w: 16, h: 16 }]] as const,
    };
    expect(gameManifestSource(opts)).toBe(gameManifestSource(opts));
  });
});
