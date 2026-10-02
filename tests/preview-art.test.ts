// tests/preview-art.test.ts — the preview page's runtime art: what a load
// with `art` makes of the staged images (tools/preview/art.ts), and how the
// play-test assets (editor/engine/playtest-view.ts) route supplied sheets
// and sprites. Texture operations are a recording fake; the wasm sim run
// of the real page is tests/preview-art-sim.test.ts.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { sliceWalkerSheet } from "../tools/lib/bake.ts";
import { sliceWalkerFrames, TUXEMON_WALKER_LAYOUT } from "../tools/lib/walker-slice.ts";
import { buildPreviewArt, PREVIEW_SHEET_KEY, type PreviewTextureOps } from "../tools/preview/art.ts";
import type { PreviewArtImage } from "../tools/preview/protocol.ts";
import { createPlaytestAssets } from "../editor/engine/playtest-view.ts";
import { PLAYTEST_NPC_SRC, PLAYTEST_SHEET_REFS } from "../editor/engine/playtest-assets.ts";
import type { CharacterFrames } from "../src/ui/game-assets.ts";
import type { Project } from "../src/engine/types.ts";

const ROOT = join(import.meta.dir, "..");
const SUNSTONE = readFileSync(join(ROOT, "examples", "sunstone", "data", "sunstone.json"), "utf8");

function project(): Project {
  const doc = JSON.parse(SUNSTONE) as Project;
  doc.sprites = { ...doc.sprites, hero: { kind: "walker", sheet: "hero-sheet" }, squat: { kind: "walker", sheet: "squat-sheet", h: 16 } };
  return doc;
}

interface Upload {
  handle: number;
  width: number;
  height: number;
  rgba: Uint8Array;
}

function fakeOps() {
  const uploads: Upload[] = [];
  const freed: number[] = [];
  const registered = new Map<string, number>();
  const ops: PreviewTextureOps = {
    upload(rgba, width, height) {
      const pow2 = (n: number) => n > 0 && n <= 512 && (n & (n - 1)) === 0;
      if (!pow2(width) || !pow2(height) || rgba.length < width * height * 4) return -1;
      const handle = 100 + uploads.length;
      uploads.push({ handle, width, height, rgba: rgba.slice() });
      return handle;
    },
    free: (handle) => freed.push(handle),
    register: (key, handle) => registered.set(key, handle),
  };
  return { ops, uploads, freed, registered };
}

/** An image whose pixel (x, y) is [x, y, seed, 255]. */
function image(kind: "sheet" | "sprite", id: string, width: number, height: number, seed = 7): PreviewArtImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) rgba.set([x & 255, y & 255, seed, 255], (y * width + x) * 4);
  }
  return { kind, id, width, height, rgba };
}

const noFallback = (key: string, index: number): number => {
  throw new Error(`unexpected fallback load ${key}#${index}`);
};

describe("preview art: tile sheets", () => {
  test("a supplied sheet streams its own 16px cells; other sheets keep the stand-ins", () => {
    const { ops, uploads } = fakeOps();
    const doc = project();
    const fallbacks: string[] = [];
    const built = buildPreviewArt(doc, [image("sheet", "town", 64, 32)], ops, (key, index) => {
      fallbacks.push(`${key}#${index}`);
      return 7;
    });
    expect(built.use).toEqual({ used: 1, skipped: [] });
    expect(built.art.sheets).toEqual({ town: { key: `${PREVIEW_SHEET_KEY}0`, cells: 8 } });
    const assets = createPlaytestAssets(doc, built.art);
    const village = doc.maps.find((map) => map.id === "village")!;
    const ground = assets.stream!.ground.village!;
    village.ground.forEach((tile, i) => {
      const cell = Number(String(tile).split(".")[1]);
      expect(ground[i]).toBe(cell < 8 ? `${PREVIEW_SHEET_KEY}0#${cell}` : null);
    });
    // The cave uses "dun", which was not supplied: still the stand-in refs.
    const cave = doc.maps.find((map) => map.id === "cave")!;
    const dun = cave.ground.findIndex((tile) => typeof tile === "string" && tile.startsWith("dun."));
    expect(dun).toBeGreaterThanOrEqual(0);
    expect(assets.stream!.ground.cave![dun]).toBe(PLAYTEST_SHEET_REFS.dun![Number(String(cave.ground[dun]).split(".")[1])]!);
    // Cell 5 (column 1, row 1) uploads as its own 16x16 texture.
    const loadTile = assets.stream!.loadTile!;
    expect(loadTile(`${PREVIEW_SHEET_KEY}0`, 5)).toBe(100);
    expect(uploads[0]).toMatchObject({ width: 16, height: 16 });
    const px = (x: number, y: number) => [...uploads[0]!.rgba.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)];
    expect(px(0, 0)).toEqual([16, 16, 7, 255]);
    expect(px(15, 15)).toEqual([31, 31, 7, 255]);
    // Out-of-range cells draw nothing; every other key goes to the default loader.
    expect(loadTile(`${PREVIEW_SHEET_KEY}0`, 8)).toBe(-1);
    expect(loadTile("ui:tile.editor-sheet-dun", 3)).toBe(7);
    expect(fallbacks).toEqual(["ui:tile.editor-sheet-dun#3"]);
    expect(built.handles).toEqual([]);
  });

  test("a sheet that is not a whole number of cells keeps its stand-in", () => {
    const { ops } = fakeOps();
    const built = buildPreviewArt(project(), [image("sheet", "town", 40, 32)], ops, noFallback);
    expect(built.use).toEqual({ used: 0, skipped: [{ kind: "sheet", id: "town", reason: "40x32 is not a whole number of 16px cells" }] });
    expect(built.art).toEqual({});
    const assets = createPlaytestAssets(project(), built.art);
    expect(assets.stream!.loadTile).toBeUndefined();
    expect(assets).toEqual(createPlaytestAssets(project()));
  });

  test("without art the assets are exactly the stand-in assets", () => {
    const doc = project();
    const plain = createPlaytestAssets(doc);
    expect(createPlaytestAssets(doc, {})).toEqual(plain);
    expect(plain.npcSrc).toBe(PLAYTEST_NPC_SRC);
    expect("loadTile" in plain.stream!).toBe(false);
  });
});

describe("preview art: sprites", () => {
  test("an image sprite uploads as one texture under a runtime key", () => {
    const { ops, uploads, registered } = fakeOps();
    const doc = project();
    const built = buildPreviewArt(doc, [image("sprite", "wiz", 16, 16)], ops, noFallback);
    expect(built.use.used).toBe(1);
    const key = built.art.sprites!.wiz as string;
    expect(registered.get(key)).toBe(100);
    expect(uploads[0]).toMatchObject({ width: 16, height: 16 });
    expect(built.handles).toEqual([100]);
    const assets = createPlaytestAssets(doc, built.art);
    expect(assets.npcSrc.wiz).toBe(key);
    expect(assets.npcSrc.boy).toBe(PLAYTEST_NPC_SRC.boy!);
  });

  test("a non-power-of-two image sprite is resampled to the next power of two", () => {
    const { ops, uploads } = fakeOps();
    const built = buildPreviewArt(project(), [image("sprite", "wiz", 12, 20)], ops, noFallback);
    expect(built.use.used).toBe(1);
    expect(uploads[0]).toMatchObject({ width: 16, height: 32 });
    // Nearest neighbour: destination (15, 31) samples source (11, 19).
    const at = (15 * 1 + 31 * 16) * 4;
    expect([...uploads[0]!.rgba.subarray(at, at + 4)]).toEqual([11, 19, 7, 255]);
  });

  test("a walker sheet registers the same twelve frames the baker cuts", () => {
    const { ops, uploads, registered } = fakeOps();
    const sheet = image("sprite", "hero", 48, 128, 9);
    const built = buildPreviewArt(project(), [sheet], ops, noFallback);
    expect(built.use).toEqual({ used: 1, skipped: [] });
    const frames = built.art.sprites!.hero as CharacterFrames;
    expect(frames.h).toBe(32);
    const baked = sliceWalkerSheet(sheet);
    const pixelsOf = (key: string) => uploads.find((upload) => upload.handle === registered.get(key))!;
    for (const pose of ["idle", "walkL", "walkR"] as const) {
      for (let facing = 0; facing < 4; facing++) {
        const upload = pixelsOf(frames[pose][facing]!);
        expect({ w: upload.width, h: upload.height }).toEqual({ w: 16, h: 32 });
        expect(upload.rgba).toEqual(decodePng(baked[pose][facing]!).rgba);
      }
    }
    expect(built.handles).toHaveLength(12);
  });

  test("a 16px walker uses its declared height", () => {
    const { ops, uploads } = fakeOps();
    const built = buildPreviewArt(project(), [image("sprite", "squat", 48, 64)], ops, noFallback);
    expect((built.art.sprites!.squat as CharacterFrames).h).toBe(16);
    expect(uploads.every((upload) => upload.width === 16 && upload.height === 16)).toBe(true);
  });

  test("sprites the game cannot use keep their stand-ins, with a reason", () => {
    const { ops } = fakeOps();
    const doc = project();
    doc.sprites!.legacy = { kind: "walker", atlases: { down: "a", left: "b", right: "c", up: "d" }, frames: 4, step: 8 };
    const built = buildPreviewArt(doc, [
      image("sprite", "nobody", 16, 16),
      image("sprite", "wiz", 1024, 16),
      image("sprite", "hero", 48, 96),
      image("sprite", "legacy", 64, 16),
    ], ops, noFallback);
    expect(built.use.used).toBe(0);
    expect(built.use.skipped).toEqual([
      { kind: "sprite", id: "nobody", reason: "the document declares no such sprite" },
      { kind: "sprite", id: "wiz", reason: "1024x16 is over the 512px texture limit" },
      { kind: "sprite", id: "hero", reason: "sprite hero: expected a 3x4 sheet of 16x32 cells, got 48x96" },
      { kind: "sprite", id: "legacy", reason: "atlas walkers (one image per facing) are not supported" },
    ]);
    expect(built.art).toEqual({});
    expect(built.handles).toEqual([]);
  });
});

describe("walker slicing is shared by the baker and the preview page", () => {
  test("bake's PNG frames decode to exactly the shared raw frames", () => {
    const source = image("sprite", "hero", 48, 128, 3);
    const raw = sliceWalkerFrames(source);
    const baked = sliceWalkerSheet(source);
    for (const pose of ["idle", "walkL", "walkR"] as const) {
      expect(baked[pose].map((png) => [...decodePng(png).rgba])).toEqual(raw[pose].map((frame) => [...frame]));
    }
    expect(sliceWalkerFrames(source, { layout: TUXEMON_WALKER_LAYOUT }).idle).toEqual(raw.idle);
  });
});
