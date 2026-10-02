// src/ui/battle/CommandGrid.tsx — KB4: the MV-style 2x2 battle command grid
// (Fight / Skill / Guard / Run and similar). Stateless: the selected cell
// and each cell's enabled state are props read straight off the battle
// state, so the grid can never desync from the reducer.
//
// Labels are never cut. A cell is fixed (CELL_W x CELL_H), so a label is
// fitted in this order, each step only when the one before does not fit:
//   1. one row at 12 px (`text-xs`);
//   2. two rows at 12 px, sharing the cell's height;
//   3. one size down, 10 px (`text-2xs`): one row, else two rows;
//      a two-row step counts only when it breaks where a row may break,
//      so a long word goes down a size whole rather than cut in two;
//   4. one 10 px row clipped to the cell, starting at its first character,
//      which the focused cell scrolls (a marquee, list-window.ts) so every
//      character comes into view.
// The prefix ("> " or "  ") is set in the label's size. The marquee is a
// pure function of a tick: the battle's own `tick` when the caller passes
// one (a rewind shows the same frame), else a counter this grid bumps only
// while the focused cell actually overflows, so a grid with nothing to
// scroll emits zero repaint.

import { createMemo, createSignal, For, Match, Switch } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { breakText, hasForcedBreak } from "../../engine/text-break.ts";
import { marqueeOffset } from "../list-window.ts";
import { Panel } from "../Panel.tsx";
import { slotMeasure, TEXT_2XS_SLOT, TEXT_XS_SLOT } from "../text-measure.ts";
import { resolveUiTheme, type UiTheme } from "../theme.ts";

export interface CommandCell {
  label: string;
  disabled?: boolean;
}

export interface CommandGridProps {
  /** Exactly four cells, laid out 2x2 in row-major order:
   *  [0,1]
   *  [2,3] */
  cells: readonly [CommandCell, CommandCell, CommandCell, CommandCell];
  /** Row-major index of the selected cell (0..3). */
  index: number;
  /** Clock of the focused cell's marquee (e.g. the battle state's
   *  `nowTick`). Omitted, the grid counts its own frames, and only while
   *  the focused label overflows its cell. */
  tick?: number;
  theme?: Partial<UiTheme>;
  style?: Record<string, number | string>;
  debugName?: string;
}

const CELL_W = 116;
const CELL_H = 22;
/** Pixel width a cell's text ("> " prefix + label) may use. The Panel is
 *  `2 * CELL_W + 4` wide; its paper is inset 2 px per side and pads 2 px
 *  per side, so the content row is `2 * CELL_W - 4` = 228 px for two
 *  116 px cells. Under the core's default flex shrink (1) each cell lays
 *  out 114 px wide; without it the right cell would overhang the content
 *  by 4 px. `CELL_W - 4` keeps every cell's ink inside its cell and the
 *  content box either way (the theme's 1 px rim sits in the padding). */
const CELL_TEXT_W = CELL_W - 4;
/** Row height of a one-row label (the clipped row included), both sizes. */
const ONE_ROW_H = 14;
/** Row height of a 12 px two-row label: both rows share the 22 px cell. */
const TWO_ROW_H = 11;
/** Row pitch of a 10 px two-row label. The grid's 40 px content box holds
 *  two 22 px cells, so a bottom cell's last 2 px lie under the frame: the
 *  10 px pair keeps to the 20 px every cell shows, one row each 10 px. */
const SMALL_TWO_ROW_H = 10;
/** Line height of each 10 px row. The core centres the 13 px atlas cell on
 *  the line height, so 8 lifts it 2.5 px within its 10 px row: a Latin
 *  row's ink (ascenders to descenders) and a Chinese row's em box each take
 *  rows 0..9 of their row, and the pair fills exactly the 20 px a cell
 *  shows without one row touching the other. */
const SMALL_TWO_ROW_LEADING = 8;
const SELECTED_PREFIX = "> ";
const IDLE_PREFIX = "  ";

/** How a label sits in its cell: its size (`small` = 10 px), its rows, and
 *  for a label too long for two 10 px rows how far (px) its one clipped
 *  row overflows the cell. */
interface CellLayout {
  kind: "one" | "two" | "clip";
  small: boolean;
  rows: string[];
  overflow: number;
}

/** Width left for a label after the wider prefix at the same size: laid
 *  out against it, a label's rows are the same with and without the
 *  cursor. */
function labelWidth(slot: number): number {
  const measure = slotMeasure(slot);
  return CELL_TEXT_W - Math.max(measure(SELECTED_PREFIX), measure(IDLE_PREFIX));
}

/** A label's rows at one size: one row, or two broken where a row may
 *  break; null when it needs more, or a cut inside a word. */
function fitRows(label: string, slot: number): string[] | null {
  const measure = slotMeasure(slot);
  const width = labelWidth(slot);
  if (measure(label) <= width) return [label];
  const rows = breakText(label, width, measure);
  return rows.length <= 2 && !hasForcedBreak(label, rows) ? rows.map((row) => row.text) : null;
}

/** Lay out a label for its cell. A bottom cell shows only 20 of its 22 px
 *  (see SMALL_TWO_ROW_H), so two 12 px rows (2 x TWO_ROW_H) do not fit
 *  there and the label goes on to the 10 px step. */
function cellLayout(label: string, bottom: boolean): CellLayout {
  // Wrap first, at 12 px then one size down at 10 px.
  for (const slot of [TEXT_XS_SLOT, TEXT_2XS_SLOT]) {
    const rows = fitRows(label, slot);
    if (rows && slot === TEXT_XS_SLOT && bottom && rows.length === 2) continue;
    if (rows) return { kind: rows.length === 1 ? "one" : "two", small: slot === TEXT_2XS_SLOT, rows, overflow: 0 };
  }
  // Still too long: one 10 px row, scrolled when focused.
  const overflow = Math.max(0, slotMeasure(TEXT_2XS_SLOT)(label) - labelWidth(TEXT_2XS_SLOT));
  return { kind: "clip", small: true, rows: [label], overflow };
}

const sameLayout = (a: CellLayout, b: CellLayout): boolean =>
  a.kind === b.kind && a.small === b.small && a.overflow === b.overflow &&
  a.rows.length === b.rows.length && a.rows.every((r, i) => r === b.rows[i]);

export function CommandGrid(props: CommandGridProps) {
  const theme = createMemo(() => resolveUiTheme(props.theme));
  const rows = [0, 1] as const;
  const cols = [0, 1] as const;
  // Each cell's layout re-runs only when its label changes.
  const layouts = [0, 1, 2, 3].map((i) =>
    createMemo(() => cellLayout(props.cells[i]!.label, i >= 2), undefined, { equals: sameLayout }));
  const focusOverflow = createMemo(() => layouts[props.index]?.().overflow ?? 0);
  // The fallback clock: restarts when the focus moves, and ticks only while
  // the focused cell has something to scroll.
  const [ownTick, setOwnTick] = createSignal(0);
  let focused = props.index;
  onFrame(() => {
    if (props.tick !== undefined) return;
    if (props.index !== focused) {
      focused = props.index;
      if (ownTick() !== 0) setOwnTick(0);
      return;
    }
    if (focusOverflow() > 0) setOwnTick((t) => t + 1);
  });
  const tick = () => props.tick ?? ownTick();

  return (
    <Panel
      theme={props.theme}
      style={{ posType: 1, width: CELL_W * 2 + 4, height: CELL_H * 2 + 4, ...props.style }}
      paperClass="flex-col p-[2]"
      debugName={props.debugName}
    >
      <For each={rows}>
        {(row) => (
          <View class="flex-row" style={{ height: CELL_H }}>
            <For each={cols}>
              {(col) => {
                const i = row * 2 + col;
                const layout = layouts[i]!;
                const kind = createMemo(() => layout().kind);
                // The label's size; the prefix beside it uses the same.
                const size = createMemo(() => (layout().small ? "text-2xs" : "text-xs"));
                const twoRowH = createMemo(() => (layout().small ? SMALL_TWO_ROW_H : TWO_ROW_H));
                const twoRowLeading = createMemo(() => (layout().small ? SMALL_TWO_ROW_LEADING : TWO_ROW_H));
                const disabled = createMemo(() => props.cells[i]!.disabled === true);
                const selected = createMemo(() => props.index === i);
                const colour = createMemo(() =>
                  disabled() ? theme().dim : selected() ? theme().accent : theme().ink);
                const prefix = () => (selected() ? SELECTED_PREFIX : IDLE_PREFIX);
                const cellName = props.debugName ? `${props.debugName}-cell-${i}` : undefined;
                // Only the focused clipped label scrolls; the others show
                // their first characters.
                const offset = createMemo(() => (selected() ? marqueeOffset(layout().overflow, tick()) : 0));
                return (
                  <Switch>
                    <Match when={kind() === "one"}>
                      <View class="flex-row items-center" style={{ width: CELL_W, height: CELL_H }} debugName={cellName}>
                        <Text class={size()} style={{ textColor: colour(), lineHeight: ONE_ROW_H, height: ONE_ROW_H }}>
                          {`${prefix()}${layout().rows[0]!}`}
                        </Text>
                      </View>
                    </Match>
                    <Match when={kind() === "two"}>
                      {/* The prefix sits beside the first row; the second
                          row starts under the first row's label. */}
                      <View class="flex-row" style={{ width: CELL_W, height: CELL_H }} debugName={cellName}>
                        <Text class={size()} style={{ textColor: colour(), lineHeight: twoRowLeading(), height: twoRowH() }}>
                          {prefix()}
                        </Text>
                        <View class="flex-col">
                          <Text class={size()} style={{ textColor: colour(), lineHeight: twoRowLeading(), height: twoRowH() }}>
                            {`${layout().rows[0] ?? ""}`}
                          </Text>
                          <Text class={size()} style={{ textColor: colour(), lineHeight: twoRowLeading(), height: twoRowH() }}>
                            {`${layout().rows[1] ?? ""}`}
                          </Text>
                        </View>
                      </View>
                    </Match>
                    <Match when={kind() === "clip"}>
                      <View class="flex-row items-center" style={{ width: CELL_W, height: CELL_H }} debugName={cellName}>
                        <Text class={size()} style={{ textColor: colour(), lineHeight: ONE_ROW_H, height: ONE_ROW_H }}>
                          {prefix()}
                        </Text>
                        <View
                          style={{ width: labelWidth(TEXT_2XS_SLOT), height: ONE_ROW_H, overflow: 1 }}
                          debugName={cellName ? `${cellName}-clip` : undefined}
                        >
                          <Text
                            class={size()}
                            style={{ textColor: colour(), lineHeight: ONE_ROW_H, height: ONE_ROW_H, shrink: 0, translateX: -offset() }}
                            debugName={cellName ? `${cellName}-marquee` : undefined}
                          >
                            {`${layout().rows[0] ?? ""}`}
                          </Text>
                        </View>
                      </View>
                    </Match>
                  </Switch>
                );
              }}
            </For>
          </View>
        )}
      </For>
    </Panel>
  );
}
