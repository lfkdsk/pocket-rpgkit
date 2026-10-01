// tools/web/preview.ts — render one frame of a built bundle to a PNG. The
// landing page uses it for a game that has no preview image configured in
// web.json. tools/web.ts runs it as a separate process because evaluating a
// bundle installs globals (ui, frame, __pak).
//
//   bun tools/web/preview.ts <pocketjs.wasm> <app.js> <app.pak|-> <out.png> <width> <height> <frames> <density>
//
// The app runs <frames> idle frames at 60 Hz on the same wasm core the
// player page uses, and the last frame is written as a PNG.

import { existsSync } from "node:fs";
import { createWasmUi } from "../../vendor/pocketjs/hosts/web/wasm-ops.js";
import { encodePNG } from "../../vendor/pocketjs/tools/png.ts";

const [wasmPath, bundlePath, pakPath, outPath, widthArg, heightArg, framesArg, densityArg] = Bun.argv.slice(2);
if (!wasmPath || !bundlePath || !pakPath || !outPath || !widthArg || !heightArg || !framesArg || !densityArg) {
  console.error("usage: bun tools/web/preview.ts <pocketjs.wasm> <app.js> <app.pak|-> <out.png> <width> <height> <frames> <density>");
  process.exit(2);
}
const width = Number(widthArg);
const height = Number(heightArg);
const frames = Number(framesArg);
const density = Number(densityArg);

const wasm = await createWasmUi(await Bun.file(wasmPath).arrayBuffer(), { width, height, rasterDensity: density });
const g = globalThis as Record<string, unknown>;
g.ui = wasm.ops;
g.__pak = pakPath !== "-" && existsSync(pakPath) ? await Bun.file(pakPath).arrayBuffer() : undefined;
g.__simHz = 60;
g.__pocketApp = "preview";
g.frame = undefined;
new Function(await Bun.file(bundlePath).text())();
const frame = g.frame as ((buttons: number, analog?: number) => void) | undefined;
if (typeof frame !== "function") throw new Error(`preview: ${bundlePath} did not install frame()`);
for (let i = 0; i < frames; i++) {
  frame(0, 0x8080);
  wasm.tick();
}
const pixels = wasm.renderScaled(density);
const colors = new Set(new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength / 4));
if (colors.size < 8) {
  console.error(`preview: frame ${frames} of ${bundlePath} is blank (${colors.size} colors)`);
  process.exit(1);
}
await Bun.write(outPath, encodePNG(pixels, width * density, height * density));
