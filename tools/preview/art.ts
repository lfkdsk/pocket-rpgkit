// tools/preview/art.ts — turning the images a frontend staged with `art`
// into the play-test's runtime art (editor/engine/playtest-view.ts
// PlaytestArt): tile sheets cut into 16px cells that stream through the
// GameView tile path, image sprites and the twelve frames of walker
// sprites registered as textures.
//
// No DOM and no engine globals: the page passes its texture operations in,
// so tests run the same code against a recording fake. Art only changes
// what is drawn; nothing here reaches the session.

import type { Project, SpriteDef } from "../../src/engine/types.ts";
import type { CharacterFrames, NpcArt } from "../../src/ui/game-assets.ts";
import type { PlaytestArt } from "../../editor/engine/playtest-view.ts";
import { sliceWalkerFrames } from "../lib/walker-slice.ts";
import type { PreviewArtImage, PreviewArtSkip, PreviewArtUse } from "./protocol.ts";

/** Tile cell edge in pixels. */
export const PREVIEW_ART_TILE = 16;
/** The largest texture side the engine uploads (spec TEX_MAX_DIM). */
export const PREVIEW_TEXTURE_MAX = 512;

/** Runtime tile keys start with this prefix; the default PocketJS loader
 *  never sees one. */
export const PREVIEW_SHEET_KEY = "rt:sheet.";
/** Runtime sprite texture keys start with this prefix. */
export const PREVIEW_SPRITE_KEY = "rt:sprite.";

/** The texture operations the art needs: PocketJS getOps().uploadTexture
 *  (RGBA8, power-of-two sides) / freeTexture and registerTexture. */
export interface PreviewTextureOps {
  /** Upload RGBA8 pixels; returns a handle, or a negative number. */
  upload(rgba: Uint8Array, width: number, height: number): number;
  free(handle: number): void;
  /** Bind an image key (an <Image> src) to a handle. */
  register(key: string, handle: number): void;
}

export interface PreviewArtBuild {
  /** Hand to createPlaytestAssets. */
  art: PlaytestArt;
  /** What the load reports back. */
  use: PreviewArtUse;
  /** Sprite textures registered for this load; free them on the next load
   *  or stop. Tile textures belong to the layers that load them. */
  handles: number[];
}

function isPow2(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** Nearest-neighbour resample to `w` x `h`. The engine stretches a texture
 *  over its image node, so a non-power-of-two sprite is resampled to the
 *  next power of two rather than padded (padding would shrink it). */
function resample(image: { width: number; height: number; rgba: Uint8Array }, w: number, h: number): Uint8Array {
  if (w === image.width && h === image.height) return image.rgba;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.floor((y * image.height) / h);
    for (let x = 0; x < w; x++) {
      const sx = Math.floor((x * image.width) / w);
      const s = (sy * image.width + sx) * 4;
      out.set(image.rgba.subarray(s, s + 4), (y * w + x) * 4);
    }
  }
  return out;
}

interface RuntimeSheet {
  rgba: Uint8Array;
  width: number;
  cols: number;
  cells: number;
}

/** Cut one 16px cell out of a sheet and upload it as its own texture. */
function uploadCell(ops: PreviewTextureOps, sheet: RuntimeSheet, index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= sheet.cells) return -1;
  const tile = PREVIEW_ART_TILE;
  const cx = index % sheet.cols;
  const cy = Math.floor(index / sheet.cols);
  const out = new Uint8Array(tile * tile * 4);
  for (let y = 0; y < tile; y++) {
    const src = ((cy * tile + y) * sheet.width + cx * tile) * 4;
    out.set(sheet.rgba.subarray(src, src + tile * 4), y * tile * 4);
  }
  const handle = ops.upload(out, tile, tile);
  return handle >= 0 ? handle : -1;
}

/** Build the runtime art for one load. Images the game cannot use (a sheet
 *  that is not a whole number of 16px cells, a sprite the document does not
 *  declare, a sprite over 512 px, a walker sheet that does not match its
 *  declared grid) are skipped with a reason and keep their stand-in.
 *  `fallbackLoad` is the default tile loader for every other key. */
export function buildPreviewArt(
  project: Project,
  images: readonly PreviewArtImage[],
  ops: PreviewTextureOps,
  fallbackLoad: (key: string, index: number) => number,
): PreviewArtBuild {
  const skipped: PreviewArtSkip[] = [];
  const handles: number[] = [];
  const sheets: Record<string, { key: string; cells: number }> = {};
  const runtime = new Map<string, RuntimeSheet>();
  const sprites: Record<string, NpcArt> = {};
  const defs: Readonly<Record<string, SpriteDef>> = project.sprites ?? {};
  let used = 0;
  let next = 0;

  const register = (key: string, rgba: Uint8Array, width: number, height: number): boolean => {
    const handle = ops.upload(rgba, width, height);
    if (handle < 0) return false;
    handles.push(handle);
    ops.register(key, handle);
    return true;
  };
  const skip = (image: PreviewArtImage, reason: string): void => {
    skipped.push({ kind: image.kind, id: image.id, reason });
  };

  for (const image of images) {
    const tile = PREVIEW_ART_TILE;
    if (image.kind === "sheet") {
      if (image.width % tile !== 0 || image.height % tile !== 0) {
        skip(image, `${image.width}x${image.height} is not a whole number of ${tile}px cells`);
        continue;
      }
      const cols = image.width / tile;
      const cells = cols * (image.height / tile);
      const key = `${PREVIEW_SHEET_KEY}${next++}`;
      runtime.set(key, { rgba: image.rgba, width: image.width, cols, cells });
      sheets[image.id] = { key, cells };
      used++;
      continue;
    }

    const def = Object.prototype.hasOwnProperty.call(defs, image.id) ? defs[image.id] : undefined;
    if (!def) {
      skip(image, "the document declares no such sprite");
      continue;
    }
    if (def.kind === "image") {
      if (image.width > PREVIEW_TEXTURE_MAX || image.height > PREVIEW_TEXTURE_MAX) {
        skip(image, `${image.width}x${image.height} is over the ${PREVIEW_TEXTURE_MAX}px texture limit`);
        continue;
      }
      const w = isPow2(image.width) ? image.width : nextPow2(image.width);
      const h = isPow2(image.height) ? image.height : nextPow2(image.height);
      const key = `${PREVIEW_SPRITE_KEY}${next++}`;
      if (!register(key, resample(image, w, h), w, h)) {
        skip(image, "the engine refused the texture");
        continue;
      }
      sprites[image.id] = key;
      used++;
      continue;
    }
    if (!("sheet" in def)) {
      skip(image, "atlas walkers (one image per facing) are not supported");
      continue;
    }
    const cellH = def.h ?? 32;
    let frames;
    try {
      frames = sliceWalkerFrames(image, { cols: def.cols, rows: def.rows, cellW: tile, cellH }, `sprite ${image.id}`);
    } catch (error) {
      skip(image, error instanceof Error ? error.message : String(error));
      continue;
    }
    const base = `${PREVIEW_SPRITE_KEY}${next++}`;
    const keys = (pose: string, list: Uint8Array[]): string[] =>
      list.map((_, facing) => `${base}.${pose}${facing}`);
    const idle = keys("idle", frames.idle);
    const walkL = keys("walkL", frames.walkL);
    const walkR = keys("walkR", frames.walkR);
    const all: [string, Uint8Array][] = [
      ...idle.map((key, i): [string, Uint8Array] => [key, frames.idle[i]!]),
      ...walkL.map((key, i): [string, Uint8Array] => [key, frames.walkL[i]!]),
      ...walkR.map((key, i): [string, Uint8Array] => [key, frames.walkR[i]!]),
    ];
    let ok = true;
    for (const [key, rgba] of all) {
      if (!register(key, rgba, frames.cellW, frames.cellH)) {
        ok = false;
        break;
      }
    }
    if (!ok) {
      skip(image, "the engine refused the texture");
      continue;
    }
    const four = (list: string[]) => list as unknown as readonly [string, string, string, string];
    const walker: CharacterFrames = { idle: four(idle), walkL: four(walkL), walkR: four(walkR), h: cellH };
    sprites[image.id] = walker;
    used++;
  }

  const art: PlaytestArt = {};
  if (runtime.size > 0) {
    art.sheets = sheets;
    art.loadTile = (key, index) => {
      const sheet = key.startsWith(PREVIEW_SHEET_KEY) ? runtime.get(key) : undefined;
      return sheet ? uploadCell(ops, sheet, index) : fallbackLoad(key, index);
    };
  }
  if (Object.keys(sprites).length > 0) art.sprites = sprites;
  return { art, use: { used, skipped }, handles };
}
