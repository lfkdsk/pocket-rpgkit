// src/ui/ChoiceIconBox.tsx — the choices box with a picture beside every
// option (ChoiceOption.icon); the `pocket-rpgkit/ui/choice-icons` entry.
// The sprite lookup is ui/choice-icons.ts.
//
// Pay for use: a game opts in by passing this component to GameView's
// `choiceIcons` (or DialogBox's `choiceIconBox`) prop, so games without
// icons do not bundle it. DialogBox mounts the box the first time a choices
// modal carries `icons` (the interpreter sets them only when an authored
// option has an icon) and keeps it mounted, hidden, afterwards; the
// text-only choices box renders exactly as before.
//
//   ┌──────────────────────────────┐  248 px wide, docked bottom right
//   │ Who do you ask?              │  (the message box is hidden during
//   │┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓│   choices, so the box takes its place
//   │┃ ☺  The curator             ┃│   and grows upward)
//   │┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛│  selected row: accent frame over an
//   │  ☺  The guide                │   accent tint, label in accent
//   │ [?] Someone else             │  missing sprite: framed "?" box
//   │                    ok  back  │
//   └──────────────────────────────┘
//
// Rows are 24 px. Icons draw at 1x, nearest-neighbour, in a 16x24 cell:
// a 16x16 image is centred in it; a 16x32 walker frame is anchored at its
// feet and its top 8 rows are clipped. Walker sheets leave that band for
// heads that overflow the tile above, and the Tuxemon characters (rows
// 11..30 of the frame) come out centred in the row, whole.

import { createMemo, For, type Accessor } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import type { ChoiceModal } from "../engine/interpreter.ts";
import { truncateLabel, windowStart } from "./list-window.ts";
import { Panel } from "./Panel.tsx";
import type { ChoiceIconArt, ChoiceIconResolver } from "./choice-icons.ts";
import type { UiTheme } from "./theme.ts";

export { resolveChoiceIcon, type ChoiceIconArt, type ChoiceIconBoxComponent, type ChoiceIconResolver } from "./choice-icons.ts";

const ROWS = [0, 1, 2, 3];
const ROW_H = 24;
/** A row's picture: art, MISSING (the "?" placeholder) or null (the option
 *  has no icon; its label stays aligned with the others). */
type RowArt = ChoiceIconArt | typeof MISSING | null;
const MISSING = 0;
const warned = new Set<string>();

/** Log a sprite key that cannot paint, once per key per session. The kit
 *  has no development build (the PocketJS build always defines
 *  NODE_ENV=production), so the warning is this one deduplicated line; the
 *  "?" placeholder in the row is the in-game signal. */
function missing(sprite: string): typeof MISSING {
  if (!warned.has(sprite)) {
    warned.add(sprite);
    console.warn(`pocket-rpgkit: choice icon sprite "${sprite}" cannot paint`);
  }
  return MISSING;
}

export interface ChoiceIconBoxProps {
  /** The open choices modal when it has icons, else null (box hidden). */
  modal: Accessor<ChoiceModal | null>;
  legend: Accessor<string>;
  theme: Accessor<UiTheme>;
  resolve?: ChoiceIconResolver;
}

export function ChoiceIconBox(props: ChoiceIconBoxProps) {
  const theme = props.theme;
  // Compared by content (the reducer may copy the modal on any step), so
  // the lookups, and any warning, run once per opened menu.
  const icons = createMemo(() => props.modal()?.icons, undefined, {
    equals: (a, b) =>
      a === b || (!!a && !!b && a.length === b.length && a.every((x, i) => {
        const y = b[i];
        return x === y || (!!x && !!y && x.sprite === y.sprite && x.dir === y.dir && x.frame === y.frame);
      })),
  });
  const arts = createMemo((): RowArt[] =>
    (icons() ?? []).map((icon) => icon && (props.resolve?.(icon) ?? missing(icon.sprite))));
  const index = () => props.modal()?.index ?? 0;
  const total = () => props.modal()?.options.length ?? 0;
  const start = () => windowStart(index(), total(), ROWS.length);
  const bar = () => ({ posType: 1, insetL: 0, insetR: 0, insetT: (index() - start()) * ROW_H, height: ROW_H });

  // Box 248 x 144: frame 2 + padding 6, prompt 14, gap 4, four rows,
  // gap 2, legend 12, padding 6 + frame 2.
  return (
    <Panel
      theme={theme()}
      style={{ posType: 1, width: 248, height: 144, insetR: 12, insetB: 8, display: props.modal() ? 0 : 1 }}
      paperClass="flex-col p-[6]"
      debugName="rpgkit-choices-icon-box"
    >
      <Text class="text-xs" style={{ textColor: theme().dim, lineHeight: 14, height: 14 }}>
        {props.modal()?.prompt ?? ""}
      </Text>
      <View style={{ height: ROWS.length * ROW_H, marginT: 4, flexDir: 1 }}>
        {/* The cursor bar under the rows, spanning icon and label: an
            accent tint and an opaque 1 px accent frame. */}
        <View style={{ ...bar(), bgColor: theme().accent, opacity: 0.2 }} />
        <View style={{ ...bar(), borderWidth: 1, borderColor: theme().accent }} />
        <For each={ROWS}>{(row) => iconRow(() => start() + row, props, arts, theme)}</For>
      </View>
      <Text class="text-xs" style={{ textColor: theme().dim, lineHeight: 12, height: 12, marginT: 2, textAlign: 2 }}>
        {`${props.legend()}`}
      </Text>
    </Panel>
  );
}

/** One 24 px row: the picture in a clipped 16 px cell 4 px in, the label
 *  6 px after it. */
function iconRow(at: () => number, props: ChoiceIconBoxProps, arts: Accessor<RowArt[]>, theme: Accessor<UiTheme>) {
  const option = () => props.modal()?.options[at()];
  const art = () => (option() === undefined ? null : arts()[at()] ?? null);
  const image = () => art() || null;
  const disabled = () => props.modal()?.enabled?.[at()] === false;
  return (
    <View style={{ height: ROW_H, flexDir: 0, align: 1, overflow: 1 }}>
      <Image
        src={image()?.src ?? ""}
        style={{
          posType: 1,
          insetL: 4,
          insetT: ROW_H - (image()?.h === 32 ? 32 : 20),
          width: 16,
          height: image()?.h ?? 16,
          display: image() ? 0 : 1,
        }}
      />
      <Text
        class="text-xs"
        style={{
          posType: 1,
          insetL: 4,
          insetT: 4,
          width: 16,
          height: 16,
          lineHeight: 16,
          textAlign: 1,
          textColor: theme().dim,
          bgColor: theme().paper,
          borderWidth: 1,
          borderColor: theme().dim,
          display: art() === MISSING ? 0 : 1,
        }}
      >
        ?
      </Text>
      <Text
        class="text-xs"
        style={{
          textColor: disabled() ? theme().dim : props.modal()?.index === at() ? theme().accent : theme().ink,
          lineHeight: 14,
          height: 14,
          marginL: 26,
        }}
      >
        {`${truncateLabel(option() ?? "", 24)}`}
      </Text>
    </View>
  );
}
