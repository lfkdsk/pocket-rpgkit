// src/ui/BoundedLine.tsx — a bounded text cell: its wrapped rows when they
// fit the cell's row budget, else a one-row marquee that scrolls sideways
// through the whole text on the view's tick. The kit's fixed chrome (shop
// header and legend, panel titles, the name-input caption) uses it to stay
// inside the 480x272 viewport for every schema-valid value: the schema
// allows 200 characters per interface word, and a cell that cannot grow
// paginates by scrolling instead of cutting.

import { Text, View } from "@pocketjs/framework/components";
import { Show, type Accessor, type JSX } from "solid-js";
import { marqueeOffset, type BoundedCell } from "./list-window.ts";

export interface BoundedLineProps {
  cell: BoundedCell;
  /** The view's marquee tick (useMarqueeTick); advances while any cell scrolls. */
  tick: Accessor<number>;
  textColor: string;
  /** px per row (the line height and the clipped marquee's height). */
  rowH: number;
  /** The cell's width (the wrap budget and the marquee's clip width). */
  width: number;
  textAlign?: number;
  debugName: string;
  sizeClass?: string;
}

/** Renders `cell`: a Text of every wrapped row, or a clipped one-row Text
 *  translated by the marquee offset. The wrap case is a plain Text node,
 *  so the common (short) tree is unchanged. */
export function BoundedLine(props: BoundedLineProps): JSX.Element {
  const cell = () => props.cell;
  return (
    <Show when={cell().kind === "wrap"} fallback={
      <View
        style={{ width: props.width, height: props.rowH, overflow: 1 }}
        debugName={props.debugName}
      >
        <Text
          class={props.sizeClass ?? "text-xs"}
          style={{
            textColor: props.textColor,
            lineHeight: props.rowH,
            height: props.rowH,
            shrink: 0,
            translateX: -marqueeOffset(cell().overflow, props.tick()),
            ...(props.textAlign !== undefined ? { textAlign: props.textAlign } : {}),
          }}
        >
          {cell().rows[0]}
        </Text>
      </View>
    }>
      <Text
        class={props.sizeClass ?? "text-xs"}
        style={{
          textColor: props.textColor,
          lineHeight: props.rowH,
          height: props.rowH * cell().rows.length,
          ...(props.textAlign !== undefined ? { textAlign: props.textAlign } : {}),
        }}
        debugName={props.debugName}
      >
        {cell().rows.join("\n")}
      </Text>
    </Show>
  );
}
