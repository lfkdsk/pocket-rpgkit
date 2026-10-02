// tests/fixtures/rpgkit-shot/rpgkit-shot.tsx — sim fixture for rpgkit-check's
// screenshot check. Renders a SCHEMATIC of any rpgkit-project/v1 document:
// passable / blocked / void cells from the engine's own passage table (with
// live character bodies), event markers colored by the trigger of the
// engine-selected active page, the player, and an optional reachability
// overlay. Painted in JS, uploaded as 512x512 texture tiles, rendered through
// the wasm sim host so screenshots come from the real core framebuffer.
//
// Config arrives as globalThis.__rpgkitShot before boot (the check driver
// injects it through bootWorld's extraGlobals):
//   { project, map, x, y, dir?, sw?, reach?, resolution: {width, height} }
// `reach` is an optional list of "map@x,y" node keys to tint blue.

import { mount } from "@pocketjs/framework";
import { getOps } from "@pocketjs/framework/host";
import {
  createElement,
  insertNode,
  setProp,
  type NodeMirror,
} from "@pocketjs/framework/renderer";
import type { JSX as SolidJSX } from "solid-js";
import { PSM } from "../../../vendor/pocketjs/contracts/spec/spec.ts";
import { buildPassage, isStandable } from "../../../src/engine/passability.ts";
import { activePage, createSwitchState } from "../../../src/engine/interpreter.ts";
import {
  createSession,
  startSession,
  stepSession,
  tableWithBodies,
  type SessionOptions,
} from "../../../src/engine/session.ts";
import type { Dir, Project } from "../../../src/engine/types.ts";
import {
  checkConditionContext,
  checkSessionOptions,
} from "../../../tools/rpgkit-check/src/dynamic/sim.ts";

export interface ShotSwitchBank {
  switches?: Record<string, boolean>;
  variables?: Record<string, number>;
  items?: Record<string, number>;
  gold?: number;
}

export interface ShotConfig {
  project: Project;
  map: string;
  x: number;
  y: number;
  dir?: Dir;
  sw?: ShotSwitchBank;
  reach?: readonly string[];
  sessionOptions?: SessionOptions;
  resolution: { width: number; height: number };
}

declare global {
  // eslint-disable-next-line no-var
  var __rpgkitShot: ShotConfig | undefined;
  // eslint-disable-next-line no-var
  var __rpgkitShotReady: boolean | undefined;
}

// ---- palette ---------------------------------------------------------------

const BG = [26, 29, 35] as const;
const VOID = [16, 18, 22] as const;
const PASS = [46, 93, 52] as const;
const BLOCK = [107, 114, 128] as const;
const GRID = [34, 38, 45] as const;
const REACH = [59, 130, 246] as const;
const PLAYER = [255, 255, 255] as const;
const INACTIVE = [90, 96, 108] as const;

const TRIGGER_COLORS: Record<string, readonly [number, number, number]> = {
  action: [245, 158, 11],
  playerTouch: [34, 211, 238],
  autorun: [232, 121, 249],
  parallel: [167, 139, 250],
};

type RGB = readonly [number, number, number];

function blend(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

// ---- painting ---------------------------------------------------------------

export interface SchematicPaint {
  rgba: Uint8Array;
  width: number;
  height: number;
}

const ZERO_INPUT = {
  buttons: 0,
  confirmEdge: false,
  cancelEdge: false,
  upEdge: false,
  downEdge: false,
};

/** Paint the schematic for one config into a width*height RGBA buffer. */
export function paintSchematic(cfg: ShotConfig): SchematicPaint {
  const { project } = cfg;
  const map = project.maps.find((m) => m.id === cfg.map);
  if (!map) throw new Error(`rpgkit-shot: unknown map ${JSON.stringify(cfg.map)}`);
  const { width, height } = cfg.resolution;

  const startProject: Project = {
    ...project,
    start: { map: cfg.map, x: cfg.x, y: cfg.y, dir: cfg.dir ?? "down" },
  };
  const session = createSession(startProject, 60, checkSessionOptions(startProject, cfg.sessionOptions));
  const sw0 = cfg.sw
    ? createSwitchState({
        switches: cfg.sw.switches ?? {},
        variables: cfg.sw.variables ?? {},
        items: cfg.sw.items ?? {},
        gold: cfg.sw.gold ?? 0,
      })
    : undefined;
  let state = startSession(startProject, session, sw0);
  // Settle so create-pages spawn their characters before bodies are stamped.
  for (let i = 0; i < 10; i++) state = stepSession(session, state, ZERO_INPUT);

  const sheets = new Map(project.sheets.map((s) => [s.id, s]));
  const table = tableWithBodies(buildPassage(map, sheets), state.chars);
  const ext = { runtime: session.extensions, ext: state.ext };
  const conditionContext = checkConditionContext(state, map);
  const reach = new Set(cfg.reach ?? []);

  const rgba = new Uint8Array(width * height * 4);
  const px = (x: number, y: number, c: RGB, alpha = 1): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const o = (y * width + x) * 4;
    if (alpha >= 1) {
      rgba[o] = c[0];
      rgba[o + 1] = c[1];
      rgba[o + 2] = c[2];
      rgba[o + 3] = 255;
    } else {
      rgba[o] = Math.round(rgba[o] + (c[0] - rgba[o]) * alpha);
      rgba[o + 1] = Math.round(rgba[o + 1] + (c[1] - rgba[o + 1]) * alpha);
      rgba[o + 2] = Math.round(rgba[o + 2] + (c[2] - rgba[o + 2]) * alpha);
      rgba[o + 3] = 255;
    }
  };
  const fill = (c: RGB): void => {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) px(x, y, c);
  };
  fill(BG);

  const cell = Math.max(1, Math.min(64, Math.floor(Math.min(width / map.width, height / map.height))));
  const ox = Math.floor((width - cell * map.width) / 2);
  const oy = Math.floor((height - cell * map.height) / 2);

  // Cells.
  for (let ty = 0; ty < map.height; ty++) {
    for (let tx = 0; tx < map.width; tx++) {
      const index = ty * map.width + tx;
      const standable = isStandable(table, tx, ty);
      const voidCell = map.ground[index] === null || map.ground[index] === undefined;
      let color: RGB = standable ? PASS : voidCell ? VOID : BLOCK;
      if (reach.has(`${map.id}@${tx},${ty}`)) color = blend(color, REACH, 0.45);
      for (let dy = 0; dy < cell; dy++) {
        for (let dx = 0; dx < cell; dx++) {
          px(ox + tx * cell + dx, oy + ty * cell + dy, color);
        }
      }
      if (cell >= 5) {
        for (let d = 0; d < cell; d++) {
          px(ox + tx * cell + d, oy + ty * cell, GRID);
          px(ox + tx * cell, oy + ty * cell + d, GRID);
        }
      }
    }
  }

  // Event markers: live char position if the entry spawned one, else the
  // authored rectangle.
  const rect = (ex: number, ey: number, color: RGB): void => {
    const x0 = ox + ex * cell;
    const y0 = oy + ey * cell;
    const w = cell;
    const border = cell >= 8 ? 2 : 1;
    for (let d = 0; d < w; d++) {
      for (let b = 0; b < border; b++) {
        px(x0 + d, y0 + b, color);
        px(x0 + d, y0 + w - 1 - b, color);
        px(x0 + b, y0 + d, color);
        px(x0 + w - 1 - b, y0 + d, color);
      }
    }
    // Corner dot makes single-cell events visible at small cell sizes.
    px(x0 + Math.floor(w / 2), y0 + Math.floor(w / 2), color);
  };
  for (const ev of map.events ?? []) {
    const ch = state.chars.chars[ev.id];
    const ex = ch ? ch.tx : ev.x;
    const ey = ch ? ch.ty : ev.y;
    const active = activePage(ev, state.sw, map.id, state.move.facing, ext, conditionContext);
    const color = active ? (TRIGGER_COLORS[active.page.trigger] ?? INACTIVE) : INACTIVE;
    const w = ev.w ?? 1;
    const h = ev.h ?? 1;
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) rect(ex + dx, ey + dy, color);
  }

  // Player.
  const px0 = ox + cfg.x * cell;
  const py0 = oy + cfg.y * cell;
  const border = cell >= 8 ? 2 : 1;
  for (let d = 0; d < cell; d++) {
    for (let b = 0; b < border; b++) {
      px(px0 + d, py0 + b, PLAYER);
      px(px0 + d, py0 + cell - 1 - b, PLAYER);
      px(px0 + b, py0 + d, PLAYER);
      px(px0 + cell - 1 - b, py0 + d, PLAYER);
    }
  }
  const mid = Math.floor(cell / 2);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) px(px0 + mid + dx, py0 + mid + dy, PLAYER);

  return { rgba, width, height };
}

// ---- component ---------------------------------------------------------------

const TEX_DIM = 512;

function Shot(): SolidJSX.Element {
  const cfg = globalThis.__rpgkitShot;
  if (!cfg) throw new Error("rpgkit-shot: globalThis.__rpgkitShot is not set");
  const { rgba, width, height } = paintSchematic(cfg);

  const root = createElement("view");
  setProp(root, "style", { posType: 1, insetL: 0, insetT: 0, width, height });
  setProp(root, "debugName", "rpgkit-shot");

  const cols = Math.ceil(width / TEX_DIM);
  const rows = Math.ceil(height / TEX_DIM);
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const x0 = tx * TEX_DIM;
      const y0 = ty * TEX_DIM;
      const w = Math.min(TEX_DIM, width - x0);
      const h = Math.min(TEX_DIM, height - y0);
      if (w <= 0 || h <= 0) continue;
      const buf = new Uint8Array(TEX_DIM * TEX_DIM * 4);
      for (let y = 0; y < h; y++) {
        const src = ((y0 + y) * width + x0) * 4;
        buf.set(rgba.subarray(src, src + w * 4), y * TEX_DIM * 4);
      }
      const handle = getOps().uploadTexture(buf, TEX_DIM, TEX_DIM, PSM.PSM_8888);
      if (handle < 0) throw new Error(`rpgkit-shot: texture upload failed for tile ${tx},${ty}`);
      const node = createElement("image");
      // Nodes stay at the texture's natural 512x512: the core maps texels
      // 1:1, and the framebuffer clips the overflow past the content edge
      // (the texture's unused strip is alpha 0). Sizing the node to the
      // content rect would stretch the texture instead.
      setProp(node, "style", { posType: 1, insetL: x0, insetT: y0, width: TEX_DIM, height: TEX_DIM });
      getOps().setImage(node.id, handle);
      insertNode(root, node);
    }
  }

  globalThis.__rpgkitShotReady = true;
  return root as unknown as SolidJSX.Element;
}

mount(() => <Shot />);
