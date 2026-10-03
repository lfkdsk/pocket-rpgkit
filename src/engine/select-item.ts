// src/engine/select-item.ts — the built-in RPG Maker select-item scene.
//
// An event opens the scene with `{ variable, itemType }`. The scene lists
// the database items (not weapons or armors) the party currently holds,
// whose `type` matches (items without a type are "regular"), in catalog
// order — MV's Window_EventItem lists $gameParty.allItems() filtered by
// DataManager.isItem and itypeId. Confirm writes the chosen item's numeric
// id (the trailing integer of its id, MV's database id) to `variable`;
// cancel writes 0 (MV parity: the variable is set to 0 on cancel). With no
// matching item the list is empty and confirming or cancelling both write 0.
//
// Pure reducer: the item list, cursor and phase all live in JSON state, so
// replay and rewind reproduce the same interaction. The UI maps ids to
// names from the project catalog.

import { deepClone } from "./clone.ts";
import type { ExtensionReadContext } from "./extensions.ts";
import type { SceneCompletion, SceneRules, SceneStart } from "./scene.ts";
import type { Item, JsonValue } from "./types.ts";

export const SELECT_ITEM_SCENE_ID = "rpgkit.selectItem";

export type SelectItemType = "regular" | "key" | "hiddenA" | "hiddenB";

export interface SelectItemArgs {
  /** Variable id receiving the chosen item's numeric id (0 on cancel). */
  variable: string;
  /** Which catalog items to list. */
  itemType: SelectItemType;
}

export interface SelectItemEntry {
  id: string;
  name: string;
}

export interface SelectItemState {
  variable: string;
  itemType: SelectItemType;
  /** Catalog items of the matching type, in catalog order. The name is
   *  carried in state so the scene UI is pure presentation of JSON (it has
   *  no project catalog of its own). */
  items: SelectItemEntry[];
  /** Cursor row. */
  index: number;
  phase: "edit" | "done";
  /** Set when the player cancelled (writes 0). */
  cancelled: boolean;
  ext: JsonValue;
}

function record(value: JsonValue): Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}

function normalizeItemType(value: JsonValue): SelectItemType {
  return value === "key" || value === "hiddenA" || value === "hiddenB" ? value : "regular";
}

function itemMatches(item: Item, type: SelectItemType, inventory: Readonly<Record<string, number>>): boolean {
  // MV parity: only database items the party currently holds, and only the
  // chosen itypeId. Weapons and armors are never offered (DataManager.isItem
  // is false for them), and an item the party does not hold is not listed.
  if (item.kind !== undefined && item.kind !== "item") return false;
  if ((item.type ?? "regular") !== type) return false;
  return (inventory[item.id] ?? 0) > 0;
}

/** The trailing integer of an id like "item007" (MV's database id), or 0. */
export function itemNumericId(id: string): number {
  const match = /(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

function stateOf(value: JsonValue): SelectItemState {
  return value as unknown as SelectItemState;
}

/** The held items the scene lists for a catalog + type, in catalog order. */
export function selectItemList(
  catalog: readonly Item[] | undefined,
  type: SelectItemType,
  inventory: Readonly<Record<string, number>>,
): SelectItemEntry[] {
  if (!catalog) return [];
  const out: SelectItemEntry[] = [];
  for (const item of catalog) {
    if (itemMatches(item, type, inventory)) out.push({ id: item.id, name: item.name });
  }
  return out;
}

/** Register under SELECT_ITEM_SCENE_ID in createSession's `scenes` map. */
export const selectItemRules: SceneRules = {
  start(ext, rawArgs, _seed, ctx): SceneStart | null {
    const args = record(rawArgs);
    const variable = typeof args.variable === "string" && args.variable.length > 0
      ? args.variable
      : null;
    // `variable` is the required destination. A malformed direct scene call
    // is skipped instead of opening a picker that cannot commit anywhere.
    if (variable === null) return null;
    const itemType = normalizeItemType(args.itemType);
    const state: SelectItemState = {
      variable,
      itemType,
      items: selectItemList(ctx.itemCatalog, itemType, ctx.items),
      index: 0,
      phase: "edit",
      cancelled: false,
      ext: deepClone(ext),
    };
    return { ext: deepClone(ext), state: state as unknown as JsonValue };
  },

  step(rawState, input): JsonValue {
    const state = stateOf(rawState);
    if (state.phase !== "edit") return rawState;
    const count = state.items.length;
    if (count > 0) {
      if (input.upEdge) state.index = (state.index + count - 1) % count;
      if (input.downEdge) state.index = (state.index + 1) % count;
    }
    if (input.confirmEdge) {
      state.phase = "done";
      state.cancelled = false;
    } else if (input.cancelEdge) {
      // MV parity: cancel writes 0, not "no write".
      state.phase = "done";
      state.cancelled = true;
    }
    return rawState;
  },

  done(rawState): SceneCompletion | null {
    const state = stateOf(rawState);
    if (state.phase !== "done") return null;
    const value = state.cancelled || state.items.length === 0
      ? 0
      : itemNumericId(state.items[state.index]!.id);
    // Not flagged cancelled: a cancel still commits the 0 write (MV parity).
    return { ext: state.ext, writes: { [state.variable]: value } };
  },
};
