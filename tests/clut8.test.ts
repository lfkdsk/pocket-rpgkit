import { describe, expect, test } from "bun:test";
import { encodeClut8Tile, type EncodedClut8Tile } from "../tools/lib/clut8.ts";
import {
  TILESET_ABSENT,
  TILESET_DIR_ENTRY_SIZE,
  TILESET_FLAG_RLE,
  TILESET_HEADER_SIZE,
  TILESET_MAGIC,
  TILESET_VERSION,
  packbitsDecode,
} from "../vendor/pocketjs/contracts/spec/spec.ts";

type Rgba = readonly [number, number, number, number];

function image(width: number, height: number, pixel: (index: number) => Rgba): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index++) out.set(pixel(index), index * 4);
  return out;
}

function decode(encoded: EncodedClut8Tile): {
  rgba: Uint8Array;
  indices: Uint8Array;
  palette: Uint32Array;
  dirOffset: number;
  streamOffset: number;
  streamLength: number;
} {
  const bytes = encoded.blob;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = dv.getUint16(8, true);
  const height = dv.getUint16(10, true);
  const paletteOffset = dv.getUint32(16, true);
  const dirOffset = dv.getUint32(20, true);
  const dataOffset = dv.getUint32(24, true);
  const streamOffset = dv.getUint32(dirOffset, true);
  const streamLength = dv.getUint32(dirOffset + 4, true);
  const indices = packbitsDecode(
    bytes.subarray(dataOffset + streamOffset, dataOffset + streamOffset + streamLength),
    width * height,
  );
  expect(indices).not.toBeNull();
  const palette = new Uint32Array(256);
  for (let index = 0; index < palette.length; index++) {
    palette[index] = dv.getUint32(paletteOffset + index * 4, true);
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < indices!.length; pixel++) {
    const word = palette[indices![pixel]!]!;
    rgba[pixel * 4] = word & 0xff;
    rgba[pixel * 4 + 1] = (word >>> 8) & 0xff;
    rgba[pixel * 4 + 2] = (word >>> 16) & 0xff;
    rgba[pixel * 4 + 3] = word >>> 24;
  }
  return { rgba, indices: indices!, palette, dirOffset, streamOffset, streamLength };
}

function canonicalizeTransparent(rgba: Uint8Array): Uint8Array {
  const out = rgba.slice();
  for (let offset = 0; offset < out.length; offset += 4) {
    if (out[offset + 3] === 0) out.fill(0, offset, offset + 4);
  }
  return out;
}

function colour(n: number, alpha = 255): Rgba {
  return [n & 0xff, (n >>> 8) & 0xff, (n * 37) & 0xff, alpha];
}

describe("single-tile CLUT8 encoder", () => {
  test("writes a 1x1 RLE TILESET header and reconstructs every exact pixel", () => {
    const rgba = image(4, 4, (index) => [index * 11, 240 - index * 7, index * 13, 255]);
    const encoded = encodeClut8Tile("battle/hero", { width: 4, height: 4, rgba });
    const dv = new DataView(encoded.blob.buffer, encoded.blob.byteOffset, encoded.blob.byteLength);

    expect(encoded.key).toBe("ui:tile.battle/hero");
    expect(encoded.descriptor).toEqual({
      kind: "tile",
      ref: "ui:tile.battle/hero#0",
      sourceWidth: 4,
      sourceHeight: 4,
    });
    expect(dv.getUint32(0, true)).toBe(TILESET_MAGIC);
    expect(dv.getUint16(4, true)).toBe(TILESET_VERSION);
    expect(dv.getUint16(6, true)).toBe(TILESET_FLAG_RLE);
    expect(dv.getUint16(8, true)).toBe(4);
    expect(dv.getUint16(10, true)).toBe(4);
    expect(dv.getUint16(12, true)).toBe(1);
    expect(dv.getUint16(14, true)).toBe(1);
    expect(dv.getUint32(16, true)).toBe(TILESET_HEADER_SIZE);
    expect(dv.getUint32(20, true)).toBe(TILESET_HEADER_SIZE + 1024);
    expect(dv.getUint32(24, true)).toBe(TILESET_HEADER_SIZE + 1024 + TILESET_DIR_ENTRY_SIZE);

    const decoded = decode(encoded);
    expect(decoded.streamOffset).not.toBe(TILESET_ABSENT);
    expect(decoded.streamLength).toBeGreaterThan(0);
    expect(decoded.rgba).toEqual(rgba);
    expect(encoded.report).toEqual({
      colours: 16,
      paletteColours: 16,
      transparent: false,
      quantized: false,
      quantizedColours: 0,
      remappedPixels: 0,
      totalSquaredError: 0,
      maxSquaredError: 0,
      meanSquaredError: 0,
    });
  });

  test("canonicalizes transparent RGB, reserves index zero, and keeps a uniform image as pixels", () => {
    const transparent = image(2, 2, (index) => index < 3
      ? [20 + index, 80 + index, 140 + index, 0]
      : [9, 8, 7, 128]);
    const encoded = encodeClut8Tile("transparent", { width: 2, height: 2, rgba: transparent });
    const decoded = decode(encoded);
    expect(decoded.indices.slice(0, 3)).toEqual(new Uint8Array([0, 0, 0]));
    expect(decoded.palette[0]).toBe(0);
    expect(decoded.rgba).toEqual(canonicalizeTransparent(transparent));
    expect(encoded.report).toMatchObject({
      colours: 2,
      paletteColours: 2,
      transparent: true,
      quantized: false,
      remappedPixels: 0,
    });

    const solidRgba = image(8, 8, () => [18, 52, 86, 255]);
    const solid = encodeClut8Tile("solid", { width: 8, height: 8, rgba: solidRgba });
    const solidDecoded = decode(solid);
    expect(solidDecoded.streamOffset).not.toBe(TILESET_ABSENT);
    expect(solidDecoded.streamLength).toBeGreaterThan(0);
    expect(solidDecoded.rgba).toEqual(solidRgba);
  });

  test("uses all 256 slots without transparency and 255 plus transparent when needed", () => {
    const opaque = image(16, 16, (index) => colour(index));
    const opaqueEncoded = encodeClut8Tile("opaque-256", { width: 16, height: 16, rgba: opaque });
    expect(decode(opaqueEncoded).rgba).toEqual(opaque);
    expect(opaqueEncoded.report).toMatchObject({
      colours: 256,
      paletteColours: 256,
      transparent: false,
      quantized: false,
    });

    const withTransparent = image(16, 16, (index) => index === 0
      ? [222, 111, 77, 0]
      : colour(index - 1));
    const transparentEncoded = encodeClut8Tile("transparent-256", {
      width: 16,
      height: 16,
      rgba: withTransparent,
    });
    expect(decode(transparentEncoded).rgba).toEqual(canonicalizeTransparent(withTransparent));
    expect(transparentEncoded.report).toMatchObject({
      colours: 256,
      paletteColours: 256,
      transparent: true,
      quantized: false,
    });
  });

  test("quantizes deterministically by frequency then ABGR and reports RGBA error", () => {
    // 300 distinct colours appear once, then colour 299 fills the remaining
    // pixels. It must survive the 256-colour cut regardless of its ABGR rank.
    const rgba = image(32, 16, (index) => colour(index < 300 ? index : 299));
    const a = encodeClut8Tile("wide", { width: 32, height: 16, rgba });
    const b = encodeClut8Tile("wide", { width: 32, height: 16, rgba: rgba.slice() });
    const decoded = decode(a);
    const frequent = colour(299);
    const frequentWord = ((frequent[3] << 24) | (frequent[2] << 16) | (frequent[1] << 8) | frequent[0]) >>> 0;

    expect(a.blob).toEqual(b.blob);
    expect(a.descriptor).toEqual(b.descriptor);
    expect(a.report).toEqual(b.report);
    expect([...decoded.palette]).toContain(frequentWord);
    expect(decoded.rgba).not.toEqual(rgba);
    expect(a.report).toMatchObject({
      colours: 300,
      paletteColours: 256,
      transparent: false,
      quantized: true,
      quantizedColours: 44,
    });
    expect(a.report.remappedPixels).toBeGreaterThan(0);
    expect(a.report.totalSquaredError).toBeGreaterThan(0);
    expect(a.report.maxSquaredError).toBeGreaterThan(0);
    expect(a.report.meanSquaredError).toBe(a.report.totalSquaredError / (32 * 16));
  });

  test("rejects invalid names, dimensions, and RGBA lengths", () => {
    expect(() => encodeClut8Tile("", { width: 1, height: 1, rgba: new Uint8Array(4) }))
      .toThrow(/invalid tile name/);
    expect(() => encodeClut8Tile("bad#tile", { width: 1, height: 1, rgba: new Uint8Array(4) }))
      .toThrow(/invalid tile name/);
    expect(() => encodeClut8Tile("zero", { width: 0, height: 1, rgba: new Uint8Array() }))
      .toThrow(/powers of two/);
    expect(() => encodeClut8Tile("non-pow2", { width: 3, height: 4, rgba: new Uint8Array(48) }))
      .toThrow(/powers of two/);
    expect(() => encodeClut8Tile("too-large", { width: 1024, height: 1, rgba: new Uint8Array(4096) }))
      .toThrow(/powers of two/);
    expect(() => encodeClut8Tile("short", { width: 2, height: 2, rgba: new Uint8Array(15) }))
      .toThrow(/got 15 RGBA bytes, want 16/);
  });
});
