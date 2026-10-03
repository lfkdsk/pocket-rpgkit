// tools/editor-playtest-shots.ts — capture the editor's in-memory playtest
// rendering the bundled playtest-art fixture, with semantic pixel assertions
// for all three registered art kinds: item icons, a parallax and a Show
// Animation.
//
//   bun run build:editor && bun tools/editor-playtest-shots.ts
//
// Boots the editor bundle on the wasm sim host, injects the bundled
// playtest-art fixture (a stage with a dusk parallax, a looping sparkle
// animation and a shop selling three icon-bearing items), opens the
// playtest, and writes the framebuffers (plus 3x nearest-neighbour zooms)
// next to dist/editor-playtest-shots/. The world shot proves the parallax
// and the animation; the shop shot proves the item icons. Each art kind is
// checked against its baked fixture PNG, not just for "non-blank".

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { bootWorld, type SimWorld } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { BUNDLED_PROJECTS } from "../editor/engine/projects.ts";
import { headerButtons, type HeaderActionId } from "../editor/engine/layout.ts";
import { PLAYTEST_BAR_H } from "../editor/engine/playtest-layout.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import type { Project } from "../src/engine/types.ts";

const ROOT = resolve(import.meta.dir, "..");
const OUT = resolve(ROOT, "dist", "editor-playtest-shots");
const W = 480;
const H = 272;
/** The fixture's animation tile and the void rows that show the parallax. */
const ANIM_TILE = { x: 17, y: 8 };
const PARALLAX_ROWS = 2;

interface EditorGlobals {
  __rpgkitEditorState?: () => any;
  __rpgkitEditorInject?: (json: string) => { ok: boolean; errors?: unknown[] };
}

interface Img {
  data: Uint8Array;
  width: number;
  height: number;
  rgba: Uint8Array;
}

function frame(world: SimWorld): void {
  world.frame(0);
  world.tick();
}

function send(inbox: string[], world: SimWorld, value: object): void {
  inbox.push(JSON.stringify(value));
  frame(world);
}

function click(inbox: string[], world: SimWorld, x: number, y: number): void {
  send(inbox, world, { t: "mouse", x, y, d: true });
  send(inbox, world, { t: "mouse", x, y, d: false });
}

function clickHeader(inbox: string[], world: SimWorld, id: HeaderActionId): void {
  let button = headerButtons(W).find((candidate) => candidate.id === id);
  if (!button) {
    const more = headerButtons(W).find((candidate) => candidate.id === "more")!;
    click(inbox, world, more.x + Math.floor(more.w / 2), more.y + Math.floor(more.h / 2));
    button = headerButtons(W).find((candidate) => candidate.id === id);
  }
  if (!button) throw new Error(`header action ${id} is unavailable at ${W}px`);
  click(inbox, world, button.x + Math.floor(button.w / 2), button.y + Math.floor(button.h / 2));
}

/** The bundled playtest-art fixture, unchanged. */
function fixtureProject(): string {
  const doc = BUNDLED_PROJECTS.find((document) => document.id === "playtest-art");
  if (!doc) throw new Error("the playtest-art fixture is not bundled");
  return doc.json;
}

function injectProject(world: SimWorld, json: string): void {
  const result = (globalThis as EditorGlobals).__rpgkitEditorInject?.(json);
  if (!result?.ok) throw new Error(`editor project injection failed: ${JSON.stringify(result?.errors ?? result)}`);
  frame(world);
}

/** Nearest-neighbour 3x zoom so the 16px art is visible in review. */
function zoom3(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * 3 * height * 3 * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      for (let oy = 0; oy < 3; oy++) {
        for (let ox = 0; ox < 3; ox++) {
          const dst = ((y * 3 + oy) * width * 3 + (x * 3 + ox)) * 4;
          out[dst] = rgba[src]!;
          out[dst + 1] = rgba[src + 1]!;
          out[dst + 2] = rgba[src + 2]!;
          out[dst + 3] = rgba[src + 3]!;
        }
      }
    }
  }
  return out;
}

function loadImg(path: string): Img {
  const png = decodePng(new Uint8Array(readFileSync(path)));
  return { data: png.rgba, width: png.width, height: png.height, rgba: png.rgba };
}

/** Fraction of `icon`'s opaque pixels that match the screen at (x, y)
 *  within a per-channel tolerance. Transparent icon pixels are skipped. */
function iconMatch(screen: Img, icon: Img, x: number, y: number): number {
  let match = 0;
  let all = 0;
  for (let py = 0; py < icon.height; py++) {
    for (let px = 0; px < icon.width; px++) {
      const ii = (py * icon.width + px) * 4;
      if (icon.rgba[ii + 3]! < 16) continue;
      const si = ((y + py) * screen.width + (x + px)) * 4;
      all++;
      const delta = Math.max(
        Math.abs(screen.rgba[si]! - icon.rgba[ii]!),
        Math.abs(screen.rgba[si + 1]! - icon.rgba[ii + 1]!),
        Math.abs(screen.rgba[si + 2]! - icon.rgba[ii + 2]!),
      );
      if (delta <= 24) match++;
    }
  }
  return all === 0 ? 0 : match / all;
}

/** Bidirectional frame match for the animation tile: the frame's opaque
 *  pixels must match the screen, and the frame's transparent pixels must
 *  match the background (so a small frame cannot match a screen showing a
 *  larger frame that contains it). Returns the matched pixel share. */
function frameMatch(screen: Img, frame: Img, x: number, y: number, bg: [number, number, number]): number {
  let match = 0;
  let all = 0;
  for (let py = 0; py < frame.height; py++) {
    for (let px = 0; px < frame.width; px++) {
      const ii = (py * frame.width + px) * 4;
      const si = ((y + py) * screen.width + (x + px)) * 4;
      all++;
      const screenIsBg =
        Math.abs(screen.rgba[si]! - bg[0]) <= 24 &&
        Math.abs(screen.rgba[si + 1]! - bg[1]) <= 24 &&
        Math.abs(screen.rgba[si + 2]! - bg[2]) <= 2;
      if (frame.rgba[ii + 3]! < 16) {
        if (screenIsBg) match++;
        continue;
      }
      const delta = Math.max(
        Math.abs(screen.rgba[si]! - frame.rgba[ii]!),
        Math.abs(screen.rgba[si + 1]! - frame.rgba[ii + 1]!),
        Math.abs(screen.rgba[si + 2]! - frame.rgba[ii + 2]!),
      );
      if (delta <= 24) match++;
    }
  }
  return match / all;
}

/** Best (x, y, score) template match of `icon` inside a screen region. */
function findIcon(screen: Img, icon: Img, region: { x: number; y: number; w: number; h: number }) {
  let best: { x: number; y: number; score: number } | null = null;
  for (let y = region.y; y <= region.y + region.h - icon.height; y++) {
    for (let x = region.x; x <= region.x + region.w - icon.width; x++) {
      const score = iconMatch(screen, icon, x, y);
      if (!best || score > best.score) best = { x, y, score };
    }
  }
  return best;
}

/** Best horizontal offset (0..sky.width-1) at which the void-row strip of
 *  the screen matches the sky image tiled across (the parallax scrolls on its
 *  looped axis, so the offset is the capture's phase). The playtest bar
 *  overlays the top of the screen, so the strip starts below it. Returns the
 *  offset and the matched pixel share. */
function parallaxMatch(screen: Img, sky: Img, stripTop: number, stripBottom: number): { offset: number; score: number } {
  let best = { offset: 0, score: 0 };
  for (let offset = 0; offset < sky.width; offset++) {
    let match = 0;
    let all = 0;
    for (let y = stripTop; y < stripBottom; y++) {
      for (let x = 0; x < screen.width; x++) {
        const si = (y * screen.width + x) * 4;
        const ki = (y * sky.width + ((x + offset) % sky.width)) * 4;
        all++;
        const delta = Math.max(
          Math.abs(screen.rgba[si]! - sky.rgba[ki]!),
          Math.abs(screen.rgba[si + 1]! - sky.rgba[ki + 1]!),
          Math.abs(screen.rgba[si + 2]! - sky.rgba[ki + 2]!),
        );
        if (delta <= 24) match++;
      }
    }
    const score = match / all;
    if (score > best.score) best = { offset, score };
  }
  return best;
}

const checks: Array<[string, boolean, string]> = [];
const check = (label: string, ok: boolean, detail: string): void => {
  checks.push([label, ok, detail]);
  console.log(`  ${ok ? "ok" : "FAIL"} ${label} (${detail})`);
};

const inbox: string[] = [];
const world = await bootWorld(
  resolve(ROOT, "dist", "editor"),
  60,
  undefined,
  (ops) => {
    ops.svcOpen = () => true;
    ops.svcPoll = () => (inbox.length > 0 ? inbox.splice(0).join("\n") : null);
    ops.svcSend = () => undefined;
  },
  { width: W, height: H },
);
for (let index = 0; index < 4; index++) frame(world);

injectProject(world, fixtureProject());

// Open the playtest from the header.
clickHeader(inbox, world, "play");
for (let i = 0; i < 4; i++) frame(world);

const state = () => (globalThis as EditorGlobals).__rpgkitEditorState?.();
const playing = state();
if (!playing?.playtest) throw new Error("playtest did not start");
console.log(`playtest: map=${playing.playState.mapId} cell=(${playing.playState.move.tx},${playing.playState.move.ty})`);

// Let the autorun page start the looping animation.
for (let i = 0; i < 10; i++) frame(world);

const sky = loadImg(join(ROOT, "editor/assets/playtest/parallax-dusk.png"));
const frames = [0, 1, 2, 3].map((i) => loadImg(join(ROOT, `editor/assets/playtest/anim-sparkle-${i}.png`)));
const icons = [0, 1, 2].map((i) => loadImg(join(ROOT, `editor/assets/tile-icons-${i}.png`)));

mkdirSync(OUT, { recursive: true });

// --- world shot: parallax + animation -------------------------------------

const worldRgba = world.render().slice();
const worldImg: Img = { data: worldRgba, width: W, height: H, rgba: worldRgba };
writeFileSync(join(OUT, "playtest-world.png"), encodePNG(worldRgba, W, H));
writeFileSync(join(OUT, "playtest-world-3x.png"), encodePNG(zoom3(worldRgba, W, H), W * 3, H * 3));

// The parallax: the void top rows show the dusk sky, tiled at the capture's
// scroll phase. The playtest bar overlays the top of the screen, so sample
// the strip below it (the void rows run to y = PARALLAX_ROWS * 16).
const stripTop = PLAYTEST_BAR_H + 1;
const stripBottom = PARALLAX_ROWS * 16;
const skyMatch = parallaxMatch(worldImg, sky, stripTop, stripBottom);
check("parallax: the void rows show the dusk sky", skyMatch.score > 0.95, `offset ${skyMatch.offset}, ${(skyMatch.score * 100).toFixed(1)}% match`);

// The animation: the sparkle tile shows one of the four cooked frames.
// Bidirectional matching (transparent pixels must stay background) so a
// small frame cannot match a screen showing a larger one that contains it.
const ax = ANIM_TILE.x * 16;
const ay = ANIM_TILE.y * 16;
// A grass pixel far from the animation tile, as the background colour.
const bgIdx = ((4 * 16 + 4) * W + 4) * 4;
const bg: [number, number, number] = [worldRgba[bgIdx]!, worldRgba[bgIdx + 1]!, worldRgba[bgIdx + 2]!];
const frameScores = frames.map((f) => frameMatch(worldImg, f, ax, ay, bg));
const firstFrame = frameScores.findIndex((s) => s > 0.9);
check("animation: the sparkle tile shows a cooked frame", firstFrame >= 0, frameScores.map((s) => s.toFixed(2)).join(", "));

// Advancing two frames (frameDuration 0.25s = 15 ticks at 60 Hz) must show a
// different frame: the animation is live, not a static decal.
for (let i = 0; i < 30; i++) frame(world);
const worldRgba2 = world.render().slice();
const worldImg2: Img = { data: worldRgba2, width: W, height: H, rgba: worldRgba2 };
const frameScores2 = frames.map((f) => frameMatch(worldImg2, f, ax, ay, bg));
const secondFrame = frameScores2.findIndex((s) => s > 0.9);
check("animation: the sparkle advanced to another frame", secondFrame >= 0 && secondFrame !== firstFrame, `frame ${firstFrame} -> ${secondFrame}`);
writeFileSync(join(OUT, "playtest-world-2.png"), encodePNG(worldRgba2, W, H));
writeFileSync(join(OUT, "playtest-world-2-3x.png"), encodePNG(zoom3(worldRgba2, W, H), W * 3, H * 3));

// --- shop shot: item icons --------------------------------------------------

// Face the shop (one tile north) and confirm to open it.
world.frame(BTN.UP);
world.tick();
for (let i = 0; i < 6; i++) frame(world);
world.frame(BTN.CIRCLE);
world.tick();
for (let i = 0; i < 30; i++) frame(world);

const modal = state()?.playState?.interp?.modal;
console.log(`modal after confirm: ${modal?.kind ?? "none"}`);

const shopRgba = world.render().slice();
const shopImg: Img = { data: shopRgba, width: W, height: H, rgba: shopRgba };
writeFileSync(join(OUT, "playtest-shop.png"), encodePNG(shopRgba, W, H));
writeFileSync(join(OUT, "playtest-shop-3x.png"), encodePNG(zoom3(shopRgba, W, H), W * 3, H * 3));

// The shop rows draw the fixture's own icon PNGs (a recognizable key, torch
// and gem), not map-tile slices. Each icon must template-match below the
// playtest bar (the icons are unique to this fixture, so the search is
// unambiguous).
const modalRegion = { x: 0, y: PLAYTEST_BAR_H + 2, w: W, h: H - PLAYTEST_BAR_H - 2 };
const iconNames = ["key", "torch", "gem"];
for (let i = 0; i < icons.length; i++) {
  const found = findIcon(shopImg, icons[i]!, modalRegion);
  check(`icon: the shop shows the ${iconNames[i]} icon`, (found?.score ?? 0) > 0.9, found ? `at (${found.x},${found.y}), ${(found.score * 100).toFixed(1)}% match` : "not found");
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\neditor-playtest-shots: ${failed.length === 0 ? "PASS" : `FAIL (${failed.length})`}; shots in ${OUT}`);
process.exit(failed.length === 0 ? 0 : 1);
