// tests/fixtures/cjk-text/assets-game.ts — the pak names gen-assets.ts writes.
import type { GameAssets } from "../../../src/ui/game-assets.ts";

const WALKER = {
  idle: ["assets/walker.png", "assets/walker.png", "assets/walker.png", "assets/walker.png"] as const,
  walkL: ["assets/walker.png", "assets/walker.png", "assets/walker.png", "assets/walker.png"] as const,
  walkR: ["assets/walker.png", "assets/walker.png", "assets/walker.png", "assets/walker.png"] as const,
};

export const GAME_ASSETS: GameAssets = {
  ground: { "cjk-field": ["assets/map-cjk-field-ground.png"] },
  upper: { "cjk-field": ["assets/map-cjk-field-upper.png"] },
  chunkColumns: { "cjk-field": 1 },
  maxChunks: 1,
  world: { "cjk-field": { w: 64, h: 64 } },
  order: ["cjk-field"],
  npcSrc: {},
  player: WALKER,
};
