// tools/preview/atlas-merge.ts — add glyphs to a baked font atlas.
//
// A FONT ATLAS blob (vendor/pocketjs/contracts/spec/spec.ts) is one slot's
// header, cmap and coverage cells. The build bakes it from Inter plus the
// app's fallback faces (framework/compiler/bake-font.ts). `supplementAtlas`
// bakes extra codepoints with the build's own `bakeSlot`, on the base
// atlas's baseline and line metrics (glyph-bake.ts is a pinned port), and merges them in: gids are renumbered
// in codepoint order, as a build bakes them, and every cell is widened to
// the wider of the two cell widths. The result is the atlas the build would
// have made had the extra characters been in the app's text (a test pins
// this byte for byte), so the core lays out and draws them exactly like
// baked text.
//
// Pure: no host, no pak. tools/preview/cjk-glyphs.ts installs the result.

import type { Font } from "./opentype.ts";
import { bakeSlot } from "./glyph-bake.ts";
import { FONT_CMAP_ENTRY_SIZE, FONT_HEADER_SIZE } from "../../vendor/pocketjs/contracts/spec/spec.ts";

const TOFU_CODEPOINT = 0xfffd;

export interface AtlasEntry {
  cp: number;
  gid: number;
  advance: number;
  xoff: number;
}

export interface ParsedAtlas {
  bytes: Uint8Array;
  glyphCount: number;
  cellW: number;
  cellH: number;
  baseline: number;
  lineHeight: number;
  slot: number;
  bold: boolean;
  density: number;
  entries: AtlasEntry[];
}

export function parseAtlas(bytes: Uint8Array): ParsedAtlas {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const glyphCount = dv.getUint16(6, true);
  const entries: AtlasEntry[] = [];
  for (let i = 0; i < glyphCount; i++) {
    const o = FONT_HEADER_SIZE + i * FONT_CMAP_ENTRY_SIZE;
    entries.push({ cp: dv.getUint32(o, true), gid: dv.getUint16(o + 4, true), advance: bytes[o + 6]!, xoff: bytes[o + 7]! });
  }
  return {
    bytes,
    glyphCount,
    cellW: bytes[8]!,
    cellH: bytes[9]!,
    baseline: bytes[10]!,
    lineHeight: bytes[11]!,
    slot: bytes[12]!,
    bold: (bytes[13]! & 1) !== 0,
    density: bytes[14]!,
    entries,
  };
}

/** Codepoints an atlas maps (U+FFFD, the tofu, excluded). */
export function atlasCodepoints(atlas: ParsedAtlas): Set<number> {
  const out = new Set<number>();
  for (const e of atlas.entries) if (e.cp !== TOFU_CODEPOINT) out.add(e.cp);
  return out;
}

/** A face that maps nothing but carries the base atlas's vertical metrics,
 *  so `bakeSlot` puts every fallback glyph on the base baseline and computes
 *  the same cell height and line height. */
function metricsFace(atlas: ParsedAtlas, px: number): Font {
  return {
    unitsPerEm: px,
    ascender: atlas.baseline,
    descender: -(atlas.cellH - atlas.baseline),
    tables: { hhea: { lineGap: atlas.lineHeight - atlas.cellH } },
    charToGlyphIndex: () => 0,
  } as unknown as Font;
}

function coverageCell(atlas: ParsedAtlas, gid: number): Uint8Array {
  const cell = atlas.cellW * atlas.cellH * atlas.density * atlas.density;
  const start = FONT_HEADER_SIZE + atlas.glyphCount * FONT_CMAP_ENTRY_SIZE + gid * cell;
  return atlas.bytes.subarray(start, start + cell);
}

/** `base` plus the glyphs `faces` give for `codepoints` that `base` lacks.
 *  Codepoints no face maps are left out (they keep drawing the tofu) and
 *  returned in `missing`. With nothing to add, `bytes` is `base` itself. */
export function supplementAtlas(
  base: Uint8Array,
  px: number,
  codepoints: Iterable<number>,
  faces: readonly Font[],
): { bytes: Uint8Array; added: number[]; missing: number[] } {
  const atlas = parseAtlas(base);
  const have = atlasCodepoints(atlas);
  const wanted = [...new Set(codepoints)].filter((cp) => cp >= 32 && cp !== 127 && cp !== TOFU_CODEPOINT && !have.has(cp));
  wanted.sort((a, b) => a - b);
  if (wanted.length === 0) return { bytes: base, added: [], missing: [] };
  const baked = bakeSlot(metricsFace(atlas, px), atlas.slot, px, atlas.bold, wanted, atlas.density, faces);
  const extra = parseAtlas(baked.bytes);
  const added = [...atlasCodepoints(extra)].sort((a, b) => a - b);
  const addedSet = new Set(added);
  const missing = wanted.filter((cp) => !addedSet.has(cp));
  if (added.length === 0) return { bytes: base, added, missing };

  // Union, renumbered in codepoint order: gid 0 stays the tofu.
  type Source = { from: ParsedAtlas; entry: AtlasEntry };
  const glyphs: Source[] = [];
  for (const entry of atlas.entries) if (entry.cp !== TOFU_CODEPOINT) glyphs.push({ from: atlas, entry });
  for (const entry of extra.entries) if (entry.cp !== TOFU_CODEPOINT) glyphs.push({ from: extra, entry });
  glyphs.sort((a, b) => a.entry.cp - b.entry.cp);
  const tofu = atlas.entries.find((e) => e.cp === TOFU_CODEPOINT)!;

  const cellW = Math.max(atlas.cellW, extra.cellW);
  const d = atlas.density;
  const coverageW = cellW * d;
  const coverageH = atlas.cellH * d;
  const cellBytes = coverageW * coverageH;
  const glyphCount = glyphs.length + 1;
  if (glyphCount > 0xffff) throw new Error("atlas-merge: too many glyphs");
  const out = new Uint8Array(FONT_HEADER_SIZE + glyphCount * FONT_CMAP_ENTRY_SIZE + glyphCount * cellBytes);
  out.set(base.subarray(0, FONT_HEADER_SIZE));
  const dv = new DataView(out.buffer);
  dv.setUint16(6, glyphCount, true);
  out[8] = cellW;

  const entries = glyphs.map((g, i) => ({ cp: g.entry.cp, gid: i + 1, advance: g.entry.advance, xoff: g.entry.xoff }));
  entries.push({ cp: TOFU_CODEPOINT, gid: 0, advance: tofu.advance, xoff: tofu.xoff });
  entries.sort((a, b) => a.cp - b.cp);
  let o = FONT_HEADER_SIZE;
  for (const e of entries) {
    dv.setUint32(o, e.cp, true);
    dv.setUint16(o + 4, e.gid, true);
    out[o + 6] = e.advance;
    out[o + 7] = e.xoff;
    o += FONT_CMAP_ENTRY_SIZE;
  }

  const coverage = FONT_HEADER_SIZE + glyphCount * FONT_CMAP_ENTRY_SIZE;
  const copyCell = (from: ParsedAtlas, gid: number, to: number) => {
    const src = coverageCell(from, gid);
    const srcW = from.cellW * d;
    for (let row = 0; row < coverageH; row++) {
      out.set(src.subarray(row * srcW, (row + 1) * srcW), coverage + to * cellBytes + row * coverageW);
    }
  };
  copyCell(atlas, 0, 0);
  glyphs.forEach((g, i) => copyCell(g.from, g.entry.gid, i + 1));
  return { bytes: out, added, missing };
}
