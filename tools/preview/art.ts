// tools/preview/art.ts — turning the images a frontend staged with `art`
// into the play-test's runtime art (editor/engine/playtest-view.ts
// PlaytestArt): tile sheets cut into 16px cells that stream through the
// GameView tile path, item cells, image/walker sprites, cooked animations
// and parallaxes registered as textures.
//
// No DOM and no engine globals: the page passes its texture operations in,
// so tests run the same code against a recording fake. Art only changes
// what is drawn; nothing here reaches the session.

import type { AnimationDef, Project, SpriteDef } from "../../src/engine/types.ts";
import type { CharacterFrames, CookedMapAnimation, NpcArt, ParallaxAsset } from "../../src/ui/game-assets.ts";
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
/** Runtime item, animation and parallax texture-key prefixes. */
export const PREVIEW_ITEM_KEY = "rt:item.";
export const PREVIEW_ANIMATION_KEY = "rt:animation.";
export const PREVIEW_PARALLAX_KEY = "rt:parallax.";

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
  /** Image textures registered for this load; free them on the next load
   *  or stop. Streamed map-tile textures belong to the layers that load
   *  them. */
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

/** Copy a rectangular RGBA frame out of an image. */
function cutFrame(image: PreviewArtImage, x: number, y: number, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const src = ((y + row) * image.width + x) * 4;
    out.set(image.rgba.subarray(src, src + width * 4), row * width * 4);
  }
  return out;
}

function animationFrames(image: PreviewArtImage, def: AnimationDef): { frames: Uint8Array[]; width: number; height: number } | string {
  const width = def.frameW ?? PREVIEW_ART_TILE;
  const height = def.frameH ?? PREVIEW_ART_TILE;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      image.height % height !== 0) {
    return `${image.width}x${image.height} does not match its declared ${width}x${height} frame grid`;
  }
  const actualCols = Math.floor(image.width / width);
  const rows = image.height / height;
  const cols = def.cols ?? actualCols;
  if (!Number.isInteger(cols) || cols < 1 || cols * width > image.width) return `declared ${cols} frame columns do not fit the image`;
  const indices = def.frames ?? (def.count === undefined ? null : Array.from({ length: def.count }, (_, index) => index));
  if (!indices || indices.length === 0 || indices.some((index) => !Number.isInteger(index) || index < 0 || index >= cols * rows)) {
    return `declared frame indices do not fit the ${cols}x${rows} frame grid`;
  }
  return {
    width,
    height,
    frames: indices.map((index) => cutFrame(image, (index % cols) * width, Math.floor(index / cols) * height, width, height)),
  };
}

/** Default and command-selected parallax ids. Commands are recursive, so
 * walk their JSON shape without coupling the small preview page to Studio's
 * inspector/command-tree modules. */
function projectParallaxIds(project: Project): Set<string> {
  const ids = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
    } else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (record.op === "changeParallax" && typeof record.image === "string" && record.image.length > 0) ids.add(record.image);
      for (const child of Object.values(record)) visit(child);
    }
  };
  for (const map of project.maps) {
    if (map.parallax?.image) ids.add(map.parallax.image);
    for (const event of map.events ?? []) for (const page of event.pages) visit(page.commands);
  }
  for (const common of project.commonEvents ?? []) visit(common.commands);
  return ids;
}

/** Build the runtime art for one load. Images the game cannot use (a sheet
 *  that is not a whole number of 16px cells, a sprite the document does not
 *  declare, a sprite over 512 px, a walker sheet that does not match its
 *  declared grid, an unknown animation/parallax, or an image whose cooked
 *  texture is too large) are skipped with a reason and keep their stand-in.
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
  const runtimeSheets = new Map<string, RuntimeSheet>();
  const sprites: Record<string, NpcArt> = {};
  const itemSrc: Record<string, string> = {};
  const animations: Record<string, CookedMapAnimation> = {};
  const parallaxes: Record<string, ParallaxAsset> = {};
  const defs: Readonly<Record<string, SpriteDef>> = project.sprites ?? {};
  const animationDefs = new Map((project.animations ?? []).map((def) => [def.id, def]));
  const parallaxIds = projectParallaxIds(project);
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
      const sheet = { rgba: image.rgba, width: image.width, cols, cells };
      runtime.set(key, sheet);
      runtimeSheets.set(image.id, sheet);
      sheets[image.id] = { key, cells };
      used++;
      continue;
    }

    if (image.kind === "animation") {
      const def = animationDefs.get(image.id);
      if (!def) {
        skip(image, "the document declares no such animation");
        continue;
      }
      const sliced = animationFrames(image, def);
      if (typeof sliced === "string") {
        skip(image, sliced);
        continue;
      }
      const textureW = nextPow2(sliced.width);
      const textureH = nextPow2(sliced.height);
      if (textureW > PREVIEW_TEXTURE_MAX || textureH > PREVIEW_TEXTURE_MAX) {
        skip(image, `${sliced.width}x${sliced.height} frames are over the ${PREVIEW_TEXTURE_MAX}px texture limit`);
        continue;
      }
      const keys: string[] = [];
      let ok = true;
      for (const rgba of sliced.frames) {
        const key = `${PREVIEW_ANIMATION_KEY}${next++}`;
        const pixels = resample({ width: sliced.width, height: sliced.height, rgba }, textureW, textureH);
        if (!register(key, pixels, textureW, textureH)) {
          ok = false;
          break;
        }
        keys.push(key);
      }
      if (!ok) {
        skip(image, "the engine refused an animation frame texture");
        continue;
      }
      animations[image.id] = {
        frames: keys,
        w: sliced.width,
        h: sliced.height,
        ...(image.offsetX === undefined ? {} : { offsetX: image.offsetX }),
        ...(image.offsetY === undefined ? {} : { offsetY: image.offsetY }),
      };
      used++;
      continue;
    }

    if (image.kind === "parallax") {
      if (!parallaxIds.has(image.id)) {
        skip(image, "the document references no such parallax");
        continue;
      }
      const width = nextPow2(image.width);
      const height = nextPow2(image.height);
      if (width > PREVIEW_TEXTURE_MAX || height > PREVIEW_TEXTURE_MAX) {
        skip(image, `${image.width}x${image.height} is over the ${PREVIEW_TEXTURE_MAX}px texture limit`);
        continue;
      }
      const key = `${PREVIEW_PARALLAX_KEY}${next++}`;
      if (!register(key, resample(image, width, height), width, height)) {
        skip(image, "the engine refused the texture");
        continue;
      }
      parallaxes[image.id] = { image: key, w: image.width, h: image.height };
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

  // Item sprites retain their authored tile ids. Register just the unique
  // referenced cells from supplied sheets as ordinary image textures; map
  // tiles continue to stream lazily through loadTile.
  for (const tileId of new Set(project.items.map((item) => item.sprite))) {
    const dot = tileId.lastIndexOf(".");
    if (dot < 1) continue;
    const sheet = runtimeSheets.get(tileId.slice(0, dot));
    const cell = Number(tileId.slice(dot + 1));
    if (!sheet || !Number.isInteger(cell)) continue;
    const handle = uploadCell(ops, sheet, cell);
    if (handle < 0) continue;
    const key = `${PREVIEW_ITEM_KEY}${next++}`;
    handles.push(handle);
    ops.register(key, handle);
    itemSrc[tileId] = key;
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
  if (Object.keys(itemSrc).length > 0) art.itemSrc = itemSrc;
  if (Object.keys(animations).length > 0) art.animations = animations;
  if (Object.keys(parallaxes).length > 0) art.parallaxes = parallaxes;
  return { art, use: { used, skipped }, handles };
}
