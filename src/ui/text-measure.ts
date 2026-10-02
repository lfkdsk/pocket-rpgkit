// src/ui/text-measure.ts — pixel widths from the running core's baked font,
// for the kit's text boxes (line breaking, label fitting).
//
// The core measures a run as the sum of its glyph advances (no kerning, no
// shaping), so a per-character cache reproduces measureText exactly while
// asking the host once per distinct character and font slot. A character
// the atlas lacks measures as the core draws it (its tofu cell).

import { getOps } from "@pocketjs/framework/host";
import type { Measure } from "../engine/text-break.ts";

/** Font slot of the `text-xs` class (12 px regular) every kit box uses. */
export const TEXT_XS_SLOT = 0;
/** Font slot of the `text-2xs` class (10 px regular): one size down, for
 *  fixed cells whose label does not fit at `text-xs`. */
export const TEXT_2XS_SLOT = 19;

const measures = new Map<number, Measure>();

/** Forget every cached advance. A host that replaces a font atlas at run
 *  time (the project preview adding a document's glyphs) calls this before
 *  anything measures again. */
export function resetSlotMeasures(): void {
  measures.clear();
}

/** A cached measurer for one font slot. */
export function slotMeasure(slot: number = TEXT_XS_SLOT): Measure {
  let measure = measures.get(slot);
  if (measure) return measure;
  const advances = new Map<number, number>();
  measure = (text: string): number => {
    let width = 0;
    for (let i = 0; i < text.length; i++) {
      const cp = text.codePointAt(i)!;
      if (cp > 0xffff) i++;
      let advance = advances.get(cp);
      if (advance === undefined) {
        advance = getOps().measureText(String.fromCodePoint(cp), slot);
        advances.set(cp, advance);
      }
      width += advance;
    }
    return width;
  };
  measures.set(slot, measure);
  return measure;
}
