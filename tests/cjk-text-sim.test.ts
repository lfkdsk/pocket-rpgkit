// tests/cjk-text-sim.test.ts — Chinese text in the kit's boxes, rendered
// through the real GameView on the deterministic wasm sim host
// (tests/fixtures/cjk-text). For every page of the fixture dialog, at
// 480x272 and 960x544: the rows the box lays out keep every character in
// order, never start with a no-line-start character or end with a
// no-line-end one, never split a Latin word or number, never exceed the
// text column (measured by the core, and checked on pixels), and match the
// expected row count. The typewriter steps by code point; the choice and
// shop labels fit their boxes. Goldens pin three frames per size.

import { describe, expect, test } from "bun:test";
import { decodePng, unpack } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { BTN, FONT_CMAP_ENTRY_SIZE, FONT_HEADER_SIZE } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { fnv1a } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { NO_LINE_END, NO_LINE_START, scalarLength, sliceScalars } from "../src/engine/text-break.ts";
import { DEFAULT_PLAYER_NAME, substituteLines, substitutePlayerName } from "../src/engine/player-name.ts";
import { flowRows } from "../src/ui/text-flow.ts";
import { AFTER_CHOICE, CHOICE_OPTIONS, CHOICE_PROMPT, ITEMS, LONG_PAGE, PAGES } from "./fixtures/cjk-text/fixture-data.ts";
import { messagePage, messagePageStarts } from "../src/ui/dialog-pages.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { breakText } from "../src/engine/text-break.ts";
import { createFontMeasure } from "../tools/lib/font-measure.ts";
import { DEFAULT_UI_THEME } from "../src/ui/theme.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { bootGameWorld, installGameSimIsolation, type BoundGameWorld } from "./helpers/sim-session.ts";

const preflight = appPreflight("cjk-text");
if (!preflight.ok) console.warn(`cjk text sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

const NO_START = new Set(NO_LINE_START);
const NO_END = new Set(NO_LINE_END);

const VIEWPORTS = [
  { width: 480, height: 272 },
  { width: 960, height: 544 },
] as const;

/** Rows each page lays out in, by viewport width: at 480 the column holds
 *  37 fullwidth characters, at 960 every authored line fits. */
const EXPECTED_ROWS: Readonly<Record<number, readonly number[]>> = {
  480: [3, 4, 3, 4, 1],
  960: [2, 2, 2, 4, 1],
};

const HASHES: Readonly<Record<string, string>> = {};

const FIXTURE = join(import.meta.dir, "fixtures", "cjk-text");
const buildMeasure = createFontMeasure({ px: 12, fallbacks: [join(FIXTURE, "fonts", "NotoSansCJKsc-subset.otf")] });

interface TreeNode {
  t?: string;
  n?: string;
  x?: string;
  k?: TreeNode[];
}

function findNode(node: TreeNode, name: string): TreeNode | null {
  if (node.n === name) return node;
  for (const child of node.k ?? []) {
    const hit = findNode(child, name);
    if (hit) return hit;
  }
  return null;
}

function nodeText(node: TreeNode | null): string {
  if (!node) return "";
  if (node.t === "#text") return node.x ?? "";
  return (node.k ?? []).map(nodeText).join("");
}

/** The message box's visible rows (a hidden row keeps a " " placeholder). */
function messageRows(world: BoundGameWorld): string[] {
  const tree = world.getTree() as TreeNode;
  const rows: string[] = [];
  for (let i = 0; i < 8; i++) {
    const text = nodeText(findNode(tree, `rpgkit-message-row-${i}`));
    if (text.trim() !== "") rows.push(text);
  }
  return rows;
}

/** Every string drawn anywhere in the tree. */
function allTexts(node: TreeNode, out: string[] = []): string[] {
  if (node.t === "#text" && node.x) out.push(node.x);
  for (const child of node.k ?? []) allTexts(child, out);
  return out;
}

/** The kit never adds an ellipsis: no drawn string has one (no fixture
 *  string contains it). */
function expectNoEllipsis(world: BoundGameWorld): void {
  for (const text of allTexts(world.getTree() as TreeNode)) {
    expect(text.includes("\u2026"), `ellipsis in ${JSON.stringify(text)}`).toBe(false);
  }
}

function measure(text: string): number {
  const ops = (globalThis as unknown as { ui: { measureText(s: string, slot: number): number } }).ui;
  return ops.measureText(text, 0);
}

function pump(world: BoundGameWorld, frames: number, buttons = 0): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(buttons, 0x8080);
    for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  }
}

function confirm(world: BoundGameWorld): void {
  pump(world, 1, BTN.CIRCLE);
  pump(world, 1);
}

type ModalProbe = {
  kind: string;
  total?: number;
  revealed?: number;
  complete?: boolean;
  lines?: string[];
  pageStarts?: number[];
  page?: number;
  index?: number;
} | null;
function modal(world: BoundGameWorld): ModalProbe {
  return (world.probes().state as unknown as { interp: { modal: ModalProbe } }).interp.modal;
}

/** Pump until the open text box has typed everything. */
function settle(world: BoundGameWorld): void {
  const done = () => {
    const m = modal(world);
    return m !== null && (m.kind !== "text" || m.complete === true);
  };
  for (let i = 0; i < 600 && !done(); i++) pump(world, 1);
  pump(world, 2);
}

/** Assert the rows are the source, in order, broken only where allowed. An
 *  authored "\n" the box joined shows as a space between Latin text and as
 *  nothing next to CJK. */
function expectLegalRows(rows: readonly string[], source: string, budget: number): void {
  const isWord = (ch: string) => /[A-Za-z0-9]/.test(ch);
  const isBreak = (ch: string | undefined) => ch === " " || ch === "\n";
  let at = 0;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    while (isBreak(source[at])) at++;
    for (let i = 0; i < row.length; i++) {
      if (source[at] === "\n") {
        at++;
        if (row[i] === " ") continue;
      }
      expect(source[at], `row ${r} ${JSON.stringify(row)} char ${i}`).toBe(row[i]);
      at++;
    }
    const first = String.fromCodePoint(row.codePointAt(0)!);
    const last = [...row].at(-1)!;
    expect(NO_START.has(first.codePointAt(0)!), `row ${r} starts with ${first}`).toBe(false);
    if (r < rows.length - 1) {
      expect(NO_END.has(last.codePointAt(0)!), `row ${r} ends with ${last}`).toBe(false);
      // A row may end inside a Latin run only at a space or an authored break.
      const next = source[at];
      if (next !== undefined && !isBreak(next)) {
        expect(isWord(last) && isWord(next), `row ${r} splits "${last}${next}"`).toBe(false);
      }
    }
    expect(measure(row), `row ${r} width`).toBeLessThanOrEqual(budget);
  }
  while (isBreak(source[at])) at++;
  expect(at, "every character is shown").toBe(source.length);
}

/** The rows the box lays a page out in at `budget` px, by the core's
 *  measurer. */
function flowRowsOf(lines: readonly string[], budget: number): string[] {
  return flowRows(lines, budget, 4, measure).rows.map((row) => row.text);
}

/** Which of the choices/shop box's first `rows` item rows hold a pixel of
 *  `color` (a `boxH` px box docked 12 px from the right and 98 px up; rows
 *  are 14 px from 26 px below its top). */
function choiceRowsWithInk(frame: Uint8Array, width: number, height: number, color: string, boxH = 96, rows = 4): boolean[] {
  const rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const top = height - 98 - boxH;
  const left = width - 12 - 248 + 8;
  return Array.from({ length: rows }, (_, row) => {
    for (let y = top + 26 + 14 * row; y < top + 40 + 14 * row; y++) {
      for (let x = left; x < width - 20; x++) {
        const px = rgbaAt(frame, width, x, y);
        if (px[0] === rgb[0] && px[1] === rgb[1] && px[2] === rgb[2]) return true;
      }
    }
    return false;
  });
}

function rgbaAt(frame: Uint8Array, width: number, x: number, y: number): number[] {
  const i = (y * width + x) * 4;
  return [...frame.subarray(i, i + 4)];
}

/** Columns of the message paper right of the text column hold no ink. */
function expectNoInkPastColumn(frame: Uint8Array, width: number, height: number): void {
  // Message box: inset 8, border 2, padding 8; four 15 px rows from the
  // paper's top padding (box top = height - 100).
  const top = height - 100 + 2 + 8;
  // The paper colour, sampled in the left padding.
  const paper = rgbaAt(frame, width, 12, top);
  for (let y = top; y < top + 60; y++) {
    for (let x = width - 18; x < width - 10; x++) {
      expect(rgbaAt(frame, width, x, y), `ink at (${x},${y})`).toEqual(paper);
    }
  }
}

async function golden(name: string, frame: Uint8Array, width: number, height: number): Promise<string> {
  const url = new URL(`./goldens/${name}.png`, import.meta.url);
  if (process.env.CJK_UPDATE_GOLDENS) await Bun.write(url, encodePNG(frame, width, height));
  const bytes = new Uint8Array(await Bun.file(url).arrayBuffer());
  expect(frame).toEqual(decodePng(bytes).rgba);
  return fnv1a(frame);
}

async function goldenFrame(world: BoundGameWorld, name: string, width: number, height: number): Promise<void> {
  const hash = await golden(name, world.render().slice(), width, height);
  if (HASHES[name]) expect(hash).toBe(HASHES[name]);
}

simDescribe("CJK text in the kit's boxes", () => {
  for (const viewport of VIEWPORTS) {
    const { width, height } = viewport;
    const size = `${width}x${height}`;
    test(`dialog pages break legally at ${size}`, async () => {
      const world = await bootGameWorld(appBundle("cjk-text"), 60, undefined, undefined, viewport);
      const budget = width - 36;
      for (let page = 0; page < PAGES.length; page++) {
        settle(world);
        const source = substitutePlayerName(PAGES[page]!.join("\n"), DEFAULT_PLAYER_NAME);
        const m = modal(world)!;
        expect(m.kind).toBe("text");
        expect(m.total, "the typewriter counts code points").toBe(scalarLength(source));
        const rows = messageRows(world);
        expect(rows.length, `page ${page} rows: ${JSON.stringify(rows)}`).toBe(EXPECTED_ROWS[width]![page]!);
        expectLegalRows(rows, source, budget);
        // An importer paginating with the build-time measurer (same font
        // files) gets the rows the device lays out.
        if (rows.length <= 4 && breakText(source, budget, buildMeasure).length <= 4) {
          expect(breakText(source, budget, buildMeasure).map((row) => row.text)).toEqual(rows);
        }
        const frame = world.render().slice();
        expectNoInkPastColumn(frame, width, height);
        if (page === 1) await goldenFrame(world, `cjk-text.kinsoku.${size}`, width, height);
        if (page === 3) await goldenFrame(world, `cjk-text.reflow.${size}`, width, height);
        confirm(world);
      }

      // The long message: pages cut at the 480 px design width with the
      // baked font (the build-time measurer gives the same offsets), one
      // confirm each, at every viewport; together they show every
      // character in order.
      const longSource = substitutePlayerName(LONG_PAGE.join("\n"), DEFAULT_PLAYER_NAME);
      const longLines = substituteLines(LONG_PAGE, DEFAULT_PLAYER_NAME);
      const starts = messagePageStarts(longLines, { viewportWidth: 480 }, buildMeasure)!;
      expect(starts.length).toBe(2);
      const pageRows: string[][] = [];
      for (let page = 0; page < starts.length; page++) {
        settle(world);
        const m = modal(world)!;
        expect(m.pageStarts).toEqual(starts);
        expect(m.page).toBe(page);
        const rows = messageRows(world);
        expect(rows.length).toBeLessThanOrEqual(4);
        // Four rows then two at the design width; the same two pages at
        // 960 px hold three rows and one.
        expect(rows.length).toBe((width === 480 ? [4, 2] : [3, 1])[page]!);
        expect(rows).toEqual(flowRowsOf(messagePage(longLines, 0, starts, page), budget));
        expectNoEllipsis(world);
        pageRows.push(rows);
        expectNoInkPastColumn(world.render().slice(), width, height);
        await goldenFrame(world, `cjk-text.long-${page + 1}.${size}`, width, height);
        confirm(world);
      }
      expectLegalRows(pageRows.flat(), longSource, budget);

      // Choices: the long option wraps onto a second row (the cursor
      // prefix on its first row only); the prompt fits as authored.
      expect(modal(world)?.kind).toBe("choices");
      const tree = world.getTree() as TreeNode;
      expect(nodeText(findNode(tree, "rpgkit-choice-prompt"))).toBe(CHOICE_PROMPT);
      const options = [0, 1, 2, 3, 4].map((i) => nodeText(findNode(tree, `rpgkit-choice-${i}`)));
      expect(options[0]).toBe(`> ${CHOICE_OPTIONS[0]}`);
      expect(options[1]!.startsWith("  ")).toBe(true);
      expect(options[2]!.startsWith("  ")).toBe(true);
      expect(options[1]!.slice(2) + options[2]!.slice(2)).toBe(CHOICE_OPTIONS[1]);
      expect(options[3]).toBe(`  ${CHOICE_OPTIONS[2]}`);
      expect(options[4]).toBe("");
      // Choices box content: 248 - 2 * (border 2 + padding 6).
      for (const option of options) expect(measure(option)).toBeLessThanOrEqual(232);
      expectNoEllipsis(world);
      await goldenFrame(world, `cjk-text.choices.${size}`, width, height);
      // The cursor colours both rows of the wrapped option.
      pump(world, 1, BTN.DOWN);
      pump(world, 1);
      expect(modal(world)?.index).toBe(1);
      const accentRows = choiceRowsWithInk(world.render().slice(), width, height, DEFAULT_UI_THEME.accent);
      expect(accentRows).toEqual([false, true, true, false]);
      expect(nodeText(findNode(world.getTree() as TreeNode, "rpgkit-choice-1")).startsWith("> ")).toBe(true);
      pump(world, 1, BTN.UP);
      pump(world, 1);
      confirm(world);
      settle(world);
      expect(messageRows(world)).toEqual([AFTER_CHOICE]);
      confirm(world);

      // Shop: a name too wide beside its price column wraps; the price
      // stays on its first row and the box grows a row.
      pump(world, 2);
      expect(modal(world)?.kind).toBe("shop");
      const shop = world.getTree() as TreeNode;
      const shopRows = [0, 1, 2, 3, 4].map((row) => (findNode(shop, `rpgkit-shop-row-${row}`)!.k ?? []).map(nodeText));
      for (const [left, right] of shopRows) {
        expect(measure(left!) + (right ? 6 + measure(right) : 0), `shop row ${left}`).toBeLessThanOrEqual(232);
      }
      expect(shopRows[0]).toEqual([`> ${ITEMS[0]!.name}`, "30g (3)"]);
      expect(shopRows[1]![1]).toBe("120g (3)");
      expect(shopRows[2]![1]).toBe("");
      expect(shopRows[1]![0]!.slice(2) + shopRows[2]![0]!.slice(2)).toBe(ITEMS[1]!.name);
      expect(shopRows[3]).toEqual([`  ${ITEMS[2]!.name}`, "200g (3)"]);
      expectNoEllipsis(world);
      await goldenFrame(world, `cjk-text.shop.${size}`, width, height);
      // The cursor on the wrapped name colours both of its rows (the box is
      // one row taller: 110 px).
      expect(choiceRowsWithInk(world.render().slice(), width, height, DEFAULT_UI_THEME.accent, 110, 5))
        .toEqual([true, false, false, false, false]);
      pump(world, 1, BTN.DOWN);
      pump(world, 1);
      expect(modal(world)?.index).toBe(1);
      expect(choiceRowsWithInk(world.render().slice(), width, height, DEFAULT_UI_THEME.accent, 110, 5))
        .toEqual([false, true, true, false, false]);
    }, 60_000);
  }

  test("the long message turns the same pages at 60, 30 and 20 Hz", async () => {
    const seen: { rows: string[][]; frames: Uint8Array[] }[] = [];
    for (const hz of [60, 30, 20] as const) {
      const world = await bootGameWorld(appBundle("cjk-text"), hz, undefined, undefined, VIEWPORTS[0]);
      for (let page = 0; page < PAGES.length; page++) {
        settle(world);
        confirm(world);
      }
      const rows: string[][] = [];
      const frames: Uint8Array[] = [];
      for (let page = 0; ; page++) {
        settle(world);
        const m = modal(world)!;
        if (m.kind !== "text" || m.lines?.[0] !== substitutePlayerName(LONG_PAGE[0]!, DEFAULT_PLAYER_NAME)) break;
        expect(m.page, `${hz} Hz page`).toBe(page);
        rows.push(messageRows(world));
        frames.push(world.render().slice());
        confirm(world);
      }
      expect(modal(world)?.kind).toBe("choices");
      seen.push({ rows, frames });
    }
    expect(seen[0]!.rows.length).toBe(2);
    for (const other of seen.slice(1)) {
      expect(other.rows).toEqual(seen[0]!.rows);
      other.frames.forEach((frame, i) => expect(fnv1a(frame), `page ${i + 1}`).toBe(fnv1a(seen[0]!.frames[i]!)));
    }
  }, 60_000);

  test("a page's typewriter starts at its first character", async () => {
    const world = await bootGameWorld(appBundle("cjk-text"), 60, undefined, undefined, VIEWPORTS[0]);
    for (let page = 0; page < PAGES.length; page++) {
      settle(world);
      confirm(world);
    }
    settle(world);
    const lines = substituteLines(LONG_PAGE, DEFAULT_PLAYER_NAME);
    const starts = modal(world)!.pageStarts!;
    confirm(world); // turn to page 2
    const text = messagePage(lines, 0, starts, 1).join("");
    const shown = new Set<number>();
    for (let i = 0; i < 400 && !modal(world)?.complete; i++) {
      const m = modal(world)!;
      expect(m.page).toBe(1);
      const typed = m.revealed! - starts[1]!;
      expect(messageRows(world).join("")).toBe(sliceScalars(text, typed));
      shown.add(typed);
      pump(world, 1);
    }
    expect(shown.has(0) || shown.has(1)).toBe(true);
    expect(messageRows(world).join("")).toBe(text);
  }, 30_000);

  test("the typewriter reveals a supplementary character as one glyph", async () => {
    const world = await bootGameWorld(appBundle("cjk-text"), 60, undefined, undefined, VIEWPORTS[0]);
    for (let page = 0; page < 4; page++) {
      settle(world);
      confirm(world);
    }
    const source = PAGES[4]!.join("\n");
    for (let i = 0; i < 60 && modal(world) === null; i++) pump(world, 1);
    const seen = new Set<number>();
    for (let i = 0; i < 400 && !modal(world)?.complete; i++) {
      const m = modal(world)!;
      const rows = messageRows(world);
      const shown = rows.join("");
      expect(shown).toBe(m.revealed! > 0 ? sliceScalars(source, m.revealed!) : "");
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(shown), "no lone high surrogate").toBe(false);
      seen.add(m.revealed!);
      pump(world, 1);
    }
    expect(seen.has(1), "one step shows the whole first character").toBe(true);
    expect(modal(world)?.total).toBe(17);
  }, 30_000);

  test("the escaped supplementary character has a real glyph, not tofu, in every slot", () => {
    // fixture-data.ts spells U+20BB7 only as "\u{20BB7}"; the font tool reads
    // decoded strings, so the subset and the baked atlases hold it.
    const blobs = unpack(new Uint8Array(readFileSync(`${appBundle("cjk-text")}.pak`)));
    const fonts = blobs.filter((blob) => blob.key.startsWith("ui:font."));
    expect(fonts.length).toBeGreaterThan(0);
    for (const blob of fonts) {
      const bytes = blob.data as Uint8Array;
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const glyphCount = dv.getUint16(6, true);
      const [cellW, cellH, density] = [bytes[8]!, bytes[9]!, bytes[14]!];
      let gid = -1;
      let advance = 0;
      for (let i = 0; i < glyphCount; i++) {
        const o = FONT_HEADER_SIZE + i * FONT_CMAP_ENTRY_SIZE;
        if (dv.getUint32(o, true) === 0x20bb7) {
          gid = dv.getUint16(o + 4, true);
          advance = bytes[o + 6]!;
        }
      }
      expect(gid, `${blob.key} maps U+20BB7`).toBeGreaterThan(0);
      const cell = cellW * cellH * density * density;
      const coverage = FONT_HEADER_SIZE + glyphCount * FONT_CMAP_ENTRY_SIZE;
      const glyph = bytes.subarray(coverage + gid * cell, coverage + (gid + 1) * cell);
      const tofu = bytes.subarray(coverage, coverage + cell);
      const ink = glyph.reduce((n, v) => n + (v > 127 ? 1 : 0), 0);
      expect(ink, `${blob.key} U+20BB7 is inked`).toBeGreaterThan(cell / 10);
      expect(Buffer.compare(Buffer.from(glyph), Buffer.from(tofu))).not.toBe(0);
      // A full-width ideograph: its advance is the slot's px, the tofu's is narrower.
      expect(advance).toBeGreaterThanOrEqual(12);
    }
  });

  const density2 = join(import.meta.dir, "..", "dist", "density-2", "cjk-text");
  const densityTest = existsSync(`${density2}.js`) && existsSync(`${density2}.pak`) ? test : test.skip;
  densityTest("renders the glyphs at 2x raster density for the web", async () => {
    const frames: { density: number; rgba: Uint8Array }[] = [];
    for (const density of [1, 2] as const) {
      const bundle = density === 1 ? appBundle("cjk-text") : density2;
      const world = await bootGameWorld(bundle, 60, undefined, undefined, {
        width: 480, height: 272, rasterDensity: density, renderScale: density,
      });
      settle(world);
      confirm(world);
      settle(world);
      // Same rows at both densities: layout is logical.
      expect(messageRows(world)[1]!.startsWith("\u5C4B\u3002")).toBe(true);
      const rgba = world.render().slice();
      expect(rgba.length).toBe(480 * density * 272 * density * 4);
      if (density === 2) await goldenFrame(world, "cjk-text.kinsoku.density2", 960, 544);
      frames.push({ density, rgba });
    }
    // Sharper strokes: at 2x a smaller share of the glyph pixels in the
    // first row are blended edge samples than at 1x.
    const edgeShare = ({ density, rgba }: { density: number; rgba: Uint8Array }) => {
      const width = 480 * density;
      const paper = rgbaAt(rgba, width, 12 * density, 182 * density);
      const inkRgb = [1, 3, 5].map((i) => parseInt(DEFAULT_UI_THEME.ink.slice(i, i + 2), 16));
      let ink = 0;
      let edge = 0;
      for (let y = 182 * density; y < 197 * density; y++) {
        for (let x = 18 * density; x < 460 * density; x++) {
          const px = rgbaAt(rgba, width, x, y);
          if (px.every((v, i) => v === paper[i])) continue;
          if (px[0] === inkRgb[0] && px[1] === inkRgb[1] && px[2] === inkRgb[2]) ink++;
          else edge++;
        }
      }
      return edge / (ink + edge);
    };
    expect(edgeShare(frames[1]!)).toBeLessThan(edgeShare(frames[0]!));
  }, 30_000);
});
