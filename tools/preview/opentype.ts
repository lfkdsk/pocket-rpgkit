// tools/preview/opentype.ts — the font parser, for the preview's run-time
// glyph baking (cjk-glyphs.ts).
//
// opentype.js is a dependency of the vendored PocketJS (its glyph baker), not
// of the kit, so it is imported from there. Its ESM build has no default
// export; the namespace import works in the Bun runtime and in the browser
// bundle alike.

// @ts-expect-error -- the ESM file ships without type declarations; the one
// function used is typed below.
import * as opentypeModule from "../../vendor/pocketjs/node_modules/opentype.js/dist/opentype.min.mjs";
import type { Font as OpentypeFont } from "../../vendor/pocketjs/node_modules/@types/opentype.js/index.d.ts";

/** An opentype.js font. */
export type Font = OpentypeFont;

export function parseFont(bytes: Uint8Array): Font {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return (opentypeModule as { parse(buffer: ArrayBuffer): Font }).parse(buffer);
}
