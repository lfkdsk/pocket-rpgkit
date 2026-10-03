// AUTO-GENERATED shape for the deterministic KRM3 select-item fixture assets.

import type { GameAssets } from "../../../src/ui/game-assets.ts";

const GROUND = [
  "assets/map-krm3-select-room-ground.png",
] as const;
const UPPER = [
  "assets/map-krm3-select-room-upper.png",
] as const;

export const GAME_ASSETS: GameAssets = {
  ground: { "krm3-select-room": GROUND },
  upper: { "krm3-select-room": UPPER },
  chunkColumns: { "krm3-select-room": 1 },
  maxChunks: 1,
  world: { "krm3-select-room": { w: 256, h: 256 } },
  order: ["krm3-select-room"],
  npcSrc: {},
  player: {
    idle: ["assets/player.png", "assets/player.png", "assets/player.png", "assets/player.png"] as const,
    walkL: ["assets/player.png", "assets/player.png", "assets/player.png", "assets/player.png"] as const,
    walkR: ["assets/player.png", "assets/player.png", "assets/player.png", "assets/player.png"] as const,
  },
  layers: {},
};
