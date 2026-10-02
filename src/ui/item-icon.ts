// Shared presentation data and geometry for icon-bearing item lists. This
// plain-TypeScript seam lets DialogBox accept the optional row component
// without pulling its Image-heavy implementation into games that do not opt
// in (the same split used by ChoiceIconBox).

import type { Component } from "solid-js";

export interface ItemIconArt {
  src: string;
  h?: 16 | 32;
}

export interface ItemIconRowProps {
  /** Art for the first line. null draws the deterministic "?" placeholder. */
  icon: ItemIconArt | null;
  /** Only the first wrapped line owns the icon/placeholder; later lines keep
   * the same gutter so their label stays aligned. */
  firstLine: boolean;
  cursor: string;
  label: string;
  price: string;
  width: number;
  leftWidth: number;
  cursorWidth: number;
  priceWidth: number;
  height: number;
  lineHeight: number;
  leftMarquee: number;
  rightMarquee: number;
  rightClipped: boolean;
  textColor: string;
  dimColor: string;
  paperColor: string;
  debugName: string;
}

/** Opt-in row component supplied from `pocket-rpgkit/ui/item-icons`. */
export type ItemIconRowComponent = Component<ItemIconRowProps>;

/** Height and horizontal footprint of the icon cell in an item row. */
export const ITEM_ICON_ROW_H = 24;
export const ITEM_ICON_W = 16;
export const ITEM_ICON_GAP = 6;

/** Empty image keys are deliberately unresolved: they must not opt a list
 * into icon layout or create an empty Image node in an otherwise plain list. */
export function resolvedItemIcon(icon: ItemIconArt | undefined): ItemIconArt | null {
  return icon && icon.src.length > 0 ? icon : null;
}

/** Whether the ids in the currently-open list contain any drawable art. */
export function itemListHasResolvedIcon(
  ids: readonly string[],
  items: Readonly<Record<string, { icon?: ItemIconArt }>> | undefined,
): boolean {
  return ids.some((id) => resolvedItemIcon(items?.[id]?.icon) !== null);
}

/** Pixel height of an icon-bearing logical item with `lines` wrapped rows. */
export function itemIconBlockHeight(lines: number, lineHeight: number): number {
  return ITEM_ICON_ROW_H + Math.max(0, lines - 1) * lineHeight;
}
