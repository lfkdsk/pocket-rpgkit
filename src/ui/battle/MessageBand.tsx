// src/ui/battle/MessageBand.tsx — KB4: the battle message band. Same
// typewriter contract as DialogBox's message box (ui/DialogBox.tsx): the
// caller's reducer owns the revealed-character count, this component only
// slices `lines` to it, so a fully-revealed band emits zero repaint once
// the state stops changing and a rewind to any tick shows exactly the
// text that tick had revealed.

import { For, createMemo } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { Panel } from "../Panel.tsx";
import { resolveUiTheme, type UiTheme } from "../theme.ts";

export interface MessageBandProps {
  /** Up to `rows` (default 2) authored lines, joined with "\n" for reveal
   *  counting exactly like DialogBox. */
  lines: readonly string[];
  /** Characters of `lines.join("\n")` to show; undefined shows all of it
   *  (a caller not doing its own typewriter can skip the reducer field). */
  revealed?: number;
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

/** Slice joined "line\nline" text to `revealed` chars, matching DialogBox's
 *  visibleLines: a line whose turn has not come renders empty. */
function visibleLines(lines: readonly string[], revealed: number): string[] {
  let left = revealed;
  return lines.map((line, i) => {
    if (left <= 0) return "";
    const take = Math.min(line.length, left);
    left -= take;
    if (i < lines.length - 1) left -= 1;
    return line.slice(0, take);
  });
}

export function MessageBand(props: MessageBandProps) {
  const theme = createMemo(() => resolveUiTheme(props.theme));
  const rows = () => props.rows ?? DEFAULT_ROWS;
  const rowIndices = createMemo(() => Array.from({ length: rows() }, (_, i) => i));
  const contentWidth = createMemo(() => Math.max(0, (props.width ?? DEFAULT_WIDTH) - 16));
  const total = createMemo(() => props.lines.join("\n").length);
  const shown = () => Math.max(0, Math.min(props.revealed ?? total(), total()));
  const complete = () => shown() >= total();
  const textLines = createMemo(() => {
    const visible = visibleLines(props.lines, shown());
    return rowIndices().map((i) => visible[i] ?? "");
  });

  return (
    <Panel
      theme={props.theme}
      style={{
        posType: 1,
        width: props.width ?? DEFAULT_WIDTH,
        height: rows() * ROW_H + 12 + 4,
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
