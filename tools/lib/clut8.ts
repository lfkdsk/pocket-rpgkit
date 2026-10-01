// tools/lib/clut8.ts — deterministic build-time encoding for one RGBA image
// as one lazily loaded PocketJS TILESET tile. The encoded texture is CLUT8;
// its index stream uses the runtime's PackBits convention.

import { encodeTilesetEntry } from "../../vendor/pocketjs/framework/compiler/pak.ts";
import {
  TILESET_FLAG_RLE,
  keyTileset,
} from "../../vendor/pocketjs/contracts/spec/spec.ts";

export interface Clut8SourceImage {
  width: number;
  height: number;
  /** Straight-alpha RGBA, four bytes per pixel in row-major order. */
  rgba: Uint8Array;
}

export interface Clut8TileDescriptor {
  kind: "tile";
  /** Complete runtime reference: `ui:tile.<name>#0`. */
  ref: string;
  /** Unscaled dimensions of the source texture. */
  sourceWidth: number;
  sourceHeight: number;
}

export interface Clut8EncodeReport {
  /** Distinct canonical source colours. All alpha-zero RGB values count once. */
  colours: number;
  /** Palette entries used by the encoded image. */
  paletteColours: number;
  /** Whether transparent index zero was reserved. */
  transparent: boolean;
  quantized: boolean;
  /** Distinct source colours mapped to a retained palette colour. */
  quantizedColours: number;
  /** Source pixels whose canonical colour changed during quantization. */
  remappedPixels: number;
  /** Sum of squared RGBA channel error over all source pixels. */
  totalSquaredError: number;
  /** Largest squared RGBA channel error of any source pixel. */
  maxSquaredError: number;
  /** `totalSquaredError / (width * height)`. */
  meanSquaredError: number;
}

export interface EncodedClut8Tile {
  /** Complete pak key: `ui:tile.<name>`. */
  key: string;
  /** Complete one-tile TILESET entry, ready for an app's pak.json file. */
  blob: Uint8Array;
  descriptor: Clut8TileDescriptor;
  report: Clut8EncodeReport;
}

interface Palette {
  words: Uint32Array;
  indexByWord: Map<number, number>;
  retainedWords: Set<number>;
  paletteColours: number;
  transparent: boolean;
}

/** RGBA bytes as the u32 ABGR word stored little-endian in a PocketJS CLUT. */
function abgr(r: number, g: number, b: number, a: number): number {
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/** Transparent texels have one identity, independent of their unused RGB. */
function canonicalWord(rgba: Uint8Array, offset: number): number {
  return rgba[offset + 3] === 0
    ? 0
    : abgr(rgba[offset]!, rgba[offset + 1]!, rgba[offset + 2]!, rgba[offset + 3]!);
}

function squaredRgbaDistance(a: number, b: number): number {
  const dr = (a & 0xff) - (b & 0xff);
  const dg = ((a >>> 8) & 0xff) - ((b >>> 8) & 0xff);
  const db = ((a >>> 16) & 0xff) - ((b >>> 16) & 0xff);
  const da = (a >>> 24) - (b >>> 24);
  return dr * dr + dg * dg + db * db + da * da;
}

function makePalette(census: ReadonlyMap<number, number>): Palette {
  const transparent = census.has(0);
  const capacity = transparent ? 255 : 256;
  const ranked = [...census]
    .filter(([word]) => !transparent || word !== 0)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const retained = ranked.slice(0, capacity);
  const words = new Uint32Array(256);
  const indexByWord = new Map<number, number>();
  const retainedWords = new Set<number>();
  let cursor = 0;

  if (transparent) {
    // Uint32Array is already zero-filled; reserve zero even for an image whose
    // first transparent texel carried non-zero RGB bytes.
    indexByWord.set(0, 0);
    retainedWords.add(0);
    cursor = 1;
  }
  for (const [word] of retained) {
    words[cursor] = word;
    indexByWord.set(word, cursor);
    retainedWords.add(word);
    cursor++;
  }

  // Resolve every discarded colour once. Strictly-smaller wins, so an exact
  // distance tie keeps the earlier retained entry: frequency first, then ABGR.
  for (const [word] of ranked.slice(capacity)) {
    let bestIndex = transparent ? 1 : 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = transparent ? 1 : 0; index < cursor; index++) {
      const distance = squaredRgbaDistance(word, words[index]!);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    indexByWord.set(word, bestIndex);
  }

  return {
    words,
    indexByWord,
    retainedWords,
    paletteColours: cursor,
    transparent,
  };
}

function validateImage(name: string, image: Clut8SourceImage): void {
  if (!name || name.includes("#")) {
    throw new Error(`clut8: invalid tile name ${JSON.stringify(name)}`);
  }
  const validDimension = (value: number): boolean =>
    Number.isInteger(value) && value >= 1 && value <= 512 && (value & (value - 1)) === 0;
  if (!validDimension(image.width) || !validDimension(image.height)) {
    throw new Error(`clut8: dimensions must be powers of two in 1..512, got ${image.width}x${image.height}`);
  }
  const expected = image.width * image.height * 4;
  if (image.rgba.length !== expected) {
    throw new Error(`clut8: got ${image.rgba.length} RGBA bytes, want ${expected}`);
  }
}

/**
 * Encode one RGBA image as a one-tile CLUT8 + PackBits TILESET entry.
 *
 * Up to 256 canonical colours round-trip exactly. Transparency, when present,
 * owns palette index zero and leaves room for 255 non-transparent colours.
 * Wider images retain colours by descending frequency and then ascending ABGR;
 * discarded colours map to the nearest retained colour in RGBA space.
 */
export function encodeClut8Tile(name: string, image: Clut8SourceImage): EncodedClut8Tile {
  validateImage(name, image);
  const pixels = image.width * image.height;
  const census = new Map<number, number>();
  const sourceWords = new Uint32Array(pixels);
  for (let pixel = 0; pixel < pixels; pixel++) {
    const word = canonicalWord(image.rgba, pixel * 4);
    sourceWords[pixel] = word;
    census.set(word, (census.get(word) ?? 0) + 1);
  }

  const palette = makePalette(census);
  const indices = new Uint8Array(pixels);
  let remappedPixels = 0;
  let totalSquaredError = 0;
  let maxSquaredError = 0;
  for (let pixel = 0; pixel < pixels; pixel++) {
    const source = sourceWords[pixel]!;
    const index = palette.indexByWord.get(source)!;
    const target = palette.words[index]!;
    indices[pixel] = index;
    if (source !== target) {
      remappedPixels++;
      const error = squaredRgbaDistance(source, target);
      totalSquaredError += error;
      if (error > maxSquaredError) maxSquaredError = error;
    }
  }

  const key = keyTileset(name);
  const quantizedColours = census.size - palette.paletteColours;
  return {
    key,
    blob: encodeTilesetEntry({
      tileW: image.width,
      tileH: image.height,
      cols: 1,
      rows: 1,
      flags: TILESET_FLAG_RLE,
      palette: palette.words,
      // A uniform image intentionally remains a pixel stream. The runtime
      // returns -1 for TILESET solid directory entries, which is unsuitable
      // for an image node that expects a texture handle.
      tiles: [{ kind: "pixels", indices }],
    }),
    descriptor: {
      kind: "tile",
      ref: `${key}#0`,
      sourceWidth: image.width,
      sourceHeight: image.height,
    },
    report: {
      colours: census.size,
      paletteColours: palette.paletteColours,
      transparent: palette.transparent,
      quantized: quantizedColours > 0,
      quantizedColours,
      remappedPixels,
      totalSquaredError,
      maxSquaredError,
      meanSquaredError: totalSquaredError / pixels,
    },
  };
}
