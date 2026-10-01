// tests/choice-icon-render.test.ts — choices options with icons
// (ChoiceOption.icon) through the built ui-theme fixture on the
// deterministic wasm sim host, at 480x272 and 960x544.
//
//   1. ICONS     each visible row draws its sprite left of the label, pixel
//                for pixel against the source PNG (1x, nearest), centred in
//                the 24 px row; the cursor bar (accent tint + accent frame)
//                spans icon and label and follows the cursor and the scroll
//                window.
//   2. MISSING   an unknown or uncooked sprite draws the framed "?"
//                placeholder, warns once per key, and never throws.
//   3. NO ICONS  the icon box is not mounted until a modal has icons, and
//                the text-only box stays byte-identical to its golden
//                (tests/goldens/ui-default.choices.png), also after an icon
//                menu has come and gone.
//
// The fixture resolves icons with GameView's resolveChoiceIcon
// (src/ui/choice-icons.ts), so the pixel checks against the exact source
// PNG also pin its frame choice: `dir` picks the facing, `frame` the pose
// (playerImageKey order), a static sprite ignores both.
//
// Icon box geometry, for a W x H screen (box 248 x 144, docked insetR 12,
// insetB 8; frame 2 + padding 6):
//   box      x W-260 .. W-12, y H-152 .. H-8
//   rows     y H-126 + 24 r, 24 px tall, r = 0..3; content from x W-252
//   icon     x W-248 .. W-232 (16 px cell): a 16x32 walker frame shows its
//            rows 8..31 over the full row, a 16x16 image rows 4..19
//   label    from x W-226
//
// Needs `bun run build:example ui-theme` and the wasm core; without them
// the sim cases register as skips.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { bootWorld, fnv1a, type SimWorld } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { DEFAULT_UI_THEME } from "../src/ui/theme.ts";
import { ICON_ART, ICON_SPRITES } from "./fixtures/ui-theme/icons.ts";
import { THEMES, type FixtureScene } from "./fixtures/ui-theme/scenes.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";

const preflight = appPreflight("ui-theme");
if (!preflight.ok) console.warn(`choice icon sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

const FIXTURE_DIR = new URL("./fixtures/ui-theme/", import.meta.url);
const ROW_H = 24;
/** Pinned pixels of the icon-mode box (iconChoices, default theme). */
const ICON_HASHES: Readonly<Record<string, string>> = {
  "480x272": "c6888635",
  "960x544": "c1c46635",
};

type Rgb = readonly [number, number, number];
const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as unknown as Rgb;

interface Png { width: number; height: number; rgba: Uint8Array }
const pngCache = new Map<string, Png>();
async function sprite(src: string): Promise<Png> {
  let png = pngCache.get(src);
  if (!png) {
    png = decodePng(new Uint8Array(await Bun.file(new URL(src, FIXTURE_DIR)).arrayBuffer())) as Png;
    pngCache.set(src, png);
  }
  return png;
}

for (const vp of [{ width: 480, height: 272 }, { width: 960, height: 544 }] as const) {
  const W = vp.width;
  const H = vp.height;
  const BOX = { x0: W - 260, x1: W - 12, y0: H - 152, y1: H - 8 };
  const ROW_X0 = W - 252; // paper content left (bar left edge)
  const ROW_X1 = W - 20; // paper content right (bar right edge, exclusive)
  const ICON_X = W - 248;
  const LABEL_X = W - 226;
  const rowY = (r: number) => H - 126 + r * ROW_H;

  const at = (fb: Uint8Array, x: number, y: number): Rgb => {
    const i = (y * W + x) * 4;
    return [fb[i]!, fb[i + 1]!, fb[i + 2]!];
  };
  const count = (fb: Uint8Array, hex: string, x0: number, x1: number, y0: number, y1: number): number => {
    const [r, g, b] = rgb(hex);
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * W + x) * 4;
        if (fb[i] === r && fb[i + 1] === g && fb[i + 2] === b) n++;
      }
    }
    return n;
  };

  /** Every opaque pixel of `src` lands at its 1x position in row `r`'s
   *  icon cell (a 16x32 frame's rows 8..31, a 16x16 image at +4). Returns
   *  how many opaque pixels were compared. */
  async function expectIcon(fb: Uint8Array, r: number, src: string): Promise<number> {
    const png = await sprite(src);
    const top = png.height === 32 ? rowY(r) - 8 : rowY(r) + 4;
    let compared = 0;
    for (let y = 0; y < png.height; y++) {
      const sy = top + y;
      if (sy < rowY(r) || sy >= rowY(r) + ROW_H) continue;
      for (let x = 0; x < png.width; x++) {
        const s = (y * png.width + x) * 4;
        if (png.rgba[s + 3] !== 255) continue;
        expect(at(fb, ICON_X + x, sy), `${src} (${x},${y}) row ${r}`).toEqual([png.rgba[s]!, png.rgba[s + 1]!, png.rgba[s + 2]!]);
        compared++;
      }
    }
    return compared;
  }

  simDescribe(`choice icons — built fixture at ${W}x${H}`, () => {
    let world: SimWorld;
    let structuralOps = 0;
    const STRUCTURAL = new Set(["createNode", "destroyNode", "insertBefore", "removeChild"]);
    const show = (scene: FixtureScene): Uint8Array => {
      (globalThis as { __uiFixture?: { show(s: FixtureScene): void } }).__uiFixture!.show(scene);
      world.frame(0);
      world.tick();
      return world.render().slice();
    };
    const hasNode = (tree: unknown, name: string): boolean => {
      const node = tree as { n?: string; k?: unknown[] } | null;
      if (!node) return false;
      return node.n === name || (Array.isArray(node.k) && node.k.some((c) => hasNode(c, name)));
    };
    let warn: ReturnType<typeof spyOn>;
    let plainChoices = "";

    beforeAll(async () => {
      world = await bootWorld(appBundle("ui-theme"), 60, undefined, (ops) => {
        for (const [name, fn] of Object.entries(ops)) {
          if (typeof fn !== "function" || !STRUCTURAL.has(name)) continue;
          ops[name] = (...args: unknown[]) => {
            structuralOps++;
            return (fn as (...a: unknown[]) => unknown).apply(ops, args);
          };
        }
      }, vp);
      // After the boot: switching worlds restores the console the previous
      // world was booted with, which would drop an earlier spy.
      warn = spyOn(console, "warn").mockImplementation(() => {});
      world.frame(0);
      world.tick();
    });
    afterAll(() => warn.mockRestore());

    test("without icons the icon box is not mounted and the text-only box is unchanged", async () => {
      show({});
      const fb = show({ modal: "choices" });
      expect(hasNode(world.getTree(), "rpgkit-choices-icon-box")).toBe(false);
      plainChoices = fnv1a(fb);
      if (W === 480) {
        const golden = new Uint8Array(await Bun.file(new URL("./goldens/ui-default.choices.png", import.meta.url)).arrayBuffer());
        expect(fnv1a(fb)).toBe(fnv1a(decodePng(golden).rgba));
      }
    });

    test("each row draws its sprite left of the label; the cursor bar spans the selected row", async () => {
      show({});
      const fb = show({ modal: "iconChoices" });
      const d = DEFAULT_UI_THEME;
      // The frame of the taller, lower-docked box.
      expect(count(fb, d.border, BOX.x0, BOX.x1, BOX.y0, BOX.y0 + 2)).toBe((BOX.x1 - BOX.x0) * 2);
      expect(count(fb, d.border, BOX.x0, BOX.x1, BOX.y1 - 2, BOX.y1)).toBe((BOX.x1 - BOX.x0) * 2);
      // Icons, pixel for pixel: curator down idle, guide left idle,
      // alternate right step-L (walkL[3]), the static sign.
      const walker = (name: string) => ICON_ART[name] as Exclude<(typeof ICON_ART)[string], string>;
      expect(await expectIcon(fb, 0, walker("curator").idle[0])).toBeGreaterThan(150);
      expect(await expectIcon(fb, 1, walker("guide").idle[1])).toBeGreaterThan(150);
      expect(await expectIcon(fb, 2, walker("alternate").walkL[3])).toBeGreaterThan(150);
      expect(await expectIcon(fb, 3, "assets/sign.png")).toBeGreaterThan(100);
      // A walker frame is clipped to its row: nothing of it shows in the
      // 4 px gap between the prompt and row 0.
      expect(count(fb, d.paper, ICON_X, ICON_X + 16, rowY(0) - 4, rowY(0))).toBe(64);
      // Cursor on row 1: accent frame on all four edges spanning icon and
      // label, tinted fill inside, plain paper on the other rows.
      const y1 = rowY(1);
      expect(count(fb, d.accent, ROW_X0, ROW_X1, y1, y1 + 1)).toBe(ROW_X1 - ROW_X0);
      expect(count(fb, d.accent, ROW_X0, ROW_X1, y1 + ROW_H - 1, y1 + ROW_H)).toBe(ROW_X1 - ROW_X0);
      expect(count(fb, d.accent, ROW_X0, ROW_X0 + 1, y1, y1 + ROW_H)).toBe(ROW_H);
      expect(count(fb, d.accent, ROW_X1 - 1, ROW_X1, y1, y1 + ROW_H)).toBe(ROW_H);
      const tint = at(fb, ROW_X1 - 8, y1 + 12);
      expect(tint).not.toEqual(rgb(d.paper));
      expect(at(fb, ICON_X + 1, y1 + 1 + 1)).toEqual(tint); // behind the icon's transparent corner
      for (const r of [0, 2, 3]) {
        expect(at(fb, ROW_X1 - 8, rowY(r) + 12), `row ${r}`).toEqual(rgb(d.paper));
        expect(count(fb, d.accent, ROW_X0, ROW_X1, rowY(r), rowY(r) + ROW_H), `row ${r}`).toBe(0);
      }
      // Labels: selected in accent, the rest in ink, left-aligned after the icon.
      expect(count(fb, d.accent, LABEL_X, ROW_X1 - 2, y1 + 2, y1 + ROW_H - 2)).toBeGreaterThan(15);
      expect(count(fb, d.ink, LABEL_X, ROW_X1 - 2, y1 + 2, y1 + ROW_H - 2)).toBe(0);
      for (const r of [0, 2, 3]) expect(count(fb, d.ink, LABEL_X, ROW_X1, rowY(r), rowY(r) + ROW_H), `row ${r}`).toBeGreaterThan(15);
      expect(count(fb, d.ink, ROW_X0, LABEL_X - 2, rowY(0), rowY(4))).toBe(0);
      // The prompt row above the rows, in dim.
      expect(count(fb, d.dim, ROW_X0, ROW_X1, H - 144, H - 130)).toBeGreaterThan(20);

      if (process.env.CHOICE_ICON_UPDATE_GOLDENS) {
        await Bun.write(new URL(`./goldens/choice-icon.${W}x${H}.png`, import.meta.url), encodePNG(fb, W, H));
      }
      const golden = new Uint8Array(await Bun.file(new URL(`./goldens/choice-icon.${W}x${H}.png`, import.meta.url)).arrayBuffer());
      expect(fnv1a(fb)).toBe(fnv1a(decodePng(golden).rgba));
      expect(fnv1a(fb)).toBe(ICON_HASHES[`${W}x${H}`]!);
    });

    test("the cursor bar moves with the cursor without building nodes", async () => {
      show({});
      show({ modal: "iconChoices" });
      structuralOps = 0;
      const fb = show({ modal: "iconChoicesLast" });
      expect(structuralOps).toBe(0);
      const d = DEFAULT_UI_THEME;
      const y3 = rowY(3);
      expect(count(fb, d.accent, ROW_X0, ROW_X1, y3, y3 + 1)).toBe(ROW_X1 - ROW_X0);
      expect(count(fb, d.accent, ROW_X0, ROW_X1, rowY(1), rowY(1) + ROW_H)).toBe(0);
      expect(at(fb, ROW_X1 - 8, rowY(1) + 12)).toEqual(rgb(d.paper));
      // The sign over the tint keeps its own opaque pixels.
      expect(await expectIcon(fb, 3, "assets/sign.png")).toBeGreaterThan(100);
    });

    test("eight icon rows scroll a four-row window that follows the cursor", async () => {
      show({});
      const fb = show({ modal: "iconChoices8" });
      // index 5 of 8 -> window 4..7, cursor on window row 1.
      const curator = ICON_ART.curator as Exclude<(typeof ICON_ART)[string], string>;
      const guide = ICON_ART.guide as Exclude<(typeof ICON_ART)[string], string>;
      const alternate = ICON_ART.alternate as Exclude<(typeof ICON_ART)[string], string>;
      expect(await expectIcon(fb, 0, curator.idle[2])).toBeGreaterThan(150);
      expect(await expectIcon(fb, 1, guide.idle[3])).toBeGreaterThan(150);
      expect(await expectIcon(fb, 2, alternate.idle[1])).toBeGreaterThan(150);
      expect(await expectIcon(fb, 3, curator.walkR[0])).toBeGreaterThan(150);
      expect(count(fb, DEFAULT_UI_THEME.accent, ROW_X0, ROW_X1, rowY(1), rowY(1) + 1)).toBe(ROW_X1 - ROW_X0);
    });

    test("an unknown or uncooked sprite draws the '?' placeholder, warns once, and never throws", async () => {
      warn.mockClear();
      show({});
      const fb = show({ modal: "iconChoicesMissing" });
      const d = DEFAULT_UI_THEME;
      // Row 0 has its curator; row 1 has no icon at all (an empty cell, the
      // label still aligned); rows 2 and 3 show the framed "?".
      expect(await expectIcon(fb, 0, (ICON_ART.curator as Exclude<(typeof ICON_ART)[string], string>).idle[0])).toBeGreaterThan(150);
      expect(count(fb, d.paper, ICON_X, ICON_X + 16, rowY(1), rowY(1) + ROW_H)).toBe(16 * ROW_H);
      expect(count(fb, d.ink, LABEL_X, ROW_X1, rowY(1), rowY(1) + ROW_H)).toBeGreaterThan(15);
      for (const r of [2, 3]) {
        const top = rowY(r) + 4;
        // A 1 px dim frame around a 16x16 box...
        expect(count(fb, d.dim, ICON_X, ICON_X + 16, top, top + 1), `row ${r} top`).toBe(16);
        expect(count(fb, d.dim, ICON_X, ICON_X + 16, top + 15, top + 16), `row ${r} bottom`).toBe(16);
        expect(count(fb, d.dim, ICON_X, ICON_X + 1, top, top + 16), `row ${r} left`).toBe(16);
        expect(count(fb, d.dim, ICON_X + 15, ICON_X + 16, top, top + 16), `row ${r} right`).toBe(16);
        // ...with a "?" glyph inside it.
        expect(144 - count(fb, d.paper, ICON_X + 2, ICON_X + 14, top + 2, top + 14), `row ${r} glyph`).toBeGreaterThan(8);
      }
      // Selected row 2: the bar still spans placeholder and label.
      expect(count(fb, d.accent, ROW_X0, ROW_X1, rowY(2), rowY(2) + 1)).toBe(ROW_X1 - ROW_X0);
      const messages: string[] = warn.mock.calls.map((call: unknown[]) => String(call[0]));
      expect(messages.filter((m) => m.includes('"ghost"'))).toHaveLength(1);
      expect(messages.filter((m) => m.includes('"uncooked"'))).toHaveLength(1);
      // Reopening the same menu (or another with the key) does not repeat it.
      show({});
      show({ modal: "iconChoicesMissing" });
      expect(warn.mock.calls.length).toBe(messages.length);
    });

    test("the icon box takes the theme", () => {
      show({});
      const p = THEMES.parchment;
      const fb = show({ modal: "iconChoices", theme: "parchment" });
      expect(count(fb, p.border, BOX.x0, BOX.x1, BOX.y0, BOX.y0 + 2)).toBe((BOX.x1 - BOX.x0) * 2);
      expect(count(fb, p.rim, BOX.x0 + 2, BOX.x1 - 2, BOX.y0 + 2, BOX.y0 + 3)).toBe(BOX.x1 - BOX.x0 - 4);
      expect(count(fb, p.accent, ROW_X0, ROW_X1, rowY(1), rowY(1) + 1)).toBe(ROW_X1 - ROW_X0);
      expect(count(fb, p.accent, LABEL_X, ROW_X1 - 2, rowY(1) + 2, rowY(1) + ROW_H - 2)).toBeGreaterThan(15);
      expect(at(fb, ROW_X1 - 8, rowY(0) + 12)).toEqual(rgb(p.paper));
      for (const c of [DEFAULT_UI_THEME.accent, DEFAULT_UI_THEME.paper]) expect(count(fb, c, BOX.x0, BOX.x1, BOX.y0, BOX.y1), c).toBe(0);
    });

    test("after an icon menu closes, text-only choices render exactly as before", async () => {
      show({ modal: "iconChoices" });
      const fb = show({ modal: "choices" });
      // The icon box is hidden, not torn down, and leaves no pixels behind.
      expect(hasNode(world.getTree(), "rpgkit-choices-icon-box")).toBe(true);
      expect(fnv1a(fb)).toBe(plainChoices);
      expect(count(fb, DEFAULT_UI_THEME.border, 0, W, H - 8, H)).toBe(0);
    });
  });
}

// A DialogBox without the opt-in icon box (a game that never passes
// GameView's `choiceIcons`) still opens an icon choice: the text-only box
// shows the labels, pixel for pixel as the same choice without icons, and a
// single warning names the missing prop.
simDescribe("choice icons — DialogBox without the opt-in icon box", () => {
  let world: SimWorld;
  let warn: ReturnType<typeof spyOn>;
  const show = (scene: FixtureScene): Uint8Array => {
    (globalThis as { __uiFixture?: { show(s: FixtureScene): void } }).__uiFixture!.show(scene);
    world.frame(0);
    world.tick();
    return world.render().slice();
  };

  beforeAll(async () => {
    world = await bootWorld(appBundle("ui-theme"), 60, { __uiFixtureNoIconBox: true });
    warn = spyOn(console, "warn").mockImplementation(() => {});
    world.frame(0);
    world.tick();
  });
  afterAll(() => warn.mockRestore());

  test("an icon choice falls back to the labels-only box and warns once", () => {
    const plain = fnv1a(show({ modal: "iconChoicesPlain" }));
    show({});
    const first = show({ modal: "iconChoices" });
    expect(fnv1a(first)).toBe(plain);
    show({});
    show({ modal: "iconChoicesLast" });
    const notes = (warn.mock.calls as unknown[][]).map((call) => String(call[0])).filter((m: string) => m.includes("choiceIconBox"));
    expect(notes).toHaveLength(1);
  });
});
