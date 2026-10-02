// Editor-only adapters for rendering an arbitrary in-memory Project through
// the production GameView. Generated TILESET entries supply each 16px cell;
// map arrays select those cells directly, so unsaved edits are visible.

import type { BattleRules } from "../../src/engine/battle.ts";
import type { SceneRules } from "../../src/engine/scene.ts";
import type { JsonValue, Project, TileId } from "../../src/engine/types.ts";
import type { GameAssets, GameScreenLayerAssets, NpcArt } from "../../src/ui/game-assets.ts";
import {
  PLAYTEST_NPC_SRC,
  PLAYTEST_PLAYER,
  PLAYTEST_SHEET_REFS,
} from "./playtest-assets.ts";
import { diagnosePlaytestProject, playtestSceneIds } from "./playtest.ts";

/** Art a host supplies at run time in place of the editor's stand-ins (the
 *  preview page builds it from the images a frontend sends). Render-only:
 *  it changes what is drawn, never the session. */
export interface PlaytestArt {
  /** Sheet id -> its runtime tile key and cell count. Cell `n` of the sheet
   *  streams as the ref `${key}#${n}`; cells past `cells` draw nothing. */
  sheets?: Readonly<Record<string, { key: string; cells: number }>>;
  /** Sprite id -> art that replaces (or fills in for) the stand-in. */
  sprites?: Readonly<Record<string, NpcArt>>;
  /** Loads the runtime tile keys (and delegates every other key);
   *  becomes StreamedGameAssets.loadTile. */
  loadTile?: (key: string, index: number) => number;
}

function tileRefs(art: PlaytestArt | undefined): (tile: TileId) => string | null {
  const sheets = art?.sheets;
  return (tile) => {
    if (tile === null) return null;
    const dot = tile.lastIndexOf(".");
    if (dot < 1) return null;
    const sheet = tile.slice(0, dot);
    const cell = Number(tile.slice(dot + 1));
    if (!Number.isInteger(cell) || cell < 0) return null;
    const supplied = sheets && Object.prototype.hasOwnProperty.call(sheets, sheet) ? sheets[sheet] : undefined;
    if (supplied) return cell < supplied.cells ? `${supplied.key}#${cell}` : null;
    const refs = PLAYTEST_SHEET_REFS[sheet];
    return refs ? refs[cell] ?? null : null;
  };
}

export function createPlaytestAssets(project: Project, art?: PlaytestArt): GameAssets {
  const tileRef = tileRefs(art);
  const ground: Record<string, readonly (string | null)[]> = {};
  const upper: Record<string, readonly (string | null)[]> = {};
  const columns: Record<string, number> = {};
  const world: Record<string, { w: number; h: number }> = {};
  let maxActors = 0;

  for (const map of project.maps) {
    ground[map.id] = map.ground.map(tileRef);
    const upperCells: (string | null)[] = new Array(map.width * map.height).fill(null);
    for (const [index, tile] of map.upper ?? []) {
      if (index >= 0 && index < upperCells.length) upperCells[index] = tileRef(tile);
    }
    upper[map.id] = upperCells;
    columns[map.id] = map.width;
    world[map.id] = { w: map.width * project.tileSize, h: map.height * project.tileSize };
    maxActors = Math.max(maxActors, map.events?.length ?? 0);
  }

  const layers: Record<string, GameScreenLayerAssets> = {};
  for (const issue of diagnosePlaytestProject(project)) {
    if (issue.kind !== "backdrop") continue;
    const slash = issue.key.lastIndexOf("/");
    const layer = issue.key.slice(0, slash);
    const variant = issue.key.slice(slash + 1);
    const current = layers[layer] ?? {
      placement: "screen",
      defaultVisible: false,
      variants: {},
    };
    layers[layer] = {
      ...current,
      variants: {
        ...current.variants,
        [variant]: { color: "#2b193f", opacity: 1 },
      },
    };
  }

  return {
    ground: {},
    upper: {},
    chunkColumns: {},
    maxChunks: 1,
    maxActors,
    world,
    order: project.maps.map((map) => map.id),
    npcSrc: art?.sprites ? { ...PLAYTEST_NPC_SRC, ...art.sprites } : PLAYTEST_NPC_SRC,
    player: PLAYTEST_PLAYER,
    stream: { chunkPx: 16, ground, upper, columns, margin: 0, ...(art?.loadTile ? { loadTile: art.loadTile } : {}) },
    layers,
  };
}

interface PreviewBattleState {
  kind: "editor-preview-battle";
  setup: JsonValue;
  ext: JsonValue;
  result: "win" | "escape" | null;
}

function battleState(value: JsonValue): PreviewBattleState {
  return value as unknown as PreviewBattleState;
}

/** Deterministic editor fallback: confirm continues through the authored win
 * branch, cancel through escape. It never interprets the opaque setup. */
export const PLAYTEST_BATTLE_RULES: BattleRules = {
  start(ext, setup) {
    return {
      state: { kind: "editor-preview-battle", setup, ext, result: null },
      ext,
    };
  },
  step(state, input) {
    const current = battleState(state);
    return {
      ...current,
      result: input.confirmEdge ? "win" : input.cancelEdge ? "escape" : current.result,
    };
  },
  done(state) {
    const current = battleState(state);
    return current.result === null ? null : { ext: current.ext, result: current.result };
  },
};

interface PreviewSceneState {
  kind: "editor-preview-scene";
  args: JsonValue;
  ext: JsonValue;
  result: "ok" | "cancel" | null;
}

function sceneState(value: JsonValue): PreviewSceneState {
  return value as unknown as PreviewSceneState;
}

/** Deterministic editor fallback: confirm continues through the authored
 * onDone branch, cancel through onCancel. It never interprets the opaque
 * args. The placeholder view learns the scene id from its GameView
 * sceneViews key, not from this state. */
export const PLAYTEST_SCENE_RULES: SceneRules = {
  start(ext, args) {
    return {
      state: { kind: "editor-preview-scene", args, ext, result: null },
      ext,
    };
  },
  step(state, input) {
    const current = sceneState(state);
    return {
      ...current,
      result: input.confirmEdge ? "ok" : input.cancelEdge ? "cancel" : current.result,
    };
  },
  done(state) {
    const current = sceneState(state);
    if (current.result === null) return null;
    return current.result === "cancel" ? { ext: current.ext, cancelled: true } : { ext: current.ext };
  },
};

/** Placeholder SceneRules for every scene id the document references, so
 *  the playtest session previews scenes instead of throwing the engine's
 *  unregistered-scene startup error. */
export function playtestSceneRules(project: Project): Record<string, SceneRules> {
  return Object.fromEntries(playtestSceneIds(project).map((id) => [id, PLAYTEST_SCENE_RULES]));
}
