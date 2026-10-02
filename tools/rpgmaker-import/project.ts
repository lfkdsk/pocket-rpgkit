// tools/rpgmaker-import/project.ts — assemble one rpgkit-project/v1
// document (plus the art a cooker needs) from a loaded RPG Maker project.
//
// Maps: every tile layer is composed per cell (compose.ts) into generated
// tile sheets, one per RM tileset ("ts<id>"); the sheet carries each
// cell's passage (block list and the undirected dirBlock edges that match
// MV's four passage bits). Events, common events and the database go
// through events.ts. Art the runtime needs besides the tile sheets
// (character blocks, tile-image events, pictures, the balloon sheet,
// animated water cells) is listed in an ImportAssets manifest so a game's
// asset cooker can bake it; the importer itself never runs at game time.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  AnimationDef,
  CommonEvent,
  Condition,
  Command,
  GameEvent,
  Item,
  MapDef,
  Page,
  PageCondition,
  Project,
  Sheet,
  SpriteDef,
  TileId,
} from "../../src/engine/types.ts";
import { Coverage } from "./coverage.ts";
import { TileAtlas, composeMap } from "./compose.ts";
import { convertCommonEvent, convertPage, type EventContext } from "./events.ts";
import { commonId, eventId, itemId, mapId, partySwitchId, slug } from "./ids.ts";
import { rmTileSize } from "./load.ts";
import { blankImage, blit, readPng, type RgbaImage } from "./png.ts";
import type { RmPageImage, RmProject } from "./rm-types.ts";
import { downscale, drawTile, loadTilesetImages, type TilesetImages } from "./tile-render.ts";

export interface ImportOptions {
  /** "visible" turns plugin/script commands into a text box naming them;
   *  "silent" drops them (both count as Placeholder). */
  placeholders?: "visible" | "silent";
}

/** Render-side outputs a cooker bakes. Paths are relative to the output
 *  directory. */
export interface ImportAssets {
  format: "rpgkit-rpgmaker-assets/v1";
  /** Sheet id -> generated 16 px tile sheet PNG. */
  sheets: Record<string, { png: string; cols: number; rows: number }>;
  /** Sprite key -> PNG of a 3x4 walker block (16 px frames) or a 16x16 tile. */
  sprites: Record<string, { png: string; kind: "walker" | "image"; h: 16 | 32 }>;
  /** Picture variant id -> source picture PNG (screen-sized, not rescaled). */
  pictures: Record<string, string>;
  /** Map id -> animated cells (water, waterfalls): sheet cells per step. */
  animated: Record<string, { x: number; y: number; above: boolean; frames: TileId[]; frameSeconds: number }[]>;
  /** The balloon sheet (8 columns x 15 rows of 16 px frames), when used. */
  balloon?: string;
  /** Sprite key of the starting party leader's walking character. */
  player?: string;
}

export interface ImportResult {
  project: Project;
  /** Generated images keyed by their output-relative path. */
  images: Map<string, RgbaImage>;
  assets: ImportAssets;
  cov: Coverage;
  warnings: string[];
}

const KIT_TILE = 16;
/** MV balloon: 8 patterns, each shown for 8 frames, then a 12 frame hold
 *  (Sprite_Balloon speed 8, waitTime 12); the kit plays the 8 patterns. */
const BALLOON_FRAME_SECONDS = 8 / 60;

const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

function nonEmpty(s: string | undefined, fallback: string): string {
  const t = (s ?? "").trim();
  return t.length > 0 ? t : fallback;
}

export async function importRmProject(rm: RmProject, options: ImportOptions = {}): Promise<ImportResult> {
  const cov = new Coverage();
  const warnings: string[] = [];
  const images = new Map<string, RgbaImage>();
  const tileSize = rmTileSize(rm);
  if (tileSize % KIT_TILE !== 0) {
    throw new Error(`rpgmaker-import: tile size ${tileSize} is not a multiple of ${KIT_TILE}`);
  }
  const scale = tileSize / KIT_TILE;
  const assets: ImportAssets = {
    format: "rpgkit-rpgmaker-assets/v1",
    sheets: {},
    sprites: {},
    pictures: {},
    animated: {},
  };

  // --- tilesets -----------------------------------------------------------
  const atlases = new Map<number, TileAtlas>();
  const tilesetImages = new Map<number, TilesetImages>();
  const atlasFor = async (tilesetId: number): Promise<{ atlas: TileAtlas; images: TilesetImages }> => {
    const tileset = rm.tilesets[tilesetId];
    if (!tileset) throw new Error(`rpgmaker-import: tileset ${tilesetId} is missing from Tilesets.json`);
    let atlas = atlases.get(tilesetId);
    if (!atlas) {
      atlas = new TileAtlas(`ts${tilesetId}`);
      atlases.set(tilesetId, atlas);
      tilesetImages.set(tilesetId, await loadTilesetImages(rm.root, tileset.tilesetNames, tileSize));
    }
    return { atlas, images: tilesetImages.get(tilesetId)! };
  };

  // --- sprites (characters and tile-image events) -------------------------
  const characterSheets = new Map<string, RgbaImage | null>();
  const spriteKeys = new Map<string, string | null>();
  let currentTilesetId = 0;
  const loadCharacterSheet = async (name: string): Promise<RgbaImage | null> => {
    if (!characterSheets.has(name)) {
      const path = join(rm.root, "img", "characters", `${name}.png`);
      characterSheets.set(name, existsSync(path) ? await readPng(path) : null);
    }
    return characterSheets.get(name)!;
  };
  // Sprites are registered synchronously from the event converter, so the
  // pixels are cut afterwards (resolveSprites) from these requests.
  const spriteRequests: { key: string; image: Pick<RmPageImage, "characterName" | "characterIndex" | "tileId">; tilesetId: number }[] = [];
  const spriteFor = (image: Pick<RmPageImage, "characterName" | "characterIndex" | "tileId">): string | null => {
    if (image.tileId > 0) {
      const key = `tile-${currentTilesetId}-${image.tileId}`;
      if (!spriteKeys.has(key)) {
        spriteKeys.set(key, key);
        spriteRequests.push({ key, image, tilesetId: currentTilesetId });
      }
      return key;
    }
    if (!image.characterName) return null;
    const big = image.characterName.includes("$");
    const key = `chr-${slug(image.characterName)}${big ? "" : `-${image.characterIndex}`}`;
    if (!spriteKeys.has(key)) {
      spriteKeys.set(key, key);
      spriteRequests.push({ key, image, tilesetId: currentTilesetId });
    }
    return key;
  };

  // --- pictures, balloons, audio ------------------------------------------
  const pictureFor = (name: string): string => {
    const id = slug(name);
    if (!assets.pictures[id]) assets.pictures[id] = `pictures/${id}.png`;
    return id;
  };
  const balloonPath = join(rm.root, "img", "system", "Balloon.png");
  const hasBalloon = existsSync(balloonPath);
  const balloonsUsed = new Set<number>();
  const balloonFor = (n: number): string | null => {
    if (!hasBalloon || n < 1 || n > 15) return null;
    balloonsUsed.add(n);
    return `balloon${n}`;
  };
  const audioUsed = new Set<string>();
  const audioFor = (kind: "bgm" | "bgs" | "me" | "se", name: string): string => {
    const id = `${kind}-${slug(name)}`;
    audioUsed.add(id);
    return id;
  };

  const kitMaps = new Map<number, string>();
  for (const info of rm.mapInfos) if (info && rm.maps.has(info.id)) kitMaps.set(info.id, mapId(info.id));

  const baseContext = {
    rm,
    cov,
    placeholders: options.placeholders ?? "visible",
    maps: kitMaps,
    sprite: spriteFor,
    picture: pictureFor,
    balloon: balloonFor,
    audio: audioFor,
  } as const;

  const leaderId = rm.system.partyMembers?.[0];
  const leader = leaderId ? rm.actors[leaderId] : null;
  if (leader?.characterName) {
    const key = spriteFor({ characterName: leader.characterName, characterIndex: leader.characterIndex, tileId: 0 });
    if (key) assets.player = key;
  }

  // --- maps ---------------------------------------------------------------
  const maps: MapDef[] = [];
  const mapIds = [...rm.maps.keys()].sort((a, b) => a - b);
  for (const rmId of mapIds) {
    const rmMap = rm.maps.get(rmId)!;
    const info = rm.mapInfos[rmId];
    const id = mapId(rmId);
    if (rmMap.width > 256 || rmMap.height > 256) {
      throw new Error(`rpgmaker-import: map ${rmId} is ${rmMap.width}x${rmMap.height}; the kit caps maps at 256x256`);
    }
    currentTilesetId = rmMap.tilesetId;
    const { atlas, images: tsImages } = await atlasFor(rmMap.tilesetId);
    const composed = composeMap(rmMap, rm.tilesets[rmMap.tilesetId]!, tsImages, atlas, cov);
    const cellId = (cell: number | null): TileId => (cell === null ? null : `${atlas.sheetId}.${cell}`);

    const eventIds = new Map<number, string>();
    for (const ev of rmMap.events) if (ev) eventIds.set(ev.id, eventId(ev.id));
    const events: GameEvent[] = [];
    const bumpCells = new Set<number>();
    for (const ev of rmMap.events) {
      if (!ev) continue;
      const kitId = eventId(ev.id);
      let shop = 0;
      const pages: Page[] = ev.pages.map((page, index) => {
        const ctx: EventContext = {
          ...baseContext,
          owner: { kind: "page", mapId: id, eventId: kitId, page: index, trigger: "action", eventIds },
          nextShopId: () => `${id}-${kitId}-shop${shop++}`,
        };
        const kitPage = convertPage(page, index, ctx);
        if ((page.trigger === 1 || page.trigger === 2) && page.priorityType === 1 && kitPage.commands.length > 0) {
          // MV starts a same-as-characters touch event when the player
          // walks INTO it (checkEventTriggerTouchFront); the kit starts a
          // touch page only when the player stands on its cell. Lower to
          // "step on it": the page stops blocking and, when the tile
          // under it is impassable (a door in a wall), the cell is opened.
          kitPage.blocks = false;
          bumpCells.add(ev.y * rmMap.width + ev.x);
          cov.record("trigger", "touch by walking into it", "Degraded",
            "lowered to stepping onto the event's cell; needs a kit touch-front trigger");
        }
        return kitPage;
      });
      // MV picks the HIGHEST-numbered page whose conditions hold; the kit
      // picks the same (activePage scans from the last page), so pages keep
      // their order.
      events.push({ id: kitId, name: truncate(nonEmpty(ev.name, kitId), 40), x: ev.x, y: ev.y, pages });
    }

    maps.push({
      id,
      name: truncate(nonEmpty(rmMap.displayName || info?.name, id), 40),
      width: rmMap.width,
      height: rmMap.height,
      sheets: [atlas.sheetId],
      ground: composed.ground.map(cellId),
      ...(composed.upper.length > 0 ? { upper: composed.upper.map(([i, c]) => [i, cellId(c)] as [number, TileId]) } : {}),
      events,
    });
    const opened = [...bumpCells].sort((a, b) => a - b).filter((i) => {
      const cell = composed.ground[i];
      return cell === null || cell === undefined || atlas.blocked(cell).length > 0;
    });
    if (opened.length > 0) maps[maps.length - 1]!.passage = opened.map((i) => [i, "pass"]);
    if (composed.animated.length > 0) {
      assets.animated[id] = composed.animated.map((a) => ({
        x: a.x,
        y: a.y,
        above: a.above,
        frames: a.frames.map((c) => cellId(c)),
        frameSeconds: a.frameSeconds,
      }));
    }
    if (rmMap.parallaxName) cov.record("tile", "parallax", "Dropped", "parallax backgrounds are not imported");
    if (rmMap.autoplayBgm && rmMap.bgm?.name) cov.record("tile", "map autoplay BGM", "Degraded", "autoplay BGM is not started on map entry");
    if (rmMap.encounterList?.length) cov.record("tile", "map encounters", "Dropped", "random encounters need a battle system");
  }

  // --- common events ------------------------------------------------------
  const commonEvents: CommonEvent[] = [];
  for (const ce of rm.commonEvents) {
    if (!ce) continue;
    currentTilesetId = 0;
    let shop = 0;
    const trigger = ce.trigger === 2 ? "parallel" : ce.trigger === 1 ? "autorun" : "none";
    const ctx: EventContext = {
      ...baseContext,
      owner: { kind: "common", id: commonId(ce.id), trigger },
      nextShopId: () => `${commonId(ce.id)}-shop${shop++}`,
    };
    commonEvents.push(convertCommonEvent(ce, ctx));
  }

  // --- sheets -------------------------------------------------------------
  const sheets: Sheet[] = [];
  for (const [tilesetId, atlas] of [...atlases.entries()].sort((a, b) => a[0] - b[0])) {
    const block: number[] = [];
    const dirBlock: Record<string, ("down" | "left" | "right" | "up")[]> = {};
    for (let cell = 0; cell < atlas.count; cell++) {
      const dirs = atlas.blocked(cell);
      if (dirs.length === 4) block.push(cell);
      else if (dirs.length > 0) dirBlock[String(cell)] = [...dirs];
    }
    const sheet: Sheet = { id: atlas.sheetId, pak: "chunks", cols: atlas.cols, rows: atlas.rows, defaultPassage: "pass" };
    if (block.length > 0) sheet.block = block;
    if (Object.keys(dirBlock).length > 0) sheet.dirBlock = dirBlock;
    sheets.push(sheet);
    const png = `tiles/${atlas.sheetId}.png`;
    images.set(png, atlas.toImage());
    assets.sheets[atlas.sheetId] = { png, cols: atlas.cols, rows: atlas.rows };
    void tilesetId;
  }

  // --- sprites ------------------------------------------------------------
  const sprites: Record<string, SpriteDef> = {};
  for (const req of spriteRequests) {
    const png = `sprites/${req.key}.png`;
    if (req.image.tileId > 0) {
      const ts = tilesetImages.get(req.tilesetId);
      const tileset = rm.tilesets[req.tilesetId];
      if (!ts || !tileset) {
        warnings.push(`sprite ${req.key}: tileset ${req.tilesetId} has no images`);
        continue;
      }
      const native = blankImage(tileSize, tileSize);
      drawTile(native, 0, 0, req.image.tileId, 0, ts, tileset.flags);
      images.set(png, scale === 1 ? native : downscale(native, scale));
      sprites[req.key] = { kind: "image", src: png };
      assets.sprites[req.key] = { png, kind: "image", h: 16 };
      continue;
    }
    const sheet = await loadCharacterSheet(req.image.characterName);
    if (!sheet) {
      warnings.push(`sprite ${req.key}: img/characters/${req.image.characterName}.png not found`);
      continue;
    }
    const big = req.image.characterName.includes("$");
    const fw = big ? sheet.width / 3 : sheet.width / 12;
    const fh = big ? sheet.height / 4 : sheet.height / 8;
    const kitW = fw / scale;
    const kitH = fh / scale;
    if (!Number.isInteger(fw) || !Number.isInteger(fh) || kitW !== KIT_TILE || (kitH !== 16 && kitH !== 32)) {
      warnings.push(`sprite ${req.key}: frames ${fw}x${fh} do not scale to 16x16 or 16x32`);
      continue;
    }
    const idx = big ? 0 : req.image.characterIndex;
    const bx = (idx % 4) * fw * 3;
    const by = Math.floor(idx / 4) * fh * 4;
    const block = blankImage(fw * 3, fh * 4);
    blit(block, 0, 0, sheet, bx, by, fw * 3, fh * 4);
    images.set(png, scale === 1 ? block : downscale(block, scale));
    sprites[req.key] = { kind: "walker", sheet: png, h: kitH as 16 | 32 };
    assets.sprites[req.key] = { png, kind: "walker", h: kitH as 16 | 32 };
  }

  // --- balloons -----------------------------------------------------------
  const animations: AnimationDef[] = [];
  if (balloonsUsed.size > 0) {
    const sheet = await readPng(balloonPath);
    images.set("system/balloon.png", scale === 1 ? sheet : downscale(sheet, scale));
    assets.balloon = "system/balloon.png";
    for (const n of [...balloonsUsed].sort((a, b) => a - b)) {
      animations.push({
        id: `balloon${n}`,
        sheet: "system/balloon.png",
        cols: 8,
        frames: [0, 1, 2, 3, 4, 5, 6, 7].map((f) => (n - 1) * 8 + f),
        frameDuration: BALLOON_FRAME_SECONDS,
        loop: false,
      });
    }
  }

  // --- database -----------------------------------------------------------
  const firstSheet = sheets[0]?.id ?? "ts0";
  const items: Item[] = [];
  for (const [kind, list] of [["item", rm.items], ["weapon", rm.weapons], ["armor", rm.armors]] as const) {
    for (const entry of list) {
      if (!entry || !entry.name) continue;
      const item: Item = {
        id: itemId(kind, entry.id),
        name: truncate(entry.name, 24),
        // Item icons (IconSet.png) are not imported; every item shows the
        // first generated tile.
        sprite: `${firstSheet}.0`,
      };
      if (entry.price > 0) item.price = entry.price;
      if (kind === "item" && entry.itypeId === 2) item.sellable = false;
      if (kind === "item" && entry.consumable === false) item.usable = false;
      items.push(item);
    }
  }

  const project: Project = {
    format: "rpgkit-project/v1",
    title: truncate(nonEmpty(rm.system.gameTitle, "Imported RPG Maker project"), 80),
    tileSize: 16,
    start: { map: mapId(rm.system.startMapId), x: rm.system.startX, y: rm.system.startY, dir: "down" },
    system: { messageBlocksPlayer: true },
    ...(leader?.name ? { playerName: leader.name } : {}),
    sheets,
    items,
    ...(Object.keys(sprites).length > 0 ? { sprites } : {}),
    ...(animations.length > 0 ? { animations } : {}),
    ...(commonEvents.length > 0 ? { commonEvents } : {}),
    maps,
  };
  invertInitialParty(project, rm.system.partyMembers ?? []);
  if (audioUsed.size > 0) {
    warnings.push(`${audioUsed.size} audio ids are referenced; audio files are not converted (project.audio is left empty)`);
  }
  return { project, images, assets, cov, warnings };
}

/** The kit has no initial switch values, and party membership is a switch
 *  per actor (ids.ts partySwitchId). For actors in the starting party the
 *  switch is stored inverted ("party-out-…" ON = left the party), so a
 *  fresh game reads them as members without an initialisation event. */
export function invertInitialParty(project: Project, initialParty: readonly number[]): void {
  const inverted = new Map<string, string>();
  for (const actor of initialParty) {
    inverted.set(partySwitchId(actor), partySwitchId(actor).replace(/^party-/, "party-out-"));
  }
  if (inverted.size === 0) return;
  const cond = (c: Condition): Condition => {
    if (c.kind === "switch" && inverted.has(c.id)) return { kind: "switch", id: inverted.get(c.id)!, value: !(c.value ?? true) };
    return c;
  };
  const pageCond = (pc: PageCondition | undefined): PageCondition | undefined => {
    if (!pc) return pc;
    const out: PageCondition = { ...pc };
    if (out.switch && inverted.has(out.switch)) {
      const id = out.switch;
      delete out.switch;
      out.all = [...(out.all ?? []), { kind: "switch", id: inverted.get(id)!, value: false }];
    }
    if (out.all) out.all = out.all.map(cond);
    return out;
  };
  const cmds = (list: Command[]): Command[] => list.map((c): Command => {
    switch (c.op) {
      case "switch":
        return inverted.has(c.id) ? { ...c, id: inverted.get(c.id)!, value: !c.value } : c;
      case "if":
        return { ...c, if: cond(c.if), then: cmds(c.then), ...(c.else ? { else: cmds(c.else) } : {}) };
      case "choices":
        return {
          ...c,
          options: c.options.map((o) => ({ ...o, commands: cmds(o.commands) })),
          ...(c.cancel ? { cancel: { commands: cmds(c.cancel.commands) } } : {}),
        };
      case "battle":
        return {
          ...c,
          ...(c.onWin ? { onWin: cmds(c.onWin) } : {}),
          ...(c.onLose ? { onLose: cmds(c.onLose) } : {}),
          ...(c.onEscape ? { onEscape: cmds(c.onEscape) } : {}),
        };
      case "scene":
        return {
          ...c,
          ...(c.onDone ? { onDone: cmds(c.onDone) } : {}),
          ...(c.onCancel ? { onCancel: cmds(c.onCancel) } : {}),
        };
      default:
        return c;
    }
  });
  for (const map of project.maps) {
    for (const ev of map.events ?? []) {
      ev.pages = ev.pages.map((p) => {
        const condition = pageCond(p.condition);
        return { ...p, ...(condition ? { condition } : {}), commands: cmds(p.commands) };
      });
    }
  }
  for (const ce of project.commonEvents ?? []) ce.commands = cmds(ce.commands);
}
