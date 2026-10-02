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
import { windowByRows, wrapLabel } from "./list-window.ts";
import { flowRows, revealRows } from "./text-flow.ts";
import { DIALOG_ROWS, FACE_WIDTH, dialogColumnWidth, messagePage, messageSpeaker, pageRevealed, shownMessageLines } from "./dialog-pages.ts";
import { slotMeasure } from "./text-measure.ts";
import { Panel } from "./Panel.tsx";
import { resolveUiTheme, speakerLabel, type SpeakerSplit, type UiTheme } from "./theme.ts";
import { startupProfileMark } from "../startup-profile.ts";
import type { ChoiceIconBoxComponent, ChoiceIconResolver } from "./choice-icons.ts";

/** Portrait images are 64x64: pak images must be power-of-two. */
const FACE_PX = 64;
/** The message box's top edge, measured up from the layer bottom
 *  (insetB 8 + height 92); the name tab sits on it. */
const BOX_TOP = 100;

export interface DialogBoxProps {
  modal: Accessor<Modal | null>;
  legend: Accessor<string>;
  /** Screen width for fixed message cells; omit to retain intrinsic layout. */
  viewportWidth?: number;
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
  /** The choices box for options with an `icon` (pocket-rpgkit/ui/choice-icons
   *  ChoiceIconBox). Opt-in, so games without icons do not bundle it; while
   *  it is absent an icon choice opens the text-only box (labels only) and
   *  logs one warning. */
  choiceIconBox?: ChoiceIconBoxComponent;
  /** Maps an option's `icon` to baked art for choiceIconBox (GameView passes
   *  resolveChoiceIcon over the project's sprites). An icon this returns
   *  null for (or every icon, without the prop) shows a "?" placeholder. */
  choiceIcon?: ChoiceIconResolver;
}

/** Rows visible at once in the choices/shop box (T2-9: up to 8 choice
 *  options and an unbounded shop goods list scroll a 4-item window). */
const VISIBLE_ROWS = 4;
/** Content width of the choices and shop boxes: 248 outer, 2 px border and
 *  6 px padding each side, 1 px more each side for a theme rim. A label
 *  wider than it (after the cursor prefix) wraps onto more rows; nothing
 *  is cut. */
const LIST_TEXT_WIDTH = 248 - 2 * (2 + 6);
/** The choices/shop box: 96 px for a one-row prompt/header and four item
 *  rows; each further row adds LIST_ROW_H and the box grows upward. */
const LIST_BOX_H = 96;
const LIST_ROW_H = 14;
/** Rows the choices/shop box may add before it would leave a 272 px
 *  screen (its bottom sits 98 px up): 272 - 98 - 96 = 78 px, five rows.
 *  Past that the item window scrolls by rows. */
const LIST_EXTRA_ROWS = 5;
/** The message box: 92 px for four rows; a page that needs more rows at
 *  a window narrower than the design width grows it upward. */
const MESSAGE_BOX_H = 92;
const MESSAGE_ROW_H = 15;
/** Row cursor prefixes ("> " selected, "  " not); the label is fitted to
 *  what remains after the wider of the two. */
const CURSOR_ON = "> ";
const CURSOR_OFF = "  ";
const NO_SPEAKER: SpeakerSplit = { name: null, rest: "", cut: 0 };
const EMPTY_LINES: readonly string[] = [];
const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
const sameRange = (a: number[], b: number[]): boolean => a.length === b.length;

/** One drawn row of the choices or shop box: an item's first row carries
 *  the cursor prefix (and a shop price), its further rows indent. */
interface ListRow {
  item: number;
  left: string;
  right: string;
}

/** The rows of a scrolled list: the window around `index` (windowByRows)
 *  with every row of every item in it. */
function listRows(
  index: number,
  labels: readonly (readonly string[])[],
  rights: readonly string[],
  maxRows: number,
): ListRow[] {
  const { start, end } = windowByRows(index, labels.map((rows) => rows.length), VISIBLE_ROWS, maxRows);
  const out: ListRow[] = [];
  for (let item = start; item < end; item++) {
    labels[item]!.forEach((text, j) => {
      out.push({
        item,
        left: `${j > 0 ? CURSOR_OFF : item === index ? CURSOR_ON : CURSOR_OFF}${text}`,
        right: j === 0 ? rights[item] ?? "" : "",
      });
    });
  }
  return out;
}
const sameLines = (a: readonly string[], b: readonly string[]): boolean =>
  a === b || (a.length === b.length && a.every((line, i) => line === b[i]));

/** A shop item row's right column. Finite shop stock (B1) shows next to the
 *  price; unlimited goods (stock: null, and every sell-stage row) show the
 *  price alone. */
function priceLabel(r: Extract<ShopRow, { kind: "item" }>): string {
  const stockSuffix = r.stock !== null ? ` (${r.stock})` : "";
  return `${r.price}g${stockSuffix}`;
}
let warnedNoIconBox = false;

export function DialogBox(props: DialogBoxProps) {
  startupProfileMark("ui-dialog:start");
  const theme = createMemo(() => resolveUiTheme(props.theme));
  const choice = createMemo(() => {
    const modal = props.modal();
    return modal?.kind === "choices" ? modal : null;
  });
  const shop = createMemo(() => {
    const modal = props.modal();
    return modal?.kind === "shop" ? modal : null;
  });
  const message = createMemo(() => {
    const modal = props.modal();
    return modal?.kind === "text" ? modal : null;
  });
  // Choices whose options carry icons open the icon box (ChoiceIconBox.tsx);
  // it mounts on first use, so games without icons never build it.
  const IconBox = props.choiceIconBox;
  const iconChoice = createMemo(() => {
    const m = choice();
    if (!m?.icons) return null;
    if (IconBox) return m;
    if (!warnedNoIconBox) {
      warnedNoIconBox = true;
      console.warn("pocket-rpgkit: choice icons need the choiceIconBox prop (ui/choice-icons); showing labels only");
    }
    return null;
  });
  const iconBoxMounted = createMemo((was: boolean) => was || iconChoice() !== null, false);
  const textChoice = createMemo(() => (iconChoice() ? null : choice()));
  const isChoice = () => textChoice() !== null;
  // Re-evaluated per typed character; downstream only sees a new speaker.
  const speaker = createMemo(
    () => {
      const m = message();
      if (m?.kind !== "text") return NO_SPEAKER;
      return messageSpeaker(m.lines, props.faces);
    },
    NO_SPEAKER,
    { equals: (a, b) => a.name === b.name && a.cut === b.cut && a.rest === b.rest },
  );
  // display: 0 shows, 1 hides (the column and the tab stay mounted).
  const faceDisplay = createMemo(() => (speaker().name ? 0 : 1));
  // All three boxes stay mounted and hide while unused: opening a dialog updates
  // text rows instead of mounting the box subtree (on a 333 MHz PSP a mount
  // costs about 100 ms of QuickJS time).
  const choicesDisplay = createMemo(() => (isChoice() ? 0 : 1));
  const shopDisplay = createMemo(() => (shop() ? 0 : 1));
  const messageDisplay = createMemo(() => (message() ? 0 : 1));
  const textWidth = createMemo(() => props.viewportWidth === undefined
    ? Number.NaN
    : dialogColumnWidth(
        { viewportWidth: props.viewportWidth, faces: props.faces, faceWidth: props.faceWidth },
        speaker().name !== null,
      ));
  const measure = slotMeasure();
  // Row width the text may fill: the Text node's width, less the rim's 1 px
  // inner border on each side when the theme draws one.
  const textBudget = createMemo(() => textWidth() - (theme().rim ? 2 : 0));
  const listBudget = createMemo(() => LIST_TEXT_WIDTH - (theme().rim ? 2 : 0));
  const labelBudget = createMemo(() => listBudget() - Math.max(measure(CURSOR_ON), measure(CURSOR_OFF)));
  // Choices: the prompt and each option wrap at the box's width; the
  // window shows whole options, four at most, and the box grows by the
  // extra rows (up to LIST_EXTRA_ROWS, then the window narrows). The
  // window is a pure function of the live cursor index: never desyncs
  // from the reducer, and wrap-around (top<->bottom) recomputes it with
  // no leftover scroll state.
  const choicePrompt = createMemo(() => wrapLabel(textChoice()?.prompt ?? "", listBudget(), measure), [""], { equals: sameLines });
  const promptSlots = createMemo(() => range(choicePrompt().length), [0], { equals: sameRange });
  // Compared by content, so a cursor move does not re-wrap the labels.
  const choiceOptions = createMemo(() => textChoice()?.options ?? EMPTY_LINES, EMPTY_LINES, { equals: sameLines });
  const choiceLabels = createMemo(() => choiceOptions().map((option) => wrapLabel(option, labelBudget(), measure)));
  const choiceRows = createMemo(() => {
    const m = textChoice();
    if (!m) return [];
    return listRows(m.index, choiceLabels(), [], VISIBLE_ROWS + LIST_EXTRA_ROWS - (choicePrompt().length - 1));
  });
  const choiceSlots = createMemo(() => range(Math.max(VISIBLE_ROWS, choiceRows().length)), range(VISIBLE_ROWS), { equals: sameRange });
  const choiceBoxH = () => LIST_BOX_H + LIST_ROW_H * (promptSlots().length - 1 + choiceSlots().length - VISIBLE_ROWS);
  // Shop: an item name wraps beside its price column (plus a 6 px gap);
  // the price stays on the name's first row.
  const shopLabels = createMemo(() => {
    const m = shop();
    if (!m) return { labels: [] as string[][], rights: [] as string[] };
    const rights = m.rows.map((r) => (r.kind === "item" ? priceLabel(r) : ""));
    const labels = m.rows.map((r, i) => {
      if (r.kind !== "item") return [r.kind === "sell" ? "Sell" : r.kind === "leave" ? "Leave" : "Back"];
      const name = props.items?.[r.item]?.name ?? r.item;
      return wrapLabel(name, labelBudget() - measure(rights[i]!) - 6, measure);
    });
    return { labels, rights };
  });
  const shopRows = createMemo(() => {
    const m = shop();
    if (!m) return [];
    const { labels, rights } = shopLabels();
    return listRows(m.index, labels, rights, VISIBLE_ROWS + LIST_EXTRA_ROWS);
  });
  const shopSlots = createMemo(() => range(Math.max(VISIBLE_ROWS, shopRows().length)), range(VISIBLE_ROWS), { equals: sameRange });
  const shopBoxH = () => LIST_BOX_H + LIST_ROW_H * (shopSlots().length - VISIBLE_ROWS);
  const messageLegend = createMemo(() => message()?.complete ? props.legend() : "");
  // The rows a message lays out in (text-flow.ts): authored lines that fit
  // stay as they are; a wider line wraps at the text column's pixel width
  // (CJK between characters with kinsoku, Latin at spaces). A message the
  // interpreter split into pages (dialog-pages.ts) shows one page at a
  // time. Recomputed when the words, the page or the column change, not
  // per typed character.
  const shownLines = createMemo(
    () => {
      const m = message();
      if (m?.kind !== "text") return EMPTY_LINES;
      return shownMessageLines(m.lines, speaker());
    },
    EMPTY_LINES,
    { equals: sameLines },
  );
  const pageStarts = createMemo(() => message()?.pageStarts);
  const page = createMemo(() => message()?.page ?? 0);
  const pageLines = createMemo(
    () => messagePage(shownLines(), speaker().cut, pageStarts(), page()),
    EMPTY_LINES,
    { equals: sameLines },
  );
  const flow = createMemo(() => flowRows(pageLines(), textBudget(), DIALOG_ROWS, measure));
  // Four rows, more only when a page needs them (a window narrower than
  // the width pages are cut at).
  const textRows = createMemo(() => range(Math.max(DIALOG_ROWS, flow().rows.length)), range(DIALOG_ROWS), { equals: sameRange });
  const extraTextH = () => (textRows().length - DIALOG_ROWS) * MESSAGE_ROW_H;
  const textLines = createMemo(() => {
    const m = message();
    if (m?.kind !== "text") return textRows().map(() => "");
    const shown = pageRevealed(m.revealed, speaker().cut, pageStarts(), page());
    const visible = revealRows(flow(), shown);
    return textRows().map((i) => visible[i] ?? "");
  });

  // Solid replaces an empty string's Text child on the next character. Keep
  // a space in that child and hide its row instead: revealing it only
  // restyles and replaces the retained leaf.
  // Four text rows + the legend row; the column holding them is the paper
  // itself, or the text column right of the portrait when faces are on.
  const messageRows = () => (
    <>
      <For each={textRows()}>
        {(row) => {
          const line = createMemo(() => textLines()[row]!);
          return (
            <Text
              class="text-xs"
              style={{
                textColor: theme().ink,
                lineHeight: MESSAGE_ROW_H,
                height: MESSAGE_ROW_H,
                width: textWidth(),
                display: line() ? 0 : 1,
              }}
              debugName={`rpgkit-message-row-${row}`}
            >
              {line() || " "}
            </Text>
          );
        }}
      </For>
      <View class="flex-row justify-end" style={{ height: 12 }}>
        <Text
          class="text-xs"
          style={{
            textColor: theme().dim,
            lineHeight: 12,
            height: 12,
            width: textWidth(),
            textAlign: 2,
            display: messageLegend() ? 0 : 1,
          }}
          debugName="rpgkit-message-legend"
        >
          {messageLegend() || " "}
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
          this box, MV parity). A long prompt or option wraps and the box
          grows upward. */}
      <Panel
        theme={theme()}
        style={{ posType: 1, width: 248, height: choiceBoxH(), insetR: 12, insetB: 98, display: choicesDisplay() }}
        paperClass="flex-col p-[6]"
        debugName="rpgkit-choices-box"
      >
        <For each={promptSlots()}>
          {(row) => (
            <Text
              class="text-xs"
              style={{ textColor: theme().dim, lineHeight: LIST_ROW_H, height: LIST_ROW_H }}
              debugName={row === 0 ? "rpgkit-choice-prompt" : `rpgkit-choice-prompt-${row}`}
            >
              {`${choicePrompt()[row] ?? ""}`}
            </Text>
          )}
        </For>
        <View class="flex-col" style={{ height: 4 }} />
        <For each={choiceSlots()}>
          {(slot) => {
            const m = textChoice;
            const row = () => choiceRows()[slot];
            const selected = () => row() !== undefined && m()!.index === row()!.item;
            const disabled = () => row() !== undefined && m()!.enabled?.[row()!.item] === false;
            return (
              <Text
                class="text-xs"
                style={{ textColor: disabled() ? theme().dim : selected() ? theme().accent : theme().ink, lineHeight: LIST_ROW_H, height: LIST_ROW_H }}
                debugName={`rpgkit-choice-${slot}`}
              >
                {`${row()?.left ?? ""}`}
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
      {IconBox && (
        <Show when={iconBoxMounted()}>
          <IconBox modal={iconChoice} legend={props.legend} theme={theme} resolve={props.choiceIcon} />
        </Show>
      )}

      {/* Shop box: same footprint and docking as the choices box, with a
            stage/gold header row instead of a prompt and a scrolling row
            list (T2-10). Buy rows a player cannot afford, has capped out
            (backpack cap) or that are out of stock (B1) render dimmed;
            sell rows for an unsellable item (B4) do too. Every dimmed row
            stays navigable, just unconfirmable. */}
      <Panel
            theme={theme()}
            style={{ posType: 1, width: 248, height: shopBoxH(), insetR: 12, insetB: 98, display: shopDisplay() }}
            paperClass="flex-col p-[6]"
            debugName="rpgkit-shop-box"
          >
            <View class="flex-row justify-between" style={{ height: 14 }}>
              <Text class="text-xs" style={{ textColor: theme().dim, lineHeight: 14, height: 14 }} debugName="rpgkit-shop-stage">
                {`${(() => {
                  const m = shop();
                  return m?.kind === "shop" ? (m.stage === "buy" ? "Buy" : "Sell") : "";
                })()}`}
              </Text>
              <Text class="text-xs" style={{ textColor: theme().dim, lineHeight: 14, height: 14 }} debugName="rpgkit-shop-gold">
                {`${(() => {
                  const m = shop();
                  return m?.kind === "shop" ? `Gold: ${m.gold}` : "";
                })()}`}
              </Text>
            </View>
            <View class="flex-col" style={{ height: 4 }} />
            <For each={shopSlots()}>
              {(slot) => {
                const m = shop;
                const row = () => shopRows()[slot];
                const shopRow = (): ShopRow | null => (row() ? m()!.rows[row()!.item]! : null);
                const selected = () => row() !== undefined && m()!.index === row()!.item;
                // Buy: unaffordable, capped, or out-of-stock rows are inert
                // (T2-10 backpack cap / B1 finite stock). Sell: an
                // unsellable row (B4 — sellList:"disable") stays listed but
                // cannot be confirmed.
                const disabled = () => {
                  const r = shopRow();
                  if (!r || r.kind !== "item") return false;
                  return m()!.stage === "buy" ? !r.canAfford || r.atCap : !r.sellable;
                };
                const rowColor = () => (disabled() ? theme().dim : selected() ? theme().accent : theme().ink);
                return (
                  <View class="flex-row justify-between" style={{ height: LIST_ROW_H }} debugName={`rpgkit-shop-row-${slot}`}>
                    <Text class="text-xs" style={{ textColor: rowColor(), lineHeight: LIST_ROW_H, height: LIST_ROW_H }}>
                      {`${row()?.left ?? ""}`}
                    </Text>
                    <Text class="text-xs" style={{ textColor: rowColor(), lineHeight: LIST_ROW_H, height: LIST_ROW_H }}>
                      {`${row()?.right ?? ""}`}
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
            style={{ posType: 1, height: MESSAGE_BOX_H + extraTextH(), insetL: 8, insetR: 8, insetB: 8, display: messageDisplay() }}
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
            insetB: BOX_TOP + extraTextH() - (theme().rim ? 3 : 2),
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
            {speaker().name ? speakerLabel(speaker().name!) : " "}
          </Text>
        </View>
      </Show>
    </View>
  );
  startupProfileMark("ui-dialog:end");
  return view;
}
