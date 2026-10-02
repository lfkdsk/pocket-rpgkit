// src/ui/dialog-pages.ts — where a dialog message that needs more than one
// box breaks into pages. Pure (no host calls of its own): the measurer is a
// parameter, so the game passes the running core's baked-font measurer and
// a headless tool passes the build-time one (tools/lib/font-measure.ts),
// and both get the same pages.
//
// The interpreter asks once, when a text box opens (WorldOptions
// .paginateText), and keeps the answer in the open modal (TextModal
// .pageStarts), so the number of confirms a message takes is reducer state:
// the same at every host rate, after a rewind and in a replay. Saves never
// hold an open text box. Pages are cut at the design width (the 480 px
// screen), not the live window, so a resized desktop window or a 960 px
// web page shows the same pages; DialogBox lays each page out at the live
// width.
//
// A message whose rows fit the box (text-flow.ts: authored rows, wrapped
// lines, or the soft reflow of a pre-wrapped page) is one page and gets no
// page state at all. Otherwise the wrapped rows go four to a page; authored
// line breaks are kept.

import { scalarLength, scalarOffset, type Measure } from "../engine/text-break.ts";
import { flowRows } from "./text-flow.ts";
import { splitSpeaker, type SpeakerSplit } from "./theme.ts";

/** Rows of the message box (the schema's commands.text.lines cap). */
export const DIALOG_ROWS = 4;
/** The design screen width pages are cut at. */
export const DIALOG_PAGE_VIEWPORT = 480;
/** Default portrait column: the 64 px image and an 8 px gap. */
export const FACE_WIDTH = 72;
/** Message box chrome left and right of the text column: 8 px insets, 2 px
 *  frame and 8 px padding per side. */
const BOX_CHROME = 36;

const NO_SPEAKER: SpeakerSplit = { name: null, rest: "", cut: 0 };

export interface DialogLayout {
  /** Screen width the box spans. */
  viewportWidth: number;
  /** Speaker portraits (DialogBoxProps.faces). */
  faces?: Readonly<Record<string, string>>;
  /** Portrait column width (default FACE_WIDTH). */
  faceWidth?: number;
  /** The theme draws a 1 px rim inside the frame. */
  rim?: boolean;
}

/** The speaker split of a message's first line under `faces`. */
export function messageSpeaker(lines: readonly string[], faces: DialogLayout["faces"]): SpeakerSplit {
  if (!faces || lines.length === 0) return NO_SPEAKER;
  return splitSpeaker(lines[0]!, faces);
}

/** The lines the box draws: the first without its "NAME: " prefix. */
export function shownMessageLines(lines: readonly string[], speaker: SpeakerSplit): readonly string[] {
  return speaker.name ? [speaker.rest, ...lines.slice(1)] : lines;
}

/** The text column's width (the Text node) for a message with or without a
 *  portrait. */
export function dialogColumnWidth(layout: DialogLayout, speaking: boolean): number {
  return Math.max(0, layout.viewportWidth - BOX_CHROME - (layout.faces && speaking ? layout.faceWidth ?? FACE_WIDTH : 0));
}

/** The width rows may fill: the column less the rim's 1 px per side. */
export function dialogRowWidth(layout: DialogLayout, speaking: boolean): number {
  return dialogColumnWidth(layout, speaking) - (layout.rim ? 2 : 0);
}

/** Code-point offsets into `lines.join("\n")` (speaker prefix included)
 *  where each page starts, [0, ...], when the message needs more than one
 *  box; null when it fits one. */
export function messagePageStarts(lines: readonly string[], layout: DialogLayout, measure: Measure): number[] | null {
  const speaker = messageSpeaker(lines, layout.faces);
  const shown = shownMessageLines(lines, speaker);
  const flow = flowRows(shown, dialogRowWidth(layout, speaker.name !== null), DIALOG_ROWS, measure);
  if (flow.rows.length <= DIALOG_ROWS) return null;
  const starts = [0];
  for (let row = DIALOG_ROWS; row < flow.rows.length; row += DIALOG_ROWS) {
    starts.push(speaker.cut + scalarLength(flow.source.slice(0, flow.rows[row]!.start)));
  }
  return starts;
}

/** The paginator a session is created with (SessionOptions.paginateText):
 *  pages cut at the design width with this box's portraits and rim. */
export function createDialogPaginator(
  layout: Omit<DialogLayout, "viewportWidth"> & { viewportWidth?: number },
  measure: Measure,
): (lines: readonly string[]) => number[] | null {
  const fixed: DialogLayout = { ...layout, viewportWidth: layout.viewportWidth ?? DIALOG_PAGE_VIEWPORT };
  return (lines) => messagePageStarts(lines, fixed, measure);
}

/** The code points of a page the typewriter has reached: `revealed` counts
 *  the whole message (speaker prefix included). */
export function pageRevealed(revealed: number, cut: number, pageStarts: readonly number[] | undefined, page: number): number {
  const from = pageStarts && pageStarts.length > 1 ? Math.max(0, pageStarts[page]! - cut) : 0;
  return Math.max(0, revealed - cut - from);
}

/** One page of a message as the box draws it: the page's part of the shown
 *  lines (the first line without its speaker prefix of `cut` code points).
 *  `pageStarts` absent means the whole message is one page. */
export function messagePage(
  shown: readonly string[],
  cut: number,
  pageStarts: readonly number[] | undefined,
  page: number,
): readonly string[] {
  if (!pageStarts || pageStarts.length < 2) return shown;
  const joined = shown.join("\n");
  const from = scalarOffset(joined, Math.max(0, pageStarts[page]! - cut));
  const to = page + 1 < pageStarts.length ? scalarOffset(joined, pageStarts[page + 1]! - cut) : joined.length;
  // The break the page was cut at (a newline or a hung space) belongs to
  // the previous page's typing time but draws nothing.
  return joined.slice(from, to).replace(/[\n ]+$/, "").split("\n");
}
