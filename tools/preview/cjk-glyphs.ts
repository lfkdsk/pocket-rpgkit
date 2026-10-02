// tools/preview/cjk-glyphs.ts — draw a loaded document's Chinese text.
//
// The preview app is built once for every project, so its baked atlases
// hold only the app's own characters (ASCII and its literals). Its pak also
// carries two budgeted faces (tools/preview/gen-cjk-font.ts): an Inter
// subset for Latin beyond ASCII and a Noto Sans CJK SC subset (GB2312 level
// 1 plus punctuation). On `load`, `supplementGlyphs` bakes the characters
// the document uses and the atlases lack, with the build's own baker
// (tools/preview/atlas-merge.ts), and swaps the merged atlases into the core
// before the GameView mounts, so layout, pagination and drawing see them
// like baked text.
//
// Determinism: the installed atlases depend only on the app's baked atlases
// and the document's characters, never on what was loaded before (each load
// starts from the original atlases), so one document always draws the same
// picture. A Latin-only document after a Chinese one restores the original
// atlases; a Latin-only preview session never parses the fonts.

import { getOps } from "@pocketjs/framework/host";
import { entries as pakEntries, get as pakGet, hasPack } from "@pocketjs/framework/pak";
import { resetSlotMeasures } from "../../src/ui/text-measure.ts";
import { atlasCodepoints, parseAtlas, supplementAtlas } from "./atlas-merge.ts";
import { parseFont, type Font } from "./opentype.ts";

/** Pak keys of the budgeted faces, in the order glyphs are looked up. */
export const PREVIEW_FACE_KEYS = ["font:preview-latin", "font:preview-cjk"] as const;
const FONT_PREFIX = "ui:font.";

export interface GlyphSupplement {
  /** Distinct characters baked into the atlases for this document. */
  added: number;
  /** Characters the document uses that no atlas or budgeted face has (they
   *  draw as the missing-glyph box), in codepoint order. */
  missing: string;
}

interface BaseAtlas {
  key: string;
  bytes: Uint8Array;
  px: number;
  have: Set<number>;
}

/** px of a font slot (vendor/pocketjs/framework/compiler/tailwind.ts:
 *  12..36 px in 0..6 and 7..13, 54 px in 14/15, mono 12/14/16 in 16..18,
 *  10 px in 19/20), restated so the compiler stays out of the app. A test
 *  pins it to the compiler's table. */
export function slotPx(slot: number): number {
  const sizes = [12, 14, 16, 18, 20, 24, 36];
  if (slot < 7) return sizes[slot]!;
  if (slot < 14) return sizes[slot - 7]!;
  if (slot < 16) return 54;
  if (slot < 19) return [12, 14, 16][slot - 16]!;
  if (slot < 21) return 10;
  throw new Error(`preview: no px known for font slot ${slot}`);
}

let bases: BaseAtlas[] | null = null;
let faces: Font[] | null = null;
/** True while a supplemented atlas is installed in the core. */
let supplemented = false;

function baseAtlases(): BaseAtlas[] {
  if (bases) return bases;
  bases = [];
  if (!hasPack()) return bases;
  for (const key of pakEntries(FONT_PREFIX).sort()) {
    // A copy: the pak view must outlive any later swap.
    const bytes = pakGet(key).slice();
    const atlas = parseAtlas(bytes);
    bases.push({ key, bytes, px: slotPx(atlas.slot), have: atlasCodepoints(atlas) });
  }
  return bases;
}

function budgetFaces(): Font[] {
  if (faces) return faces;
  faces = [];
  for (const key of PREVIEW_FACE_KEYS) {
    if (!pakEntries(key).includes(key)) continue;
    faces.push(parseFont(pakGet(key)));
  }
  return faces;
}

/** Every string in a parsed document: keys and values. */
function collect(value: unknown, into: Set<number>): void {
  if (typeof value === "string") {
    for (const ch of value) {
      const cp = ch.codePointAt(0)!;
      if (cp >= 32 && cp !== 127) into.add(cp);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collect(item, into);
  } else if (value && typeof value === "object") {
    for (const key in value as Record<string, unknown>) {
      collect(key, into);
      collect((value as Record<string, unknown>)[key], into);
    }
  }
}

/** Codepoints of a document's strings. */
export function documentCodepoints(...values: unknown[]): Set<number> {
  const out = new Set<number>();
  for (const value of values) collect(value, out);
  return out;
}

/** Make the core's atlases cover `codepoints` as far as the budgeted faces
 *  allow (see the header). Call before the view that shows them mounts. */
export function supplementGlyphs(codepoints: ReadonlySet<number>): GlyphSupplement {
  const atlases = baseAtlases();
  const needed = new Set<number>();
  for (const atlas of atlases) for (const cp of codepoints) if (!atlas.have.has(cp)) needed.add(cp);
  const ops = getOps();
  if (needed.size === 0) {
    if (supplemented) {
      for (const atlas of atlases) ops.loadFontAtlas?.(atlas.bytes);
      supplemented = false;
      resetSlotMeasures();
    }
    return { added: 0, missing: "" };
  }
  const added = new Set<number>();
  const missing = new Set<number>();
  for (const atlas of atlases) {
    const merged = supplementAtlas(atlas.bytes, atlas.px, codepoints, budgetFaces());
    for (const cp of merged.added) added.add(cp);
    for (const cp of merged.missing) missing.add(cp);
    ops.loadFontAtlas?.(merged.bytes);
  }
  supplemented = true;
  resetSlotMeasures();
  return { added: added.size, missing: [...missing].sort((a, b) => a - b).map((cp) => String.fromCodePoint(cp)).join("") };
}
