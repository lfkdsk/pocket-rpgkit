// Build-time composition for the feature gallery's Tuxemon town and rooms.
// The source sheets below are vendored, attributed inputs.  We keep the
// authored maps small and deterministic, then crop and arrange their pixel
// art into the streamed ground/upper layers used by the real renderer.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodePng } from "../../vendor/pocketjs/framework/compiler/pak.ts";
import type { MapDef } from "../../src/engine/types.ts";

const TILE = 16;
const SOURCE = join(import.meta.dir, "assets", "tuxemon", "mods", "tuxemon");

interface Bitmap {
  width: number;
  height: number;
  rgba: Uint8Array;
}

function load(relative: string): Bitmap {
  return decodePng(new Uint8Array(readFileSync(join(SOURCE, relative))));
}

const CITY = load("gfx/tilesets/core_city_and_country.png");
const BUCH = load("gfx/tilesets/Basic_Buch_Tiles_Compiled.png");
const INTERIOR = load("gfx/tilesets/Interior_Tiles_by_ArMM1998.png");
const NOTE = load("gfx/bubbles/note.png");

function crop(source: Bitmap, x: number, y: number, width: number, height: number): Bitmap {
  if (x < 0 || y < 0 || x + width > source.width || y + height > source.height) {
    throw new Error(`showcase art: crop ${x},${y} ${width}x${height} outside ${source.width}x${source.height}`);
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const from = ((y + row) * source.width + x) * 4;
    rgba.set(source.rgba.subarray(from, from + width * 4), row * width * 4);
  }
  return { width, height, rgba };
}

function cell(source: Bitmap, x: number, y: number): Bitmap {
  return crop(source, x * TILE, y * TILE, TILE, TILE);
}

function composite(target: Bitmap, source: Bitmap, x: number, y: number, opacity = 1): void {
  for (let sy = 0; sy < source.height; sy++) {
    const ty = y + sy;
    if (ty < 0 || ty >= target.height) continue;
    for (let sx = 0; sx < source.width; sx++) {
      const tx = x + sx;
      if (tx < 0 || tx >= target.width) continue;
      const from = (sy * source.width + sx) * 4;
      const alpha = source.rgba[from + 3]! / 255 * opacity;
      if (alpha <= 0) continue;
      const to = (ty * target.width + tx) * 4;
      const inverse = 1 - alpha;
      target.rgba[to] = Math.round(source.rgba[from]! * alpha + target.rgba[to]! * inverse);
      target.rgba[to + 1] = Math.round(source.rgba[from + 1]! * alpha + target.rgba[to + 1]! * inverse);
      target.rgba[to + 2] = Math.round(source.rgba[from + 2]! * alpha + target.rgba[to + 2]! * inverse);
      target.rgba[to + 3] = Math.round(255 * alpha + target.rgba[to + 3]! * inverse);
    }
  }
}

function fill(target: Bitmap, tile: Bitmap): void {
  for (let y = 0; y < target.height; y += tile.height) {
    for (let x = 0; x < target.width; x += tile.width) composite(target, tile, x, y);
  }
}

function fillCells(target: Bitmap, tile: Bitmap, x: number, y: number, width: number, height: number): void {
  for (let ty = y; ty < y + height; ty++) {
    for (let tx = x; tx < x + width; tx++) composite(target, tile, tx * TILE, ty * TILE);
  }
}

function grade(target: Bitmap, tint: readonly [number, number, number]): void {
  for (let i = 0; i < target.rgba.length; i += 4) {
    target.rgba[i] = Math.round(target.rgba[i]! * tint[0] / 255);
    target.rgba[i + 1] = Math.round(target.rgba[i + 1]! * tint[1] / 255);
    target.rgba[i + 2] = Math.round(target.rgba[i + 2]! * tint[2] / 255);
  }
}

function pixel(target: Bitmap, x: number, y: number, colour: readonly [number, number, number, number]): void {
  if (x < 0 || y < 0 || x >= target.width || y >= target.height) return;
  target.rgba.set(colour, (y * target.width + x) * 4);
}

function ring(target: Bitmap, cx: number, cy: number, radius: number): void {
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      const distance = Math.hypot(x - cx, y - cy);
      if (distance > radius || distance < radius - 3) continue;
      pixel(target, x, y, distance > radius - 1.5 ? [70, 48, 54, 255] : [238, 190, 96, 255]);
    }
  }
}

const DIGITS = [
  "111101101101111", "010110010010111", "110001111100111", "110001111001110",
  "101101111001001", "111100110001110", "011100111101111", "111001010010010",
  "111101111101111", "111101111001110",
] as const;

/** Small numbered town marker shared by the baked lobby and actor manifest. */
export function showcasePortalBadge(number?: number): Uint8Array {
  const out: Bitmap = { width: TILE, height: TILE, rgba: new Uint8Array(TILE * TILE * 4) };
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const distance = Math.hypot(x - 7.5, y - 7.5);
      if (distance <= 7) pixel(out, x, y, distance > 5.6 ? [96, 62, 34, 255] : [255, 220, 82, 255]);
    }
  }
  if (number === undefined) return out.rgba;
  const label = String(number);
  const width = label.length * 4 - 1;
  const left = Math.floor((TILE - width) / 2);
  for (let digit = 0; digit < label.length; digit++) {
    const glyph = DIGITS[Number(label[digit])]!;
    for (let gy = 0; gy < 5; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        if (glyph[gy * 3 + gx] === "1") pixel(out, left + digit * 4 + gx, 5 + gy, [55, 31, 52, 255]);
      }
    }
  }
  return out.rgba;
}

const GRASS = cell(CITY, 0, 0);
const WATER = cell(CITY, 3, 3);
const STONE = cell(INTERIOR, 6, 7);
const WOOD = cell(INTERIOR, 1, 4);
const CARPET = cell(INTERIOR, 1, 8);
const FLOWERS = crop(BUCH, 128, 80, 32, 32);
const TREE = crop(CITY, 80, 256, 32, 32);
const HOUSE = crop(CITY, 112, 0, 64, 80);
const FOUNTAIN = crop(CITY, 352, 160, 64, 64);
const SHELVES = crop(INTERIOR, 48, 192, 48, 32);
const COUNTER = crop(INTERIOR, 160, 112, 48, 48);
const FIREPLACE = crop(INTERIOR, 160, 192, 48, 32);
const TABLE = crop(INTERIOR, 160, 160, 48, 32);
const BED = crop(INTERIOR, 256, 16, 64, 48);

const OUTDOOR = new Set([
  "showcase-lobby",
  "showcase-screen-effects",
  "showcase-map-animations",
  "showcase-movement-controls",
  "showcase-shop",
  "hall-streaming",
  "hall-attract",
]);

function baseLayers(map: MapDef): { ground: Bitmap; upper: Bitmap } {
  const width = map.width * TILE;
  const height = map.height * TILE;
  const ground = { width, height, rgba: new Uint8Array(width * height * 4) };
  const upper = { width, height, rgba: new Uint8Array(width * height * 4) };
  if (OUTDOOR.has(map.id)) {
    fill(ground, GRASS);
    fillCells(ground, STONE, 1, 7, 18, 2);
    fillCells(ground, STONE, 9, 1, 3, 13);
  } else {
    fill(ground, WOOD);
    fillCells(ground, CARPET, 3, 3, 14, 9);
    fillCells(ground, STONE, 1, 11, 4, 3);
  }
  return { ground, upper };
}

function outdoorBorder(upper: Bitmap, dense = false): void {
  for (let x = 0; x < 20; x += dense ? 2 : 4) {
    if (x === 8 || x === 10 || x === 12) continue;
    composite(upper, TREE, x * TILE, -4);
  }
  composite(upper, TREE, 0, 12 * TILE);
  composite(upper, TREE, 18 * TILE, 12 * TILE);
  composite(upper, FLOWERS, 4 * TILE, 12 * TILE);
  composite(upper, FLOWERS, 14 * TILE, 12 * TILE);
}

function indoorBorder(upper: Bitmap): void {
  for (let x = 0; x < 20; x += 3) composite(upper, SHELVES, x * TILE, -4);
  composite(upper, SHELVES, 16, 12 * TILE);
  composite(upper, SHELVES, 15 * TILE, 12 * TILE);
}

function lobby(map: MapDef, ground: Bitmap, upper: Bitmap): void {
  fillCells(ground, STONE, 3, 3, 14, 8);
  fillCells(ground, GRASS, 4, 4, 12, 6);
  fillCells(ground, STONE, 8, 4, 5, 6);
  composite(upper, HOUSE, 16, -12);
  composite(upper, HOUSE, 240, -12);
  composite(upper, FOUNTAIN, 128, 48);
  composite(upper, TREE, 0, 80);
  composite(upper, TREE, 288, 80);
  composite(upper, FLOWERS, 48, 144);
  composite(upper, FLOWERS, 240, 144);
  for (const event of map.events ?? []) {
    const match = /^(\d+)\./.exec(event.name ?? "");
    if (!event.id.startsWith("door-") || !match) continue;
    composite(upper, { width: TILE, height: TILE, rgba: showcasePortalBadge(Number(match[1])) }, event.x * TILE, event.y * TILE);
  }
}

function sceneDecor(map: MapDef, ground: Bitmap, upper: Bitmap): void {
  switch (map.id) {
    case "showcase-lobby":
      lobby(map, ground, upper);
      break;
    case "showcase-screen-effects":
      outdoorBorder(upper);
      composite(upper, FOUNTAIN, 224, 40);
      composite(upper, HOUSE, 16, -16);
      composite(upper, TREE, 256, 144);
      grade(ground, [104, 128, 170]);
      grade(upper, [116, 136, 184]);
      break;
    case "showcase-map-animations":
      outdoorBorder(upper);
      fillCells(ground, WATER, 7, 2, 7, 4);
      composite(upper, FOUNTAIN, 128, 32);
      composite(upper, FLOWERS, 224, 144);
      break;
    case "showcase-runtime-visuals":
      indoorBorder(upper);
      composite(upper, BED, 224, 16);
      composite(upper, COUNTER, 224, 128);
      composite(upper, TABLE, 80, 48);
      break;
    case "showcase-movement-controls":
      outdoorBorder(upper);
      fillCells(ground, STONE, 3, 3, 14, 2);
      fillCells(ground, STONE, 3, 9, 14, 2);
      composite(upper, TREE, 80, 96);
      composite(upper, TREE, 224, 96);
      composite(upper, FLOWERS, 112, 176);
      break;
    case "showcase-extensions":
      indoorBorder(upper);
      grade(ground, [154, 120, 190]);
      composite(upper, FIREPLACE, 224, 24);
      composite(upper, TABLE, 64, 48);
      composite(upper, BED, 208, 160);
      break;
    case "showcase-battle":
      fillCells(ground, STONE, 2, 2, 16, 11);
      ring(ground, 168, 120, 58);
      ring(ground, 168, 120, 43);
      composite(upper, FIREPLACE, 32, 16);
      composite(upper, FIREPLACE, 240, 16);
      break;
    case "showcase-shop":
      outdoorBorder(upper);
      composite(upper, HOUSE, 224, -8);
      composite(upper, COUNTER, 208, 128);
      composite(upper, TABLE, 64, 48);
      composite(upper, FLOWERS, 64, 160);
      break;
    case "hall-streaming":
      outdoorBorder(upper, true);
      fillCells(ground, WATER, 3, 2, 4, 3);
      fillCells(ground, WATER, 13, 9, 4, 3);
      composite(upper, TREE, 64, 80);
      composite(upper, TREE, 240, 48);
      composite(upper, TREE, 240, 160);
      break;
    case "hall-theme":
      indoorBorder(upper);
      composite(upper, SHELVES, 32, 32);
      composite(upper, SHELVES, 224, 32);
      composite(upper, TABLE, 128, 48);
      composite(upper, FIREPLACE, 224, 160);
      break;
    case "showcase-input-and-idle":
      indoorBorder(upper);
      composite(upper, TABLE, 128, 32);
      composite(upper, BED, 224, 144);
      composite(upper, FIREPLACE, 32, 32);
      break;
    case "hall-save":
      indoorBorder(upper);
      composite(upper, COUNTER, 208, 32);
      composite(upper, SHELVES, 32, 48);
      composite(upper, TABLE, 112, 160);
      break;
    case "hall-attract":
      outdoorBorder(upper);
      composite(upper, HOUSE, 224, -12);
      composite(upper, FOUNTAIN, 112, 32);
      composite(upper, FLOWERS, 224, 160);
      break;
    case "hall-audio":
      indoorBorder(upper);
      grade(ground, [150, 118, 176]);
      composite(upper, FIREPLACE, 136, 24);
      composite(upper, TABLE, 48, 48);
      composite(upper, TABLE, 224, 48);
      composite(upper, BED, 208, 160);
      composite(upper, NOTE, 80, 80);
      composite(upper, NOTE, 240, 80);
      composite(upper, NOTE, 152, 40);
      break;
  }
}

export function showcaseMapArt(map: MapDef): { ground: Uint8Array; upper: Uint8Array } {
  const layers = baseLayers(map);
  sceneDecor(map, layers.ground, layers.upper);
  return { ground: layers.ground.rgba, upper: layers.upper.rgba };
}
