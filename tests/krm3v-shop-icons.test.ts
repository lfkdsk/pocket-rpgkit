// Opt-in shop item icon primitives. DialogBox uses these predicates before it
// changes a single row width or native node, keeping legacy `{ name }` tables
// on the original text-only path.

import { describe, expect, test } from "bun:test";
import type { DialogItemPresentation } from "../src/ui/DialogBox.tsx";
import {
  ITEM_ICON_GAP,
  ITEM_ICON_ROW_H,
  ITEM_ICON_W,
  itemIconBlockHeight,
  itemListHasResolvedIcon,
  resolvedItemIcon,
} from "../src/ui/item-icon.ts";

describe("KRM3V shop item icons", () => {
  test("legacy name-only and empty image entries do not opt into icon layout", () => {
    const items: Record<string, DialogItemPresentation> = {
      potion: { name: "Potion" },
      blank: { name: "Blank", icon: { src: "" } },
      elsewhere: { name: "Elsewhere", icon: { src: "assets/elsewhere.png" } },
    };

    expect(itemListHasResolvedIcon(["potion", "blank"], items)).toBe(false);
    expect(itemListHasResolvedIcon(["missing"], items)).toBe(false);
    // Art outside the currently-open shop must not switch its layout.
    expect(itemListHasResolvedIcon(["potion"], items)).toBe(false);
    expect(resolvedItemIcon(items.blank!.icon)).toBeNull();
  });

  test("one nonempty current icon enables the aligned layout and preserves its height", () => {
    const icon = { src: "assets/potion.png", h: 32 as const };
    const items: Record<string, DialogItemPresentation> = {
      potion: { name: "Potion", icon },
      rope: { name: "Rope" },
    };

    expect(itemListHasResolvedIcon(["potion", "rope"], items)).toBe(true);
    expect(resolvedItemIcon(items.potion!.icon)).toBe(icon);
    expect(ITEM_ICON_W + ITEM_ICON_GAP).toBe(22);
  });

  test("a partial icon table keeps missing current items as placeholders", () => {
    const items: Record<string, DialogItemPresentation> = {
      potion: { name: "Potion", icon: { src: "assets/potion.png" } },
      rope: { name: "Rope" },
    };

    expect(itemListHasResolvedIcon(["potion", "rope"], items)).toBe(true);
    expect(resolvedItemIcon(items.rope!.icon)).toBeNull();
  });

  test("the first icon line is 24px and wrapped lines retain 14px each", () => {
    expect(ITEM_ICON_ROW_H).toBe(24);
    expect(itemIconBlockHeight(1, 14)).toBe(24);
    expect(itemIconBlockHeight(2, 14)).toBe(38);
    expect(itemIconBlockHeight(4, 14)).toBe(66);
  });
});
