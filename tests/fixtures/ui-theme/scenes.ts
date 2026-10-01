// tests/fixtures/ui-theme/scenes.ts — the named scenes of the ui-theme sim
// fixture, shared by the fixture app (ui-theme.tsx) and its test
// (tests/ui-theme-sim.test.ts). Every string the components display is a
// literal here, reachable from the fixture entry, so the build bakes its
// glyphs; the test only passes scene names.

import type { Modal } from "../../../src/engine/interpreter.ts";
import type { MenuState } from "../../../src/engine/save-menu.ts";
import type { SlotInfo } from "../../../src/ui/SaveMenu.tsx";
import type { UiTheme } from "../../../src/ui/theme.ts";

function text(lines: string[], revealed?: number): Modal {
  const total = lines.join("\n").length;
  const shown = revealed ?? total;
  return { kind: "text", fiber: "fixture", lines, total, revealed: shown, complete: shown >= total };
}

const SPEAKER = ["KEEPER: The lamp is lit tonight.", "Climb while the light holds."];

export const MODALS = {
  none: null,
  plain: text(["The road north is closed.", "Snow on the pass since dawn.", "Rest here until the plow comes."]),
  speaker: text(SPEAKER),
  // The speaker text without its prefix, as a plain line: the glyph
  // reference for the stripped speaker line.
  stripped: text(["The lamp is lit tonight.", "Climb while the light holds."]),
  clerk: text(["CLERK: Two letters for the farm.", "Sign here, please."]),
  // "KEEPER: " is 8 characters: 13 revealed shows five typed letters...
  typing: text(SPEAKER, 13),
  // ...which must look like this line fully revealed.
  typed: text(["The l"]),
  // Still inside the name prefix: nothing typed yet.
  prefix: text(SPEAKER, 5),
  // MAYOR has no portrait: a plain line.
  unknown: text(["MAYOR: Welcome to the valley.", "Mind the ice on the bridge."]),
  choices: {
    kind: "choices",
    fiber: "fixture",
    prompt: "Take the mountain road?",
    options: ["Climb now", "Wait for dawn", "Turn back"],
    index: 1,
    cancellable: true,
  },
  // T2-9: 8 options, scrolled so the cursor sits mid-list (row 5 of 8),
  // proving the 4-row window follows the live cursor past the fourth row.
  choices8: {
    kind: "choices",
    fiber: "fixture",
    prompt: "Choose your travel script",
    options: [
      "Mercenary route", "Diplomat route", "Smuggler route", "Pilgrim route",
      "Scholar route", "A label far too long to fit the choices box at all",
      "Hermit route", "Wanderer route",
    ],
    index: 5,
    cancellable: false,
  },
  // Same list, cursor at the top: window [0..3], proving the window
  // follows the cursor back up (not pinned wherever it last scrolled to).
  choices8Top: {
    kind: "choices",
    fiber: "fixture",
    prompt: "Choose your travel script",
    options: [
      "Mercenary route", "Diplomat route", "Smuggler route", "Pilgrim route",
      "Scholar route", "A label far too long to fit the choices box at all",
      "Hermit route", "Wanderer route",
    ],
    index: 0,
    cancellable: false,
  },
  // An extension-provided list carries stable keys and per-row enabled
  // state. The selected long label is both scrolled into row 1 and disabled.
  choicesDynamic: {
    kind: "choices",
    fiber: "fixture",
    prompt: "Choose your live route",
    options: [
      "Mercenary route", "Diplomat route", "Smuggler route", "Pilgrim route",
      "Scholar route", "A label far too long to fit the choices box at all",
      "Hermit route", "Wanderer route",
    ],
    keys: [
      "mercenary", "diplomat", "smuggler", "pilgrim",
      "scholar", "long-disabled", "hermit", "wanderer",
    ],
    enabled: [true, true, true, true, true, false, true, true],
    index: 5,
    cancellable: true,
  },
  // T2-10 shop buy stage: enough goods to exercise every row state —
  // affordable, unaffordable (torch costs more than the fixture's gold),
  // and at the backpack cap (rope already owns 99) — plus the sell tab.
  shopBuy: {
    kind: "shop",
    fiber: "fixture",
    gold: 42,
    sell: true,
    stage: "buy",
    index: 1,
    rows: [
      { kind: "item", item: "key", price: 10, owned: 0, canAfford: true, atCap: false, stock: null, sellable: true },
      { kind: "item", item: "torch", price: 999, owned: 0, canAfford: false, atCap: false, stock: null, sellable: true },
      { kind: "item", item: "rope", price: 5, owned: 99, canAfford: true, atCap: true, stock: null, sellable: true },
      { kind: "sell" },
      { kind: "leave" },
    ],
  },
  // Sell stage: the player's own stock, selected on the second row.
  shopSell: {
    kind: "shop",
    fiber: "fixture",
    gold: 42,
    sell: true,
    stage: "sell",
    index: 1,
    rows: [
      { kind: "item", item: "key", price: 5, owned: 2, canAfford: true, atCap: false, stock: null, sellable: true },
      { kind: "item", item: "rope", price: 2, owned: 99, canAfford: true, atCap: false, stock: null, sellable: true },
      { kind: "back" },
    ],
  },
  // B1: a buy row with finite shop stock remaining (row0, "(3)" next to the
  // price) and one that has sold out (row1, dimmed like the backpack cap —
  // affordable and under the cap, but stock:0 alone disables it).
  shopBuyStock: {
    kind: "shop",
    fiber: "fixture",
    gold: 42,
    sell: false,
    stage: "buy",
    index: 0,
    rows: [
      { kind: "item", item: "key", price: 10, owned: 0, canAfford: true, atCap: false, stock: 3, sellable: true },
      { kind: "item", item: "torch", price: 5, owned: 0, canAfford: true, atCap: true, stock: 0, sellable: true },
      { kind: "leave" },
    ],
  },
  // B4: sell stage with an unsellable row (row1, "Rope" priced at 0 — the
  // sellList:"disable" default keeps it listed but dimmed) beside a normal
  // sellable one (row0, selected, accent).
  shopSellDisabled: {
    kind: "shop",
    fiber: "fixture",
    gold: 42,
    sell: true,
    stage: "sell",
    index: 0,
    rows: [
      { kind: "item", item: "key", price: 5, owned: 2, canAfford: true, atCap: false, stock: null, sellable: true },
      { kind: "item", item: "rope", price: 0, owned: 1, canAfford: true, atCap: false, stock: null, sellable: false },
      { kind: "back" },
    ],
  },
} satisfies Record<string, Modal | null>;

/** Shop box item display names (DialogBox `items` prop). */
export const ITEMS: Record<string, { name: string }> = {
  key: { name: "Iron Key" },
  torch: { name: "Torch" },
  rope: { name: "Rope" },
};

export const MENUS = {
  closed: { kind: "closed" },
  root: { kind: "root", index: 1 },
  slots: { kind: "slots-save", index: 0 },
  code: { kind: "code-export", page: 0 },
  message: { kind: "message", title: "SAVED - SLOT 1", body: "Your progress is stored.", back: { kind: "root", index: 0 } },
} satisfies Record<string, MenuState>;

export const THEMES = {
  default: undefined,
  // Every colour replaced, with the optional rim ring.
  parchment: {
    border: "#7a4a2a",
    rim: "#e8a050",
    paper: "#f4ecd8",
    ink: "#302820",
    dim: "#8a6040",
    accent: "#c03020",
    backdrop: "#101418",
  },
  // A partial override without a rim: the rest stays the kit default.
  slate: { border: "#c0c8d0", paper: "#2a3a4a" },
} satisfies Record<string, Partial<UiTheme> | undefined>;

/** Portraits written by gen-assets.ts (faces.ts). */
export const FACES: Record<string, string> = {
  KEEPER: "assets/face-keeper.png",
  CLERK: "assets/face-clerk.png",
};

export const SAVE_TITLE = "FIELD OFFICE - SAVE";
export const SLOTS: SlotInfo = [{ slot: 1, map: "hub", frame: 1200, checksum: "00000000" }, null, { slot: 3, error: "bad checksum" }];
export const CODE = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_".repeat(6);

export interface FixtureScene {
  modal?: keyof typeof MODALS;
  /** Override text reveal to exercise every row and legend boundary. */
  revealed?: number;
  menu?: keyof typeof MENUS;
  theme?: keyof typeof THEMES;
  /** Pass FACES to the DialogBox. */
  faces?: boolean;
  /** Pass SAVE_TITLE to the SaveMenu. */
  title?: boolean;
  /** Pass ITEMS to the DialogBox (shop row display names). */
  items?: boolean;
}
