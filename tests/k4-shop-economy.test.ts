// tests/k4-shop-economy.test.ts — comprehensive shop economy regressions.
//
// The first describe block is the Tuxemon economy census shape as a single
// automatic regression: two shops, the same item selling back at two
// different prices, a condition-gated good, and a finite-stock good that
// survives a real createSnapshot/encodeEnvelope/restoreSessionEnvelope
// round trip, a sell-back that restocks it, and agreement across 60/30/20/4
// Hz and across two replays of the same save checkpoint.
//
// The second is B3: a schema-legal but huge initialGold/sellPrice (JSON
// Schema's "integer" only rejects a fractional part, not a huge magnitude)
// must not let a shop sale push state.sw.gold non-finite; the write has to
// clamp through the same normalizer as every other numeric bank, or the
// save it produces can never be read back.

import { describe, expect, test } from "bun:test";
import { createSwitchState, type ShopModal } from "../src/engine/interpreter.ts";
import { createSnapshot, encodeEnvelope } from "../src/engine/save.ts";
import { restoreSessionEnvelope } from "../src/engine/save-restore.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionInput,
  type SessionState,
} from "../src/engine/session.ts";
import { validateSchema } from "../src/engine/schema-validate.ts";
import schema from "../src/data/schema.json" with { type: "json" };
import type { GameEvent, MapDef, Project, ShopGood } from "../src/engine/types.ts";

function tick(session: Session, state: SessionState, input: Partial<SessionInput> = {}): SessionState {
  return stepSession(session, state, { buttons: 0, ...input });
}

function shop(state: SessionState): ShopModal {
  expect(state.interp.modal?.kind).toBe("shop");
  return state.interp.modal as ShopModal;
}

function currentRow(state: SessionState): ShopModal["rows"][number] {
  const modal = shop(state);
  return modal.rows[modal.index]!;
}

function seek(
  session: Session,
  state: SessionState,
  predicate: (row: ShopModal["rows"][number]) => boolean,
): SessionState {
  for (let n = 0; n < shop(state).rows.length; n++) {
    if (predicate(currentRow(state))) return state;
    state = tick(session, state, { downEdge: true });
  }
  throw new Error("shop row not found");
}

const northGoods: ShopGood[] = [
  { item: "potion", price: 100, sellPrice: 50 },
  { item: "tm_avalanche", price: 2_000, sellPrice: 400, stock: 1 },
  {
    item: "tuxeball_diurnal",
    price: 300,
    sellPrice: 150,
    condition: { all: [{ kind: "switch", id: "daytime", value: true }] },
  },
];

const southGoods: ShopGood[] = [
  { item: "potion", price: 20, sellPrice: 5 },
  { item: "revive", price: 100, sellPrice: 20 },
];

function map(id: string, shopId: string, goods: ShopGood[], destination: string): MapDef {
  const merchant: GameEvent = {
    id: "merchant",
    x: 1,
    y: 0,
    pages: [{
      trigger: "action",
      sprite: null,
      commands: [
        { op: "shop", id: shopId, goods, sell: true, sellList: "hide" },
        { op: "transfer", map: destination, x: 0, y: 0, dir: "right" },
      ],
    }],
  };
  return {
    id,
    name: id,
    width: 3,
    height: 1,
    sheets: ["town"],
    ground: ["town.0", "town.0", "town.0"],
    events: [merchant],
  };
}

const project: Project = {
  format: "rpgkit-project/v1",
  title: "Economy census fixture",
  tileSize: 16,
  start: { map: "north", x: 0, y: 0, dir: "right" },
  sheets: [{ id: "town", pak: "chunks", cols: 1, rows: 1, defaultPassage: "pass" }],
  items: [
    { id: "potion", name: "Potion", sprite: "town.0", price: 100 },
    { id: "revive", name: "Revive", sprite: "town.0", price: 1_000 },
    { id: "tm_avalanche", name: "Avalanche", sprite: "town.0", price: 2_000 },
    { id: "tuxeball_diurnal", name: "Diurnal", sprite: "town.0", price: 300 },
  ],
  system: { inventory: { maxPerItem: 999_999, maxKinds: 99 } },
  maps: [
    map("north", "spyder_cotton_tech", northGoods, "south"),
    map("south", "tuxe_mart_taba", southGoods, "north"),
  ],
};

function itemRows(state: SessionState): string[] {
  return shop(state).rows.flatMap((row) => (row.kind === "item" ? [row.item] : []));
}

interface Summary {
  savedStock: number;
  southPotionSellPrice: number;
  northPotionSellPrice: number;
  finalStock: number;
  finalGold: number;
  finalItems: Record<string, number>;
  finalMap: string;
}

const EXPECTED_SUMMARY: Summary = {
  savedStock: 0,
  southPotionSellPrice: 5,
  northPotionSellPrice: 50,
  finalStock: 1,
  finalGold: 3_455,
  finalItems: { potion: 0, tm_avalanche: 0 },
  finalMap: "south",
};

// Resumes from a real save envelope (already at the south shop with the
// north shop's stock persisted at 0), sells the held potion at each shop's
// own sellPrice, buys the finite-stock good back, and reports the final
// numbers so two independent runs (replay / cross-Hz) can be compared.
function runTail(session: Session, envelope: string): Summary {
  let state = restoreSessionEnvelope(session, envelope);
  expect(state.mapId).toBe("south");
  expect(state.sw.shopStock["spyder_cotton_tech:tm_avalanche"]).toBe(0);

  state = tick(session, state, { confirmEdge: true });
  state = seek(session, state, (row) => row.kind === "sell");
  state = tick(session, state, { confirmEdge: true });
  const southPotion = shop(state).rows.find((row) => row.kind === "item" && row.item === "potion");
  expect(southPotion?.kind).toBe("item");
  expect((southPotion as { price: number }).price).toBe(5);
  state = tick(session, state, { confirmEdge: true }); // sell one held potion at 5g
  state = tick(session, state, { cancelEdge: true }); // sell stage -> back to buy stage
  state = tick(session, state, { cancelEdge: true }); // leave the shop, transfer to north
  expect(state.mapId).toBe("north");

  state = tick(session, state, { confirmEdge: true });
  state = seek(session, state, (row) => row.kind === "sell");
  state = tick(session, state, { confirmEdge: true }); // buy stage -> sell stage
  const northPotion = shop(state).rows.find((row) => row.kind === "item" && row.item === "potion");
  expect(northPotion?.kind).toBe("item");
  expect((northPotion as { price: number }).price).toBe(50);
  state = seek(session, state, (row) => row.kind === "item" && row.item === "potion");
  state = tick(session, state, { confirmEdge: true }); // sell the last held potion at 50g
  expect(state.sw.items.potion).toBe(0);

  // The potion row drops out of the sell list (owned hit 0); the cursor
  // stays put and now lands on tm_avalanche, still in the sell stage.
  expect(currentRow(state).kind).toBe("item");
  expect((currentRow(state) as { item: string }).item).toBe("tm_avalanche");
  state = tick(session, state, { confirmEdge: true }); // sell tm_avalanche back: this shop restocks it
  expect(state.sw.shopStock["spyder_cotton_tech:tm_avalanche"]).toBe(1);
  state = tick(session, state, { cancelEdge: true }); // sell stage -> back to buy stage
  state = tick(session, state, { cancelEdge: true }); // leave the shop

  return {
    savedStock: 0,
    southPotionSellPrice: (southPotion as { price: number }).price,
    northPotionSellPrice: (northPotion as { price: number }).price,
    finalStock: state.sw.shopStock["spyder_cotton_tech:tm_avalanche"]!,
    finalGold: state.sw.gold,
    finalItems: { ...state.sw.items },
    finalMap: state.mapId,
  };
}

function run(hz: number): Summary {
  const session = createSession(project, hz);
  let state = startSession(
    project,
    session,
    createSwitchState({ gold: 5_000, items: { potion: 2 }, switches: { daytime: false } }),
  );

  state = tick(session, state, { confirmEdge: true });
  expect(itemRows(state)).toEqual(["potion", "tm_avalanche"]); // tuxeball_diurnal hidden: daytime false
  state = seek(session, state, (row) => row.kind === "item" && row.item === "tm_avalanche");
  state = tick(session, state, { confirmEdge: true }); // buy the last tm_avalanche: stock 1 -> 0
  expect(state.sw.shopStock["spyder_cotton_tech:tm_avalanche"]).toBe(0);
  state = tick(session, state, { cancelEdge: true });
  expect(state.mapId).toBe("south");

  // Snapshot at the tile boundary just after transferring, then encode and
  // restore through the real save envelope (not a raw JSON round-trip) so
  // the finite stock actually survives production save/load.
  const snapshot = createSnapshot(state.mapId, state.move, state.interp, 0);
  const envelope = encodeEnvelope(snapshot, session.content);
  const first = runTail(session, envelope);
  const replay = runTail(session, envelope); // same checkpoint replayed twice must agree
  expect(replay).toEqual(first);
  return first;
}

describe("B1-test: Tuxemon economy census shape (multi-shop, save round trip)", () => {
  test("the project census shape validates against the v1 schema", () => {
    expect(validateSchema(schema, project)).toEqual([]);
  });

  test("a daytime-gated good is hidden until its switch condition is met", () => {
    const session = createSession(project, 60);
    let state = startSession(
      project,
      session,
      createSwitchState({ gold: 5_000, items: { potion: 2 }, switches: { daytime: true } }),
    );
    state = tick(session, state, { confirmEdge: true });
    expect(itemRows(state)).toEqual(["potion", "tm_avalanche", "tuxeball_diurnal"]);
  });

  test("buying and selling never mutate retained item or finite-stock banks", () => {
    const session = createSession(project, 60);
    let state = startSession(
      project,
      session,
      createSwitchState({ gold: 5_000, items: { potion: 2 } }),
    );

    state = tick(session, state, { confirmEdge: true });
    state = seek(session, state, (row) => row.kind === "item" && row.item === "tm_avalanche");
    const beforeBuy = state;
    const beforeBuyJson = JSON.stringify(beforeBuy);
    state = tick(session, state, { confirmEdge: true });
    expect(JSON.stringify(beforeBuy)).toBe(beforeBuyJson);
    expect(beforeBuy.sw.items.tm_avalanche).toBeUndefined();
    expect(beforeBuy.sw.shopStock["spyder_cotton_tech:tm_avalanche"]).toBeUndefined();
    expect(state.sw.items.tm_avalanche).toBe(1);
    expect(state.sw.shopStock["spyder_cotton_tech:tm_avalanche"]).toBe(0);

    state = tick(session, state, { cancelEdge: true }); // north -> south
    state = tick(session, state, { confirmEdge: true });
    state = tick(session, state, { cancelEdge: true }); // south -> north
    state = tick(session, state, { confirmEdge: true });
    state = seek(session, state, (row) => row.kind === "sell");
    state = tick(session, state, { confirmEdge: true });
    state = seek(session, state, (row) => row.kind === "item" && row.item === "tm_avalanche");
    const beforeSell = state;
    const beforeSellJson = JSON.stringify(beforeSell);
    state = tick(session, state, { confirmEdge: true });
    expect(JSON.stringify(beforeSell)).toBe(beforeSellJson);
    expect(beforeSell.sw.items.tm_avalanche).toBe(1);
    expect(beforeSell.sw.shopStock["spyder_cotton_tech:tm_avalanche"]).toBe(0);
    expect(state.sw.items.tm_avalanche).toBe(0);
    expect(state.sw.shopStock["spyder_cotton_tech:tm_avalanche"]).toBe(1);
  });

  test(
    "two shops sell the same item back at different prices, a finite-stock good survives a " +
      "real save/restore round trip and restocks on sell-back, and a save checkpoint replays identically",
    () => {
      expect(run(60)).toEqual(EXPECTED_SUMMARY);
    },
  );

  test("the same script folds to the identical economy outcome at 60/30/20/4 Hz", () => {
    const summaries = [60, 30, 20, 4].map((hz) => run(hz));
    for (const summary of summaries) expect(summary).toEqual(EXPECTED_SUMMARY);
  });
});

describe("B3: a schema-legal overflow initialGold/sellPrice still saves and reloads", () => {
  const MAX = Number.MAX_SAFE_INTEGER;

  test("initialGold: 1e308 and a shop sellPrice: 1e308 clamp on sale and survive a real envelope round trip", () => {
    const merchant: GameEvent = {
      id: "merchant",
      x: 0,
      y: 0,
      pages: [{
        trigger: "action",
        sprite: null,
        commands: [
          { op: "item", item: "relic", set: "add", count: 1 }, // instant: folds before the shop opens
          { op: "shop", id: "overflow_shop", goods: [{ item: "relic", price: 100, sellPrice: 1e308 }], sell: true },
        ],
      }],
    };
    const overflowProject: Project = {
      format: "rpgkit-project/v1",
      title: "Overflow economy fixture",
      tileSize: 16,
      initialGold: 1e308,
      start: { map: "town", x: 0, y: 0, dir: "right" },
      sheets: [{ id: "town", pak: "chunks", cols: 1, rows: 1, defaultPassage: "pass" }],
      items: [{ id: "relic", name: "Relic", sprite: "town.0", price: 100 }],
      maps: [{ id: "town", name: "town", width: 1, height: 1, sheets: ["town"], ground: ["town.0"], events: [merchant] }],
    };
    expect(validateSchema(schema, overflowProject)).toEqual([]); // schema has no upper bound: the clamp is a runtime invariant

    const session = createSession(overflowProject, 60);
    let state = startSession(overflowProject, session); // no sw0: exercises the initialGold seed path
    expect(Number.isFinite(state.sw.gold)).toBe(true);
    expect(state.sw.gold).toBe(MAX);

    state = tick(session, state, { confirmEdge: true }); // adds the relic, then opens the shop (buy stage)
    state = seek(session, state, (row) => row.kind === "sell");
    state = tick(session, state, { confirmEdge: true }); // buy stage -> sell stage
    state = tick(session, state, { confirmEdge: true }); // sell the relic at 1e308, clamped
    expect(Number.isFinite(state.sw.gold)).toBe(true);
    expect(state.sw.gold).toBe(MAX);
    state = tick(session, state, { cancelEdge: true }); // sell stage -> back to buy stage
    state = tick(session, state, { cancelEdge: true }); // leave the shop (tile boundary, no modal)

    const snapshot = createSnapshot(state.mapId, state.move, state.interp, 0);
    const envelope = encodeEnvelope(snapshot, session.content); // throws on a non-finite gold
    const restored = restoreSessionEnvelope(session, envelope);
    expect(restored.sw.gold).toBe(MAX);
  });
});
