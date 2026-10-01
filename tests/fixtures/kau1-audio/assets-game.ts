import type { GameAssets } from "../../../src/ui/game-assets.ts";

const WALKER = {
  idle: ["assets/walker.png", "assets/walker.png", "assets/walker.png", "assets/walker.png"],
  walkL: ["assets/walker.png", "assets/walker.png", "assets/walker.png", "assets/walker.png"],
  walkR: ["assets/walker.png", "assets/walker.png", "assets/walker.png", "assets/walker.png"],
} as const;

export const GAME_ASSETS: GameAssets = {
  ground: { "kau1-field": ["assets/map-kau1-field-ground.png"] },
  upper: { "kau1-field": ["assets/map-kau1-field-upper.png"] },
  chunkColumns: { "kau1-field": 1 },
  maxChunks: 1,
  world: { "kau1-field": { w: 64, h: 64 } },
  order: ["kau1-field"],
  npcSrc: {},
  player: WALKER,
};
