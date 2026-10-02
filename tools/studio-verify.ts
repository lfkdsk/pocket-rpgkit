// tools/studio-verify.ts — drive Studio (dist/web/studio) in headless Chrome
// end to end, measure frame times and write the documentation screenshots.
//
//   bun run web && bun tools/studio-verify.ts
//   bun tools/studio-verify.ts --site dist/web --out dist/studio-verify --shots docs/screenshots/studio
//
// Checks (any console error, exception or failed request also fails):
//   load      Studio opens Sunstone and draws its map
//   paint     palette pick + brush drag paints cells through paint-cells;
//             Ctrl+Z / Ctrl+Shift+Z undo and redo it
//   event     the event tool creates an event; the inspector adds a text
//             command and writes a line of dialog
//   drag      dragging a map row reorders the maps with one move-map step;
//             dragging a command row into another branch is one transaction
//             (delete + insert) and lands where the drop line showed;
//             dragging an event on the canvas moves it with one update-event
//             step (ghost, target frame and coordinates drawn meanwhile);
//             each is undone byte for byte; Esc cancels a drag; the
//             shortcuts panel, empty states and the problem jump's pulse
//   save      Ctrl+S stores the document; a reload restores it
//   download  the downloaded JSON passes schema validation and rpgkit-edit
//             (the CLI) reads it and lists the new event
//   pack      a sharded pack opens; editing one map and downloading changes
//             exactly that shard (plus the shell's index entry)
//   host      the page runs on the browser host; capability probing enables
//             Open folder and disables the agent and engine checks with reasons
//   folder    a loose sharded project in the origin-private file system opens
//             through the browser host's directory path; Ctrl+S writes back
//             exactly the edited shard and the shell and leaves no temporary
//             file; with the shell's write failing, Save reports the error,
//             puts the shard back and a retry succeeds; Save pressed twice
//             runs the saves one after the other (Save disabled, "saving…"
//             shown) and leaves one whole version on disk
//   art       a project folder with its own art (art/sheets/town.png, an
//             autumn recolour, and the wiz sprite's src file) opens with that
//             art on the canvas, pixel for pixel; Download writes a pack that
//             carries the art, and opening that pack shows it again; the
//             play-test gets the art too (the game's screen shows the autumn
//             sheet and the recoloured sprite)
//   limits    a picked file over the pack limit is refused before it is read;
//             the served page carries the browser host's boot script
//   perf      a 100×100 map: zoom, pan and a 200-cell stroke stay fast
//   playtest  Play opens the panel with the site's preview page embedded:
//             the game starts at the selected village cell (state reports
//             that cell), frames advance and the readout refreshes; Esc
//             hands the keyboard back; after editing the elder's dialogue,
//             Reload restarts the latest document at the same cell, and
//             walking up and pressing Enter shows the edited line; Restart
//             after opening the village chest (+25 gold, the thorn key, self
//             switch A) puts gold, items and the switch back to their start
//             values; Stop, a chapter start and the sharded pack also play;
//             forged
//             replies (Studio's own window, a sandboxed frame, a second
//             same-origin frame) are ignored; a protocol version mismatch is
//             shown; a document over the protocol's message limit is refused
//             with its reason and never sent
//   shots     dark, light, map editing, command tree, problems, narrow,
//             and the play-test panel (light, dark, running, edited dialogue)

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { executeEditOperation } from "../editor/api/operations.ts";
import { parseShardedPack } from "../editor/api/pack.ts";
import { loadProject } from "../editor/engine/document.ts";
import type { Project } from "../src/engine/types.ts";
import { Cdp, launchChrome } from "./lib/cdp.ts";
import { splitProjectMaps } from "./lib/map-project.ts";
import { DEFAULT_UI_THEME } from "../src/ui/theme.ts";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { autumn, encodePng } from "./lib/png-encode.ts";

const ROOT = resolve(import.meta.dir, "..");

function option(name: string, fallback: string): string {
  const argv = process.argv.slice(2);
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1]! : fallback;
}

const SITE = resolve(option("site", join(ROOT, "dist", "web")));
const OUT = resolve(option("out", join(ROOT, "dist", "studio-verify")));
const SHOTS = resolve(option("shots", join(ROOT, "docs", "screenshots", "studio")));
const CHROME = option("chrome", Bun.which("google-chrome") ?? Bun.which("chromium") ?? "/usr/bin/google-chrome");

if (!existsSync(join(SITE, "studio", "index.html"))) {
  console.error(`studio-verify: no Studio at ${SITE}/studio; run \`bun run web\` (or bun tools/studio-build.ts) first`);
  process.exit(2);
}

interface Failure { check: string; message: string }
const failures: Failure[] = [];
const results: Record<string, unknown> = {};
const consoleErrors: string[] = [];
const requests: { url: string; status: number }[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function expect(check: string, ok: boolean, message: string): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${check}: ${message}`);
  if (!ok) failures.push({ check, message });
}

function serve() {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      const rel = decodeURIComponent(url.pathname);
      let path = resolve(SITE, `.${rel}`);
      if (!path.startsWith(SITE)) return new Response("forbidden", { status: 403 });
      if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
      const status = existsSync(path) ? 200 : 404;
      requests.push({ url: url.pathname, status });
      return status === 200 ? new Response(Bun.file(path)) : new Response("not found", { status });
    },
  });
}

/** A 100×100 copy of Sunstone's village for the frame-time measurement. */
function largeProject(): string {
  const project = JSON.parse(readFileSync(join(ROOT, "examples", "sunstone", "data", "sunstone.json"), "utf8")) as Project;
  const village = project.maps.find((map) => map.id === "village")!;
  const W = 100;
  const H = 100;
  const ground: string[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) ground.push(village.ground[(y % village.height) * village.width + (x % village.width)] as string);
  }
  const upper = (village.upper ?? []).flatMap(([index, tile]) => {
    const vx = index % village.width;
    const vy = Math.floor(index / village.width);
    const out: [number, string][] = [];
    for (let oy = 0; oy + vy < H; oy += village.height) for (let ox = 0; ox + vx < W; ox += village.width) out.push([(vy + oy) * W + vx + ox, tile as string]);
    return out;
  }).sort((a, b) => a[0] - b[0]);
  project.maps.push({ id: "large", name: "Large 100×100", width: W, height: H, sheets: village.sheets, ground, upper, events: [] } as unknown as Project["maps"][number]);
  project.start = { ...project.start, map: "large", x: 10, y: 10 };
  return `${JSON.stringify(project, null, 2)}\n`;
}

async function main(): Promise<void> {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  const downloads = join(OUT, "downloads");
  mkdirSync(downloads, { recursive: true });
  const server = serve();
  const base = `http://127.0.0.1:${server.port}/studio/`;
  const profile = mkdtempSync(join(OUT, "chrome-profile-"));
  const chrome = await launchChrome(CHROME, profile, "1440,900");
  const cdp = await Cdp.connect(chrome.ws);
  let phase = "startup";

  cdp.on("Runtime.consoleAPICalled", (p) => {
    if (p.type === "error" || p.type === "assert") consoleErrors.push(`[${phase}] console.${p.type}: ${p.args.map((a: any) => a.value ?? a.description).join(" ")}`);
  });
  cdp.on("Runtime.exceptionThrown", (p) => {
    consoleErrors.push(`[${phase}] exception: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`);
  });
  cdp.on("Log.entryAdded", (p) => {
    if (p.entry.level === "error") consoleErrors.push(`[${phase}] log: ${p.entry.text} ${p.entry.url ?? ""}`);
  });
  cdp.on("Network.loadingFailed", (p) => {
    if (!p.canceled) consoleErrors.push(`[${phase}] request failed: ${p.errorText}`);
  });
  cdp.on("Page.javascriptDialogOpening", () => {
    void cdp.send("Page.handleJavaScriptDialog", { accept: true });
  });
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Network.enable");
  await cdp.send("Page.enable");
  await cdp.send("DOM.enable");
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true });

  const evaluate = async <T = any>(expression: string): Promise<T> => {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`evaluate failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result.value as T;
  };
  const waitFor = async <T>(label: string, expression: string, timeout = 15_000): Promise<T> => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const value = await evaluate<T>(expression).catch(() => undefined);
      if (value) return value;
      await sleep(60);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const navigate = async (url: string) => {
    const loaded = new Promise((r) => cdp.on("Page.loadEventFired", r));
    await cdp.send("Page.navigate", { url });
    await loaded;
    await waitFor("Studio ready", `document.documentElement.dataset.ready === "1"`);
    await sleep(250);
  };
  const viewport = async (width: number, height: number, mobile = false) => {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
    await sleep(300);
  };
  const shot = async (name: string) => {
    // Transient notices would cover the panels in documentation shots.
    await evaluate(`(() => { __studio.app.notices = []; __studio.app.emit("notice"); })()`);
    await sleep(200);
    const data = await cdp.send("Page.captureScreenshot", { format: "png" });
    const path = join(SHOTS, `${name}.png`);
    writeFileSync(path, Buffer.from(data.data, "base64"));
    results[`shot:${name}`] = path.slice(ROOT.length + 1);
  };
  /** A play-test documentation shot with semantic checks. The capture goes
   *  to OUT first and replaces the committed picture only when every check
   *  passes, so a broken frame never overwrites the docs. Dynamic areas (the
   *  readout's frame number, the status bar's `op N ms`) are never sampled. */
  const playShot = async (name: string, want: { dialogue: boolean; theme: "light" | "dark" }) => {
    // Focusing a field scrolls the inspector so that the top of its page
    // tabs is cut off at the panel edge; scroll back just enough that the
    // page tabs show whole and the edited field stays in view.
    results[`inspectorScroll:${name}`] = await evaluate<number[]>(`(() => {
      const i = document.getElementById("inspector");
      const before = i.scrollTop;
      const tabs = i.querySelector(".ins-tabs");
      if (tabs) {
        const cut = i.getBoundingClientRect().top - tabs.getBoundingClientRect().top;
        if (cut > -8) i.scrollTop = Math.max(0, before - cut - 8);
      }
      return [before, i.scrollTop];
    })()`);
    await evaluate(`(() => { __studio.app.notices = []; __studio.app.emit("notice"); })()`);
    await sleep(200);
    const layout = await evaluate<any>(`(() => {
      const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; };
      const frame = document.querySelector("#playtest-screen iframe");
      const doc = frame?.contentDocument;
      const shown = (sel) => [...(doc?.querySelectorAll(sel) ?? [])].filter((el) => doc.defaultView.getComputedStyle(el).display !== "none" && el.getClientRects().length > 0).length;
      const canvas = box(doc?.getElementById("screen"));
      const fr = box(frame);
      const right = document.querySelector("aside.right");
      const inspector = document.getElementById("inspector");
      return {
        vw: innerWidth, vh: innerHeight,
        theme: document.documentElement.dataset.theme,
        bg: getComputedStyle(document.getElementById("playtest")).backgroundColor,
        toolbarBg: getComputedStyle(document.getElementById("toolbar")).backgroundColor,
        frame: fr, inner: frame ? { w: frame.clientWidth, h: frame.clientHeight } : null,
        canvas: canvas && fr ? { x: fr.x + canvas.x, y: fr.y + canvas.y, w: canvas.w, h: canvas.h } : null,
        embedded: !!doc?.body.classList.contains("embedded"),
        chromeShown: shown(".bar, .caption, .pad, .info, .demo-controls, .site-footer"),
        panel: box(document.getElementById("playtest")),
        hint: box(document.querySelector(".playtest-hint")),
        toolbar: box(document.getElementById("toolbar")),
        statusbar: box(document.getElementById("statusbar")),
        right: box(right),
        inspector: box(inspector),
        inspectorClipX: inspector ? inspector.scrollWidth - inspector.clientWidth : null,
      };
    })()`);
    const data = await cdp.send("Page.captureScreenshot", { format: "png" });
    const bytes = Buffer.from(data.data, "base64");
    const draft = join(OUT, `${name}.png`);
    writeFileSync(draft, bytes);
    const img = decodePng(new Uint8Array(bytes));
    const at = (x: number, y: number): [number, number, number] => {
      const i = (Math.floor(y) * img.width + Math.floor(x)) * 4;
      return [img.rgba[i]!, img.rgba[i + 1]!, img.rgba[i + 2]!];
    };
    /** Fraction of pixels in a rectangle that pass `test`. */
    const share = (r: { x: number; y: number; w: number; h: number }, test: (p: [number, number, number]) => boolean): number => {
      let hit = 0;
      let all = 0;
      for (let y = Math.ceil(r.y); y < Math.floor(r.y + r.h); y++) {
        for (let x = Math.ceil(r.x); x < Math.floor(r.x + r.w); x++) {
          all++;
          if (test(at(x, y))) hit++;
        }
      }
      return all ? hit / all : 0;
    };
    const rgb = (css: string): [number, number, number] => (css.match(/\d+/g) ?? []).slice(0, 3).map(Number) as [number, number, number];
    const hex = (h: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
    const near = (a: [number, number, number], b: [number, number, number], tol: number) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
    const luma = (p: [number, number, number]) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
    const ok: [string, boolean, unknown][] = [];
    ok.push(["the capture is the 1440×900 window", img.width === layout.vw && img.height === layout.vh && img.width === 1440 && img.height === 900, `${img.width}×${img.height}`]);
    const f = layout.frame;
    ok.push(["the game iframe is 480×272 and inside the window", layout.inner?.w === 480 && layout.inner?.h === 272 && f && f.x >= 0 && f.y >= 0 && f.x + f.w <= layout.vw && f.y + f.h <= layout.vh, { frame: f, inner: layout.inner }]);
    const c = layout.canvas;
    ok.push(["the embed shows only the game screen, filling the frame", layout.embedded && layout.chromeShown === 0 && c && Math.abs(c.x - f.x) <= 1 && Math.abs(c.y - f.y) <= 1 && Math.abs(c.w - 480) <= 1 && Math.abs(c.h - 272) <= 1, { embedded: layout.embedded, chromeShown: layout.chromeShown, canvas: c }]);
    // The world: the upper part of the screen, above where a message box sits.
    const world = share({ x: f.x, y: f.y, w: f.w, h: f.h * 0.55 }, (p) => Math.max(...p) > 48);
    const colors = new Set<number>();
    for (let y = f.y + 4; y < f.y + f.h * 0.55; y += 3) for (let x = f.x + 4; x < f.x + f.w - 4; x += 3) { const p = at(x, y); colors.add(((p[0] >> 4) << 8) | ((p[1] >> 4) << 4) | (p[2] >> 4)); }
    ok.push(["the world is drawn (not black, many colours)", world > 0.3 && colors.size >= 12, { lit: world.toFixed(2), colors: colors.size }]);
    // The message window: paper fill and ink text in the lower part.
    const lower = { x: f.x + 8, y: f.y + f.h * 0.66, w: f.w - 16, h: f.h * 0.3 };
    const paper = share(lower, (p) => near(p, hex(DEFAULT_UI_THEME.paper), 8));
    const ink = share(lower, (p) => near(p, hex(DEFAULT_UI_THEME.ink), 40));
    ok.push([want.dialogue ? "the message window shows paper and text" : "no message window is open",
      want.dialogue ? paper > 0.5 && ink > 0.01 : paper < 0.05, { paper: paper.toFixed(3), ink: ink.toFixed(4) }]);
    // Theme chrome: the empty play-test panel below its hint and the toolbar.
    const bg = rgb(layout.bg);
    const below = { x: layout.panel.x + 20, y: layout.hint.y + layout.hint.h + 20, w: layout.panel.w - 40, h: Math.min(60, layout.statusbar.y - (layout.hint.y + layout.hint.h) - 30) };
    const panelMatch = below.h > 10 ? share(below, (p) => near(p, bg, 3)) : 0;
    const bar = rgb(layout.toolbarBg);
    const barMatch = share({ x: 700, y: layout.toolbar.y + 2, w: 120, h: 4 }, (p) => near(p, bar, 3)) || share({ x: layout.toolbar.x + layout.toolbar.w / 2 - 40, y: layout.toolbar.y + 1, w: 80, h: 2 }, (p) => near(p, bar, 3));
    const themed = want.theme === "light" ? luma(bg) > 200 && luma(bar) > 200 : luma(bg) < 60 && luma(bar) < 60;
    ok.push([`the chrome uses the ${want.theme} theme`, layout.theme === want.theme && themed && panelMatch > 0.95 && barMatch > 0.5, { theme: layout.theme, bg, bar, panelMatch: panelMatch.toFixed(2), barMatch: barMatch.toFixed(2) }]);
    // Panels: the play-test panel, the inspector and the window edges.
    const r = layout.right;
    const insp = layout.inspector;
    ok.push(["the inspector is not clipped", r && insp && r.x + r.w <= layout.vw && insp.x >= r.x && insp.x + insp.w <= r.x + r.w && insp.y + insp.h <= layout.statusbar.y + 1 && layout.inspectorClipX <= 0 && layout.panel.x + layout.panel.w <= r.x + 1, { right: r, inspector: insp, clipX: layout.inspectorClipX, panel: layout.panel }]);
    let all = true;
    for (const [label, pass, detail] of ok) {
      expect(`shot ${name}: ${label}`, pass, JSON.stringify(detail));
      all &&= pass;
    }
    if (all) {
      const path = join(SHOTS, `${name}.png`);
      writeFileSync(path, bytes);
      results[`shot:${name}`] = path.slice(ROOT.length + 1);
    } else {
      results[`shot:${name}`] = `rejected; see ${draft.slice(ROOT.length + 1)}`;
    }
  };
  const mouse = async (type: string, x: number, y: number, button: "left" | "right" | "middle" | "none" = "left", extra: Record<string, unknown> = {}) => {
    await cdp.send("Input.dispatchMouseEvent", { type, x, y, button, buttons: type === "mouseReleased" || button === "none" ? 0 : button === "left" ? 1 : button === "right" ? 2 : 4, clickCount: 1, ...extra });
  };
  const click = async (x: number, y: number) => {
    await mouse("mouseMoved", x, y, "none");
    await mouse("mousePressed", x, y);
    await mouse("mouseReleased", x, y);
  };
  const clickSelector = async (selector: string) => {
    const point = await evaluate<{ x: number; y: number } | null>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "nearest" });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!point) throw new Error(`no element ${selector}`);
    await click(point.x, point.y);
    await sleep(80);
  };
  const key = async (keyName: string, code: string, modifiers = 0, text?: string) => {
    const keyCode = keyName.length === 1 ? keyName.toUpperCase().charCodeAt(0) : ({ Delete: 46, Escape: 27, Enter: 13 } as Record<string, number>)[keyName] ?? 0;
    await cdp.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key: keyName, code, modifiers, windowsVirtualKeyCode: keyCode, ...(text ? { text } : {}) });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, modifiers, windowsVirtualKeyCode: keyCode });
    await sleep(60);
  };
  const CTRL = 2;
  const SHIFT = 8;
  const cell = (x: number, y: number) => evaluate<{ x: number; y: number }>(`__studio.cellToClient(${x}, ${y})`);
  const drag = async (cells: [number, number][], button: "left" | "right" = "left") => {
    const points = [];
    for (const [x, y] of cells) points.push(await cell(x, y));
    await mouse("mouseMoved", points[0]!.x, points[0]!.y, "none");
    await mouse("mousePressed", points[0]!.x, points[0]!.y, button);
    for (const point of points.slice(1)) await mouse("mouseMoved", point.x, point.y, button);
    await mouse("mouseReleased", points.at(-1)!.x, points.at(-1)!.y, button);
    await sleep(120);
  };
  const setFile = async (selector: string, path: string) => {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    await cdp.send("DOM.setFileInputFiles", { nodeId, files: [path] });
  };
  const waitDownload = async (before: Set<string>, timeout = 10_000): Promise<string> => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const done = readdirSync(downloads).filter((name) => !before.has(name) && !name.endsWith(".crdownload"));
      if (done.length > 0) return join(downloads, done[0]!);
      await sleep(100);
    }
    throw new Error("download did not finish");
  };
  const download = async (): Promise<string> => {
    const before = new Set(readdirSync(downloads));
    await clickSelector("#studio-download");
    return waitDownload(before);
  };

  try {
    // ---- load ----
    phase = "load";
    await viewport(1440, 900);
    await navigate(`${base}?example=sunstone`);
    const loaded = await evaluate<{ title: string; map: string; maps: number; kind: string }>(`({ title: __studio.app.session.title(), map: __studio.app.mapId, maps: __studio.app.session.maps().length, kind: __studio.app.session.kind })`);
    expect("load: Sunstone opens on its start map", loaded.map === "village" && loaded.maps === 3 && loaded.kind === "inline", JSON.stringify(loaded));
    await waitFor("sheet art", `__studio.art.sheetStatus("town").source === "bundled"`);
    const nonVoid = await evaluate<number>(`(() => {
      const c = document.querySelector(".map-canvas");
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      const seen = new Set();
      for (let i = 0; i < d.length; i += 4 * 97) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      return seen.size;
    })()`);
    expect("load: the canvas shows tile art", nonVoid > 30, `${nonVoid} distinct sampled colors`);
    // Headless Chrome reports a light system theme: pin it for the shots.
    await evaluate(`localStorage.setItem("pocket-rpgkit:studio:theme", "light")`);
    const originalText = await evaluate<string>(`__studio.app.session.exportText()`);

    // ---- paint ----
    phase = "paint";
    const palettePoint = await evaluate<{ x: number; y: number }>(`(() => {
      const c = document.querySelector(".palette-canvas");
      const r = c.getBoundingClientRect();
      const cols = 12, rows = 11, cell = 37;
      return { x: r.left + ((cell % cols) + 0.5) * r.width / cols, y: r.top + (Math.floor(cell / cols) + 0.5) * r.height / rows };
    })()`);
    await click(palettePoint.x, palettePoint.y);
    const brush = await evaluate<string>(`__studio.app.brush`);
    expect("paint: a palette click picks the brush", brush === "town.37", String(brush));
    await key("b", "KeyB", 0, "b");
    const stroke: [number, number][] = [[2, 2], [3, 2], [4, 2], [5, 3], [6, 3]];
    const before = await evaluate<string[]>(`[${stroke.map(([x, y]) => `__studio.tileAt(${x}, ${y})`).join(",")}]`);
    await drag(stroke);
    const after = await evaluate<string[]>(`[${stroke.map(([x, y]) => `__studio.tileAt(${x}, ${y})`).join(",")}]`);
    const history = await evaluate<{ label: string; commands: string[] }[]>(`__studio.app.session.history().map((h) => ({ label: h.label, commands: h.commands }))`);
    expect("paint: a brush drag paints every cell of the stroke", after.every((tile) => tile === "town.37"), `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    expect("paint: the stroke is one paint-cells history step", history.length === 1 && history[0]!.commands[0] === "paint-cells", JSON.stringify(history));
    await key("z", "KeyZ", CTRL);
    const undone = await evaluate<string[]>(`[${stroke.map(([x, y]) => `__studio.tileAt(${x}, ${y})`).join(",")}]`);
    const undoneText = await evaluate<string>(`__studio.app.session.exportText()`);
    expect("paint: Ctrl+Z restores the document byte-for-byte", JSON.stringify(undone) === JSON.stringify(before) && undoneText === originalText, JSON.stringify(undone));
    await key("z", "KeyZ", CTRL | SHIFT);
    const redone = await evaluate<string[]>(`[${stroke.map(([x, y]) => `__studio.tileAt(${x}, ${y})`).join(",")}]`);
    expect("paint: Ctrl+Shift+Z redoes it", redone.every((tile) => tile === "town.37"), JSON.stringify(redone));

    // ---- event ----
    phase = "event";
    await key("n", "KeyN", 0, "n");
    const target = await cell(5, 5);
    await click(target.x, target.y);
    await sleep(150);
    const created = await evaluate<{ id: string; x: number; y: number } | null>(`(() => {
      const s = __studio.app.selection;
      if (s.kind !== "event") return null;
      const e = __studio.app.currentMap().events.find((item) => item.id === s.eventId);
      return e ? { id: e.id, x: e.x, y: e.y } : null;
    })()`);
    expect("event: the event tool creates and selects an event", !!created && created.x === 5 && created.y === 5, JSON.stringify(created));
    await clickSelector('[data-action="add-command"]');
    await waitFor("command picker", `!!document.querySelector('[data-field="command-picker"]')`);
    await evaluate(`(() => { const i = document.querySelector('[data-field="command-picker"]'); i.value = "text"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await sleep(80);
    const pickerHit = await evaluate<string>(`(() => {
      const el = document.querySelector('button[data-op="text"]:not([data-action])');
      el.scrollIntoView({ block: "nearest" });
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return JSON.stringify({ r: [r.left, r.top, r.width, r.height], hit: hit?.outerHTML.slice(0, 120), inside: el.contains(hit) });
    })()`);
    results.pickerHit = pickerHit;
    await clickSelector('button[data-op="text"]:not([data-action])');
    await waitFor("inserted text command", `__studio.app.currentMap().events.find((e) => e.id === ${JSON.stringify(created?.id ?? "")})?.pages[0].commands.length === 1`);
    if (!(await evaluate<boolean>(`!!document.querySelector('[data-field="command.lines"]')`))) await clickSelector('[data-action="select-command"]');
    await waitFor("text field", `!!document.querySelector('[data-field="command.lines"]')`);
    await evaluate(`(() => {
      const f = document.querySelector('[data-field="command.lines"]');
      f.focus();
      f.value = "Hello from Studio!";
      f.dispatchEvent(new Event("input", { bubbles: true }));
      f.dispatchEvent(new Event("change", { bubbles: true }));
      f.blur();
    })()`);
    await sleep(200);
    const written = await evaluate<unknown>(`__studio.app.currentMap().events.find((e) => e.id === ${JSON.stringify(created?.id ?? "")})?.pages[0].commands`);
    expect("event: the inspector writes a line of dialog", JSON.stringify(written) === JSON.stringify([{ op: "text", lines: ["Hello from Studio!"] }]), JSON.stringify(written));

    // ---- drag and drop ----
    phase = "drag";
    const rectOf = (expression: string) => evaluate<{ x: number; y: number; w: number; h: number } | null>(`(() => {
      const el = ${expression};
      if (!el) return null;
      el.scrollIntoView({ block: "nearest" });
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    })()`);
    /** Press at `from`, move there in steps, optionally shoot, release. */
    const dragPoints = async (from: { x: number; y: number }, to: { x: number; y: number }, shotName?: string, release = true) => {
      await mouse("mouseMoved", from.x, from.y, "none");
      await mouse("mousePressed", from.x, from.y);
      for (let i = 1; i <= 8; i++) await mouse("mouseMoved", from.x + (to.x - from.x) * i / 8, from.y + (to.y - from.y) * i / 8);
      await sleep(120);
      if (shotName) await shot(shotName);
      if (release) await mouse("mouseReleased", to.x, to.y);
      await sleep(150);
    };
    const beforeDrag = await evaluate<string>(`__studio.app.session.exportText()`);
    const historyDepth = () => evaluate<number>(`__studio.app.session.history().length`);
    const lastStep = () => evaluate<{ label: string; commands: string[] }>(`(() => { const h = __studio.app.session.history().at(-1); return { label: h.label, commands: h.commands }; })()`);

    // Maps: drag the last map (cave) above the first.
    const mapOrder = () => evaluate<string[]>(`__studio.app.session.maps().map((m) => m.id)`);
    const order0 = await mapOrder();
    const caveRow = await rectOf(`document.querySelector('.map-row[data-map="cave"]')`);
    const firstRow = await rectOf(`document.querySelector('.map-row[data-map="${order0[0]}"]')`);
    const depth0 = await historyDepth();
    await dragPoints({ x: caveRow!.x + 40, y: caveRow!.y + caveRow!.h / 2 }, { x: firstRow!.x + 40, y: firstRow!.y + 3 }, "studio-drag-map", false);
    const lineShown = await evaluate<boolean>(`!!document.querySelector(".map-drop-line") && !!document.querySelector(".map-row.dragging")`);
    await mouse("mouseReleased", firstRow!.x + 40, firstRow!.y + 3);
    await sleep(150);
    const order1 = await mapOrder();
    const mapStep = await lastStep();
    expect("drag: a map row drag shows the drop line and the dragged row", lineShown, String(lineShown));
    expect("drag: dropping the map above the first reorders the maps", order1[0] === "cave" && order1.length === order0.length && order1.slice(1).join() === order0.filter((id) => id !== "cave").join(), `${order0} -> ${order1}`);
    expect("drag: the map drag is one move-map step", (await historyDepth()) === depth0 + 1 && mapStep.commands.join() === "move-map", JSON.stringify(mapStep));
    expect("drag: the open map stays open after the drop", (await evaluate<string>(`__studio.app.mapId`)) === "village", await evaluate<string>(`__studio.app.mapId`));
    await key("z", "KeyZ", CTRL);
    expect("drag: Ctrl+Z puts the map order back byte for byte", (await evaluate<string>(`__studio.app.session.exportText()`)) === beforeDrag, (await mapOrder()).join());
    // Alt+Down on the focused list moves the open map one place down.
    await evaluate(`document.querySelector(".map-scroller").focus()`);
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "ArrowDown", code: "ArrowDown", modifiers: 1, windowsVirtualKeyCode: 40 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowDown", code: "ArrowDown", modifiers: 1, windowsVirtualKeyCode: 40 });
    await sleep(120);
    const altOrder = await mapOrder();
    expect("drag: Alt+Down moves the open map down one place", altOrder.indexOf("village") === order0.indexOf("village") + 1, altOrder.join());
    await key("z", "KeyZ", CTRL);

    // Commands: drag the elder's first line into the top of the choice's
    // "Farewell" branch.
    await key("v", "KeyV", 0, "v");
    const elderAt = await cell(9, 5);
    await click(elderAt.x, elderAt.y);
    await waitFor("elder command tree", `document.querySelectorAll('[data-action="select-command"]').length >= 4`);
    const elderBefore = await evaluate<any[]>(`__studio.app.currentMap().events.find((e) => e.id === "elder").pages[0].commands`);
    const firstText = await rectOf(`document.querySelector('.ins-row[data-op="text"]')`);
    const farewell = await rectOf(`[...document.querySelectorAll(".ins-branch")].find((el) => /farewell/i.test(el.textContent))`);
    const depth1 = await historyDepth();
    await dragPoints({ x: firstText!.x + 60, y: firstText!.y + firstText!.h / 2 }, { x: farewell!.x + 80, y: farewell!.y + farewell!.h / 2 }, "studio-drag-command", false);
    const cmdLine = await evaluate<{ dragging: boolean; target: string | null }>(`({ dragging: !!document.querySelector(".ins-row.dragging"), target: document.querySelector(".drop-after, .drop-before")?.textContent ?? null })`);
    await mouse("mouseReleased", farewell!.x + 80, farewell!.y + farewell!.h / 2);
    await sleep(200);
    const elderAfter = await evaluate<any[]>(`__studio.app.currentMap().events.find((e) => e.id === "elder").pages[0].commands`);
    const cmdStep = await lastStep();
    expect("drag: the command drag marks the dragged row and the Farewell branch", cmdLine.dragging && /farewell/i.test(cmdLine.target ?? ""), JSON.stringify(cmdLine));
    expect("drag: the line lands at the top of the Farewell branch",
      elderAfter.length === 1 && elderAfter[0].op === "choices" && JSON.stringify(elderAfter[0].options[1].commands[0]) === JSON.stringify(elderBefore[0]) && elderAfter[0].options[1].commands.length === 2,
      JSON.stringify(elderAfter).slice(0, 200));
    expect("drag: the command drag is one transaction step", (await historyDepth()) === depth1 + 1 && cmdStep.commands.join() === "delete-command,insert-command" && cmdStep.label === "Move command", JSON.stringify(cmdStep));
    const movedSelected = await evaluate<string | null>(`document.querySelector(".ins-row.selected")?.dataset.op ?? null`);
    expect("drag: the moved command is selected afterwards", movedSelected === "text", String(movedSelected));
    // Esc during a drag drops nothing.
    const choicesRow = await rectOf(`document.querySelector('.ins-row[data-op="choices"]')`);
    await dragPoints({ x: choicesRow!.x + 60, y: choicesRow!.y + choicesRow!.h / 2 }, { x: choicesRow!.x + 60, y: choicesRow!.y + choicesRow!.h * 3 }, undefined, false);
    await evaluate(`document.querySelector('[data-role="command-tree"]').focus()`);
    await key("Escape", "Escape");
    await mouse("mouseReleased", choicesRow!.x + 60, choicesRow!.y + choicesRow!.h * 3);
    await sleep(150);
    expect("drag: Esc cancels a command drag", (await historyDepth()) === depth1 + 1, String(await historyDepth()));
    await key("z", "KeyZ", CTRL);
    expect("drag: Ctrl+Z puts the command back byte for byte", (await evaluate<string>(`__studio.app.session.exportText()`)) === beforeDrag, "");

    // Events: drag the new event from (5,5) to (7,6) on the canvas.
    await key("Escape", "Escape");
    const from = await cell(5, 5);
    const to = await cell(7, 6);
    const depth2 = await historyDepth();
    await dragPoints(from, to, "studio-drag-event", false);
    const ghost = await evaluate<boolean>(`document.querySelector(".map-canvas").classList.contains("moving-event")`);
    await mouse("mouseReleased", to.x, to.y);
    await sleep(150);
    const moved = await evaluate<{ x: number; y: number } | null>(`(() => { const e = __studio.app.currentMap().events.find((e) => e.id === ${JSON.stringify(created?.id ?? "")}); return e ? { x: e.x, y: e.y } : null; })()`);
    const eventStep = await lastStep();
    expect("drag: the canvas shows the move cursor while an event is dragged", ghost, String(ghost));
    expect("drag: dropping the event moves it to the drop cell in one update-event step", moved?.x === 7 && moved?.y === 6 && (await historyDepth()) === depth2 + 1 && eventStep.commands.join() === "update-event", `${JSON.stringify(moved)} ${JSON.stringify(eventStep)}`);
    // Esc while dragging the event leaves it where it is.
    await dragPoints(await cell(7, 6), await cell(10, 8), undefined, false);
    await key("Escape", "Escape");
    const escTo = await cell(10, 8);
    await mouse("mouseReleased", escTo.x, escTo.y);
    await sleep(120);
    const stayed = await evaluate<{ x: number; y: number } | null>(`(() => { const e = __studio.app.currentMap().events.find((e) => e.id === ${JSON.stringify(created?.id ?? "")}); return e ? { x: e.x, y: e.y } : null; })()`);
    expect("drag: Esc cancels an event drag", stayed?.x === 7 && stayed?.y === 6 && (await historyDepth()) === depth2 + 1, JSON.stringify(stayed));
    await key("z", "KeyZ", CTRL);
    expect("drag: Ctrl+Z puts the event back byte for byte", (await evaluate<string>(`__studio.app.session.exportText()`)) === beforeDrag, "");

    // Polish: the shortcuts panel, empty states.
    await evaluate(`document.activeElement?.blur()`);
    await key("?", "Slash", SHIFT, "?");
    await waitFor("shortcuts panel", `!!document.querySelector('[data-role="shortcuts"]')`);
    const groups = await evaluate<string[]>(`[...document.querySelectorAll(".shortcut-group h3")].map((el) => el.textContent)`);
    expect("drag: the shortcuts panel lists its groups, drag gestures included", groups.length >= 5 && (await evaluate<boolean>(`/Drag command/.test(document.querySelector('[data-role="shortcuts"]').textContent)`)), groups.join(", "));
    await shot("studio-shortcuts");
    await key("Escape", "Escape");
    await evaluate(`(() => { const i = document.querySelector(".map-search"); i.value = "zzz"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await sleep(80);
    const emptyMaps = await evaluate<string | null>(`document.querySelector(".map-scroller .empty-state")?.textContent ?? null`);
    expect("drag: a filter with no match shows an empty state with Clear filter", !!emptyMaps && /Clear filter/.test(emptyMaps), String(emptyMaps));
    await clickSelector(".map-scroller .empty-action");
    expect("drag: Clear filter brings the maps back", (await evaluate<number>(`document.querySelectorAll(".map-row").length`)) === order0.length, "");

    // ---- save / restore ----
    phase = "save";
    await evaluate(`document.activeElement?.blur()`);
    await key("s", "KeyS", CTRL);
    await sleep(150);
    const stored = await evaluate<string | null>(`localStorage.getItem("pocket-rpgkit:studio:document:v1")`);
    const savedText = await evaluate<string>(`__studio.app.session.exportText()`);
    expect("save: Ctrl+S stores the export bytes in this browser", !!stored && JSON.parse(stored).text === savedText, stored ? `${stored.length} chars` : "nothing stored");
    await navigate(base);
    const restored = await evaluate<{ text: string; dirty: boolean }>(`({ text: __studio.app.session.exportText(), dirty: __studio.app.session.isDirty() })`);
    expect("save: a reload restores the saved document", restored.text === savedText && !restored.dirty, `${restored.text.length} chars, dirty ${restored.dirty}`);

    // ---- download ----
    phase = "download";
    const downloaded = await download();
    const downloadedText = readFileSync(downloaded, "utf8");
    const schema = loadProject(downloadedText);
    expect("download: the file is the export and passes the schema", downloadedText === savedText && schema.errors.length === 0, `${downloaded.split("/").pop()}, ${schema.errors.length} schema errors`);
    const cli = Bun.spawnSync([process.execPath, join(ROOT, "tools", "rpgkit-edit", "cli.ts"), "list-events", "--file", downloaded, "--json", JSON.stringify({ map: "village" })], { cwd: ROOT });
    const listed = JSON.parse(cli.stdout.toString() || "{}") as { ok?: boolean; result?: { id: string }[] };
    expect("download: rpgkit-edit reads it and lists the new event", cli.exitCode === 0 && listed.ok === true && !!listed.result?.some((event) => event.id === created?.id), `exit ${cli.exitCode}, ${listed.result?.length ?? 0} events`);
    results.download = downloaded.slice(OUT.length + 1);

    // ---- screenshots of the edited Sunstone ----
    phase = "shots";
    await shot("studio-light");
    const elder = await cell(9, 5);
    await key("v", "KeyV", 0, "v");
    await click(elder.x, elder.y);
    await sleep(200);
    // Select a command inside a choice branch so the tree shows its nesting
    // and the form shows that command's fields.
    const rows = await evaluate<number>(`document.querySelectorAll('[data-action="select-command"]').length`);
    await clickSelector(`[data-action="select-command"]:nth-of-type(1)`);
    await evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-action="select-command"]')];
      const nested = rows.find((row) => row.dataset.op === "text" && row !== rows[0]) ?? rows[rows.length - 1];
      nested.click();
    })()`);
    await sleep(250);
    await evaluate(`document.querySelector('[data-role="command-tree"]').scrollIntoView({ block: "start" })`);
    expect("shots: the elder's command tree has nested rows", rows >= 4, `${rows} rows`);
    await shot("studio-event-commands");
    await key("Escape", "Escape");

    // ---- pack ----
    phase = "pack";
    const packPath = join(OUT, "sunstone-pack.json");
    const packSource = readFileSync(join(SITE, "studio", "examples", "sunstone-pack.json"), "utf8");
    writeFileSync(packPath, packSource);
    await setFile("#studio-open-input", packPath);
    await waitFor("pack opened", `__studio.app.session?.kind === "pack"`);
    const packInfo = await evaluate<{ loaded: string[]; maps: number }>(`({ loaded: __studio.app.session.loadedEntries(), maps: __studio.app.session.maps().length })`);
    expect("pack: opening parses only the start map's shard", packInfo.maps === 3 && packInfo.loaded.length === 1, JSON.stringify(packInfo));
    await clickSelector('.map-row[data-map="forest"]');
    await sleep(200);
    const forestPalette = await evaluate<{ x: number; y: number }>(`(() => {
      const r = document.querySelector(".palette-canvas").getBoundingClientRect();
      return { x: r.left + (1 + 0.5) * r.width / 12, y: r.top + (3 + 0.5) * r.height / 11 };
    })()`);
    await click(forestPalette.x, forestPalette.y);
    await key("b", "KeyB", 0, "b");
    await drag([[3, 3], [4, 3], [5, 3]]);
    const dirty = await evaluate<string[]>(`__studio.app.session.dirtyEntries()`);
    results.packState = await evaluate<unknown>(`({ map: __studio.app.mapId, tool: __studio.app.tool, brush: __studio.app.brush, notices: __studio.app.notices.map((n) => n.text), history: __studio.app.session.history().map((h) => h.label) })`);
    expect("pack: an edit dirties exactly its shard", JSON.stringify(dirty) === JSON.stringify(["maps/forest.json"]), JSON.stringify(dirty));
    const packDownload = readFileSync(await download(), "utf8");
    const original = parseShardedPack(packSource);
    const replaced = parseShardedPack(packDownload);
    const changedShards = [...original.shards.keys()].filter((entry) => original.shards.get(entry) !== replaced.shards.get(entry));
    expect("pack: the replacement pack changes only that shard and the shell", JSON.stringify(changedShards) === JSON.stringify(["maps/forest.json"]) && replaced.shellText !== original.shellText, JSON.stringify(changedShards));
    const shardValid = executeEditOperation(JSON.stringify({ ...JSON.parse(replaced.shellText), mapIndex: undefined, mapManifestHash: undefined, mapSchemaHash: undefined, maps: [...replaced.shards.values()].map((text) => JSON.parse(text)) }), "validate");
    expect("pack: the replacement validates as a whole project", shardValid.response.ok && (shardValid.response.result as { valid: boolean }).valid, JSON.stringify(shardValid.response.ok ? (shardValid.response.result as { errors: unknown[] }).errors.slice(0, 2) : shardValid.response.error));
    await key("Escape", "Escape");

    // ---- host: capability probing drives the controls ----
    phase = "host";
    const hostState = await evaluate<{ name: string; caps: Record<string, { available: boolean; reason: string }>; agent: { disabled: boolean; title: string } }>(`(() => {
      const agent = document.querySelector("#studio-agent");
      return { name: __studio.host.name, caps: __studio.host.capabilities(), agent: { disabled: agent.disabled, title: agent.title } };
    })()`);
    results.capabilities = hostState.caps;
    expect("host: Studio runs on the browser host", hostState.name === "browser", hostState.name);
    expect("host: the agent button is disabled and says it needs the desktop app", hostState.agent.disabled && /desktop app/.test(hostState.agent.title), JSON.stringify(hostState.agent));
    await clickSelector("#studio-open");
    await sleep(150);
    const folderItem = await evaluate<{ disabled: boolean; title: string } | null>(`(() => {
      const item = document.querySelector('.menu [data-menu="Open folder…"]');
      return item ? { disabled: item.disabled, title: item.title } : null;
    })()`);
    await key("Escape", "Escape");
    expect("host: Chrome's directory picker enables Open folder…", !!folderItem && !folderItem.disabled && hostState.caps.openDirectory?.available === true, JSON.stringify(folderItem));
    await clickSelector("#status-problems");
    await sleep(150);
    const engine = await evaluate<{ disabled: boolean; title: string } | null>(`(() => { const b = document.querySelector("#studio-engine-checks"); return b ? { disabled: b.disabled, title: b.title } : null; })()`);
    await clickSelector("#status-problems");
    expect("host: engine checks are disabled with a reason", !!engine && engine.disabled && engine.title.length > 20, JSON.stringify(engine));

    // ---- folder: a loose sharded project saved in place ----
    phase = "folder";
    const split = splitProjectMaps(JSON.parse(readFileSync(join(ROOT, "examples", "sunstone", "data", "sunstone.json"), "utf8")) as Project);
    const looseFiles: Record<string, string> = { "project.json": split.shellText };
    for (const entry of split.entries) looseFiles[entry.path] = entry.text;
    await evaluate(`(async () => {
      const root = await navigator.storage.getDirectory();
      for await (const name of root.keys()) await root.removeEntry(name, { recursive: true });
      const dir = await root.getDirectoryHandle("sunstone", { create: true });
      for (const [path, text] of Object.entries(${JSON.stringify(looseFiles)})) {
        const parts = path.split("/");
        let parent = dir;
        for (const part of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(part, { create: true });
        const w = await (await parent.getFileHandle(parts.at(-1), { create: true })).createWritable();
        await w.write(text);
        await w.close();
      }
      await __studio.host.openDirectoryHandle(dir);
    })()`);
    await waitFor("folder opened", `__studio.files.target?.name === "sunstone/" && __studio.app.session?.kind === "pack"`);
    await evaluate(`__studio.app.openMap("forest")`);
    await evaluate(`__studio.app.run("paint-cells", { map: "forest", layer: "ground", cells: [[2, 2], [3, 2]], value: "town.37" }, "Paint 2 ground cells")`);
    await evaluate(`document.activeElement?.blur()`);
    await key("s", "KeyS", CTRL);
    await waitFor("folder saved", `__studio.files.lastSavedWhere === "directory"`);
    const onDisk = await evaluate<{ files: Record<string, string>; pack: string; status: string; dirty: boolean }>(`(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("sunstone");
      const files = {};
      for (const path of ${JSON.stringify(Object.keys(looseFiles))}) {
        const parts = path.split("/");
        let parent = dir;
        for (const part of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(part);
        files[path] = await (await (await parent.getFileHandle(parts.at(-1))).getFile()).text();
      }
      return { files, pack: __studio.app.session.exportText(), status: document.querySelector("#status-saved").textContent, dirty: __studio.app.session.isDirty() };
    })()`);
    const savedPack = parseShardedPack(onDisk.pack);
    const rewritten = Object.keys(looseFiles).filter((path) => onDisk.files[path] !== looseFiles[path]).sort();
    const matches = onDisk.files["project.json"] === savedPack.shellText && [...savedPack.shards].every(([entry, text]) => onDisk.files[entry] === text);
    results.folder = { rewritten, status: onDisk.status };
    expect("folder: Ctrl+S writes back exactly the edited shard and the shell", JSON.stringify(rewritten) === JSON.stringify(["maps/forest.json", "project.json"]) && matches && !onDisk.dirty, JSON.stringify({ rewritten, matches, dirty: onDisk.dirty }));
    expect("folder: the status bar names the folder", onDisk.status === "saved to sunstone/", onDisk.status);

    // Every file in the folder, recursively: a save leaves no temporaries.
    const listFolder = `(async () => {
      const out = [];
      const walk = async (dir, prefix) => {
        for await (const [name, handle] of dir.entries()) {
          if (handle.kind === "directory") await walk(handle, prefix + name + "/");
          else out.push(prefix + name);
        }
      };
      await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle("sunstone"), "");
      return out.sort();
    })()`;
    const afterSave = await evaluate<string[]>(listFolder);
    const moveSupported = await evaluate<boolean>(`typeof FileSystemFileHandle !== "undefined" && typeof FileSystemFileHandle.prototype.move === "function"`);
    expect("folder: the save leaves no temporary files", JSON.stringify(afterSave) === JSON.stringify(Object.keys(looseFiles).sort()), JSON.stringify({ files: afterSave, moveSupported }));

    // A failed shell write: the error is shown, the shard is put back, and
    // the baseline stays old so the next save succeeds.
    const readFolder = `(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("sunstone");
      const files = {};
      for (const path of ${JSON.stringify(Object.keys(looseFiles))}) {
        const parts = path.split("/");
        let parent = dir;
        for (const part of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(part);
        files[path] = await (await (await parent.getFileHandle(parts.at(-1))).getFile()).text();
      }
      return files;
    })()`;
    await evaluate(`(() => {
      const ref = __studio.files.target.ref;
      const real = ref.dir;
      const fail = () => Promise.reject(new Error("injected shell failure"));
      ref.realDir = real;
      ref.dir = {
        ...real,
        write: (path, text) => path === "project.json" ? fail() : real.write(path, text),
        ...(real.rename ? { rename: (from, to) => to === "project.json" ? fail() : real.rename(from, to) } : {}),
      };
      __studio.app.run("paint-cells", { map: "forest", layer: "ground", cells: [[4, 2]], value: "town.37" }, "Paint 1 ground cell");
    })()`);
    await evaluate(`document.activeElement?.blur()`);
    await key("s", "KeyS", CTRL);
    await waitFor("failed folder save reported", `__studio.app.notices.some((n) => n.level === "error" && n.text.includes("injected shell failure"))`);
    const failed = await evaluate<{ notice: string; dirty: boolean }>(`({ notice: __studio.app.notices.filter((n) => n.level === "error").at(-1).text, dirty: __studio.app.session.isDirty() })`);
    const afterFailure = await evaluate<Record<string, string>>(readFolder);
    const failureFiles = await evaluate<string[]>(listFolder);
    results.folderFailure = { notice: failed.notice, moveSupported };
    expect("folder: a failed shell write leaves the previous save on disk", JSON.stringify(afterFailure) === JSON.stringify(onDisk.files) && failed.dirty, JSON.stringify({ dirty: failed.dirty, changed: Object.keys(afterFailure).filter((path) => afterFailure[path] !== onDisk.files[path]) }));
    expect("folder: the failure notice says the previous version was restored", /restored maps\/forest\.json, so the folder still holds the previous version/.test(failed.notice), failed.notice);
    expect("folder: the failed save leaves no temporary files", JSON.stringify(failureFiles) === JSON.stringify(afterSave), JSON.stringify(failureFiles));
    await evaluate(`(() => { const ref = __studio.files.target.ref; ref.dir = ref.realDir; delete ref.realDir; })()`);
    await key("s", "KeyS", CTRL);
    await waitFor("retried folder save", `!__studio.app.session.isDirty()`);
    const retried = await evaluate<Record<string, string>>(readFolder);
    const retriedPack = parseShardedPack(await evaluate<string>(`__studio.app.session.exportText()`));
    expect("folder: saving again after the failure writes the edit", retried["project.json"] === retriedPack.shellText && [...retriedPack.shards].every(([entry, text]) => retried[entry] === text) && retried["maps/forest.json"] !== onDisk.files["maps/forest.json"], "retry saved");

    // Save pressed twice: the first save is held at its first file write;
    // the second waits for it (touching nothing), Save is disabled and the
    // status bar says "saving…" meanwhile, and afterwards the folder holds
    // one whole version (the later one).
    await evaluate(`(() => {
      const ref = __studio.files.target.ref;
      const real = ref.dir;
      ref.realDir = real;
      window.__saveOps = [];
      window.__releaseSave = null;
      const held = new Promise((resolve) => { window.__releaseSave = resolve; });
      let holding = true;
      const gate = async (op, path) => {
        window.__saveOps.push(op + " " + path);
        if (holding && op === "write") { holding = false; window.__saveHeld = true; await held; }
      };
      ref.dir = {
        ...real,
        read: async (path) => { await gate("read", path); return real.read(path); },
        write: async (path, text) => { await gate("write", path); return real.write(path, text); },
        remove: async (path) => { await gate("remove", path); return real.remove(path); },
        ...(real.rename ? { rename: async (from, to) => { await gate("rename", to); return real.rename(from, to); } } : {}),
      };
      __studio.app.run("paint-cells", { map: "forest", layer: "ground", cells: [[5, 2]], value: "town.37" }, "Paint 1 ground cell");
    })()`);
    await evaluate(`document.activeElement?.blur()`);
    await key("s", "KeyS", CTRL);
    await waitFor("first folder save held", `window.__saveHeld === true && __studio.files.saving === 1`);
    const opsAtHold = await evaluate<number>(`window.__saveOps.length`);
    await evaluate(`__studio.app.run("paint-cells", { map: "cave", layer: "ground", cells: [[2, 2]], value: "dun.30" }, "Paint 1 ground cell")`);
    await evaluate(`document.activeElement?.blur()`);
    await key("s", "KeyS", CTRL);
    await evaluate(`document.querySelector("#studio-save").click()`);
    await sleep(300);
    const whileHeld = await evaluate<{ saving: number; ops: number; disabled: boolean; label: string; status: string }>(`({
      saving: __studio.files.saving,
      ops: window.__saveOps.length,
      disabled: document.querySelector("#studio-save").disabled,
      label: document.querySelector("#studio-save").getAttribute("aria-label"),
      status: document.querySelector("#status-saved").textContent,
    })`);
    const savingShot = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, "folder-saving.png"), Buffer.from(savingShot.data, "base64"));
    results.folderSaving = { ...whileHeld, opsAtHold, shot: join(OUT, "folder-saving.png").slice(ROOT.length + 1) };
    expect("folder: a second Save while one runs is queued and touches nothing", whileHeld.saving === 2 && whileHeld.ops === opsAtHold, JSON.stringify({ saving: whileHeld.saving, ops: whileHeld.ops, opsAtHold }));
    expect("folder: Save is disabled and the status bar says saving… meanwhile", whileHeld.disabled && whileHeld.label === "Saving to sunstone/…" && whileHeld.status === "saving…", JSON.stringify(whileHeld));
    await evaluate(`window.__releaseSave()`);
    await waitFor("queued folder save finished", `__studio.files.saving === 0 && !__studio.app.session.isDirty()`);
    const queued = await evaluate<Record<string, string>>(readFolder);
    const queuedPack = parseShardedPack(await evaluate<string>(`__studio.app.session.exportText()`));
    const queuedFiles = await evaluate<string[]>(listFolder);
    const queuedStatus = await evaluate<string>(`document.querySelector("#status-saved").textContent`);
    expect("folder: after two overlapping Saves the shell and every map file are the later version", queued["project.json"] === queuedPack.shellText && [...queuedPack.shards].every(([entry, text]) => queued[entry] === text) && JSON.stringify(queuedFiles) === JSON.stringify(afterSave) && queuedStatus === "saved to sunstone/", JSON.stringify({ files: queuedFiles, status: queuedStatus }));
    await evaluate(`(() => { const ref = __studio.files.target.ref; ref.dir = ref.realDir; delete ref.realDir; })()`);

    // ---- limits: oversized input is refused before it is read ----
    phase = "art";
    const townSource = decodePng(new Uint8Array(readFileSync(join(ROOT, "examples", "sunstone", "assets", "src", "town-tiles.png"))));
    const autumnRgba = autumn(townSource.rgba);
    const autumnPng = encodePng(townSource.width, townSource.height, autumnRgba);
    const wizRgba = new Uint8Array(16 * 16 * 4);
    for (let i = 0; i < wizRgba.length; i += 4) wizRgba.set([236, 64, 200, 255], i);
    const wizPng = encodePng(16, 16, wizRgba);
    const artFiles: Record<string, string> = { "art/sheets/town.png": Buffer.from(autumnPng).toString("base64"), "assets/npc/wiz.png": Buffer.from(wizPng).toString("base64") };
    await navigate(`${base}?example=sunstone`);
    await evaluate(`(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("sunstone-art", { create: true });
      const write = async (path, data) => {
        const parts = path.split("/");
        let parent = dir;
        for (const part of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(part, { create: true });
        const w = await (await parent.getFileHandle(parts.at(-1), { create: true })).createWritable();
        await w.write(data);
        await w.close();
      };
      for (const [path, text] of Object.entries(${JSON.stringify(looseFiles)})) await write(path, text);
      for (const [path, b64] of Object.entries(${JSON.stringify(artFiles)})) await write(path, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
      await __studio.host.openDirectoryHandle(dir);
    })()`);
    await waitFor("art folder opened", `__studio.files.target?.name === "sunstone-art/"`);
    await waitFor("project art loaded", `__studio.art.sheetStatus("town").source === "project" && __studio.art.spriteStatus("wiz").source === "project"`);
    const artStatus = await evaluate<unknown>(`({ town: __studio.art.sheetStatus("town"), wiz: __studio.art.spriteStatus("wiz"), dun: __studio.art.sheetStatus("dun"), merchant: __studio.art.spriteStatus("merchant"), notices: __studio.app.notices.map((n) => n.text) })`);
    results.projectArt = artStatus;
    const status = artStatus as { town: { from: string }; wiz: { from: string }; dun: { source: string }; merchant: { source: string } };
    expect("art: the folder's art/sheets/town.png and the wiz sprite's src file are used", status.town.from === "art/sheets/town.png" && status.wiz.from === "assets/npc/wiz.png", JSON.stringify(artStatus));
    expect("art: ids the folder has no art for keep the bundled art", status.dun.source === "bundled" && status.merchant.source === "bundled", JSON.stringify(artStatus));
    await evaluate(`__studio.app.openMap("village")`);
    await evaluate(`__studio.canvas.fit()`);
    await sleep(300);
    /** Compare the map canvas at a cell centre with the autumn sheet pixel of the tile there. */
    const village = JSON.parse(split.entries.find((entry) => entry.path.includes("village"))!.text) as { width: number; height: number; ground: (string | null)[]; upper?: [number, string][]; events: { id: string; x: number; y: number; w?: number; h?: number; pages: { sprite?: string }[] }[] };
    const wizEvent = village.events.find((event) => event.pages.some((page) => page.sprite === "wiz"))!;
    const samples: { x: number; y: number; want: number[] }[] = [];
    // Cells with only a ground tile (no upper tile, no event over them),
    // spread over the map: four distinct tiles.
    const covered = new Set((village.upper ?? []).map(([index]) => index));
    for (const event of village.events) for (let dy = 0; dy < (event.h ?? 1); dy++) for (let dx = 0; dx < (event.w ?? 1); dx++) covered.add((event.y + dy) * village.width + event.x + dx);
    const plain: [number, number][] = [];
    const seenTiles = new Set<string>();
    for (let index = 0; index < village.width * village.height; index += 7) {
      const tile = village.ground[index];
      if (!tile?.startsWith("town.") || covered.has(index) || seenTiles.has(tile)) continue;
      seenTiles.add(tile);
      plain.push([index % village.width, Math.floor(index / village.width)]);
      if (plain.length === 4) break;
    }
    for (const [x, y] of plain) {
      const tile = village.ground[y * village.width + x]!;
      const cellIndex = Number(tile.slice(5));
      const cols = townSource.width / 16;
      const px = (cellIndex % cols) * 16 + 8;
      const py = Math.floor(cellIndex / cols) * 16 + 8;
      const i = (py * townSource.width + px) * 4;
      samples.push({ x, y, want: [autumnRgba[i]!, autumnRgba[i + 1]!, autumnRgba[i + 2]!] });
    }
    const pixelAt = async (cx: number, cy: number) => {
      const p = await cell(cx, cy);
      return evaluate<number[]>(`(() => {
        const c = document.querySelector(".map-canvas");
        const r = c.getBoundingClientRect();
        const s = c.width / r.width;
        return [...c.getContext("2d").getImageData(Math.round((${p.x} - r.left) * s), Math.round((${p.y} - r.top) * s), 1, 1).data].slice(0, 3);
      })()`);
    };
    const got: unknown[] = [];
    let tilesMatch = samples.length >= 3;
    for (const sample of samples) {
      const seen = await pixelAt(sample.x, sample.y);
      got.push({ ...sample, seen });
      tilesMatch &&= seen.every((value, i) => Math.abs(value - sample.want[i]!) <= 3);
    }
    expect("art: the canvas draws the folder's town sheet pixel for pixel", tilesMatch, JSON.stringify(got));
    const wizSeen = await pixelAt(wizEvent.x, wizEvent.y);
    expect("art: the canvas draws the folder's wiz sprite", Math.abs(wizSeen[0]! - 236) <= 3 && Math.abs(wizSeen[1]! - 64) <= 3 && Math.abs(wizSeen[2]! - 200) <= 3, JSON.stringify({ at: [wizEvent.x, wizEvent.y], wizSeen }));
    await shot("studio-project-art");
    // The play-test draws the same art: the game gets the folder's images.
    await key("v", "KeyV", 0, "v");
    const artStart = await cell(9, 7);
    await click(artStart.x, artStart.y);
    await clickSelector("#studio-play");
    const artRunning = await waitFor<unknown>("the game running with project art", `__studio.play.status === "running" && __studio.play.readings > 0 || (__studio.play.status === "error" && "error: " + __studio.play.error)`, 25_000);
    await sleep(900);
    const playArt = await evaluate<any>(`({ art: __studio.play.art, note: __studio.play.artNote, state: __studio.play.state && { map: __studio.play.state.map, x: __studio.play.state.x, y: __studio.play.state.y }, line: document.querySelector('#playtest dd[data-field="art"]')?.textContent ?? null })`);
    results.playArt = playArt;
    expect("art: the play-test runs with the project's art (2 images used) and says so", artRunning === true && playArt.art?.kind === "project" && playArt.art.used === 2 && playArt.art.skipped.length === 0 && playArt.note === null && playArt.line === "project (2 images)", JSON.stringify(playArt));
    const artFrame = await evaluate<{ x: number; y: number; w: number; h: number }>(`(() => { const r = document.querySelector("#playtest-screen iframe").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    const artCapture = decodePng(new Uint8Array(Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64")));
    let autumnPixels = 0;
    let greenPixels = 0;
    let magentaPixels = 0;
    let allPixels = 0;
    for (let y = Math.ceil(artFrame.y); y < artFrame.y + artFrame.h * 0.6; y += 2) {
      for (let x = Math.ceil(artFrame.x); x < artFrame.x + artFrame.w; x += 2) {
        const i = (y * artCapture.width + x) * 4;
        const [r, g, b] = [artCapture.rgba[i]!, artCapture.rgba[i + 1]!, artCapture.rgba[i + 2]!];
        allPixels++;
        if (r > g + 30 && r > 120 && b < g) autumnPixels++;
        if (g > r + 15 && g > b + 15) greenPixels++;
        if (Math.abs(r - 236) <= 4 && Math.abs(g - 64) <= 4 && Math.abs(b - 200) <= 4) magentaPixels++;
      }
    }
    const gameColors = { autumn: autumnPixels / allPixels, green: greenPixels / allPixels, magenta: magentaPixels };
    results.playArtColors = gameColors;
    expect("art: the game draws the autumn town sheet (no green grass left) and the magenta wiz", gameColors.autumn > 0.2 && gameColors.green < 0.02 && gameColors.magenta > 20, JSON.stringify(gameColors));
    await mouse("mouseMoved", 700, 860, "none");
    await sleep(200);
    await shot("studio-playtest-project-art");
    await clickSelector("#playtest-close");
    const artPack = readFileSync(await download(), "utf8");
    const artPackParsed = parseShardedPack(artPack);
    expect("art: Download writes a pack that carries the folder's art", JSON.stringify([...artPackParsed.assets.keys()].sort()) === JSON.stringify(Object.keys(artFiles).sort()) && artPackParsed.assets.get("art/sheets/town.png")?.data === artFiles["art/sheets/town.png"], JSON.stringify([...artPackParsed.assets.keys()]));
    const artPackPath = join(OUT, "sunstone-art-pack.json");
    writeFileSync(artPackPath, artPack);
    await navigate(`${base}?example=sunstone`);
    await setFile("#studio-open-input", artPackPath);
    await waitFor("art pack opened", `__studio.app.session?.kind === "pack" && __studio.files.target === null`);
    await waitFor("pack art loaded", `__studio.art.sheetStatus("town").source === "project" && __studio.art.spriteStatus("wiz").source === "project"`, 5000).catch(() => undefined);
    const packArt = await evaluate<unknown>(`({ town: __studio.art.sheetStatus("town"), wiz: __studio.art.spriteStatus("wiz") })`);
    expect("art: opening that pack in the browser draws its art again", JSON.stringify(packArt).split('"project"').length === 3, JSON.stringify(packArt));
    await evaluate(`(async () => { const root = await navigator.storage.getDirectory(); await root.removeEntry("sunstone-art", { recursive: true }); })()`);

    phase = "limits";
    const openBefore = await evaluate<string>(`__studio.app.session.exportText()`);
    await evaluate(`(() => {
      const input = document.querySelector("#studio-open-input");
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(64 * 1024 * 1024 + 1)], "huge.json", { type: "application/json" }));
      input.files = transfer.files;
      input.dispatchEvent(new Event("change"));
    })()`);
    await waitFor("oversized file refused", `__studio.app.notices.some((n) => n.level === "error" && n.text.startsWith("huge.json is"))`);
    const refused = await evaluate<{ text: string; same: boolean }>(`({ text: __studio.app.notices.filter((n) => n.level === "error").at(-1).text, same: __studio.app.session.exportText() === ${JSON.stringify(openBefore)} })`);
    expect("limits: a 64 MiB + 1 byte file is refused with a visible error and the open document stays", refused.same && refused.text === "huge.json is 67,108,865 bytes; project files can be at most 32 MiB and sharded packs at most 64 MiB.", refused.text);
    const page = readFileSync(join(SITE, "studio", "index.html"), "utf8");
    const boot = page.match(/<script>[\s\S]*?<\/script>/g) ?? [];
    expect("limits: the served page carries the browser host's boot script once", boot.length === 1 && boot[0]!.includes('"pocket-rpgkit:studio:theme"') && !page.includes("studio:host-boot"), `${boot.length} inline script(s)`);

    // ---- perf ----
    phase = "perf";
    const largePath = join(OUT, "large-100x100.json");
    writeFileSync(largePath, largeProject());
    await setFile("#studio-open-input", largePath);
    await waitFor("large map", `__studio.app.mapId === "large"`);
    await sleep(400);
    const rebuild = await evaluate<number>(`__studio.canvas.lastRebuildMs`);
    // Zoom and pan as a user would: wheel steps at the pointer, then a long
    // middle-button drag. Frame cost is the draw() time Studio records.
    await evaluate(`__studio.canvas.stats.recent.length = 0`);
    const center = await evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector(".map-canvas").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    for (const delta of [-100, -100, -100, 100, 100, -100]) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: center.x, y: center.y, deltaX: 0, deltaY: delta });
      await sleep(40);
    }
    await mouse("mouseMoved", center.x, center.y, "none");
    await mouse("mousePressed", center.x, center.y, "middle");
    for (let i = 1; i <= 60; i++) {
      await mouse("mouseMoved", center.x - i * 8, center.y - i * 5, "middle");
      await sleep(16);
    }
    await mouse("mouseReleased", center.x - 480, center.y - 300, "middle");
    await sleep(100);
    const navFrames = await evaluate<number[]>(`__studio.canvas.stats.recent.slice()`);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(`__studio.canvas.fit()`);
    await sleep(200);
    await evaluate(`__studio.canvas.stats.recent.length = 0`);
    const strokeCells: [number, number][] = [];
    for (let i = 0; i < 200; i++) strokeCells.push([5 + (i % 90), 5 + Math.floor(i / 90) * 3 + (i % 7)]);
    const strokeStart = performance.now();
    await drag(strokeCells);
    const strokeWall = performance.now() - strokeStart;
    const strokeFrames = await evaluate<number[]>(`__studio.canvas.stats.recent.slice()`);
    const commitMs = await evaluate<number>(`__studio.app.lastOpMs`);
    const cacheUpdate = await evaluate<{ ms: number; cells: number }>(`({ ms: __studio.canvas.lastRebuildMs, cells: __studio.canvas.lastRebuildCells })`);
    const painted = await evaluate<{ label: string } | undefined>(`__studio.app.session.history().at(-1)`);
    const summary = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
      return { frames: values.length, median: +pick(0.5).toFixed(2), p95: +pick(0.95).toFixed(2), max: +(sorted.at(-1) ?? 0).toFixed(2) };
    };
    const perf = { rebuildMs: +rebuild.toFixed(1), navigate: summary(navFrames), stroke: summary(strokeFrames), strokeCommitMs: +commitMs.toFixed(1), cacheUpdateAfterCommit: { ms: +cacheUpdate.ms.toFixed(2), cells: cacheUpdate.cells }, strokeWallMs: Math.round(strokeWall), lastStep: painted?.label };
    results.perf = perf;
    expect("perf: zoom/pan frames on 100×100 stay under 8 ms (p95)", perf.navigate.frames > 20 && perf.navigate.p95 < 8, JSON.stringify(perf.navigate));
    expect("perf: brush stroke frames stay under 8 ms (max)", perf.stroke.frames > 5 && perf.stroke.max < 8, JSON.stringify(perf.stroke));
    expect("perf: the commit repaints no cell the preview already drew", cacheUpdate.cells === 0, JSON.stringify(cacheUpdate));
    expect("perf: a 200-cell stroke commits as one step", /Paint \d+ ground cells/.test(perf.lastStep ?? "") , `${perf.lastStep}, commit ${perf.strokeCommitMs} ms`);

    // ---- map editing shot: Sunstone forest, zoomed, passage overlay ----
    phase = "map-shot";
    await navigate(`${base}?example=sunstone`);
    await waitFor("sheet art", `__studio.art.sheetStatus("town").source === "bundled"`);
    await clickSelector('.map-row[data-map="forest"]');
    await sleep(200);
    for (const tileCell of [61, 37, 26, 3]) {
      const point = await evaluate<{ x: number; y: number }>(`(() => {
        const r = document.querySelector(".palette-canvas").getBoundingClientRect();
        return { x: r.left + (${tileCell % 12} + 0.5) * r.width / 12, y: r.top + (${Math.floor(tileCell / 12)} + 0.5) * r.height / 11 };
      })()`);
      await click(point.x, point.y);
    }
    await key("p", "KeyP", 0, "p");
    await evaluate(`__studio.canvas.setZoom(3)`);
    const hoverAt = await cell(7, 6);
    await mouse("mouseMoved", hoverAt.x, hoverAt.y, "none");
    await shot("studio-map-editing");
    await key("p", "KeyP", 0, "p");

    // ---- problems ----
    phase = "problems";
    await navigate(`${base}?example=sunstone`);
    await waitFor("sheet art", `__studio.art.sheetStatus("town").source === "bundled"`);
    // A dangling transfer and an unknown item: both are rpgkit-check findings.
    await evaluate(`__studio.app.run("insert-command", { map: "village", event: "elder", page: 0, address: { path: [], index: 0 }, command: { op: "transfer", map: "forest", x: 40, y: 40 } }, "Add a transfer")`);
    await evaluate(`__studio.app.run("insert-command", { map: "village", event: "sign", page: 0, address: { path: [], index: 0 }, command: { op: "item", item: "moonstone", set: "add", count: 1 } }, "Add an item")`);
    await sleep(500);
    await clickSelector("#status-problems");
    await sleep(200);
    const problemCount = await evaluate<number>(`document.querySelectorAll(".problem").length`);
    expect("problems: rpgkit-check findings are listed", problemCount >= 2, `${problemCount} problems`);
    await clickSelector(".problem");
    const located = await evaluate<{ kind: string; eventId?: string }>(`__studio.app.selection`);
    expect("problems: clicking a problem selects its event", located.kind === "event", JSON.stringify(located));
    const pulse = await waitFor<{ canvas: boolean; inspector: boolean }>("problem pulse", `(() => { const p = { canvas: __studio.canvas.flashing, inspector: !!document.querySelector("#inspector .ins-section.flash") }; return p.canvas && p.inspector ? p : null; })()`, 2000).catch(() => null);
    expect("problems: the jump pulses the event on the canvas and in the inspector", !!pulse, JSON.stringify(pulse));
    await sleep(1200);
    await shot("studio-problems");

    // ---- narrow ----
    phase = "narrow";
    await clickSelector("#status-problems");
    await viewport(820, 1180);
    await evaluate(`__studio.canvas.fit()`);
    await shot("studio-narrow");
    const narrow = await evaluate<{ overflowX: boolean; canvas: number }>(`({ overflowX: document.documentElement.scrollWidth > innerWidth + 1, canvas: document.querySelector(".map-canvas").getBoundingClientRect().width })`);
    expect("narrow: the layout fits an 820 px window", !narrow.overflowX && narrow.canvas > 700, JSON.stringify(narrow));

    // ---- play-test ----
    phase = "playtest";
    await viewport(1440, 900);
    await navigate(`${base}?example=sunstone`);
    await waitFor("sheet art", `__studio.art.sheetStatus("town").source === "bundled"`);
    const playState = () => evaluate<any>(`__studio.play.state`);
    const waitRunning = (label: string) => waitFor(label, `__studio.play.status === "running" && __studio.play.readings > 0 || (__studio.play.status === "error" && "error: " + __studio.play.error)`, 25_000);
    const theme0 = await evaluate<string>(`document.documentElement.dataset.theme`);
    if (theme0 !== "light") await clickSelector("#studio-theme");
    await key("v", "KeyV", 0, "v");
    const startCell = await cell(9, 7);
    await click(startCell.x, startCell.y);
    const picked = await evaluate<any>(`__studio.app.selection`);
    expect("playtest: the select tool picks village cell (9, 7)", picked.kind === "cell" && picked.x === 9 && picked.y === 7, JSON.stringify(picked));
    const playEnabled = await evaluate<boolean>(`!document.getElementById("studio-play").disabled`);
    expect("playtest: the toolbar's Play button is enabled", playEnabled, String(playEnabled));
    await clickSelector("#studio-play");
    const started = await waitRunning("the game running");
    expect("playtest: the embedded game starts", started === true, String(started));
    const frameInfo = await evaluate<any>(`(() => { const f = document.querySelector("#playtest-screen iframe"); return f ? { src: new URL(f.src).pathname + new URL(f.src).search, sameOrigin: new URL(f.src).origin === location.origin } : null; })()`);
    expect("playtest: the panel embeds the site's preview page", frameInfo?.src?.endsWith("/preview/?embed") && frameInfo.sameOrigin, JSON.stringify(frameInfo));
    const first = await playState();
    expect("playtest: state reports the selected cell", first?.map === "village" && first.x === 9 && first.y === 7 && first.dir === "down", JSON.stringify(first));
    const readings0 = await evaluate<number>(`__studio.play.readings`);
    await sleep(1200);
    const later = await playState();
    const readings1 = await evaluate<number>(`__studio.play.readings`);
    expect("playtest: the frame number advances", later?.frame > first?.frame, `${first?.frame} -> ${later?.frame}`);
    expect("playtest: the readout refreshes several times a second", readings1 - readings0 >= 3, `${readings1 - readings0} readings in 1.2 s`);
    const readout = await evaluate<Record<string, string>>(`Object.fromEntries([...document.querySelectorAll("#playtest-readout dd")].map((d) => [d.dataset.field, d.textContent]))`);
    expect("playtest: the readout shows map, position and frame", readout.map === "village" && readout.position === "(9, 7)" && Number(readout.frame) > 0, JSON.stringify(readout));
    const focused = await evaluate<string>(`document.activeElement?.tagName ?? ""`);
    expect("playtest: the game has the keyboard after starting", focused === "IFRAME", focused);
    await mouse("mouseMoved", 420, 760, "none"); // no toolbar tooltip in the shot
    await playShot("studio-playtest-light", { dialogue: false, theme: "light" });

    await key("Escape", "Escape");
    await sleep(150);
    const released = await evaluate<{ tag: string; status: string }>(`({ tag: document.activeElement?.tagName ?? "", cls: document.activeElement?.className ?? "", status: __studio.play.status })`);
    expect("playtest: Esc returns the keyboard to the editor", released.tag !== "IFRAME" && released.status === "running", JSON.stringify(released));

    // Edit the elder's first line in the inspector.
    const NEW_LINE = "ELDER: Studio says hello!";
    const elderCell = await cell(9, 5);
    await click(elderCell.x, elderCell.y);
    await sleep(150);
    await clickSelector(`[data-action="select-command"]`);
    await waitFor("text field", `!!document.querySelector('[data-field="command.lines"]')`);
    await evaluate(`(() => {
      const f = document.querySelector('[data-field="command.lines"]');
      f.focus();
      f.value = ${JSON.stringify(`${NEW_LINE}\nThe play-test runs this edit.`)};
      f.dispatchEvent(new Event("input", { bubbles: true }));
      f.dispatchEvent(new Event("change", { bubbles: true }));
      f.blur();
    })()`);
    await sleep(200);
    const edited = await evaluate<unknown>(`__studio.app.currentMap().events.find((e) => e.id === "elder").pages[0].commands[0].lines`);
    expect("playtest: the elder's dialogue is edited", JSON.stringify(edited) === JSON.stringify([NEW_LINE, "The play-test runs this edit."]), JSON.stringify(edited));
    const stale = await evaluate<{ stale: boolean; pressed: string | null }>(`({ stale: __studio.play.stale, pressed: document.getElementById("playtest-reload")?.getAttribute("aria-pressed") })`);
    expect("playtest: Reload is marked once the document changes", stale.stale && stale.pressed === "true", JSON.stringify(stale));
    await clickSelector("#playtest-reload");
    await waitFor("the reloaded game", `__studio.play.status === "running" && __studio.play.readings > 0 && !__studio.play.stale`, 20_000);
    const reloaded = await playState();
    expect("playtest: Reload starts the latest document at the same cell", reloaded?.map === "village" && reloaded.x === 9 && reloaded.y === 7 && reloaded.message === null, JSON.stringify(reloaded));

    // Walk up to the elder with the real keyboard and press Enter.
    const iframeBox = await evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector("#playtest-screen iframe").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await click(iframeBox.x, iframeBox.y);
    await sleep(100);
    const gameKey = async (keyName: string, code: string, holdMs: number) => {
      const keyCode = ({ ArrowUp: 38, Enter: 13 } as Record<string, number>)[keyName] ?? 0;
      await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: keyName, code, windowsVirtualKeyCode: keyCode });
      await sleep(holdMs);
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, windowsVirtualKeyCode: keyCode });
    };
    await gameKey("ArrowUp", "ArrowUp", 220);
    await waitFor("the player at (9, 6)", `(() => { const s = __studio.play.state; return s && s.y === 6 && !s.moving && s.dir === "up"; })()`, 8000);
    await gameKey("Enter", "Enter", 80);
    await waitFor("the elder's dialogue", `__studio.play.state?.message?.text.startsWith(${JSON.stringify(NEW_LINE)})`, 8000);
    await sleep(1800); // let the typewriter reveal the line
    const talking = await playState();
    expect("playtest: the game shows the edited dialogue", talking?.message?.kind === "text" && talking.message.text.startsWith(NEW_LINE) && talking.running >= 1 && talking.event === "village/elder", JSON.stringify({ message: talking?.message, running: talking?.running, event: talking?.event }));
    const shown = await evaluate<string>(`document.querySelector('#playtest-readout dd[data-field="message"]').textContent`);
    expect("playtest: the readout shows the open message", shown.startsWith(NEW_LINE), shown);
    await playShot("studio-playtest-dialogue", { dialogue: true, theme: "light" });
    await clickSelector("#studio-theme");
    await evaluate(`__studio.play.focusGame()`);
    await mouse("mouseMoved", 420, 760, "none");
    await sleep(250);
    await playShot("studio-playtest-dark", { dialogue: true, theme: "dark" });
    await clickSelector("#studio-theme");
    await sleep(150);

    // Restart: a fresh game at the same cell (the frame counter starts over).
    const beforeRestart = await playState();
    await clickSelector("#playtest-restart");
    await waitFor("the restarted game", `(() => { const s = __studio.play.state; return __studio.play.status === "running" && s && s.y === 7 && s.message === null; })()`, 10_000);
    const restarted = await playState();
    expect("playtest: Restart starts afresh at the start cell", restarted?.map === "village" && restarted.x === 9 && restarted.y === 7 && restarted.dir === "down" && restarted.running === 0 && restarted.frame < beforeRestart?.frame, JSON.stringify({ before: beforeRestart?.frame, after: restarted }));

    // Restart forgets what the game earned. Start below Sunstone's village
    // chest facing it, open it (+25 gold, the thorn key, self switch A), then
    // Restart: gold and items are back to their start values, and the chest
    // offers its first page again (self switch A is clear).
    const closeMessage = async (label: string) => {
      for (let i = 0; i < 8 && (await playState())?.message; i++) {
        await gameKey("Enter", "Enter", 80);
        await sleep(400);
      }
      const after = await playState();
      if (after?.message) throw new Error(`the ${label} message did not close: ${JSON.stringify(after.message)}`);
    };
    const chestCell = await cell(17, 4);
    await click(chestCell.x, chestCell.y);
    await sleep(150);
    await evaluate(`(() => { const s = document.getElementById("playtest-dir"); s.value = "up"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await clickSelector("#playtest-play");
    await waitFor("the game below the chest", `(() => { const s = __studio.play.state; return __studio.play.status === "running" && s && s.x === 17 && s.y === 4 && s.dir === "up"; })()`, 15_000);
    const beforeChest = await playState();
    expect("playtest: the game starts below the chest with no key", beforeChest?.gold === 5 && !beforeChest.items["thorn-key"] && beforeChest.message === null, JSON.stringify({ gold: beforeChest?.gold, items: beforeChest?.items }));
    const box = await evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector("#playtest-screen iframe").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await click(box.x, box.y);
    await sleep(100);
    await gameKey("Enter", "Enter", 80);
    await waitFor("the chest's text", `__studio.play.state?.message?.text.startsWith("Found 25 gold")`, 8000);
    const opened = await playState();
    expect("playtest: opening the chest adds 25 gold and the thorn key", opened?.gold === beforeChest.gold + 25 && opened.items["thorn-key"] === 1 && opened.event === "village/village-chest", JSON.stringify({ gold: opened?.gold, items: opened?.items, event: opened?.event }));
    await closeMessage("chest");
    await gameKey("Enter", "Enter", 80);
    await waitFor("the empty chest's text", `__studio.play.state?.message?.text.startsWith("The chest is empty")`, 8000);
    const emptied = await playState();
    expect("playtest: the chest's self switch A is set (its second page runs)", emptied?.event === "village/village-chest" && emptied.gold === beforeChest.gold + 25, JSON.stringify({ message: emptied?.message, gold: emptied?.gold }));
    await closeMessage("empty chest");
    await clickSelector("#playtest-restart");
    await waitFor("the restarted chest game", `(() => { const s = __studio.play.state; return __studio.play.status === "running" && __studio.play.readings > 0 && s && s.x === 17 && s.y === 4 && s.message === null; })()`, 15_000);
    const afresh = await playState();
    expect("playtest: Restart puts gold and items back to their start values", afresh?.gold === beforeChest.gold && !afresh.items["thorn-key"] && JSON.stringify(afresh.items) === JSON.stringify(beforeChest.items) && JSON.stringify(afresh.switches) === JSON.stringify(beforeChest.switches), JSON.stringify({ gold: afresh?.gold, items: afresh?.items, switches: afresh?.switches }));
    await gameKey("Enter", "Enter", 80);
    await waitFor("the chest's first page again", `(() => { const t = __studio.play.state?.message?.text ?? ""; return t.startsWith("Found 25 gold") || t.startsWith("The chest is empty"); })()`, 8000);
    const reopened = await playState();
    expect("playtest: after Restart the chest's self switch A is clear (first page again)", reopened?.message?.text.startsWith("Found 25 gold") && reopened.gold === beforeChest.gold + 25, JSON.stringify({ message: reopened?.message, gold: reopened?.gold }));
    await closeMessage("reopened chest");

    // Forged replies: Studio's own window, a sandboxed frame and a second
    // same-origin frame answer a pending request; only the game's reply counts.
    const forged = await evaluate<any>(`(async () => {
      const preview = __studio.host.preview();
      const ignored0 = preview.debug().ignored;
      const fake = (id) => ({ protocol: "rpgkit-preview/v1", type: "reply", requestId: id, ok: true, result: { status: "running", map: "forged", x: 0, y: 0, px: 0, py: 0, dir: "down", moving: false, frame: 1, running: 0, event: null, message: null, switches: {}, variables: {}, gold: 999, items: {} } });
      const request = preview.state();
      const id = preview.debug().pending.at(-1);
      window.postMessage(fake(id), "*");
      const sandboxed = document.createElement("iframe");
      sandboxed.setAttribute("sandbox", "allow-scripts");
      sandboxed.srcdoc = "<script>parent.postMessage(" + JSON.stringify(fake(id)) + ", '*'); parent.postMessage({ protocol: 'rpgkit-preview/v1', type: 'event', event: 'ready', version: 1 }, '*');<\/script>";
      const twin = document.createElement("iframe");
      twin.srcdoc = "<script>parent.postMessage(" + JSON.stringify(fake(id)) + ", '*');<\/script>";
      document.body.append(sandboxed, twin);
      const result = await request;
      await new Promise((r) => setTimeout(r, 400));
      sandboxed.remove();
      twin.remove();
      return { ok: result.ok, map: result.ok ? result.value.map : result.message, ignored: preview.debug().ignored - ignored0, status: __studio.play.status, readoutMap: document.querySelector('#playtest-readout dd[data-field="map"]').textContent };
    })()`);
    expect("playtest: forged replies are ignored and the game's own reply wins", forged.ok && forged.map === "village" && forged.ignored >= 4 && forged.readoutMap === "village", JSON.stringify(forged));

    // Unrelated traffic from the game page (not this protocol) is not an error.
    await evaluate(`document.querySelector("#playtest-screen iframe").contentWindow.eval("parent.postMessage({ hello: 'studio' }, '*'); parent.postMessage('text', '*')")`);
    await sleep(600);
    const unrelated = await evaluate<any>(`({ status: __studio.play.status, error: __studio.play.error, readings: __studio.play.readings })`);
    expect("playtest: unrelated messages from the game page are ignored", unrelated.status === "running" && unrelated.error === null, JSON.stringify(unrelated));

    // A chapter start: Sunstone ships its demo chapters as save points.
    const chapters = await evaluate<string[]>(`[...document.querySelectorAll('#playtest-from option')].map((o) => o.value)`);
    expect("playtest: Sunstone's chapters are offered", ["chapter:village", "chapter:forest", "chapter:cave"].every((id) => chapters.includes(id)), JSON.stringify(chapters));
    await evaluate(`(() => { const s = document.getElementById("playtest-from"); s.value = "chapter:forest"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await clickSelector("#playtest-play");
    await waitFor("the forest chapter", `(() => { const s = __studio.play.state; return __studio.play.status === "running" && s && s.map === "forest"; })()`, 15_000);
    const forest = await playState();
    expect("playtest: a chapter start restores its save point", forest?.map === "forest" && forest.x === 10 && forest.y === 13, JSON.stringify({ map: forest?.map, x: forest?.x, y: forest?.y }));
    await sleep(300);
    await playShot("studio-playtest-running", { dialogue: false, theme: "light" });

    await clickSelector("#playtest-stop");
    await waitFor("stopped", `__studio.play.status === "stopped"`);
    const afterStop = await evaluate<any>(`(async () => { const r = await __studio.host.preview().state(); return { ok: r.ok, code: r.ok ? null : r.code, status: __studio.play.status }; })()`);
    expect("playtest: Stop unloads the game", afterStop.ok === false && afterStop.code === "not-loaded" && afterStop.status === "stopped", JSON.stringify(afterStop));

    // A protocol version mismatch from the game page is shown, not swallowed.
    await evaluate(`(() => { const s = document.getElementById("playtest-from"); s.value = "selection"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await clickSelector("#playtest-play");
    await waitRunning("the game running again");
    await evaluate(`document.querySelector("#playtest-screen iframe").contentWindow.eval("parent.postMessage({ protocol: 'rpgkit-preview/v2', type: 'event', event: 'ready', version: 2 }, '*')")`);
    await waitFor("the version error", `__studio.play.status === "error"`, 5000);
    const versionText = await evaluate<string>(`document.getElementById("playtest-error")?.textContent ?? ""`);
    expect("playtest: a protocol version mismatch is shown", /rpgkit-preview\/v2/.test(versionText) && /rpgkit-preview\/v1/.test(versionText), versionText);
    await clickSelector("#playtest-play");
    const recovered = await waitRunning("a fresh game after the mismatch");
    expect("playtest: Play embeds a fresh game after the mismatch", recovered === true, String(recovered));

    // The sharded pack plays, put together as one document.
    await clickSelector("#playtest-close");
    await evaluate(`__studio.files.openExample("sunstone-pack")`);
    await waitFor("the pack", `__studio.app.session?.kind === "pack"`);
    await clickSelector("#studio-play");
    await waitRunning("the pack running");
    const packState = await playState();
    const packNote = await evaluate<boolean>(`__studio.play.expanded`);
    expect("playtest: a sharded pack plays as one document", packState?.map === "village" && packNote, JSON.stringify({ map: packState?.map, x: packState?.x, y: packState?.y, expanded: packNote }));
    await clickSelector("#playtest-close");

    // Over the protocol's 4 MiB message limit: refused with the reason, never sent.
    const big = JSON.parse(readFileSync(join(ROOT, "examples", "sunstone", "data", "sunstone.json"), "utf8")) as Project;
    for (let i = 1; i <= 7; i++) {
      big.maps.push({ id: `big-${i}`, name: `Big ${i}`, width: 256, height: 256, sheets: ["town"], ground: new Array(256 * 256).fill("town.37"), events: [] } as unknown as Project["maps"][number]);
    }
    const bigText = `${JSON.stringify(big)}\n`;
    await evaluate(`__studio.files.openText(${JSON.stringify(bigText)}, "big.json", "big.json")`);
    await waitFor("the big document", `__studio.app.session?.maps().length === 10`);
    const sentBefore = await evaluate<number>(`__studio.host.preview().debug().sent`);
    await clickSelector("#studio-play");
    await sleep(500);
    const overLimit = await evaluate<any>(`({ blocked: __studio.play.blocked, notice: document.getElementById("playtest-error")?.textContent ?? "", playDisabled: document.getElementById("playtest-play")?.disabled, reloadDisabled: document.getElementById("playtest-reload")?.disabled, frame: !!document.querySelector("#playtest-screen iframe"), status: __studio.play.status })`);
    expect("playtest: an over-limit document is refused with its reason", /Too large to play-test/.test(overLimit.notice) && /4\.0 MiB/.test(overLimit.notice) && overLimit.playDisabled && overLimit.reloadDisabled, JSON.stringify(overLimit));
    const sentAfter = await evaluate<number>(`__studio.host.preview().debug().sent`);
    expect("playtest: the over-limit document is never sent", !overLimit.frame && sentAfter === sentBefore, JSON.stringify({ frame: overLimit.frame, sentBefore, sentAfter }));
    await clickSelector("#playtest-close");

    // ---- dark theme shot last so the stored theme does not leak ----
    phase = "dark";
    await viewport(1440, 900);
    await navigate(`${base}?example=sunstone`);
    await waitFor("sheet art", `__studio.art.sheetStatus("town").source === "bundled"`);
    await clickSelector("#studio-theme");
    await sleep(200);
    const theme = await evaluate<string>(`document.documentElement.dataset.theme`);
    expect("theme: the toggle switches theme", theme === "dark", theme);
    const elder2 = await cell(9, 5);
    await key("v", "KeyV", 0, "v");
    await click(elder2.x, elder2.y);
    await shot("studio-dark");
    // The drag feedback and the shortcuts panel in the dark theme.
    await waitFor("elder command tree", `document.querySelectorAll('[data-action="select-command"]').length >= 4`);
    await evaluate(`document.querySelector('[data-role="command-tree"]').scrollIntoView({ block: "start" })`);
    await sleep(100);
    const darkRow = await evaluate<{ x: number; y: number; w: number; h: number }>(`(() => { const el = document.querySelector('.ins-row[data-op="text"]'); el.scrollIntoView({ block: "nearest" }); const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    const darkBranch = await evaluate<{ x: number; y: number; w: number; h: number }>(`(() => { const el = [...document.querySelectorAll(".ins-branch")].find((b) => /farewell/i.test(b.textContent)); const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    await mouse("mouseMoved", darkRow.x + 60, darkRow.y + darkRow.h / 2, "none");
    await mouse("mousePressed", darkRow.x + 60, darkRow.y + darkRow.h / 2);
    for (let i = 1; i <= 8; i++) await mouse("mouseMoved", darkRow.x + 60 + 20 * i / 8, darkRow.y + darkRow.h / 2 + (darkBranch.y + darkBranch.h / 2 - darkRow.y - darkRow.h / 2) * i / 8);
    await sleep(150);
    const darkDrop = await evaluate<boolean>(`!!document.querySelector(".ins-branch.drop-after") && !!document.querySelector(".ins-row.dragging")`);
    expect("theme: the command drag shows its drop line in the dark theme", darkDrop, String(darkDrop));
    await shot("studio-drag-command-dark");
    await evaluate(`document.querySelector('[data-role="command-tree"]').focus()`);
    await key("Escape", "Escape");
    await mouse("mouseReleased", darkBranch.x + 80, darkBranch.y + darkBranch.h / 2);
    await sleep(150);
    expect("theme: Esc left the elder's commands as they were", (await evaluate<number>(`__studio.app.session.history().length`)) === 0, "");
    await evaluate(`document.activeElement?.blur()`);
    await key("?", "Slash", SHIFT, "?");
    await waitFor("shortcuts panel", `!!document.querySelector('[data-role="shortcuts"]')`);
    await shot("studio-shortcuts-dark");
    await key("Escape", "Escape");
  } catch (error) {
    failures.push({ check: phase, message: error instanceof Error ? error.message : String(error) });
    console.log(`  FAIL ${phase}: ${error instanceof Error ? error.stack : error}`);
    await shot(`error-${phase}`).catch(() => {});
  } finally {
    const bad = requests.filter((r) => r.status >= 400 && !r.url.endsWith("favicon.ico"));
    expect("network: no failed requests", bad.length === 0, bad.length ? bad.map((r) => `${r.status} ${r.url}`).join(", ") : `${requests.length} requests`);
    expect("console: no errors", consoleErrors.length === 0, consoleErrors.length ? consoleErrors.join("\n") : "clean");
    await Bun.write(join(OUT, "report.json"), JSON.stringify({ failures, results, consoleErrors }, null, 2) + "\n");
    cdp.close();
    chrome.proc.kill();
    await chrome.proc.exited;
    server.stop(true);
    rmSync(profile, { recursive: true, force: true });
  }
}

await main();
console.log(`\nstudio-verify: ${failures.length === 0 ? "PASS" : `FAIL (${failures.length})`}; report in ${OUT}`);
process.exit(failures.length === 0 ? 0 : 1);
