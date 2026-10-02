// tools/preview/gen-cjk-font.ts — the preview's budgeted Chinese font.
//
//   bun tools/preview/gen-cjk-font.ts           # rewrite tools/preview/fonts/
//   bun tools/preview/gen-cjk-font.ts --check   # verify the committed files (no network)
//
// The preview plays any project a Studio user loads, so it cannot bake one
// project's characters at build time. It carries a subset of the pinned Noto
// Sans CJK SC source (tools/lib/cjk-font.ts) instead, and bakes the glyphs a
// loaded document needs at load time (tools/preview/cjk-glyphs.ts). The
// budget is the GB2312 level-1 hanzi (3,755 common characters) plus the
// GB2312 symbol rows, CJK punctuation (U+3000-303F) and the full-width forms
// (U+FF01-FF5E), less what Inter already draws. A character outside it shows
// as a missing-glyph box in the preview and is reported by `load`; a built
// game bakes its own subset (tools/cjk-font.ts) and is not limited by this.
//
// Characters beyond ASCII that Inter draws (curly quotes, dashes, accented
// Latin) are drawn from Inter in a built game, so a second, small subset of
// Inter Regular (Latin-1, Latin Extended-A, general punctuation, currency,
// letterlike symbols, arrows) comes first in the preview's face list.
//
// The Noto source is downloaded once and cached (RPGKIT_FONT_CACHE); the
// output is byte-identical across runs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  APP_LICENSE_FILE,
  CJK_FONT_SOURCE,
  cjkSourceFont,
  fallbackCharacters,
  licenseNotice,
  parseFontFile,
  subsetFont,
} from "../lib/cjk-font.ts";

const HERE = import.meta.dir;
export const PREVIEW_FONT_DIR = join(HERE, "fonts");
export const PREVIEW_FONT_FILE = "NotoSansCJKsc-preview.otf";
export const PREVIEW_LATIN_FILE = "Inter-preview.otf";
export const INTER_LICENSE_FILE = "LICENSE-Inter.txt";
const INTER_REGULAR = join(HERE, "../../vendor/pocketjs/assets/fonts/Inter-Regular.ttf");
const INTER_LICENSE = join(HERE, "../../vendor/pocketjs/assets/fonts/LICENSE.txt");

/** The Inter characters the Latin subset holds: every mapped codepoint of
 *  these blocks. */
export const PREVIEW_LATIN_RANGES: readonly (readonly [number, number])[] = [
  [0x00a0, 0x017f],
  [0x2010, 0x205e],
  [0x20a0, 0x20bf],
  [0x2100, 0x214f],
  [0x2190, 0x21ff],
];

/** The budgeted characters, decoded from GB2312 and the two Unicode blocks. */
export function previewBudgetText(): string {
  const gb2312 = new TextDecoder("gbk");
  let text = "";
  const rows = (first: number, last: number) => {
    for (let row = first; row <= last; row++) {
      for (let cell = 0xa1; cell <= 0xfe; cell++) {
        const ch = gb2312.decode(new Uint8Array([row, cell]));
        if (ch.length > 0 && ch !== "�") text += ch;
      }
    }
  };
  rows(0xa1, 0xa9); // symbols, punctuation, kana, Greek, Cyrillic, box drawing
  rows(0xb0, 0xd7); // level-1 hanzi
  for (let cp = 0x3000; cp <= 0x303f; cp++) text += String.fromCodePoint(cp);
  for (let cp = 0xff01; cp <= 0xff5e; cp++) text += String.fromCodePoint(cp);
  return text;
}

function provenance(characters: number, fontBytes: number): string {
  return `# Preview Chinese font

\`${PREVIEW_FONT_FILE}\` is the font the project preview (Studio play-test) draws Chinese
text from. It is a pak entry of the preview app; when a loaded document uses characters
the preview's baked atlases lack, the preview bakes just those glyphs from this font.

- Source: [${CJK_FONT_SOURCE.file}](https://github.com/notofonts/noto-cjk/blob/${CJK_FONT_SOURCE.revision}/Sans/OTF/SimplifiedChinese/${CJK_FONT_SOURCE.file})
  at commit \`${CJK_FONT_SOURCE.revision}\`, SHA-256 \`${CJK_FONT_SOURCE.sha256}\`.
\`${PREVIEW_LATIN_FILE}\` is a subset of Inter Regular (the kit's text face) for the characters
beyond ASCII that Inter draws; it is tried first. Its license is \`${INTER_LICENSE_FILE}\`.

- Budget: GB2312 level-1 hanzi, GB2312 symbol rows, U+3000-303F and U+FF01-FF5E,
  less the characters Inter draws: ${characters} characters, ${fontBytes} bytes.

Regenerate with \`bun tools/preview/gen-cjk-font.ts\`; \`--check\` verifies the committed
files offline. The font is licensed under the SIL Open Font License 1.1; the copyright
notice and the license are in \`${APP_LICENSE_FILE}\`, which the preview's pak and site
directory carry.
`;
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const wanted = fallbackCharacters([previewBudgetText()]);
  const fontPath = join(PREVIEW_FONT_DIR, PREVIEW_FONT_FILE);
  if (check) {
    if (!existsSync(fontPath)) {
      console.error(`gen-cjk-font: ${fontPath} is missing`);
      process.exit(1);
    }
    const font = parseFontFile(fontPath);
    const mapped = wanted.filter(cp => font.charToGlyphIndex(String.fromCodePoint(cp)) > 0).length;
    console.log(`gen-cjk-font: ${mapped} of ${wanted.length} budgeted characters mapped`);
    process.exit(mapped > 0 ? 0 : 1);
  }
  const inter = parseFontFile(INTER_REGULAR);
  const latin: number[] = [];
  for (const [first, last] of PREVIEW_LATIN_RANGES) {
    for (let cp = first; cp <= last; cp++) if (inter.charToGlyphIndex(String.fromCodePoint(cp)) > 0) latin.push(cp);
  }
  mkdirSync(PREVIEW_FONT_DIR, { recursive: true });
  const latinFont = subsetFont(INTER_REGULAR, latin, "Inter Preview Subset").bytes;
  writeFileSync(join(PREVIEW_FONT_DIR, PREVIEW_LATIN_FILE), latinFont);
  writeFileSync(join(PREVIEW_FONT_DIR, INTER_LICENSE_FILE), readFileSync(INTER_LICENSE));
  console.log(`gen-cjk-font: ${PREVIEW_LATIN_FILE}: ${latin.length} characters, ${latinFont.length} bytes`);

  const source = await cjkSourceFont();
  const { bytes, missing } = subsetFont(source, wanted);
  writeFileSync(fontPath, bytes);
  writeFileSync(join(PREVIEW_FONT_DIR, APP_LICENSE_FILE), licenseNotice(parseFontFile(source).getEnglishName("copyright")));
  const characters = wanted.length - missing.length;
  writeFileSync(join(PREVIEW_FONT_DIR, "NotoSansCJKsc-preview.md"), provenance(characters, bytes.length));
  console.log(`gen-cjk-font: ${characters} characters (${missing.length} budgeted ones the source lacks), ${bytes.length} bytes`);
}
