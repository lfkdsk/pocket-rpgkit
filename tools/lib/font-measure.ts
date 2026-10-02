// tools/lib/font-measure.ts — build-time text widths equal to the PocketJS
// atlas measurement.
//
// The core measures a run as the sum of the cmap advances of its code points
// (vendor/pocketjs/engine/core/src/text.rs `measure_run_provider`). The
// advances come from vendor/pocketjs/framework/compiler/bake-font.ts
// `bakeSlot`: the slot's Inter face first, then the first fallback face that
// maps the codepoint, advance = clamp(round(advanceWidth * px / unitsPerEm),
// 0, 255) through the SOURCE face's unitsPerEm. This module repeats that
// resolution per codepoint (cached), so layout decided at build time matches
// the device without baking an atlas.
//
// Special cases, each matching the core:
// - "\n" measures 0 (the core starts a new line instead of advancing).
// - U+FFFD is the tofu entry: advance max(4, round(px * 0.55)) + 2.
// - A codepoint the atlas does not hold (no face maps it, or it is a control
//   character bakeAtlases never bakes: below U+0020, or U+007F) misses the
//   cmap, and the core advances by the atlas cell width `cellW`. cellW is
//   the widest inked glyph of the WHOLE atlas, so it depends on the atlas
//   charset: it is computed the way bakeSlot computes it over ASCII
//   32..126 plus `charset`. Without `charset`, the charset is every
//   codepoint the fallback faces map — for an app's subset font (see
//   tools/lib/cjk-font.ts) that is the app's fallback charset, and Inter's
//   non-ASCII glyphs are narrower than the CJK cells that set the width.
//   Pass the build's charset to pin cellW exactly.
// - A lone UTF-16 surrogate measures as U+FFFD (what it becomes in UTF-8).
//
// Streamed font archives (font_stream) advance a miss by the archive's own
// advance instead; this module models baked atlases only.

import { join } from "node:path";
import { REPO_ROOT, parseFontFile } from "./cjk-font.ts";

const INTER_REGULAR = join(REPO_ROOT, "vendor/pocketjs/assets/fonts/Inter-Regular.ttf");
const INTER_BOLD = join(REPO_ROOT, "vendor/pocketjs/assets/fonts/Inter-Bold.ttf");
const TOFU_CODEPOINT = 0xfffd;
const CURVE_STEPS = 8; // bake-font.ts CURVE_STEPS (metric contours)

type Face = any;
const faces = new Map<string, Face>();
function face(path: string): Face {
  let f = faces.get(path);
  if (!f) faces.set(path, (f = parseFontFile(path)));
  return f;
}

/** bakeSlot's face resolution: the slot face, then the first fallback that maps cp. */
function resolveGlyph(primary: Face, fallbacks: Face[], cp: number): { source: Face; gid: number } | null {
  const ch = String.fromCodePoint(cp);
  let source = primary;
  let gid = primary.charToGlyphIndex(ch);
  for (let f = 0; gid <= 0 && f < fallbacks.length; f++) {
    const candidate = fallbacks[f]!.charToGlyphIndex(ch);
    if (candidate > 0) {
      source = fallbacks[f]!;
      gid = candidate;
    }
  }
  return gid > 0 ? { source, gid } : null;
}

/** bakeSlot's logical ink extent: ceil(maxX + xoff) of the flattened outline. */
function inkWidth(glyph: any, baseline: number, px: number): number {
  const path = glyph.getPath(0, baseline, px);
  let minX = 0;
  let maxX = 0;
  const see = (x: number) => {
    if (x > maxX) maxX = x;
    if (x < minX) minX = x;
  };
  let cx = 0;
  let sx = 0;
  for (const cmd of path.commands) {
    switch (cmd.type) {
      case "M":
        sx = cx = cmd.x;
        see(cx);
        break;
      case "L":
        cx = cmd.x;
        see(cx);
        break;
      case "Q":
        for (let i = 1; i <= CURVE_STEPS; i++) {
          const t = i / CURVE_STEPS;
          const u = 1 - t;
          see(u * u * cx + 2 * u * t * cmd.x1 + t * t * cmd.x);
        }
        cx = cmd.x;
        break;
      case "C":
        for (let i = 1; i <= CURVE_STEPS; i++) {
          const t = i / CURVE_STEPS;
          const u = 1 - t;
          see(u * u * u * cx + 3 * u * u * t * cmd.x1 + 3 * u * t * t * cmd.x2 + t * t * t * cmd.x);
        }
        cx = cmd.x;
        break;
      case "Z":
        cx = sx;
        see(sx);
        break;
    }
  }
  const xoff = Math.min(255, Math.ceil(Math.max(0, -minX)));
  return Math.ceil(maxX + xoff);
}

export interface FontMeasureOptions {
  /** Slot pixel size. */
  px: number;
  /** Inter Bold instead of Inter Regular. */
  bold?: boolean;
  /** Fallback face paths, in fonts.json order. */
  fallbacks?: string[];
  /** Codepoints of the atlas being modelled; only sets the advance of a
   *  codepoint the atlas lacks (the cell width). See the header. */
  charset?: Iterable<number>;
}

/** Width in logical px that the core measures for `text` on a baked atlas
 *  of Inter (regular or bold) at `px` with `fallbacks`. */
export function createFontMeasure(opts: FontMeasureOptions): (text: string) => number {
  const { px } = opts;
  const primary = face(opts.bold ? INTER_BOLD : INTER_REGULAR);
  const fallbacks = (opts.fallbacks ?? []).map(face);
  const scale = px / primary.unitsPerEm;
  const baseline = Math.round(primary.ascender * scale);
  const tofuAdvance = Math.min(255, Math.max(4, Math.round(px * 0.55)) + 2);
  const advances = new Map<number, number>();

  let cellW: number | null = null;
  const missAdvance = (): number => {
    if (cellW !== null) return cellW;
    const chars = new Set<number>();
    for (let cp = 32; cp <= 126; cp++) chars.add(cp);
    if (opts.charset) {
      for (const cp of opts.charset) if (cp >= 32 && cp !== 127) chars.add(cp);
    } else {
      for (const f of fallbacks) for (const key of Object.keys(f.tables.cmap.glyphIndexMap)) chars.add(Number(key));
    }
    let w = Math.max(4, Math.round(px * 0.55));
    for (const cp of chars) {
      if (cp === TOFU_CODEPOINT) continue;
      const hit = resolveGlyph(primary, fallbacks, cp);
      if (hit) w = Math.max(w, inkWidth(hit.source.glyphs.get(hit.gid), baseline, px));
    }
    cellW = Math.min(255, Math.max(1, w));
    return cellW;
  };

  const advance = (cp: number): number => {
    const cached = advances.get(cp);
    if (cached !== undefined) return cached;
    let value: number;
    if (cp === 10) value = 0;
    else if (cp === TOFU_CODEPOINT || (cp >= 0xd800 && cp <= 0xdfff)) value = tofuAdvance;
    else if (cp < 32 || cp === 127) value = missAdvance();
    else {
      const hit = resolveGlyph(primary, fallbacks, cp);
      if (!hit) value = missAdvance();
      else {
        const glyph = hit.source.glyphs.get(hit.gid);
        const sourceScale = hit.source === primary ? scale : px / hit.source.unitsPerEm;
        value = Math.max(0, Math.min(255, Math.round((glyph.advanceWidth ?? 0) * sourceScale)));
      }
    }
    advances.set(cp, value);
    return value;
  };

  return (text: string): number => {
    let width = 0;
    for (const ch of text) width += advance(ch.codePointAt(0)!);
    return width;
  };
}
