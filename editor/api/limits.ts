// editor/api/limits.ts — resource limits for documents and art the editor
// accepts from outside: imported project JSON, sharded packs, their shards and
// local PNGs. Everything that reads such input (EditSession, the pack reader,
// Studio's hosts) checks it against these numbers before doing expensive work,
// so a huge or hostile file fails with a clear message instead of freezing or
// exhausting the page.
//
// The limits leave ample room for real projects: the largest one known is an
// inline JSON of about 17 MB with 263 maps, at most 502 events on a map and
// maps no larger than 100×100 cells.
//
// Map cells are already bounded by the project schema (src/data/schema.json):
// a map's width and height are at most 256, so a map has at most 65,536
// cells. Schema validation enforces that wherever a document is opened.
//
// Sizes are UTF-8 bytes (what a file on disk weighs). This module is plain
// data and pure functions with no imports, so the browser bundle stays small.

const MiB = 1024 * 1024;

/** One inline project JSON file, and a sharded project's shell file. */
export const MAX_PROJECT_FILE_BYTES = 32 * MiB;
/** One whole sharded pack file. */
export const MAX_PACK_BYTES = 64 * MiB;
/** One shard's text. */
export const MAX_SHARD_BYTES = 8 * MiB;
/** Shards in one pack (equivalently, mapIndex entries in its shell). */
export const MAX_SHARDS = 1024;
/** Maps in one inline project. */
export const MAX_MAPS = 1024;
/** Events on one map (inline maps and shards alike). */
export const MAX_EVENTS_PER_MAP = 4096;
/** One local PNG file. */
export const MAX_PNG_BYTES = 16 * MiB;
/** A local PNG's width and height, in pixels. */
export const MAX_PNG_SIDE = 8192;
/** A local PNG's width × height. */
export const MAX_PNG_PIXELS = 16_777_216;
/** Bytes a PNG header needs for readPngSize: signature + IHDR width/height. */
export const PNG_HEADER_BYTES = 24;

/** UTF-8 byte length of `text`, counted without allocating. When `limit` is
 * given and the text has more UTF-16 units than that, the byte count is
 * certainly over the limit too (every unit is at least one byte), so the
 * unit count is returned at once as a lower bound. */
export function utf8Bytes(text: string, limit = Infinity): number {
  if (text.length > limit) return text.length;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else bytes += 3; // BMP, or a lone surrogate (encoded as U+FFFD)
  }
  return bytes;
}

/** "512 B", "1.5 KiB", "40.0 MiB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MiB) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / MiB).toFixed(1)} MiB`;
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

/** "32 MiB" for whole mebibytes, else formatBytes. */
export function formatLimit(bytes: number): string {
  return bytes % MiB === 0 ? `${bytes / MiB} MiB` : formatBytes(bytes);
}

/** "40.0 MiB"; exact bytes when rounding would hide the excess (a file one
 * byte over 32 MiB must not read as "32.0 MiB"). */
function sizeOver(bytes: number, limit: number): string {
  const rounded = formatBytes(bytes);
  return rounded === formatBytes(limit) ? `${count(bytes)} bytes` : rounded;
}

/** Why an inline project file (or a shell file) is too big, or null. */
export function projectFileProblem(bytes: number, name = "the project file"): string | null {
  return bytes > MAX_PROJECT_FILE_BYTES
    ? `${name} is ${sizeOver(bytes, MAX_PROJECT_FILE_BYTES)}; project files can be at most ${formatLimit(MAX_PROJECT_FILE_BYTES)}.`
    : null;
}

/** Why a sharded pack file is too big, or null. */
export function packFileProblem(bytes: number, name = "the pack"): string | null {
  return bytes > MAX_PACK_BYTES
    ? `${name} is ${sizeOver(bytes, MAX_PACK_BYTES)}; sharded packs can be at most ${formatLimit(MAX_PACK_BYTES)}.`
    : null;
}

/** Why a file picked to open is too big to even read, or null. The exact
 * project/pack distinction is made after reading, by EditSession. */
export function openFileProblem(bytes: number, name: string): string | null {
  return bytes > MAX_PACK_BYTES
    ? `${name} is ${sizeOver(bytes, MAX_PACK_BYTES)}; project files can be at most ${formatLimit(MAX_PROJECT_FILE_BYTES)} and sharded packs at most ${formatLimit(MAX_PACK_BYTES)}.`
    : null;
}

/** Why one shard's text is too big, or null. */
export function shardProblem(entry: string, bytes: number): string | null {
  return bytes > MAX_SHARD_BYTES
    ? `shard ${JSON.stringify(entry)} is ${sizeOver(bytes, MAX_SHARD_BYTES)}; one map shard can be at most ${formatLimit(MAX_SHARD_BYTES)}.`
    : null;
}

/** Why a pack has too many shards, or null. */
export function shardCountProblem(shards: number): string | null {
  return shards > MAX_SHARDS ? `the pack has ${count(shards)} map shards; a pack can have at most ${count(MAX_SHARDS)}.` : null;
}

/** Why an inline project has too many maps, or null. */
export function mapCountProblem(maps: number): string | null {
  return maps > MAX_MAPS ? `the project has ${count(maps)} maps; a project can have at most ${count(MAX_MAPS)}.` : null;
}

/** Why one map has too many events, or null. */
export function eventCountProblem(map: string, events: number): string | null {
  return events > MAX_EVENTS_PER_MAP
    ? `map ${JSON.stringify(map)} has ${count(events)} events; a map can have at most ${count(MAX_EVENTS_PER_MAP)}.`
    : null;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = [0x49, 0x48, 0x44, 0x52];

/** Width and height from a PNG's first 24 bytes (8-byte signature, then the
 * IHDR chunk's length, type, width and height), or null when `bytes` does not
 * start like a PNG. */
export function readPngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < PNG_HEADER_BYTES) return null;
  if (PNG_SIGNATURE.some((byte, i) => bytes[i] !== byte)) return null;
  if (IHDR.some((byte, i) => bytes[12 + i] !== byte)) return null;
  const word = (at: number) => ((bytes[at]! << 24) >>> 0) + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!;
  return { width: word(16), height: word(20) };
}

/** Why a local PNG cannot be used, or null. `bytes` is the file size;
 * `header` (its first 24 bytes), when given, is checked for the PNG
 * signature and the image's width, height and pixel count. */
export function pngProblem(name: string, bytes: number, header?: Uint8Array): string | null {
  if (bytes > MAX_PNG_BYTES) return `${name} is ${sizeOver(bytes, MAX_PNG_BYTES)}; local PNGs can be at most ${formatLimit(MAX_PNG_BYTES)}.`;
  if (header === undefined) return null;
  const size = readPngSize(header);
  if (!size || size.width === 0 || size.height === 0) return `${name} is not a PNG image.`;
  const { width, height } = size;
  if (width > MAX_PNG_SIDE || height > MAX_PNG_SIDE) {
    return `${name} is ${count(width)}×${count(height)} px; local PNGs can be at most ${count(MAX_PNG_SIDE)} px on a side.`;
  }
  if (width * height > MAX_PNG_PIXELS) {
    return `${name} is ${count(width)}×${count(height)} px (${count(width * height)} pixels); local PNGs can have at most ${count(MAX_PNG_PIXELS)} pixels.`;
  }
  return null;
}
