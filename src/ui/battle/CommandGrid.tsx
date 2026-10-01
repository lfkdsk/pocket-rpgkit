// src/ui/battle/CommandGrid.tsx — KB4: the MV-style 2x2 battle command grid
// (Fight / Skill / Guard / Run and similar). Stateless: the selected cell
// and each cell's enabled state are props read straight off the battle
// state, so the grid can never desync from the reducer.

import { createMemo, For } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { Panel } from "../Panel.tsx";
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
  theme?: Partial<UiTheme>;
  style?: Record<string, number | string>;
  debugName?: string;
}

const CELL_W = 116;
const CELL_H = 22;

export function CommandGrid(props: CommandGridProps) {
  const theme = createMemo(() => resolveUiTheme(props.theme));
  const rows = [0, 1] as const;
  const cols = [0, 1] as const;

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
                const cell = createMemo(() => props.cells[i]!);
                const selected = createMemo(() => props.index === i);
                const colour = createMemo(() =>
                  cell().disabled ? theme().dim : selected() ? theme().accent : theme().ink);
                return (
                  <View
                    class="flex-row items-center"
                    style={{ width: CELL_W, height: CELL_H }}
                    debugName={props.debugName ? `${props.debugName}-cell-${i}` : undefined}
                  >
                    <Text
                      class="text-xs"
                      style={{ textColor: colour(), lineHeight: 14, height: 14 }}
                    >
                      {`${selected() ? "> " : "  "}${cell().label}`}
                    </Text>
                  </View>
                );
              }}
            </For>
          </View>
        )}
      </For>
    </Panel>
  );
}
