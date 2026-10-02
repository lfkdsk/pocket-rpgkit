// src/ui/world-cache-driver.ts — per-frame orchestration of the seamless
// world's layered caches. GameView constructs one only when the project
// carries a WorldLayout; projects without one never allocate it and their
// hot loop gains nothing but a single untaken branch.
//
// Each sync recomputes the working set (active/visible/imminent) from the
// current camera and player, advances cross-frame prefetch of the compiled
// keep-set, and evicts every layer to its keep-set when the set changes.
// Eviction and prefetch are derived-cache policy: they never publish map
// data (the transfer boundary still does) and never block the fold.
//
// Coordinate contract: the `camera` passed to `sync` is in component-world
// pixels — the same space as `GameViewWorldRuntime.cameraFor`'s output and
// `WorldComponent.bounds`. GameView passes its presented camera directly
// when a connected-world renderer is active; without one it promotes the
// legacy map-local camera by the active placement's origin. The driver
// never adds the origin itself. The player tile in `state.move` is always
// map-local, so the driver converts it to world tiles with the active
// placement before deriving the working set.

import { componentOfMap, workingSet } from "../engine/world-working-set.ts";
import { createWorldPrefetcher, type WorldPrefetcher } from "../engine/world-prefetch.ts";
import {
  releaseSessionMapLayers,
  releaseSessionMapsExcept,
  type Session,
  type SessionState,
} from "../engine/session.ts";
import type { CameraState, WorldLayout } from "../engine/types.ts";

export interface WorldCacheStats {
  active: string;
  visible: readonly string[];
  parsedKeep: readonly string[];
  compiledKeep: readonly string[];
  /** Resident parsed MapDefs (session.maps.size). */
  maps: number;
  /** Resident compiled worlds (session.worlds.size). */
  worlds: number;
  /** Resident compiled passage tables (session.tables.size). */
  tables: number;
  /** Fully staged, still unpublished maps. */
  staged: number;
  /** Imminent targets still missing stages. */
  pending: number;
  /** Staged preparations (session.preparingMaps.size). */
  preparing: number;
  /** Resident mutable passage overrides (session.runtimeTables.size). */
  runtime: number;
  /** Repository bytes still cached (map-repository stats().cached). */
  repoCached: number;
  failures: Readonly<Record<string, string>>;
}

export interface WorldCacheDriverOptions {
  /** Per-update prefetch budget in milliseconds. Defaults to 8. */
  budgetMs?: number;
  /** Clock for the budget; defaults to Date.now. */
  now?: () => number;
  /** Fires after every sync with the residency counters. */
  onStats?: (stats: WorldCacheStats) => void;
}

export interface WorldCacheDriver {
  /** Recompute the working set, advance prefetch, evict on change.
   *  `camera` is a component-world pixel rect (the same space as
   *  `GameViewWorldRuntime.cameraFor`); the driver intersects it against
   *  placements without adding any origin. */
  sync(state: Readonly<SessionState>, camera: Readonly<CameraState>, viewport: { w: number; h: number }): void;
}

export function createWorldCacheDriver(
  sess: Session,
  layout: Readonly<WorldLayout>,
  options: WorldCacheDriverOptions = {},
): WorldCacheDriver {
  const tile = sess.cfg.tile;
  const prefetcher: WorldPrefetcher = createWorldPrefetcher(sess, {
    budgetMs: options.budgetMs,
    now: options.now,
  });
  let lastActive: string | null = null;

  return {
    sync(state, camera, viewport) {
      const component = componentOfMap(layout, state.mapId);
      if (!component) {
        // An unplaced active map (indoor maps, portal-only destinations):
        // the legacy single-map policy, applied when the active map changes.
        if (lastActive !== state.mapId) {
          releaseSessionMapsExcept(sess, [state.mapId]);
          lastActive = state.mapId;
        }
        return;
      }
      const placement = component.placements.find((p) => p.mapId === state.mapId);
      if (!placement) return; // validated layout: unreachable
      // `camera` is already in component-world pixels (see the coordinate
      // contract in the file header and world-contract.ts); adding the
      // placement origin here would offset it twice. The player tile is
      // map-local, so it is converted to world tiles with the placement.
      const set = workingSet(
        layout,
        state.mapId,
        {
          x: camera.x,
          y: camera.y,
          w: viewport.w,
          h: viewport.h,
        },
        tile,
        {
          x: placement.originTileX + state.move.tx,
          y: placement.originTileY + state.move.ty,
        },
        state.move.facing,
      );
      const prefetchStats = prefetcher.update(set);
      // Enforce the keep-set every sync: the caches are tiny (bounded by the
      // keep-set itself), so this is a few Map deletions at most, and it
      // evicts maps acquired out-of-band as well as stale working-set members.
      releaseSessionMapLayers(sess, set.parsedKeep, set.compiledKeep, set.active);
      lastActive = state.mapId;
      options.onStats?.({
        active: set.active,
        visible: set.visible,
        parsedKeep: set.parsedKeep,
        compiledKeep: set.compiledKeep,
        maps: sess.maps.size,
        worlds: sess.worlds.size,
        tables: sess.tables.size,
        staged: prefetchStats.staged,
        pending: prefetchStats.pending,
        preparing: sess.preparingMaps.size,
        runtime: sess.runtimeTables.size,
        repoCached: sess.repository?.stats?.().cached ?? 0,
        failures: prefetchStats.failures,
      });
    },
  };
}
