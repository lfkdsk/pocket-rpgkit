// tests/fixtures/ui-text/assets-game.ts — the pak names gen-assets.ts writes.
import type { GameAssets } from "../../../src/ui/game-assets.ts";

const WALKER = {
  idle: ["assets/walker.png", "assets/walker.png", "assets/walker.png", "assets/walker.png"] as const,
  walkL: ["assets/walker.png", "assets/walker.png", "assets/walker.png", "assets/walker.png"] as const,
  walkR: ["assets/walker.png", "assets/walker.png", "assets/walker.png", "assets/walker.png"] as const,
};

export const GAME_ASSETS: GameAssets = {
  ground: { "ui-text-field": ["assets/map-ui-text-field-ground.png"], "ui-text-field-2": ["assets/map-ui-text-field-ground.png"] },
  upper: { "ui-text-field": ["assets/map-ui-text-field-upper.png"], "ui-text-field-2": ["assets/map-ui-text-field-upper.png"] },
  chunkColumns: { "ui-text-field": 1, "ui-text-field-2": 1 },
  maxChunks: 1,
  world: { "ui-text-field": { w: 64, h: 64 }, "ui-text-field-2": { w: 64, h: 64 } },
  order: ["ui-text-field", "ui-text-field-2"],
  npcSrc: {},
  player: WALKER,
  maxActors: 1,
};
