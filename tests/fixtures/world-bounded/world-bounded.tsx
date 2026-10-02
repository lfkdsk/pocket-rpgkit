// tests/fixtures/world-bounded/world-bounded.tsx — mounts GameView with
// BOTH the connected-world renderer (W2) and the cache driver (W3) so the
// bounded-residency sim exercises the real production wiring: a world
// camera feeds the renderer and the driver, and the driver's keep-sets
// bound every session/terrain layer as the player walks the line.
//
// The project is split into a shell plus on-demand map entries (the same
// shape as a packaged game), so the session loads maps through a
// repository and the driver's layered eviction actually runs.

import { mount } from "@pocketjs/framework";
import { GameView, createWorldCacheDriver, type WorldCacheStats } from "../../../src/ui/index.ts";
import { createWorldRenderer } from "../../../src/ui/world/index.ts";
import type { WorldStreamedTerrainStats } from "../../../src/ui/WorldStreamedTerrain.tsx";
import { createJsonMapRepository } from "../../../src/engine/map-repository.ts";
import { splitProjectMaps } from "../../../tools/lib/map-project.ts";
import { GAME_ASSETS } from "./assets-game.ts";
import { WORLD_BOUNDED_PROJECT } from "./fixture-data.ts";

export interface WorldBoundedStats {
  driver?: WorldCacheStats;
  ground?: WorldStreamedTerrainStats;
  upper?: WorldStreamedTerrainStats;
}

declare global {
  // eslint-disable-next-line no-var
  var __worldBoundedStats: WorldBoundedStats | undefined;
}

const stats: WorldBoundedStats = {};
globalThis.__worldBoundedStats = stats;

const split = splitProjectMaps(WORLD_BOUNDED_PROJECT);
const files = new Map(split.entries.map((entry) => [entry.meta.id, entry.bytes]));
const repository = createJsonMapRepository(split.shell.mapIndex, {
  read: (entry) => {
    const meta = split.shell.mapIndex.find((m) => m.entry === entry);
    return meta ? files.get(meta.id) : undefined;
  },
});

mount(() => (
  <GameView
    project={split.shell}
    maps={repository}
    assets={GAME_ASSETS}
    world={createWorldRenderer()}
    createWorldCacheDriver={(session, layout) => createWorldCacheDriver(session, layout, {
      budgetMs: 1000,
      onStats: (s) => { stats.driver = s; },
    })}
    onStreamStats={(layer, value) => { stats[layer] = value as WorldStreamedTerrainStats; }}
  />
));
