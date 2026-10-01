// tools/lib/chunks.ts — build-time map baking for GameView games: every map
// becomes row-major 512x512 ground and star-layer chunks (one chunk for a
// map up to 32x32 tiles), and gameManifestSource() writes the GameAssets
// module the game mounts. Pure RGBA functions: no filesystem and no PNG
// codec, so any cooker produces the same bytes for the same tiles. Used by
// examples/sunstone/gen-assets.ts; the same functions bake projects
// imported from Tiled in the PocketJS working copy.

import { CHUNK_PX, CHUNK_TILES, TILE } from "../../src/engine/tiles.ts";
import type { MapDef, TileId } from "../../src/engine/types.ts";

/** Edge of the per-map ground/upper canvas (pow2 <= spec TEX_MAX_DIM). Map
 *  tiles paint from the top-left; GameView clips the canvas to the map. */
export const MAP_CANVAS = 512;

export interface RgbaImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export interface BakedChunkLayers {
  columns: number;
  rows: number;
  ground: Uint8Array[];
  upper: Uint8Array[];
}

/** Copy the 16x16 cell whose top-left pixel is (x0, y0). */
export function cutCell(img: RgbaImage, x0: number, y0: number): Uint8Array {
  if (x0 < 0 || y0 < 0 || x0 + TILE > img.width || y0 + TILE > img.height) {
    throw new Error(`cutCell: (${x0},${y0}) +${TILE} outside ${img.width}x${img.height}`);
  }
  const tile = new Uint8Array(TILE * TILE * 4);
  for (let y = 0; y < TILE; y++) {
    const src = ((y0 + y) * img.width + x0) * 4;
    tile.set(img.rgba.subarray(src, src + TILE * 4), y * TILE * 4);
  }
  return tile;
}

/** Composite a 16x16 straight-alpha RGBA tile over the canvas at (px0, py0)
 *  with the Porter-Duff "over" operator. Opaque texels replace, transparent
 *  texels leave the canvas untouched. */
export function blitTile(canvas: Uint8Array, canvasW: number, px0: number, py0: number, art: Uint8Array): void {
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const sp = (y * TILE + x) * 4;
      const a = art[sp + 3]!;
      const dp = ((py0 + y) * canvasW + (px0 + x)) * 4;
      if (a === 255) {
        canvas.set(art.subarray(sp, sp + 4), dp);
      } else if (a !== 0) {
        const da = canvas[dp + 3]!;
        const below = (da * (255 - a)) / 255;
        const outA = a + below;
        for (let k = 0; k < 3; k++) {
          canvas[dp + k] = Math.round((art[sp + k]! * a + canvas[dp + k]! * below) / outA);
        }
        canvas[dp + 3] = Math.round(outA);
      }
    }
  }
}

/** Bake one map into its ground and upper MAP_CANVAS canvases. `pad`, when
 *  given, first tiles the whole ground canvas (the map rect then paints
 *  over it); void (null) ground cells stay transparent. */
export function bakeMapCanvases(
  map: MapDef,
  tileArt: (tile: TileId) => Uint8Array | null,
  pad: Uint8Array | null,
): { ground: Uint8Array; upper: Uint8Array } {
  if (map.width * TILE > MAP_CANVAS || map.height * TILE > MAP_CANVAS) {
    throw new Error(`bake: map ${map.id} (${map.width}x${map.height}) exceeds the ${MAP_CANVAS}px canvas`);
  }
  const ground = new Uint8Array(MAP_CANVAS * MAP_CANVAS * 4);
  if (pad) {
    for (let py = 0; py < MAP_CANVAS; py += TILE) {
      for (let px = 0; px < MAP_CANVAS; px += TILE) blitTile(ground, MAP_CANVAS, px, py, pad);
    }
  }
  for (let ty = 0; ty < map.height; ty++) {
    for (let tx = 0; tx < map.width; tx++) {
      const art = tileArt(map.ground[ty * map.width + tx] ?? null);
      if (art) blitTile(ground, MAP_CANVAS, tx * TILE, ty * TILE, art);
    }
  }
  const upper = new Uint8Array(MAP_CANVAS * MAP_CANVAS * 4);
  for (const [idx, tileId] of map.upper ?? []) {
    const art = tileArt(tileId);
    if (art) blitTile(upper, MAP_CANVAS, (idx % map.width) * TILE, Math.floor(idx / map.width) * TILE, art);
  }
  return { ground, upper };
}

/** Bake an arbitrary-size map as row-major 512x512 chunks. The one-chunk
 *  case delegates to the original baker, preserving every existing byte. */
export function bakeMapChunks(
  map: MapDef,
  tileArt: (tile: TileId) => Uint8Array | null,
  pad: Uint8Array | null,
): BakedChunkLayers {
  const columns = Math.ceil(map.width / CHUNK_TILES);
  const rows = Math.ceil(map.height / CHUNK_TILES);
  if (columns === 1 && rows === 1) {
    const baked = bakeMapCanvases(map, tileArt, pad);
    return { columns, rows, ground: [baked.ground], upper: [baked.upper] };
  }

  const count = columns * rows;
  const ground = Array.from({ length: count }, () => new Uint8Array(CHUNK_PX * CHUNK_PX * 4));
  const upper = Array.from({ length: count }, () => new Uint8Array(CHUNK_PX * CHUNK_PX * 4));
  if (pad) {
    for (const chunk of ground) {
      for (let py = 0; py < CHUNK_PX; py += TILE) {
        for (let px = 0; px < CHUNK_PX; px += TILE) blitTile(chunk, CHUNK_PX, px, py, pad);
      }
    }
  }
  const draw = (layers: Uint8Array[], tx: number, ty: number, art: Uint8Array | null): void => {
    if (!art) return;
    const cx = Math.floor(tx / CHUNK_TILES);
    const cy = Math.floor(ty / CHUNK_TILES);
    blitTile(layers[cy * columns + cx]!, CHUNK_PX, (tx % CHUNK_TILES) * TILE, (ty % CHUNK_TILES) * TILE, art);
  };
  for (let ty = 0; ty < map.height; ty++) {
    for (let tx = 0; tx < map.width; tx++) {
      draw(ground, tx, ty, tileArt(map.ground[ty * map.width + tx] ?? null));
    }
  }
  for (const [idx, tileId] of map.upper ?? []) {
    draw(upper, idx % map.width, Math.floor(idx / map.width), tileArt(tileId));
  }
  return { columns, rows, ground, upper };
}

export const groundAsset = (mapId: string): string => `assets/map-${mapId}-ground.png`;
export const upperAsset = (mapId: string): string => `assets/map-${mapId}-upper.png`;
export const groundChunkAsset = (mapId: string, chunk: number, count: number): string =>
  count === 1 ? groundAsset(mapId) : `assets/map-${mapId}-ground-${chunk}.png`;
export const upperChunkAsset = (mapId: string, chunk: number, count: number): string =>
  count === 1 ? upperAsset(mapId) : `assets/map-${mapId}-upper-${chunk}.png`;

/** The player's 12 walker frame images, by facing (0 down, 1 left, 2 up,
 *  3 right). */
export interface PlayerFrameNames {
  idle: readonly string[];
  walkL: readonly string[];
  walkR: readonly string[];
}

/** Source of a GameView asset manifest module: full string literals (pass 1
 *  of tools/build.ts bakes only complete literals) plus per-map geometry,
 *  exported both as named tables and as one GameAssets value. */
export function gameManifestSource(opts: {
  /** Header line naming the generator. */
  generator: string;
  /** Module specifier of src/ui/game-assets.ts from the manifest. */
  typesImport: string;
  maps: readonly {
    id: string;
    width: number;
    height: number;
    events?: readonly { pages: readonly { sprite?: string | null }[] }[];
  }[];
  /** Page.sprite key -> baked character image, in manifest order. */
  npcSrc: readonly (readonly [string, string])[];
  player: PlayerFrameNames;
  /** AnimationDef id -> cooked per-frame images, in play order. Absent (or
   *  empty) keeps the generated text byte-identical to the older manifest. */
  anims?: readonly (readonly [string, { frames: readonly string[]; w: number; h: number }])[];
}): string {
  const table = (rows: string[]): string => rows.map((r) => `  ${r},`).join("\n");
  // A computed property keeps "__proto__" as an own data key. Preserve the
  // existing generated text for every other identifier.
  const entry = (key: string, value: string): string =>
    key === "__proto__" ? `[${JSON.stringify(key)}]: ${value}` : `${JSON.stringify(key)}: ${value}`;
  const q = JSON.stringify;
  const chunkCount = (m: { width: number; height: number }): number =>
    Math.ceil(m.width / CHUNK_TILES) * Math.ceil(m.height / CHUNK_TILES);
  const maxChunks = Math.max(1, ...opts.maps.map(chunkCount));
  const maxActors = Math.max(0, ...opts.maps.map((m) =>
    m.events?.length ?? 0));
  const frames = (name: string, names: readonly string[]): string => {
    if (names.length !== 4) throw new Error(`gameManifestSource: ${name} needs 4 facings, got ${names.length}`);
    return `export const ${name}: readonly [string, string, string, string] = [\n${table(names.map((n) => q(n)))}\n];\n\n`;
  };
  const animsBlock = opts.anims && opts.anims.length > 0
    ? `export const ANIM_FRAMES: Record<string, { frames: readonly string[]; w: number; h: number }> = {\n` +
      table(opts.anims.map(([id, a]) => entry(id, `{ frames: ${q(a.frames)}, w: ${a.w}, h: ${a.h} }`))) +
      `\n};\n\n`
    : "";
  return (
    `// AUTO-GENERATED by ${opts.generator} — GameView asset\n` +
    `// literals (full strings so tools/build.ts bakes them) and per-map world\n` +
    `// geometry. Every map owns row-major 512px chunk image lists.\n\n` +
    `import type { GameAssets } from ${q(opts.typesImport)};\n\n` +
    `export const MAP_CANVAS_PX = ${MAP_CANVAS};\n\n` +
    `export const MAP_GROUND: Record<string, readonly string[]> = {\n` +
    table(opts.maps.map((m) => {
      const count = chunkCount(m);
      return entry(m.id, q(Array.from({ length: count }, (_, i) => groundChunkAsset(m.id, i, count))));
    })) +
    `\n};\n\n` +
    `export const MAP_UPPER: Record<string, readonly string[]> = {\n` +
    table(opts.maps.map((m) => {
      const count = chunkCount(m);
      return entry(m.id, q(Array.from({ length: count }, (_, i) => upperChunkAsset(m.id, i, count))));
    })) +
    `\n};\n\n` +
    `export const MAP_CHUNK_COLUMNS: Record<string, number> = {\n` +
    table(opts.maps.map((m) => entry(m.id, String(Math.ceil(m.width / CHUNK_TILES))))) +
    `\n};\n\n` +
    `export const MAP_MAX_CHUNKS = ${maxChunks};\n\n` +
    `export const MAP_WORLD: Record<string, { w: number; h: number }> = {\n` +
    table(opts.maps.map((m) => entry(m.id, `{ w: ${m.width * TILE}, h: ${m.height * TILE} }`))) +
    `\n};\n\n` +
    `export const MAP_ORDER: readonly string[] = ${q(opts.maps.map((m) => m.id))};\n\n` +
    `export const NPC_SRC: Record<string, string> = {\n` +
    table(opts.npcSrc.map(([key, src]) => entry(key, q(src)))) +
    `\n};\n\n` +
    `// Player walker frames, facing order 0 down, 1 left, 2 up, 3 right.\n` +
    frames("PLAYER_IDLE", opts.player.idle) +
    frames("PLAYER_WALK_L", opts.player.walkL) +
    frames("PLAYER_WALK_R", opts.player.walkR) +
    animsBlock +
    `export const GAME_ASSETS: GameAssets = {\n` +
    `  ground: MAP_GROUND,\n` +
    `  upper: MAP_UPPER,\n` +
    `  chunkColumns: MAP_CHUNK_COLUMNS,\n` +
    `  maxChunks: MAP_MAX_CHUNKS,\n` +
    `  maxActors: ${maxActors},\n` +
    `  world: MAP_WORLD,\n` +
    `  order: MAP_ORDER,\n` +
    `  npcSrc: NPC_SRC,\n` +
    `  player: { idle: PLAYER_IDLE, walkL: PLAYER_WALK_L, walkR: PLAYER_WALK_R },\n` +
    (opts.anims && opts.anims.length > 0 ? `  anims: ANIM_FRAMES,\n` : "") +
    `};\n`
  );
}
