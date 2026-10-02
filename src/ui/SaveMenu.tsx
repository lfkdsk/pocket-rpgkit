// src/ui/SaveMenu.tsx — P1⑤ save/load menu presentation.
//
// RpgKitApp owns engine/save-menu.ts's pure navigation state and performs
// the command a CONFIRM returns (fs write/read, snapshot build, OSK open);
// this component renders the current page. On a target without data.fs the
// root lists the two code rows only. The code export pages the URL-safe
// base64 of the same envelope the desktop writes; the code import runs the
// system OSK (@pocketjs/framework/osk), whose alphabet covers the code's
// A-Z a-z 0-9 - _. While the OSK is open its button block owns input.
//
// The panel is a Panel coloured by the `theme` prop (ui/theme.ts), over the
// theme's backdrop; `title` renames the root page ("POCKET RPG KIT — SAVE").
// Game-supplied strings (the title, a slot's map id, a message page) are
// never cut: one wider than the panel wraps onto more rows, and the panel
// grows past its 232 px when a page's rows need it.

import { createMemo, For, Show, type Accessor } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { Osk } from "@pocketjs/framework/osk";
import type { OskController } from "@pocketjs/framework/osk";
import type { FsSlotInfo } from "../host/save-fs.ts";
import { ROOT_CODE, ROOT_FS, type MenuState } from "../engine/save-menu.ts";
import { wrapLabel } from "./list-window.ts";
import { Panel } from "./Panel.tsx";
import { slotMeasure } from "./text-measure.ts";
import { resolveUiTheme, type UiTheme } from "./theme.ts";

export type SlotInfo = (FsSlotInfo | { slot: number; error: string } | null)[];

export interface SaveMenuProps {
  menu: Accessor<MenuState>;
  hasFs: boolean;
  slots: Accessor<SlotInfo>;
  saveCode: Accessor<string>;
  osk: OskController;
  legend: Accessor<string>;
  /** Panel and backdrop colours; missing keys keep DEFAULT_UI_THEME. */
  theme?: Partial<UiTheme>;
  /** Root page title (default "POCKET RPG KIT — SAVE"). */
  title?: string;
}

/** Font slot of `text-sm` (14 px regular): index 1 of PocketJS's FONT_PX
 *  table (framework/compiler/tailwind.ts fontSlotFor). */
const TEXT_SM_SLOT = 1;
/** Content width of the 420 px panel: minus the Panel's 2 px border and the
 *  paper's 8 px padding (p-[8]) per side. The theme's 1 px rim sits inside
 *  that padding. Game-supplied strings (the root title, a slot's map id, a
 *  message page) wrap to it; the kit's own English rows already fit. */
const CONTENT_W = 420 - 2 * (2 + 8);
/** The panel's height when every row fits it; a page whose rows need more
 *  grows it (PANEL_FRAME is the border and padding above and below). */
const PANEL_H = 232;
const PANEL_FRAME = 2 * (2 + 8);
/** Row heights: the root and message pages' `text-sm` rows, a root menu row,
 *  a one-row slot, and each row of a slot summary that wraps. */
const TITLE_ROW_H = 18;
const ROOT_ROW_H = 20;
const SLOT_ROW_H = 22;
const SLOT_WRAP_ROW_H = 18;
/** Spacer under a page title, and the legend row at the page's foot. */
const TITLE_GAP = 6;
const LEGEND_H = 14;
const SELECTED_PREFIX = "> ";
const IDLE_PREFIX = "  ";

// Export pages: fixed-width rows of the code, ten rows per page.
const CODE_COLS = 24;
const CODE_ROWS = 10;

function codePages(code: string): string[] {
  const pages: string[] = [];
  for (let i = 0; i < code.length; i += CODE_COLS * CODE_ROWS) {
    pages.push(code.slice(i, i + CODE_COLS * CODE_ROWS));
  }
  return pages.length ? pages : [""];
}

function pageRows(page: string): string[] {
  const rows: string[] = [];
  for (let i = 0; i < CODE_ROWS; i++) {
    rows.push(page.slice(i * CODE_COLS, (i + 1) * CODE_COLS));
  }
  return rows;
}

function slotLabel(info: SlotInfo[number]): string {
  if (info === null) return "- empty";
  if ("error" in info) return "! damaged save";
  return `${info.map}  f${info.frame}`;
}

/** `text` in `text-sm` rows across the panel's content width. */
function wrapSm(text: string, width: number = CONTENT_W): string[] {
  return wrapLabel(text, width, slotMeasure(TEXT_SM_SLOT));
}

const sameStrings = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((s, i) => s === b[i]);

/** Height of a slot row whose summary takes `rows` rows: one keeps the
 *  list's 22 px row, more stack at SLOT_WRAP_ROW_H with the same 4 px of
 *  air. */
function slotRowHeight(rows: number): number {
  return rows <= 1 ? SLOT_ROW_H : rows * SLOT_WRAP_ROW_H + (SLOT_ROW_H - SLOT_WRAP_ROW_H);
}

function isIndex(m: MenuState, i: number): boolean {
  return (m.kind === "root" || m.kind === "slots-save" || m.kind === "slots-load") && m.index === i;
}

export function SaveMenu(props: SaveMenuProps) {
  const pages = createMemo(() => codePages(props.saveCode()));
  const theme = createMemo(() => resolveUiTheme(props.theme));
  const rawTitle = createMemo(() => props.title);
  const rootTitle = createMemo(
    () => {
      const t = rawTitle();
      return t === undefined ? ["POCKET RPG KIT — SAVE"] : wrapSm(t);
    },
    undefined,
    { equals: sameStrings },
  );
  // Each slot's summary, wrapped after the wider prefix and the slot
  // number; re-wraps only when a slot's summary string changes.
  const slotRows = [0, 1, 2].map((row) => {
    const rawSummary = createMemo(() => slotLabel(props.slots()[row]!));
    return createMemo(() => {
      const measure = slotMeasure(TEXT_SM_SLOT);
      const prefix = Math.max(measure(SELECTED_PREFIX), measure(IDLE_PREFIX)) + measure(`${row + 1}. `);
      return wrapSm(rawSummary(), CONTENT_W - prefix);
    }, undefined, { equals: sameStrings });
  });
  const messageRows = createMemo(
    () => {
      const m = props.menu();
      return m.kind === "message" ? { title: wrapSm(m.title), body: wrapSm(m.body) } : { title: [], body: [] };
    },
    undefined,
    { equals: (a, b) => sameStrings(a.title, b.title) && sameStrings(a.body, b.body) },
  );
  // The panel keeps PANEL_H unless the open page's rows need more.
  const panelHeight = createMemo(() => {
    const m = props.menu();
    let content = 0;
    if (m.kind === "root") {
      const rows = (props.hasFs ? ROOT_FS : ROOT_CODE).length;
      content = rootTitle().length * TITLE_ROW_H + TITLE_GAP + rows * ROOT_ROW_H + LEGEND_H;
    } else if (m.kind === "slots-save" || m.kind === "slots-load") {
      content = TITLE_ROW_H + TITLE_GAP + LEGEND_H;
      for (const rows of slotRows) content += slotRowHeight(rows().length);
    } else if (m.kind === "message") {
      const { title, body } = messageRows();
      content = (title.length + body.length) * TITLE_ROW_H + TITLE_GAP + LEGEND_H;
    }
    return Math.max(PANEL_H, content + PANEL_FRAME);
  });

  return (
    <Show when={props.menu().kind !== "closed"}>
      <View
        class="absolute inset-0 flex-row justify-center items-center"
        style={{ posType: 1, bgColor: theme().backdrop }}
        debugName="rpgkit-save-overlay"
      >
        <Panel
          theme={theme()}
          style={{ posType: 1, width: 420, height: panelHeight() }}
          paperClass="flex-col grow p-[8]"
          debugName="rpgkit-save-panel"
        >
          {/* ROOT */}
          <Show when={props.menu().kind === "root"}>
            <Text
              class="text-sm"
              style={{ textColor: theme().accent, lineHeight: TITLE_ROW_H, height: rootTitle().length * TITLE_ROW_H }}
              debugName="rpgkit-save-title"
            >
              {rootTitle().join("\n")}
            </Text>
            <View style={{ height: 6 }} />
            <For each={props.hasFs ? ROOT_FS : ROOT_CODE}>
              {(row, i) => (
                <Text
                  class="text-sm"
                  style={{ textColor: isIndex(props.menu(), i()) ? theme().accent : theme().ink, lineHeight: 20, height: 20 }}
                  debugName={`rpgkit-save-root-${i()}`}
                >
                  {`${isIndex(props.menu(), i()) ? "> " : "  "}${row.label}`}
                </Text>
              )}
            </For>
            <View class="grow" />
            <Text class="text-xs" style={{ textColor: theme().dim, lineHeight: 14, height: 14 }} debugName="rpgkit-save-legend">
              {`${props.legend()}`}
            </Text>
          </Show>

          {/* SLOT LISTS */}
          <Show when={props.menu().kind === "slots-save" || props.menu().kind === "slots-load"}>
            {(() => {
              const m = props.menu();
              if (m.kind !== "slots-save" && m.kind !== "slots-load") return null;
              const saving = m.kind === "slots-save";
              return (
                <>
                  <Text class="text-sm" style={{ textColor: theme().accent, lineHeight: 18, height: 18 }} debugName="rpgkit-slot-title">
                    {saving ? "SAVE TO SLOT" : "LOAD FROM SLOT"}
                  </Text>
                  <View style={{ height: 6 }} />
                  <For each={[0, 1, 2]}>
                    {(row) => {
                      // The summary (a map id may be CJK) on one row as
                      // before, or wrapped: its rows stack in one Text
                      // beside the prefix and slot number, so every row
                      // starts under the first.
                      const summary = slotRows[row]!;
                      const wraps = createMemo(() => summary().length > 1);
                      const colour = () => (m.index === row ? theme().accent : theme().ink);
                      const lead = () => `${m.index === row ? SELECTED_PREFIX : IDLE_PREFIX}${row + 1}. `;
                      return (
                        <Show
                          when={wraps()}
                          fallback={
                            <Text
                              class="text-sm"
                              style={{ textColor: colour(), lineHeight: SLOT_ROW_H, height: SLOT_ROW_H }}
                              debugName={`rpgkit-slot-${row}`}
                            >
                              {`${lead()}${summary()[0]!}`}
                            </Text>
                          }
                        >
                          <View
                            class="flex-row"
                            style={{ height: slotRowHeight(summary().length), paddingT: (SLOT_ROW_H - SLOT_WRAP_ROW_H) / 2 }}
                            debugName={`rpgkit-slot-${row}`}
                          >
                            <Text class="text-sm" style={{ textColor: colour(), lineHeight: SLOT_WRAP_ROW_H, height: SLOT_WRAP_ROW_H }}>
                              {lead()}
                            </Text>
                            <Text
                              class="text-sm"
                              style={{ textColor: colour(), lineHeight: SLOT_WRAP_ROW_H, height: summary().length * SLOT_WRAP_ROW_H }}
                              debugName={`rpgkit-slot-${row}-summary`}
                            >
                              {summary().join("\n")}
                            </Text>
                          </View>
                        </Show>
                      );
                    }}
                  </For>
                  <View class="grow" />
                  <Text class="text-xs" style={{ textColor: theme().dim, lineHeight: 14, height: 14 }} debugName="rpgkit-slot-legend">
                    {`${props.legend()}`}
                  </Text>
                </>
              );
            })()}
          </Show>

          {/* CODE EXPORT */}
          <Show when={props.menu().kind === "code-export"}>
            {(() => {
              const m = props.menu();
              if (m.kind !== "code-export") return null;
              const all = pages();
              const page = Math.min(m.page, all.length - 1);
              return (
                <>
                  <Text class="text-xs" style={{ textColor: theme().accent, lineHeight: 15, height: 15 }} debugName="rpgkit-code-title">
                    {`SAVE CODE — page ${page + 1}/${all.length}  (up/down: page)`}
                  </Text>
                  <View style={{ height: 4 }} />
                  <For each={pageRows(all[page]!)}>
                    {(line) => (
                      <Text class="text-xs" style={{ textColor: theme().ink, lineHeight: 15, height: 15 }} debugName="rpgkit-code-row">
                        {line}
                      </Text>
                    )}
                  </For>
                  <View class="grow" />
                  <Text class="text-xs" style={{ textColor: theme().dim, lineHeight: 14, height: 14 }} debugName="rpgkit-code-hint">
                    Write this code down; import it with "Load code". x: back.
                  </Text>
                </>
              );
            })()}
          </Show>

          {/* CODE IMPORT */}
          <Show when={props.menu().kind === "code-import"}>
            <Text class="text-sm" style={{ textColor: theme().accent, lineHeight: 18, height: 18 }} debugName="rpgkit-import-title">
              TYPE A SAVE CODE
            </Text>
            <View style={{ height: 4 }} />
            <Text class="text-xs" style={{ textColor: theme().ink, lineHeight: 15, height: 15 }} debugName="rpgkit-import-hint">
              The keyboard opens below; START commits, x cancels.
            </Text>
          </Show>

          {/* MESSAGE */}
          <Show when={props.menu().kind === "message"}>
            {(() => {
              const m = props.menu();
              if (m.kind !== "message") return null;
              // Game-supplied texts: wrapped to the panel's width, each
              // one Text of as many rows as it needs.
              const title = () => messageRows().title;
              const body = () => messageRows().body;
              return (
                <>
                  <View class="grow" />
                  <Text
                    class="text-sm"
                    style={{ textColor: theme().accent, lineHeight: TITLE_ROW_H, height: title().length * TITLE_ROW_H }}
                    debugName="rpgkit-message-title"
                  >
                    {title().join("\n")}
                  </Text>
                  <View style={{ height: 6 }} />
                  <Text
                    class="text-sm"
                    style={{ textColor: theme().ink, lineHeight: TITLE_ROW_H, height: body().length * TITLE_ROW_H }}
                    debugName="rpgkit-message-body"
                  >
                    {body().join("\n")}
                  </Text>
                  <View class="grow" />
                  <Text class="text-xs" style={{ textColor: theme().dim, lineHeight: 14, height: 14 }} debugName="rpgkit-message-legend">
                    {`${props.legend()}`}
                  </Text>
                </>
              );
            })()}
          </Show>
        </Panel>
      </View>
      {/* The system keyboard floats over the overlay while importing. */}
      <Osk osk={props.osk} />
    </Show>
  );
}
