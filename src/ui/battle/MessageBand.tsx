// src/ui/battle/MessageBand.tsx — KB4: the battle message band. Same
// typewriter contract as DialogBox's message box (ui/DialogBox.tsx): the
// caller's reducer owns the revealed-character count, this component only
// slices `lines` to it, so a fully-revealed band emits zero repaint once
// the state stops changing and a rewind to any tick shows exactly the
// text that tick had revealed. Rows are laid out by ui/text-flow.ts: lines
// that fit keep their authored rows exactly; a wider line (CJK, a long
// substituted name) wraps to the band's pixel width. Nothing is cut: a
// message that needs more than `rows` rows grows the band by a row each
// (upward, for the usual bottom-anchored band).

import { For, createMemo } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { scalarLength } from "../../engine/text-break.ts";
import { Panel } from "../Panel.tsx";
import { flowRows, revealRows } from "../text-flow.ts";
import { slotMeasure } from "../text-measure.ts";
import { resolveUiTheme, type UiTheme } from "../theme.ts";

export interface MessageBandProps {
  /** Authored lines, joined with "\n" for reveal counting exactly like
   *  DialogBox. Laid out in `rows` (default 2) rows when they fit; more
   *  rows grow the band. */
  lines: readonly string[];
  /** Characters (code points) of `lines.join("\n")` to show; undefined
   *  shows all of it (a caller not doing its own typewriter can skip the
   *  reducer field). Same as UTF-16 length for text without supplementary
   *  characters. */
  revealed?: number;
  /** Rows the band always has (default 2); a longer message adds rows. */
  rows?: number;
  width?: number;
  /** Legend/hint text right-aligned under the message (e.g. "ok"). Shown
   *  only once fully revealed, matching DialogBox. */
  legend?: string;
  theme?: Partial<UiTheme>;
  style?: Record<string, number | string>;
  debugName?: string;
}

const ROW_H = 15;
const DEFAULT_ROWS = 2;
const DEFAULT_WIDTH = 300;
/** Outer width minus the text width: the Panel's 2 px border (its paper is
 *  inset 2 px per side) plus the paper's 6 px padding per side (p-[6]). */
const CONTENT_INSET = 16;
// The Solid universal renderer only patches a Text node's existing content
// in place (replaceText) when its PREVIOUS value was already a non-empty
// string; coming from "" it tears the node down and creates a fresh one
// (solid-js/universal's insertExpression, current === "" branch). A row
// that isn't its typewriter's turn yet, or a legend before the message
// completes, would otherwise flip between "" and real text every beat,
// so every such slot renders this invisible placeholder instead of "" —
// never literally empty — keeping every frame on the cheap replaceText
// path with zero create/destroy/insert/remove.
const BLANK = " ";
const orBlank = (s: string): string => (s.length > 0 ? s : BLANK);

/** Lines compared by content: a caller that re-splits the same message
 *  every tick (`message.split("\n")`) must not re-run the layout. */
function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a === b || (a.length === b.length && a.every((line, i) => line === b[i]));
}

export function MessageBand(props: MessageBandProps) {
  const theme = createMemo(() => resolveUiTheme(props.theme));
  const rows = () => props.rows ?? DEFAULT_ROWS;
  const contentWidth = createMemo(() => Math.max(0, (props.width ?? DEFAULT_WIDTH) - CONTENT_INSET));
  const lines = createMemo(() => props.lines, undefined, { equals: sameLines });
  const total = createMemo(() => scalarLength(lines().join("\n")));
  const shown = () => Math.max(0, Math.min(props.revealed ?? total(), total()));
  const complete = () => shown() >= total();
  // The layout runs when the words or the box change; a typewriter beat
  // only re-slices the rows it already has.
  const flow = createMemo(() => flowRows(lines(), contentWidth(), rows(), slotMeasure()));
  // Every laid-out row gets a Text: a message wider than `rows` rows grows
  // the band instead of losing its tail.
  const rowCount = createMemo(() => Math.max(rows(), flow().rows.length));
  const rowIndices = createMemo(() => Array.from({ length: rowCount() }, (_, i) => i));
  const textLines = createMemo(() => {
    const visible = revealRows(flow(), shown());
    return rowIndices().map((i) => visible[i] ?? "");
  });

  return (
    <Panel
      theme={props.theme}
      style={{
        posType: 1,
        width: props.width ?? DEFAULT_WIDTH,
        height: rowCount() * ROW_H + 12 + 4,
        ...props.style,
      }}
      paperClass="flex-col p-[6]"
      debugName={props.debugName}
    >
      <For each={rowIndices()}>
        {(row) => (
          <Text
            class="text-xs"
            style={{ textColor: theme().ink, lineHeight: ROW_H, height: ROW_H, width: contentWidth() }}
            debugName={props.debugName ? `${props.debugName}-row-${row}` : undefined}
          >
            {orBlank(textLines()[row]!)}
          </Text>
        )}
      </For>
      {props.legend !== undefined ? (
        <View class="flex-row justify-end" style={{ height: 12, insetT: 2 }}>
          <Text
            class="text-xs"
            style={{ textColor: theme().dim, lineHeight: 12, height: 12, width: contentWidth(), textAlign: 2 }}
            debugName={props.debugName ? `${props.debugName}-legend` : undefined}
          >
            {orBlank(complete() ? props.legend! : "")}
          </Text>
        </View>
      ) : null}
    </Panel>
  );
}
