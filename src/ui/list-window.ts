// src/ui/list-window.ts — stateless scroll windows and label wrapping for
// the kit's list boxes (DialogBox choices, the shop box, the icon choices
// box, battle menus). No engine state stores a scroll offset: the visible
// window is a pure function of the live cursor index and the list, so it
// can never desync from the reducer, and wrapping (bottom -> top, MV
// choice-cursor parity) recomputes the correct window with no leftover
// state from the previous frame.
//
// Labels are never cut: a label wider than its box wraps onto more rows
// (text-break.ts rules: CJK between characters with kinsoku, Latin at
// spaces), and the boxes grow or scroll by rows to show every row.

import { breakText, scalarLength, sliceScalars, type Measure } from "../engine/text-break.ts";

/** First row index a `visible`-row window should show so that `index` is
 *  always inside it. Keeps the cursor one row from the window's top when
 *  there is room to scroll further up, and clamps at both ends. */
export function windowStart(index: number, total: number, visible: number): number {
  if (total <= visible) return 0;
  const maxStart = total - visible;
  let start = index - 1;
  if (start < 0) start = 0;
  if (start > maxStart) start = maxStart;
  return start;
}

/** The items `[start, end)` a list whose items take `rows[i]` rows each
 *  shows: windowStart's window of at most `maxItems` items, then narrowed
 *  (dropping items away from the cursor first) until it fits `maxRows`
 *  rows. The cursor's own item always stays, even if it alone is taller.
 *  With every item one row tall this is exactly windowStart's window. */
export function windowByRows(
  index: number,
  rows: readonly number[],
  maxItems: number,
  maxRows: number,
): { start: number; end: number } {
  const total = rows.length;
  let start = windowStart(index, total, maxItems);
  let end = Math.min(total, start + maxItems);
  let used = 0;
  for (let i = start; i < end; i++) used += rows[i]!;
  while (used > maxRows && end - start > 1) {
    if (end - 1 > index) used -= rows[--end]!;
    else if (start < index) used -= rows[start++]!;
    else break;
  }
  return { start, end };
}

/** The rows `label` wraps to at `maxWidth` px: one row when it fits (or the
 *  width is NaN), more when it does not. Every character is on some row. */
export function wrapLabel(label: string, maxWidth: number, measure: Measure): string[] {
  if (!(maxWidth > 0) || measure(label) <= maxWidth) return [label];
  return breakText(label, maxWidth, measure).map((row) => row.text);
}

/** Truncate a label to `max` characters, replacing the tail with "…" when
 *  it does not fit. The kit's own boxes no longer call it (they wrap); it
 *  stays for games that want a short form of a label. Counts code points,
 *  so a supplementary character (U+20BB7) is never cut into a lone
 *  surrogate. */
export function truncateLabel(label: string, max: number): string {
  if (scalarLength(label) <= max) return label;
  if (max <= 1) return sliceScalars(label, max);
  return `${sliceScalars(label, max - 1)}…`;
}

/** Ticks a marquee rests at each end before moving. */
export const MARQUEE_HOLD = 45;
/** Marquee speed: one pixel per this many ticks. */
export const MARQUEE_TICKS_PER_PX = 2;

/** How far (px, >= 0) a one-row label `overflow` px wider than its cell is
 *  scrolled left at `tick`: it rests at the start, scrolls until its end is
 *  in view, rests there, and starts over. A pure function of the tick, so a
 *  rewind or a replay shows the same frame. 0 when nothing overflows. */
export function marqueeOffset(overflow: number, tick: number): number {
  if (!(overflow > 0)) return 0;
  const travel = Math.ceil(overflow) * MARQUEE_TICKS_PER_PX;
  const cycle = 2 * MARQUEE_HOLD + travel;
  const t = ((Math.floor(tick) % cycle) + cycle) % cycle;
  if (t < MARQUEE_HOLD) return 0;
  if (t >= MARQUEE_HOLD + travel) return Math.ceil(overflow);
  return Math.floor((t - MARQUEE_HOLD) / MARQUEE_TICKS_PER_PX);
}
