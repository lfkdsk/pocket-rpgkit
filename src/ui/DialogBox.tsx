// src/ui/DialogBox.tsx — P1③ message layer: the typewriter dialog
// box and the choices box (docs/HIG.md §2.4 screen anatomy). The component is
// pure presentation: the interpreter reducer (engine/interpreter.ts) owns
// every word and the cursor; Solid signals only repaint when the visible
// string changes, so a fully-revealed box emits zero guest->core ops.
//
// Every row is its OWN fixed Text node (max four rows, the schema's
// commands.text.lines cap). One multiline Text repaints whole-document on
// every typed character and the framework's row pool leaves stale glyphs
// behind when the document shrinks; four independent row nodes change only
// their own line and nothing else.
//
//   ┌───────────────────────────┐  choices box (when modal=choices),
//   │  Read the weathered note? │    right-aligned above the message box
//   │  >Read note              │
//   │    Walk on                │
//   └───────────────────────────┘
//   ┌───────────────────────────┐  message box docked to the bottom
//   │ BRAMBLE MEADOW            │    of the 480x272 playfield
//   │ South: quiet grass....    │
//   │                   ○ next  │
//   └───────────────────────────┘
//
// All three boxes are Panels coloured by the `theme` prop (ui/theme.ts); without
// one they draw the kit's default palette.
//
// Portraits. With a `faces` table, a text whose first line opens with a
// listed speaker ("KEEPER: The lamp is lit.") shows that speaker's 64x64
// image in a column left of the text and a name tab ("Keeper") on the
// box's top edge. The prefix is dropped from the typed text; the
// interpreter still counts it, so the reveal is offset by its length (the
// words start after that many characters' worth of typing time). Other
// lines hide the column and the tab and lay out exactly as without faces.
//
//     ┌ Keeper ┐
//   ┌─┴────────┴────────────────┐
//   │ ┌──────┐ The lamp is lit. │
//   │ │ face │ Climb while the  │
//   │ └──────┘           ○ next │
//   └───────────────────────────┘

import { createMemo, For, Show, type Accessor } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import type { Modal, ShopRow } from "../engine/interpreter.ts";
import { truncateLabel, windowStart } from "./list-window.ts";
import { Panel } from "./Panel.tsx";
import { resolveUiTheme, speakerLabel, splitSpeaker, type SpeakerSplit, type UiTheme } from "./theme.ts";
import { startupProfileMark } from "../startup-profile.ts";

/** Portrait images are 64x64: pak images must be power-of-two. */
const FACE_PX = 64;
/** Default portrait column: the image plus an 8 px gap before the text. */
const FACE_WIDTH = 72;
/** The message box's top edge, measured up from the layer bottom
 *  (insetB 8 + height 92); the name tab sits on it. */
const BOX_TOP = 100;

export interface DialogBoxProps {
  modal: Accessor<Modal | null>;
  legend: Accessor<string>;
  /** Colours of both boxes; missing keys keep DEFAULT_UI_THEME. */
  theme?: Partial<UiTheme>;
  /** Speaker portraits: NAME -> 64x64 image src (a full string literal
   *  somewhere in the game's sources, so the build bakes it). A text whose
   *  first line starts "NAME: " for a listed NAME shows that portrait. */
  faces?: Readonly<Record<string, string>>;
  /** Width of the portrait column, text starts after it (default 72: the
   *  64 px image and an 8 px gap). Art drawn smaller inside its 64x64
   *  canvas can narrow it. */
  faceWidth?: number;
  /** Shop box item display names: id -> name. An id absent from the table
   *  (or the prop itself omitted) renders its raw id. */
  items?: Readonly<Record<string, { name: string }>>;
}

/** Slice the joined "line\nline" text to `revealed` chars; lines whose turn
 *  has not come render as empty strings (every row node stays mounted). */
function visibleLines(lines: string[], revealed: number): string[] {
  let left = revealed;
  return lines.map((line, i) => {
    if (left <= 0) return "";
    const take = Math.min(line.length, left);
    left -= take;
    if (i < lines.length - 1) left -= 1; // the joined "\n" separator
    return line.slice(0, take);
  });
}

const TEXT_ROWS = [0, 1, 2, 3];
const CHOICE_ROWS = [0, 1, 2, 3];
/** Rows visible at once in the choices/shop box (T2-9: up to 8 choice
 *  options and an unbounded shop goods list scroll a 4-row window; the
 *  box's fixed pixel height never grows). */
const VISIBLE_ROWS = 4;
/** Choice/shop row content budget after the 2-char "> "/"  " cursor
 *  prefix: the box fit maxLength:24 authored text before T2-9 raised the
 *  schema cap to 32/unbounded item names, so a longer label truncates
 *  instead of overflowing the 248px panel. */
const ROW_LABEL_MAX = 24;
const NO_SPEAKER: SpeakerSplit = { name: null, rest: "", cut: 0 };

export function DialogBox(props: DialogBoxProps) {
  startupProfileMark("ui-dialog:start");
  const theme = createMemo(() => resolveUiTheme(props.theme));
  const isChoice = () => props.modal()?.kind === "choices";
  const isShop = () => props.modal()?.kind === "shop";
  // Re-evaluated per typed character; downstream only sees a new speaker.
  const speaker = createMemo(
    () => {
      const m = props.modal();
      const faces = props.faces;
      if (!faces || m?.kind !== "text" || m.lines.length === 0) return NO_SPEAKER;
      return splitSpeaker(m.lines[0]!, faces);
    },
    NO_SPEAKER,
    { equals: (a, b) => a.name === b.name && a.cut === b.cut && a.rest === b.rest },
  );
  const textLines = () => {
    const m = props.modal();
    if (m?.kind !== "text") return ["", "", "", ""];
    const sp = speaker();
    const lines = sp.name ? [sp.rest, ...m.lines.slice(1)] : m.lines;
    const visible = visibleLines(lines, Math.max(0, m.revealed - sp.cut));
    return TEXT_ROWS.map((i) => visible[i] ?? "");
  };
  // display: 0 shows, 1 hides (the column and the tab stay mounted).
  const faceDisplay = () => (speaker().name ? 0 : 1);
  // All three boxes stay mounted and hide while unused: opening a dialog updates
  // text rows instead of mounting the box subtree (on a 333 MHz PSP a mount
  // costs about 100 ms of QuickJS time).
  const choicesDisplay = () => (isChoice() ? 0 : 1);
  const shopDisplay = () => (isShop() ? 0 : 1);
  const messageDisplay = () => (props.modal()?.kind === "text" ? 0 : 1);

  // Four text rows + the legend row; the column holding them is the paper
  // itself, or the text column right of the portrait when faces are on.
  const messageRows = () => (
    <>
      <For each={TEXT_ROWS}>
        {(row) => (
          <Text
            class="text-xs"
            style={{ textColor: theme().ink, lineHeight: 15, height: 15 }}
            debugName={`rpgkit-message-row-${row}`}
          >
            {`${textLines()[row]!}`}
          </Text>
        )}
      </For>
      <View class="flex-row justify-end" style={{ height: 12 }}>
        <Text class="text-xs" style={{ textColor: theme().dim, lineHeight: 12, height: 12 }} debugName="rpgkit-message-legend">
          {`${(() => {
            const m = props.modal();
            if (m?.kind !== "text") return "";
            return m.complete ? props.legend() : "";
          })()}`}
        </Text>
      </View>
    </>
  );

  const view = (
    <View
      class="absolute left-0 right-0 bottom-0"
      style={{ posType: 1, height: 180 }}
      debugName="rpgkit-message-layer"
    >
      {/* Choices box: docked right, immediately above the message box.
          During choices the message box is hidden (the prompt lives in
          this box, MV parity). */}
      <Panel
        theme={theme()}
        style={{ posType: 1, width: 248, height: 96, insetR: 12, insetB: 98, display: choicesDisplay() }}
        paperClass="flex-col p-[6]"
        debugName="rpgkit-choices-box"
      >
        <Text class="text-xs" style={{ textColor: theme().dim, lineHeight: 14, height: 14 }} debugName="rpgkit-choice-prompt">
          {`${isChoice() ? (props.modal() as Extract<Modal, { kind: "choices" }>).prompt : ""}`}
        </Text>
        <View class="flex-col" style={{ height: 4 }} />
        <For each={CHOICE_ROWS}>
          {(row) => {
            const m = () => props.modal() as Extract<Modal, { kind: "choices" }> | null;
            const total = () => m()?.options.length ?? 0;
            // A pure function of the live cursor index: never desyncs
            // from the reducer, and wrap-around (top<->bottom) recomputes
            // the correct window with no leftover scroll state.
            const start = () => windowStart(m()?.index ?? 0, total(), VISIBLE_ROWS);
            const optIndex = () => start() + row;
            const exists = () => m()?.kind === "choices" && optIndex() < total();
            const selected = () => exists() && m()!.index === optIndex();
            const label = () =>
              exists()
                ? `${selected() ? "> " : "  "}${truncateLabel(m()!.options[optIndex()]!, ROW_LABEL_MAX)}`
                : "";
            return (
              <Text
                class="text-xs"
                style={{ textColor: selected() ? theme().accent : theme().ink, lineHeight: 14, height: 14 }}
                debugName={`rpgkit-choice-${row}`}
              >
                {`${label()}`}
              </Text>
            );
          }}
        </For>
        <View class="flex-row justify-end" style={{ height: 14, insetT: 4 }}>
          <Text class="text-xs" style={{ textColor: theme().dim, lineHeight: 12, height: 12 }} debugName="rpgkit-choice-legend">
            {`${props.legend()}`}
          </Text>
        </View>
      </Panel>

      {/* Shop box: same footprint and docking as the choices box, with a
            stage/gold header row instead of a prompt and a scrolling row
            list (T2-10). Buy rows a player cannot afford, has capped out
            (backpack cap) or that are out of stock (B1) render dimmed;
            sell rows for an unsellable item (B4) do too. Every dimmed row
            stays navigable, just unconfirmable. */}
      <Panel
            theme={theme()}
            style={{ posType: 1, width: 248, height: 96, insetR: 12, insetB: 98, display: shopDisplay() }}
            paperClass="flex-col p-[6]"
            debugName="rpgkit-shop-box"
          >
            <View class="flex-row justify-between" style={{ height: 14 }}>
              <Text class="text-xs" style={{ textColor: theme().dim, lineHeight: 14, height: 14 }} debugName="rpgkit-shop-stage">
                {`${(() => {
                  const m = props.modal();
                  return m?.kind === "shop" ? (m.stage === "buy" ? "Buy" : "Sell") : "";
                })()}`}
              </Text>
              <Text class="text-xs" style={{ textColor: theme().dim, lineHeight: 14, height: 14 }} debugName="rpgkit-shop-gold">
                {`${(() => {
                  const m = props.modal();
                  return m?.kind === "shop" ? `Gold: ${m.gold}` : "";
                })()}`}
              </Text>
            </View>
            <View class="flex-col" style={{ height: 4 }} />
            <For each={CHOICE_ROWS}>
              {(row) => {
                const m = () => props.modal() as Extract<Modal, { kind: "shop" }> | null;
                const total = () => m()?.rows.length ?? 0;
                const start = () => windowStart(m()?.index ?? 0, total(), VISIBLE_ROWS);
                const rowIndex = () => start() + row;
                const exists = () => m()?.kind === "shop" && rowIndex() < total();
                const shopRow = (): ShopRow | null => (exists() ? m()!.rows[rowIndex()]! : null);
                const selected = () => exists() && m()!.index === rowIndex();
                // Buy: unaffordable, capped, or out-of-stock rows are inert
                // (T2-10 backpack cap / B1 finite stock). Sell: an
                // unsellable row (B4 — sellList:"disable") stays listed but
                // cannot be confirmed.
                const disabled = () => {
                  const r = shopRow();
                  if (!r || r.kind !== "item") return false;
                  return m()!.stage === "buy" ? !r.canAfford || r.atCap : !r.sellable;
                };
                const leftLabel = () => {
                  const r = shopRow();
                  const prefix = selected() ? "> " : "  ";
                  if (!r) return "";
                  if (r.kind === "item") {
                    const name = props.items?.[r.item]?.name ?? r.item;
                    return `${prefix}${truncateLabel(name, ROW_LABEL_MAX)}`;
                  }
                  return `${prefix}${r.kind === "sell" ? "Sell" : r.kind === "leave" ? "Leave" : "Back"}`;
                };
                const rightLabel = () => {
                  const r = shopRow();
                  if (r?.kind !== "item") return "";
                  // Finite shop stock (B1) shows next to the price; unlimited
                  // goods (stock: null, and every sell-stage row) show price
                  // alone.
                  const stockSuffix = r.stock !== null ? ` (${r.stock})` : "";
                  return `${r.price}g${stockSuffix}`;
                };
                const rowColor = () => (disabled() ? theme().dim : selected() ? theme().accent : theme().ink);
                return (
                  <View class="flex-row justify-between" style={{ height: 14 }} debugName={`rpgkit-shop-row-${row}`}>
                    <Text class="text-xs" style={{ textColor: rowColor(), lineHeight: 14, height: 14 }}>
                      {`${leftLabel()}`}
                    </Text>
                    <Text class="text-xs" style={{ textColor: rowColor(), lineHeight: 14, height: 14 }}>
                      {`${rightLabel()}`}
                    </Text>
                  </View>
                );
              }}
            </For>
            <View class="flex-row justify-end" style={{ height: 14, insetT: 4 }}>
              <Text class="text-xs" style={{ textColor: theme().dim, lineHeight: 12, height: 12 }} debugName="rpgkit-shop-legend">
                {`${props.legend()}`}
              </Text>
            </View>
      </Panel>

        {/* Message box: framed panel, four fixed text rows + legend, and
            the portrait column when the game passes faces. */}
      <Panel
            theme={theme()}
            style={{ posType: 1, height: 92, insetL: 8, insetR: 8, insetB: 8, display: messageDisplay() }}
            paperClass="flex-col p-[8]"
            debugName="rpgkit-message-box"
          >
            {/* With faces: a row filling the paper, portrait column then
                text column (flexDir 0 row, 1 column). Layout goes through
                style props, not new class strings, so every app's baked
                style table stays as it was. */}
            <Show when={props.faces} fallback={messageRows()}>
              <View style={{ flexDir: 0, grow: 1 }}>
                <View
                  style={{ width: props.faceWidth ?? FACE_WIDTH, height: FACE_PX, display: faceDisplay() }}
                  debugName="rpgkit-message-face"
                >
                  <Image
                    src={speaker().name ? props.faces![speaker().name!] : ""}
                    style={{ width: FACE_PX, height: FACE_PX }}
                  />
                </View>
                <View style={{ flexDir: 1, grow: 1 }}>{messageRows()}</View>
              </View>
            </Show>
      </Panel>
      {/* Name tab: overlaps the frame (border, and rim if any) so it
          reads as part of the box; paper-coloured text on the border. */}
      <Show when={props.faces}>
        <View
          style={{
            posType: 1,
            insetL: 20,
            insetB: BOX_TOP - (theme().rim ? 3 : 2),
            height: 15,
            flexDir: 0,
            paddingL: 6,
            paddingR: 6,
            bgColor: theme().border,
            display: messageDisplay() === 0 ? faceDisplay() : 1,
          }}
          debugName="rpgkit-message-name"
        >
          <Text class="text-xs" style={{ textColor: theme().paper, lineHeight: 15, height: 15 }}>
            {`${speaker().name ? speakerLabel(speaker().name!) : ""}`}
          </Text>
        </View>
      </Show>
    </View>
  );
  startupProfileMark("ui-dialog:end");
  return view;
}
