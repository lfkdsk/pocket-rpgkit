// tools/lib/anim-sheet.ts — cook AnimationDef sheets into per-frame static
// PNGs, the same deterministic pipeline as walker sheets (bake.ts). The
// runtime selects frames[animFrameIndex(...)] from the saved reference tick,
// so playback is identical under rewind and after a save/load; no host
// auto-play atlas is involved (the core's sprite clock is not save state).

import { decodePng } from "../../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../../vendor/pocketjs/tests/png.ts";
import type { AnimationDef } from "../../src/engine/types.ts";
import type { SheetImage } from "./bake.ts";

export interface AnimationFrames {
  /** Per-frame PNG bytes in play order. */
  frames: Buffer[];
  /** Frame width in px. */
  w: number;
  /** Frame height in px. */
  h: number;
}

/** The authored fields sliceAnimationSheet needs. */
export type AnimationSheetDef = Pick<
  AnimationDef,
  "id" | "frameW" | "frameH" | "cols" | "frames" | "count"
>;

/** Slice a decoded sheet into one PNG per authored frame, in play order.
 *  Frame indices address the sheet row-major in a `cols`-wide grid (cols
 *  defaults to sheet width / frameW). Pure: the same sheet yields the same
 *  bytes on every run. */
export function sliceAnimationSheet(
  png: SheetImage,
  def: AnimationSheetDef,
  source = `animation ${def.id}`,
): AnimationFrames {
  const w = def.frameW ?? 16;
  const h = def.frameH ?? 16;
  if (!Number.isInteger(w) || w < 1 || !Number.isInteger(h) || h < 1) {
    throw new Error(`${source}: frame sizes must be positive integers`);
  }
  const cols = def.cols ?? Math.floor(png.width / w);
  if (!Number.isInteger(cols) || cols < 1) {
    throw new Error(`${source}: cols must be a positive integer`);
  }
  if (cols * w > png.width) {
    throw new Error(`${source}: ${cols} cols of ${w} px exceed the ${png.width} px sheet width`);
  }
  if (png.height % h !== 0) {
    throw new Error(`${source}: sheet height ${png.height} is not a whole number of ${h} px frames`);
  }
  const order = def.frames
    ?? (def.count !== undefined ? Array.from({ length: def.count }, (_, i) => i) : null);
  if (order === null || order.length === 0) {
    throw new Error(`${source}: frames or count must name at least one frame`);
  }
  const rows = png.height / h;
  for (const index of order) {
    if (!Number.isInteger(index) || index < 0 || index >= cols * rows) {
      throw new Error(`${source}: frame index ${index} outside the ${cols}x${rows} sheet`);
    }
  }
  const frames = order.map((index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      const src = ((row * h + y) * png.width + col * w) * 4;
      out.set(png.rgba.subarray(src, src + w * 4), y * w * 4);
    }
    return encodePNG(out, w, h);
  });
  return { frames, w, h };
}

/** Decode and slice one animation sheet. A missing file is a build error. */
export async function loadAnimationSheet(path: string, def: AnimationSheetDef): Promise<AnimationFrames> {
  const png = decodePng(new Uint8Array(await Bun.file(path).arrayBuffer()));
  return sliceAnimationSheet(png, def, path);
}
