import { describe, expect, test } from "bun:test";
import type { Project } from "../src/engine/types.ts";
import { createPlaytestAssets } from "../editor/engine/playtest-view.ts";
import { previewArtMessages } from "../editor/studio/preview.ts";
import { projectArtRefs } from "../editor/studio/project-art.ts";
import {
  buildPreviewArt,
  PREVIEW_ANIMATION_KEY,
  PREVIEW_ITEM_KEY,
  PREVIEW_PARALLAX_KEY,
  type PreviewTextureOps,
} from "../tools/preview/art.ts";
import {
  parsePreviewArt,
  PreviewArtStage,
  PreviewError,
  type PreviewArtImage,
  type PreviewArtKind,
} from "../tools/preview/protocol.ts";

function project(): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Studio art",
    tileSize: 16,
    start: { map: "map", x: 0, y: 0, dir: "down" },
    sheets: [{ id: "iconset", cols: 2, rows: 1 }],
    items: [
      { id: "potion", name: "Potion", sprite: "iconset.1" },
      { id: "tonic", name: "Tonic", sprite: "iconset.1" },
    ],
    animations: [{ id: "spark", sheet: "animations/spark.png", frameW: 10, frameH: 16, cols: 2, frames: [1, 0], frameDuration: 0.1 }],
    maps: [{
      id: "map",
      name: "Map",
      width: 1,
      height: 1,
      ground: [null],
      parallax: { image: "mist", loopX: true, loopY: false, sx: 1, sy: 0, showInEditor: true },
    }],
  };
}

function image(kind: PreviewArtKind, id: string, width: number, height: number, offset?: { offsetX?: number; offsetY?: number }): PreviewArtImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) rgba.set([x, y, 19, 255], (y * width + x) * 4);
  }
  return { kind, id, width, height, rgba, ...offset };
}

function fakeOps() {
  const uploads: { handle: number; width: number; height: number; rgba: Uint8Array }[] = [];
  const registered = new Map<string, number>();
  const ops: PreviewTextureOps = {
    upload(rgba, width, height) {
      const handle = 100 + uploads.length;
      uploads.push({ handle, width, height, rgba: rgba.slice() });
      return handle;
    },
    free() {},
    register: (key, handle) => registered.set(key, handle),
  };
  return { ops, uploads, registered };
}

describe("Studio KRM3V project art", () => {
  test("discovers animation sheets and logical or explicit parallax paths", () => {
    expect(projectArtRefs({
      animations: project().animations,
      parallaxes: ["mist", "backgrounds/clouds.png"],
    })).toEqual([
      { kind: "animation", id: "spark", candidates: ["animations/spark.png"] },
      { kind: "parallax", id: "mist", candidates: ["art/parallaxes/mist.png", "parallaxes/mist.png"] },
      {
        kind: "parallax",
        id: "backgrounds/clouds.png",
        candidates: ["backgrounds/clouds.png"],
      },
    ]);
  });

  test("forwards and stages optional animation offsets without changing old art messages", () => {
    const animation = image("animation", "spark", 2, 1, { offsetX: -4, offsetY: 7 });
    const [message] = previewArtMessages(animation, 8);
    expect(message).toMatchObject({ kind: "animation", offsetX: -4, offsetY: 7 });
    const stage = new PreviewArtStage();
    stage.add(parsePreviewArt({ ...message! }));
    expect(stage.take()[0]).toMatchObject({ kind: "animation", id: "spark", offsetX: -4, offsetY: 7 });

    const sheet = previewArtMessages(image("sheet", "tiles", 1, 1), 4)[0]!;
    expect("offsetX" in sheet).toBe(false);
    expect(() => parsePreviewArt({ ...sheet, offsetX: 1 })).toThrow(PreviewError);
  });

  test("registers item cells, cooked animation frames and parallax art for GameView", () => {
    const { ops, uploads, registered } = fakeOps();
    const built = buildPreviewArt(project(), [
      image("sheet", "iconset", 32, 16),
      image("animation", "spark", 20, 16, { offsetX: -6, offsetY: -9 }),
      image("parallax", "mist", 20, 12),
    ], ops, () => -1);

    expect(built.use).toEqual({ used: 3, skipped: [] });
    expect(built.art.itemSrc?.["iconset.1"]).toStartWith(PREVIEW_ITEM_KEY);
    expect(built.art.animations?.spark).toMatchObject({
      frames: [expect.stringContaining(PREVIEW_ANIMATION_KEY), expect.stringContaining(PREVIEW_ANIMATION_KEY)],
      w: 10,
      h: 16,
      offsetX: -6,
      offsetY: -9,
    });
    expect(built.art.parallaxes?.mist).toMatchObject({ image: expect.stringContaining(PREVIEW_PARALLAX_KEY), w: 20, h: 12 });

    const iconKey = built.art.itemSrc!["iconset.1"]!;
    const iconUpload = uploads.find((upload) => upload.handle === registered.get(iconKey))!;
    expect(iconUpload).toMatchObject({ width: 16, height: 16 });
    expect([...iconUpload.rgba.subarray(0, 4)]).toEqual([16, 0, 19, 255]);

    const assets = createPlaytestAssets(project(), built.art);
    expect(assets.itemSrc).toBe(built.art.itemSrc);
    expect(assets.anims).toBe(built.art.animations);
    expect(assets.parallaxes).toBe(built.art.parallaxes);
    expect(built.handles).toHaveLength(4);
  });
});
