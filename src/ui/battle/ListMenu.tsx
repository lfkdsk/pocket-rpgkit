// src/ui/battle/ListMenu.tsx — KB4: a scrolling list menu for battle
// submenus (skills, items, party switch). Shares the kit's stateless scroll
// window and label wrapping (ui/list-window.ts) with DialogBox's
// choices/shop boxes, so a battle skill list scrolls exactly like every
// other list in the kit. Nothing is cut: a label wider than its row
// (fullwidth CJK is about twice as wide as Latin) wraps onto more rows and
// the window scrolls by rows; the title and description wrap and grow the
// box.

import { createMemo, For, Index } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { windowByRows, wrapLabel } from "../list-window.ts";
import { Panel } from "../Panel.tsx";
import { slotMeasure } from "../text-measure.ts";
import { resolveUiTheme, type UiTheme } from "../theme.ts";

export interface ListMenuRow {
  label: string;
  disabled?: boolean;
  /** Right-aligned secondary text (a cost, a quantity, a range/type tag). */
  detail?: string;
}

export interface ListMenuProps {
  rows: readonly ListMenuRow[];
  /** Selected row index into `rows` (not the visible window). */
  index: number;
  /** Prompt/title above the list; omit for none. Wraps to more rows when
   *  it is wider than the box. */
  title?: string;
  /** Description pinned under the list (a skill's flavour text). Wraps to
   *  more rows when it is wider than the box. */
  description?: string;
  /** Text rows the list area shows (default 4). A label that wraps takes
   *  more than one; the selected label is always shown whole, growing the
   *  box when it alone needs more rows than this. */
  visibleRows?: number;
  width?: number;
  /** @deprecated Ignored: labels are no longer cut to a character count;
   *  a label wider than its row wraps. Kept so existing callers compile. */
  labelMax?: number;
  theme?: Partial<UiTheme>;
  style?: Record<string, number | string>;
  debugName?: string;
}

const ROW_H = 14;
const DEFAULT_VISIBLE = 4;
const DEFAULT_WIDTH = 200;
/** The rows' content width is `width` minus this: the Panel's outer box is
 *  `width + 4`, its paper is inset 2 px per side (paper = `width`) and the
 *  paper class pads 2 px per side (content = `width - 4`). The theme's rim
 *  is a 1 px border drawn inside the paper, within that padding. */
const CONTENT_INSET = 4;
/** Minimum gap kept between a row's label and its right-aligned detail. */
const DETAIL_GAP = 4;
const SELECTED_PREFIX = "> ";
const IDLE_PREFIX = "  ";

/** One text row of the list area: row `row` of item `item`'s wrapped label. */
interface ListLine {
  item: number;
  row: number;
  text: string;
}

const sameStrings = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((s, i) => s === b[i]);

export function ListMenu(props: ListMenuProps) {
  const theme = createMemo(() => resolveUiTheme(props.theme));
  const visible = () => props.visibleRows ?? DEFAULT_VISIBLE;
  const width = () => props.width ?? DEFAULT_WIDTH;
  const contentWidth = createMemo(() => width() - CONTENT_INSET);
  // The title and description wrap across the content width; a string memo
  // in front keeps a parent re-render with the same words from re-wrapping.
  const rawTitle = createMemo(() => props.title);
  const rawDescription = createMemo(() => props.description);
  const titleRows = createMemo(() => {
    const t = rawTitle();
    return t !== undefined ? wrapLabel(t, contentWidth(), slotMeasure()) : [];
  }, undefined, { equals: sameStrings });
  const descriptionRows = createMemo(() => {
    const d = rawDescription();
    return d !== undefined ? wrapLabel(d, contentWidth(), slotMeasure()) : [];
  }, undefined, { equals: sameStrings });
  const titleH = () => (titleRows().length > 0 ? titleRows().length * ROW_H + 4 : 0);
  const descriptionH = () => (descriptionRows().length > 0 ? descriptionRows().length * ROW_H + 4 : 0);

  // Labels and details as strings, so the wrap below re-runs only when
  // a label, a detail or the box changes, never on a cursor move or a
  // parent that rebuilds the same rows.
  const labels = createMemo(() => props.rows.map((r) => r.label), undefined, { equals: sameStrings });
  const details = createMemo(() => props.rows.map((r) => r.detail ?? ""), undefined, { equals: sameStrings });
  // Wrapped against the wider of the two prefixes, so a label's rows do not
  // change as the cursor moves onto or off it; the detail's width is kept
  // free on every row of its label.
  const wrapped = createMemo(() => {
    const measure = slotMeasure();
    const prefix = Math.max(measure(SELECTED_PREFIX), measure(IDLE_PREFIX));
    const ds = details();
    return labels().map((label, i) => {
      const d = ds[i]!;
      const budget = contentWidth() - prefix - (d.length > 0 ? measure(d) + DETAIL_GAP : 0);
      return wrapLabel(label, Math.max(0, budget), measure);
    });
  });
  // Derive the window and its lines from one wrapped-row snapshot. During a
  // live battle transition `rows` and `index` can change in the same Solid
  // update; separate memos can otherwise expose a new range with the prior
  // wrapped array and index past its end for that evaluation.
  const lines = createMemo((): ListLine[] => {
    const all = wrapped();
    const { start, end } = windowByRows(
      props.index,
      all.map((rows) => rows.length),
      visible(),
      visible(),
    );
    const out: ListLine[] = [];
    for (let item = start; item < end; item++) {
      all[item]!.forEach((text, row) => out.push({ item, row, text }));
    }
    return out;
  });
  // `visible` text rows, or more when the selected label alone is taller.
  const rowSlots = createMemo(() => Array.from({ length: Math.max(visible(), lines().length) }, (_, i) => i), undefined, {
    equals: (a, b) => a.length === b.length,
  });

  return (
    <Panel
      theme={props.theme}
      style={{
        posType: 1,
        width: width() + 4,
        height: titleH() + rowSlots().length * ROW_H + descriptionH() + 4,
        ...props.style,
      }}
      paperClass="flex-col p-[2]"
      debugName={props.debugName}
    >
      <Index each={titleRows()}>
        {(row, i) => (
          <Text
            class="text-xs"
            style={{ textColor: theme().dim, lineHeight: ROW_H, height: ROW_H, insetB: 4 }}
            debugName={props.debugName ? `${props.debugName}-title${i === 0 ? "" : `-${i}`}` : undefined}
          >
            {row()}
          </Text>
        )}
      </Index>
      <For each={rowSlots()}>
        {(slot) => {
          const line = () => lines()[slot];
          const item = () => {
            const l = line();
            return l ? props.rows[l.item] : undefined;
          };
          const selected = createMemo(() => line()?.item === props.index);
          const colour = createMemo(() => {
            const r = item();
            if (!r) return theme().ink;
            return r.disabled ? theme().dim : selected() ? theme().accent : theme().ink;
          });
          // A label's first row carries the cursor prefix and the detail;
          // its continuation rows are indented under the label.
          const label = () => {
            const l = line();
            if (!l) return "";
            return `${l.row === 0 && selected() ? SELECTED_PREFIX : IDLE_PREFIX}${l.text}`;
          };
          const detail = () => {
            const l = line();
            return l && l.row === 0 ? (item()?.detail ?? "") : "";
          };
          return (
            <View
              class="flex-row justify-between"
              style={{ height: ROW_H }}
              debugName={props.debugName ? `${props.debugName}-row-${slot}` : undefined}
            >
              <Text class="text-xs" style={{ textColor: colour(), lineHeight: ROW_H, height: ROW_H }}>
                {`${label()}`}
              </Text>
              <Text class="text-xs" style={{ textColor: colour(), lineHeight: ROW_H, height: ROW_H }}>
                {`${detail()}`}
              </Text>
            </View>
          );
        }}
      </For>
      <Index each={descriptionRows()}>
        {(row, i) => (
          <Text
            class="text-xs"
            style={{ textColor: theme().dim, lineHeight: ROW_H, height: ROW_H, insetT: 4 }}
            debugName={props.debugName ? `${props.debugName}-description${i === 0 ? "" : `-${i}`}` : undefined}
          >
            {row()}
          </Text>
        )}
      </Index>
    </Panel>
  );
}
