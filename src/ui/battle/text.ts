// src/ui/battle/text.ts — the battle widgets' English words (engine/ui-text.ts
// keys). StatBar draws its default readout without the table (a template
// literal), and formats `battle.statValue` only when a game replaces it.

import { breakText, hasForcedBreak } from "../../engine/text-break.ts";
import { slotMeasure, TEXT_2XS_SLOT, TEXT_XS_SLOT } from "../text-measure.ts";
import type { UiTextTable } from "../../engine/ui-text.ts";

/** English default of StatBar's readout. */
export const STAT_BAR_UI_TEXT = {
  "battle.statValue": "{current} / {max}",
} as const satisfies Partial<UiTextTable>;

/** How the readout sits in its reserved cell: size (`small` = 10 px),
 *  rows, and for a text too long for two 10 px rows how far its one
 *  clipped row overflows the cell. */
export interface ReadoutLayout {
  kind: "one" | "two" | "clip";
  small: boolean;
  rows: string[];
  overflow: number;
}

/** A readout's rows at one size: one row, or two broken where a row may
 *  break; null when it needs more, or a cut inside a word. */
function fitReadout(text: string, slot: number, width: number): string[] | null {
  const measure = slotMeasure(slot);
  if (measure(text) <= width) return [text];
  const rows = breakText(text, width, measure);
  return rows.length <= 2 && !hasForcedBreak(text, rows) ? rows.map((row) => row.text) : null;
}

/** Lay out a readout for a fixed cell of `width` px: one 12 px row, two
 *  12 px rows, two 10 px rows, or a clipped 10 px row that scrolls
 *  sideways (a marquee) so a long value is never cut. */
export function readoutLayout(text: string, width: number): ReadoutLayout {
  for (const slot of [TEXT_XS_SLOT, TEXT_2XS_SLOT]) {
    const rows = fitReadout(text, slot, width);
    if (rows) return { kind: rows.length === 1 ? "one" : "two", small: slot === TEXT_2XS_SLOT, rows, overflow: 0 };
  }
  const overflow = Math.max(0, slotMeasure(TEXT_2XS_SLOT)(text) - width);
  return { kind: "clip", small: true, rows: [text], overflow };
}
