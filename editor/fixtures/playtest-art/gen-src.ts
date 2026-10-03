// editor/fixtures/playtest-art/gen-src.ts — generate the fixture's source
// art (committed): the icon sheet, the parallax sky and the animation sheet.
//
//   bun editor/fixtures/playtest-art/gen-src.ts
//
// All art is original and procedural, drawn so each kind reads clearly in a
// 16px playtest: the icons are recognizable items (not map-tile slices), the
// parallax is a dusk sky, the animation is a pulsing sparkle. Deterministic:
// the same PNG bytes are regenerated from this script every run.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodePNG } from "../../../vendor/pocketjs/tests/png.ts";

const HERE = new URL(".", import.meta.url).pathname;
const SRC = join(HERE, "assets", "src");
mkdirSync(SRC, { recursive: true });

type Rgba = readonly [number, number, number, number];
const CLEAR: Rgba = [0, 0, 0, 0];

interface Img {
  data: Uint8Array;
  w: number;
  h: number;
  set(x: number, y: number, c: Rgba): void;
}

function img(w: number, h: number): Img {
  const data = new Uint8Array(w * h * 4);
  return {
    data,
    w,
    h,
    set(x, y, c) {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      data.set(c, (y * w + x) * 4);
    },
  };
}

function disc(image: Img, cx: number, cy: number, r: number, fill: Rgba, outline?: Rgba): void {
  for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) {
    for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r) image.set(x, y, fill);
      else if (outline && d <= r + 0.9) image.set(x, y, outline);
    }
  }
}

function rect(image: Img, x0: number, y0: number, x1: number, y1: number, c: Rgba): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) image.set(x, y, c);
}

function save(name: string, image: Img): void {
  writeFileSync(join(SRC, name), encodePNG(image.data, image.w, image.h));
  console.log(`wrote assets/src/${name} (${image.w}x${image.h})`);
}

// --- icons sheet: three recognizable items in 16px cells --------------------

const GOLD: Rgba = [255, 210, 63, 255];
const GOLD_DARK: Rgba = [176, 133, 14, 255];
const BROWN: Rgba = [121, 66, 30, 255];
const FLAME: Rgba = [255, 107, 53, 255];
const CYAN: Rgba = [63, 224, 255, 255];
const CYAN_DARK: Rgba = [18, 130, 166, 255];

const icons = img(48, 16);

// Key: a ring bow, a shaft and two teeth.
disc(icons, 4, 5, 3, GOLD, GOLD_DARK);
disc(icons, 4, 5, 1, CLEAR);
rect(icons, 7, 4, 13, 5, GOLD);
rect(icons, 7, 6, 13, 6, GOLD_DARK);
rect(icons, 10, 7, 10, 9, GOLD);
rect(icons, 13, 7, 13, 8, GOLD);

// Torch: a handle and a layered flame.
rect(icons, 22, 8, 24, 13, BROWN);
disc(icons, 23, 5, 3, FLAME);
disc(icons, 23, 4, 1.6, [255, 214, 90, 255]);

// Gem: a faceted diamond.
for (let y = 3; y <= 12; y++) {
  const half = 5 - Math.abs(y - 8);
  for (let x = 8 - half; x <= 8 + half; x++) {
    icons.set(x + 32, y, x + 32 < 36 ? CYAN : CYAN_DARK);
  }
}
rect(icons, 39, 3, 41, 12, [210, 248, 255, 255]);

save("icons.png", icons);

// --- parallax: a dusk sky with a moon and stars -----------------------------
// 128x64 (power-of-two sides: the pak image encoder requires it).

const sky = img(128, 64);
for (let y = 0; y < sky.h; y++) {
  const t = y / (sky.h - 1);
  // Deep violet at the top warming to magenta at the horizon.
  const r = Math.round(26 + (150 - 26) * t);
  const g = Math.round(12 + (60 - 12) * t);
  const b = Math.round(60 + (90 - 60) * t);
  for (let x = 0; x < sky.w; x++) sky.set(x, y, [r, g, b, 255]);
}
// A pale moon with two craters.
disc(sky, 100, 14, 8, [245, 232, 200, 255]);
disc(sky, 96, 11, 1.6, [222, 206, 168, 255]);
disc(sky, 104, 17, 1.2, [222, 206, 168, 255]);
// Scattered stars.
for (const [x, y] of [[8, 6], [24, 18], [40, 5], [58, 22], [76, 9], [118, 28], [16, 38], [68, 40], [92, 44], [44, 50]] as const) {
  rect(sky, x, y, x + 1, y + 1, [255, 255, 255, 255]);
}
save("sky.png", sky);

// --- animation sheet: a pulsing four-point sparkle, four frames -------------

const fx = img(64, 16);
const CORE: Rgba = [255, 255, 255, 255];
const RAY: Rgba = [255, 232, 120, 255];

/** A four-point sparkle: a horizontal and a vertical ray, each tapering
 *  from 3px at the centre to 1px at the tips, with a white-hot core. */
function sparkle(frame: number, radius: number): void {
  const ox = frame * 16;
  const put = (x: number, y: number, c: Rgba) => {
    if (x >= 0 && y >= 0 && x < 16 && y < 16) fx.set(ox + x, y, c);
  };
  for (let d = -radius; d <= radius; d++) {
    const half = Math.max(0, Math.round(((radius - Math.abs(d)) / radius) * 1.5));
    for (let t = -half; t <= half; t++) {
      const core = Math.abs(d) <= 1 && t === 0;
      put(7 + d, 7 + t, core ? CORE : RAY);
      put(7 + t, 7 + d, core ? CORE : RAY);
    }
  }
  disc(fx, ox + 7, 7, 1.6, CORE);
}

// Small, medium, large, medium: a four-frame pulse.
sparkle(0, 3);
sparkle(1, 5);
sparkle(2, 7);
sparkle(3, 5);
save("fx.png", fx);
