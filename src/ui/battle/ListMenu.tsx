// src/ui/battle/ListMenu.tsx — KB4: a scrolling list menu for battle
// submenus (skills, items, party switch). Shares the kit's fixed-row
// scroll window and label truncation (ui/list-window.ts) with DialogBox's
// choices/shop boxes, so a battle skill list scrolls exactly like every
// other list in the kit.

import { createMemo, For } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { truncateLabel, windowStart } from "../list-window.ts";
import { Panel } from "../Panel.tsx";
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
  /** Prompt/title row above the list; omit for none. */
  title?: string;
  /** Description line pinned under the list (a skill's flavour text). */
  description?: string;
  visibleRows?: number;
  width?: number;
  labelMax?: number;
  theme?: Partial<UiTheme>;
  style?: Record<string, number | string>;
  debugName?: string;
}

const ROW_H = 14;
const DEFAULT_VISIBLE = 4;
const DEFAULT_WIDTH = 200;
const DEFAULT_LABEL_MAX = 20;

export function ListMenu(props: ListMenuProps) {
  const theme = createMemo(() => resolveUiTheme(props.theme));
  const visible = () => props.visibleRows ?? DEFAULT_VISIBLE;
  const width = () => props.width ?? DEFAULT_WIDTH;
  const labelMax = () => props.labelMax ?? DEFAULT_LABEL_MAX;
  const start = createMemo(() => windowStart(props.index, props.rows.length, visible()));
  const rowSlots = createMemo(() => Array.from({ length: visible() }, (_, i) => i));
  const titleH = () => (props.title !== undefined ? ROW_H + 4 : 0);
  const descriptionH = () => (props.description !== undefined ? ROW_H + 4 : 0);

  return (
    <Panel
      theme={props.theme}
      style={{
        posType: 1,
        width: width() + 4,
        height: titleH() + visible() * ROW_H + descriptionH() + 4,
        ...props.style,
      }}
      paperClass="flex-col p-[2]"
      debugName={props.debugName}
    >
      {props.title !== undefined ? (
        <Text
          class="text-xs"
          style={{ textColor: theme().dim, lineHeight: ROW_H, height: ROW_H, insetB: 4 }}
          debugName={props.debugName ? `${props.debugName}-title` : undefined}
        >
          {props.title}
        </Text>
      ) : null}
      <For each={rowSlots()}>
        {(slot) => {
          const rowIndex = () => start() + slot;
          const exists = () => rowIndex() < props.rows.length;
          const row = () => (exists() ? props.rows[rowIndex()]! : null);
          const selected = createMemo(() => exists() && rowIndex() === props.index);
          const colour = createMemo(() => {
            const r = row();
            if (!r) return theme().ink;
            return r.disabled ? theme().dim : selected() ? theme().accent : theme().ink;
          });
          const label = () => {
            const r = row();
            if (!r) return "";
            return `${selected() ? "> " : "  "}${truncateLabel(r.label, labelMax())}`;
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
                {`${row()?.detail ?? ""}`}
              </Text>
            </View>
          );
        }}
      </For>
      {props.description !== undefined ? (
        <Text
          class="text-xs"
          style={{ textColor: theme().dim, lineHeight: ROW_H, height: ROW_H, insetT: 4 }}
          debugName={props.debugName ? `${props.debugName}-description` : undefined}
        >
          {props.description}
        </Text>
      ) : null}
    </Panel>
  );
}
