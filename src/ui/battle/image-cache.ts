// Battle-owned lifecycle for opt-in TILESET images. GameView deliberately
// keeps a battle subtree mounted after first use, so `active=false` — not
// component cleanup — marks the end of one battle's pinned working set.

import { createRenderEffect, onCleanup, type Accessor } from "solid-js";
import {
  TileTextureCache,
  type TileTextureCacheOptions,
} from "../tile-texture-cache.ts";

export function createBattleImageCache(
  active: Accessor<boolean>,
  options: TileTextureCacheOptions = {},
): TileTextureCache {
  const cache = new TileTextureCache(options);
  createRenderEffect(() => {
    if (active()) cache.beginScope();
    else cache.endScope();
  });
  onCleanup(() => cache.endScope());
  return cache;
}
