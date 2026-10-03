// tests/krm3-select-item.test.ts — built-in RPG Maker select-item scene rules.

import { describe, expect, test } from "bun:test";
import type { ExtensionReadContext } from "../src/engine/extensions.ts";
import {
  SELECT_ITEM_SCENE_ID,
  itemNumericId,
  selectItemList,
  selectItemRules,
  type SelectItemState,
} from "../src/engine/select-item.ts";
import type { Item, JsonValue, VariableValue } from "../src/engine/types.ts";

const CATALOG: Item[] = [
  { id: "item001", name: "Potion", sprite: "s", type: "regular" },
  { id: "item002", name: "Key Card", sprite: "s", type: "key" },
  { id: "weapon001", name: "Sword", sprite: "s", kind: "weapon" },
  { id: "item003", name: "Hidden A", sprite: "s", type: "hiddenA" },
  { id: "item004", name: "Hidden B", sprite: "s", type: "hiddenB" },
  { id: "item005", name: "Ether", sprite: "s", type: "regular" },
];

/** The party holds one of every catalog item except item003/item004. */
const HOLDS: Record<string, number> = {
  item001: 2,
  item002: 1,
  weapon001: 1,
  item005: 3,
};

function context(catalog?: Item[], items: Record<string, number> = HOLDS): ExtensionReadContext {
  return {
    ext: null,
    switches: {},
    variables: {},
    items,
    gold: 0,
    playerName: "Hero",
    ...(catalog ? { itemCatalog: catalog } : {}),
  };
}

function start(
  args: JsonValue = { variable: "pick", itemType: "regular" },
  catalog?: Item[],
  items?: Record<string, number>,
): SelectItemState {
  const started = selectItemRules.start({ marker: 1 }, args, 123, context(catalog, items));
  if (started === null) throw new Error("select item did not start");
  return started.state as unknown as SelectItemState;
}

function step(
  state: SelectItemState,
  edges: { confirm?: boolean; cancel?: boolean; up?: boolean; down?: boolean } = {},
): SelectItemState {
  return selectItemRules.step(state as unknown as JsonValue, {
    buttons: 0,
    confirmEdge: edges.confirm === true,
    cancelEdge: edges.cancel === true,
    upEdge: edges.up === true,
    downEdge: edges.down === true,
  }, 1) as unknown as SelectItemState;
}

function done(state: SelectItemState): Record<string, VariableValue> {
  const completion = selectItemRules.done(state as unknown as JsonValue);
  if (!completion) throw new Error("select item did not complete");
  return { ...(completion.writes ?? {}) };
}

describe("KRM3 built-in select item", () => {
  test("exports the registered scene id and requires a variable destination", () => {
    expect(SELECT_ITEM_SCENE_ID).toBe("rpgkit.selectItem");
    expect(selectItemRules.start(null, { itemType: "regular" }, 0, context())).toBeNull();
    expect(selectItemRules.start(null, { variable: "", itemType: "regular" }, 0, context())).toBeNull();
  });

  test("lists only held database items of the requested type (MV Window_EventItem)", () => {
    // MV lists $gameParty.allItems() filtered by DataManager.isItem and the
    // chosen itypeId: held items only, weapons/armors excluded.
    expect(selectItemList(CATALOG, "regular", HOLDS).map((e) => e.id)).toEqual(["item001", "item005"]);
    expect(selectItemList(CATALOG, "key", HOLDS).map((e) => e.id)).toEqual(["item002"]);
    expect(selectItemList(CATALOG, "hiddenA", HOLDS).map((e) => e.id)).toEqual([]);
    expect(selectItemList(CATALOG, "hiddenB", HOLDS).map((e) => e.id)).toEqual([]);
    expect(selectItemList(undefined, "regular", HOLDS)).toEqual([]);
  });

  test("an item the party does not hold is not listed even when the type matches", () => {
    const holds = { item001: 0, item005: 9 };
    expect(selectItemList(CATALOG, "regular", holds).map((e) => e.id)).toEqual(["item005"]);
    expect(selectItemList(CATALOG, "regular", {}).map((e) => e.id)).toEqual([]);
  });

  test("a held weapon or armor is never offered", () => {
    const holds = { weapon001: 5, item001: 1 };
    expect(selectItemList(CATALOG, "regular", holds).map((e) => e.id)).toEqual(["item001"]);
  });

  test("defaults a missing itemType to regular", () => {
    const state = start({ variable: "pick" }, CATALOG);
    expect(state.itemType).toBe("regular");
    expect(state.items.map((e) => e.id)).toEqual(["item001", "item005"]);
  });

  test("confirm writes the chosen item's numeric id", () => {
    let state = start({ variable: "pick", itemType: "regular" }, CATALOG);
    state = step(state, { down: true }); // item005
    state = step(state, { confirm: true });
    expect(done(state)).toEqual({ pick: 5 });
  });

  test("up/down wrap around the list", () => {
    let state = start({ variable: "pick", itemType: "regular" }, CATALOG);
    state = step(state, { up: true }); // wraps to last
    expect(state.index).toBe(1);
    state = step(state, { down: true }); // wraps to first
    expect(state.index).toBe(0);
  });

  test("cancel writes 0 (MV parity)", () => {
    let state = start({ variable: "pick", itemType: "key" }, CATALOG);
    state = step(state, { cancel: true });
    expect(done(state)).toEqual({ pick: 0 });
  });

  test("an empty list completes with 0", () => {
    let state = start({ variable: "pick", itemType: "key" }, [], {});
    expect(state.items).toEqual([]);
    state = step(state, { confirm: true });
    expect(done(state)).toEqual({ pick: 0 });
  });

  test("numeric id helper", () => {
    expect(itemNumericId("item007")).toBe(7);
    expect(itemNumericId("weapon12")).toBe(12);
    expect(itemNumericId("plain")).toBe(0);
  });

  test("a mid-edit state is not yet complete", () => {
    const state = start({ variable: "pick", itemType: "regular" }, CATALOG);
    expect(selectItemRules.done(state as unknown as JsonValue)).toBeNull();
  });
});
