// tools/web-verify.ts — play the built web site (dist/web) in headless
// Chrome and check that every game really runs and answers input.
//
//   bun run web && bun tools/web-verify.ts
//   bun tools/web-verify.ts --chrome /usr/bin/google-chrome --out dist/web-verify
//
// It serves the site twice from an in-process static server: at "/" and
// under "/pocket-rpgkit/" (the GitHub Pages project path), where anything
// outside the prefix is a 404, so an absolute URL shows up as a failed
// request. Chrome runs over the DevTools protocol; nothing is installed.
//
// Checks, with screenshots in --out (the page, and the canvas at its native
// raster size). Games other than the three examples get the generic ones.
//   landing   every card, and its preview image, loads
//   showcase  enters two feature halls, triggers both demonstrations, and
//             returns to the lobby after each one
//   sunstone  idles into attract mode (the player moves on its own), a key
//             takes over, and held arrows then walk the player
//   grow      the settlement grows on its own; a mouse drag and a touch
//             drag on the timeline strip seek it; ← steps one tick back; a
//             smaller window shrinks the live viewport
//   meadow    held arrows walk the player
//   focus     the game has keyboard focus after load; clicking elsewhere
//             shows the hint and keys stop; a click on the game restores
//   sizing    every raster sample occupies whole device pixels, the backing
//             canvas matches logical size × configured density, at 1x, 2x
//             and 1.25x, fixed and dynamic; touch buttons appear on a phone
//   subpath   the landing page and every game run under /pocket-rpgkit/
// Any console error, uncaught exception or failed request fails the run.

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const PREFIX = "/pocket-rpgkit/";

function option(name: string, fallback: string): string {
  const argv = process.argv.slice(2);
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1]! : fallback;
}

const SITE = resolve(option("site", join(ROOT, "dist", "web")));
const OUT = resolve(option("out", join(ROOT, "dist", "web-verify")));
const CHROME = option("chrome", Bun.which("google-chrome") ?? Bun.which("chromium") ?? "/usr/bin/google-chrome");

if (!existsSync(join(SITE, "index.html"))) {
  console.error(`web-verify: no site at ${SITE}; run \`bun run web\` first`);
  process.exit(2);
}

// ---- static server -----------------------------------------------------------

interface RequestLog { url: string; status: number }
const requests: RequestLog[] = [];

function serveStatic(prefix: string) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      let status = 404;
      let response: Response;
      if (!url.pathname.startsWith(prefix) && url.pathname !== prefix.slice(0, -1)) {
        response = new Response("not found", { status: 404 });
      } else {
        const rel = decodeURIComponent(url.pathname.slice(prefix.length - 1));
        const path = resolve(SITE, `.${rel}`);
        if (!path.startsWith(SITE)) {
          response = new Response("forbidden", { status: 403 });
          status = 403;
        } else if (existsSync(path) && statSync(path).isDirectory()) {
          if (!url.pathname.endsWith("/")) {
            // What GitHub Pages does for a directory without its slash.
            response = Response.redirect(`${url.pathname}/`, 301);
            status = 301;
          } else if (existsSync(join(path, "index.html"))) {
            response = new Response(Bun.file(join(path, "index.html")));
            status = 200;
          } else response = new Response("not found", { status: 404 });
        } else if (existsSync(path)) {
          response = new Response(Bun.file(path));
          status = 200;
        } else response = new Response("not found", { status: 404 });
      }
      requests.push({ url: url.pathname, status });
      return response;
    },
  });
}

// ---- Chrome over CDP -----------------------------------------------------------

class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, ((params: any) => void)[]>();
  constructor(private ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(`${message.error.message} (${message.error.code})`));
        else waiter?.resolve(message.result);
      } else {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
      }
    });
  }
  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)), { once: true });
    });
    return new Cdp(ws);
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(method: string, listener: (params: any) => void): void {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
  }
  close(): void {
    this.ws.close();
  }
}

async function launchChrome(profile: string): Promise<{ proc: ReturnType<typeof Bun.spawn>; ws: string }> {
  const proc = Bun.spawn(
    [
      CHROME, "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--remote-debugging-port=0",
      `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking", "--disable-component-update", "--hide-scrollbars",
      "--window-size=1440,1000", "--force-device-scale-factor=1", "about:blank",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
    const match = /DevTools listening on (ws:\/\/\S+)/.exec(text);
    if (match) {
      reader.releaseLock();
      const port = new URL(match[1]!).port;
      const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[];
      const page = targets.find((t) => t.type === "page");
      if (!page) throw new Error("Chrome started without a page target");
      return { proc, ws: page.webSocketDebuggerUrl };
    }
  }
  proc.kill();
  throw new Error(`Chrome did not start: ${text.slice(-2000)}`);
}

// ---- checks ----------------------------------------------------------------------

interface Failure { check: string; message: string }
const failures: Failure[] = [];
const results: Record<string, unknown> = {};
const consoleErrors: string[] = [];

function expect(check: string, ok: boolean, message: string): void {
  if (!ok) failures.push({ check, message });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${check}: ${message}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const rootServer = serveStatic("/");
  const subServer = serveStatic(PREFIX);
  const rootBase = `http://127.0.0.1:${rootServer.port}/`;
  const subBase = `http://127.0.0.1:${subServer.port}${PREFIX}`;
  const profile = mkdtempSync(join(OUT, "chrome-profile-"));
  const chrome = await launchChrome(profile);
  const cdp = await Cdp.connect(chrome.ws);
  let phase = "startup";
  let loadEvents = 0;

  cdp.on("Page.loadEventFired", () => { loadEvents++; });
  cdp.on("Runtime.consoleAPICalled", (p) => {
    if (p.type === "error" || p.type === "assert") {
      consoleErrors.push(`[${phase}] console.${p.type}: ${p.args.map((a: any) => a.value ?? a.description).join(" ")}`);
    }
  });
  cdp.on("Runtime.exceptionThrown", (p) => {
    consoleErrors.push(`[${phase}] exception: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`);
  });
  cdp.on("Log.entryAdded", (p) => {
    if (p.entry.level === "error") consoleErrors.push(`[${phase}] log: ${p.entry.text} ${p.entry.url ?? ""}`);
  });
  cdp.on("Network.loadingFailed", (p) => {
    if (!p.canceled) consoleErrors.push(`[${phase}] request failed: ${p.errorText} ${p.requestId}`);
  });
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Network.enable");
  await cdp.send("Page.enable");

  const evaluate = async <T = any>(expression: string): Promise<T> => {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`evaluate failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result.value as T;
  };
  const waitFor = async <T>(label: string, expression: string, timeout = 20_000): Promise<T> => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const value = await evaluate<T>(expression).catch(() => undefined);
      if (value) return value;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const navigate = async (url: string) => {
    const loaded = new Promise((r) => cdp.on("Page.loadEventFired", r));
    await cdp.send("Page.navigate", { url });
    await loaded;
  };
  const screenshot = async (name: string, fullPage = false) => {
    const metrics = fullPage ? await cdp.send("Page.getLayoutMetrics") : undefined;
    const size = metrics?.cssContentSize ?? metrics?.contentSize;
    const shot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      ...(size ? { captureBeyondViewport: true, clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } } : {}),
    });
    await Bun.write(join(OUT, `${name}.page.png`), Buffer.from(shot.data, "base64"));
  };
  const canvasShot = async (name: string) => {
    const data = await evaluate<string>(`document.getElementById("screen").toDataURL("image/png")`);
    await Bun.write(join(OUT, `${name}.canvas.png`), Buffer.from(data.split(",")[1]!, "base64"));
  };
  const canvasStats = () =>
    evaluate<{ nonBlack: number; colors: number; hash: string }>(`(() => {
      const c = document.getElementById("screen");
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let nonBlack = 0, h = 0x811c9dc5;
      const colors = new Set();
      for (let i = 0; i < d.length; i += 4) {
        const v = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
        if (v !== 0) nonBlack++;
        colors.add(v);
        h = Math.imul(h ^ v, 0x01000193);
      }
      return { nonBlack: nonBlack / (d.length / 4), colors: colors.size, hash: (h >>> 0).toString(16) };
    })()`);
  /** Whether the physical backing canvas and CSS presentation agree on one
   * whole number of device pixels per native-density raster sample. */
  const wholePixels = async (dpr: number) => {
    const fit = await evaluate<{
      k: number; raster: number; cssW: number; cssH: number;
      logicalW: number; logicalH: number; backingW: number; backingH: number; density: number;
    }>(`(() => {
      const c = document.getElementById("screen");
      const r = c.getBoundingClientRect();
      return {
        k: __pocketPlayer.scale.device,
        raster: __pocketPlayer.scale.raster,
        cssW: r.width,
        cssH: r.height,
        logicalW: __pocketPlayer.width,
        logicalH: __pocketPlayer.height,
        backingW: c.width,
        backingH: c.height,
        density: __pocketPlayer.config.rasterDensity,
      };
    })()`);
    // Layout snaps to 1/64 CSS px, so allow a few hundredths of a device pixel.
    const ok =
      fit.density >= 1 &&
      fit.k >= fit.density &&
      fit.k % fit.density === 0 &&
      fit.raster === fit.k / fit.density &&
      fit.backingW === fit.logicalW * fit.density &&
      fit.backingH === fit.logicalH * fit.density &&
      Math.abs(fit.cssW * dpr - fit.backingW * fit.raster) < 0.05 &&
      Math.abs(fit.cssH * dpr - fit.backingH * fit.raster) < 0.05;
    return {
      ok,
      text:
        `${fit.logicalW}x${fit.logicalH} logical, ${fit.backingW}x${fit.backingH} backing at ${fit.density}x; ` +
        `${fit.raster} device px/raster sample (${fit.cssW.toFixed(2)}x${fit.cssH.toFixed(2)} CSS px at ${dpr}x)`,
    };
  };
  const frames = () => evaluate<number>("__pocketPlayer.frames");
  const waitFrames = async (count: number) => {
    const target = (await frames()) + count;
    await waitFor(`frame ${target}`, `__pocketPlayer.frames >= ${target}`, count * 50 + 5_000);
  };
  const VK: Record<string, number> = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13, KeyZ: 90, KeyL: 76, ShiftLeft: 16 };
  const key = (type: "keyDown" | "keyUp", code: string) =>
    cdp.send("Input.dispatchKeyEvent", { type, code, key: code.replace(/^Key/, "").toLowerCase().replace(/^arrow/, "Arrow"), windowsVirtualKeyCode: VK[code] ?? 0 });
  const holdKey = async (code: string, count: number) => {
    await key("keyDown", code);
    await waitFrames(count);
    await key("keyUp", code);
  };
  const clickElement = async (selector: string) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "center" })`);
    await sleep(50);
    const point = await toClientOf(selector);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
  };
  const installNoReloadSentinel = () => evaluate(`globalThis.__demoClickSentinel = {
    player: globalThis.__pocketPlayer,
    canvas: document.getElementById("screen"),
    frames: globalThis.__pocketPlayer.frames,
  }`);
  const noReloadSentinel = () => evaluate<{ stable: boolean; advanced: boolean }>(`({
    stable: globalThis.__demoClickSentinel?.player === globalThis.__pocketPlayer &&
      globalThis.__demoClickSentinel?.canvas === document.getElementById("screen"),
    advanced: globalThis.__pocketPlayer.frames > globalThis.__demoClickSentinel?.frames,
  })`);
  /** Logical game pixel -> page CSS pixel, from the canvas rectangle. */
  const toClient = async (x: number, y: number) =>
    evaluate<{ x: number; y: number }>(`(() => {
      const r = document.getElementById("screen").getBoundingClientRect();
      const w = __pocketPlayer.width, h = __pocketPlayer.height;
      return { x: r.left + (${x} + 0.5) * r.width / w, y: r.top + (${y} + 0.5) * r.height / h };
    })()`);
  const openGame = async (base: string, id: string) => {
    phase = id;
    await navigate(`${base}${id}/`);
    await waitFor(`${id} running`, `globalThis.__pocketPlayer?.state === "running" && __pocketPlayer.frames > 30`);
  };
  const checkRuns = async (id: string) => {
    const stats = await canvasStats();
    expect(`${id}: renders`, stats.nonBlack > 0.3 && stats.colors > 20, `${(stats.nonBlack * 100).toFixed(1)}% non-black, ${stats.colors} colors`);
    const fit = await wholePixels(1);
    expect(`${id}: whole device pixels at 1x`, fit.ok, fit.text);
    const focused = await evaluate<boolean>(`document.activeElement === document.getElementById("stage")`);
    expect(`${id}: keyboard focus on load`, focused, focused ? "the game screen has focus" : "focus is elsewhere");
    return stats;
  };

  try {
    // ---- landing ----
    phase = "landing";
    await navigate(rootBase);
    // Local cards use lazy previews. A featured card adds enough height that
    // the last image can sit outside Chrome's lazy-load distance, so visit
    // the bottom once before requiring every local preview to be decoded.
    await evaluate(`window.scrollTo(0, document.documentElement.scrollHeight)`);
    await waitFor("previews", `[...document.querySelectorAll(".game-card:not(.showcase-card) img")].every((i) => i.complete)`);
    await evaluate(`window.scrollTo(0, 0)`);
    const landing = await evaluate<{ cards: string[]; previews: number[]; links: string[] }>(`({
      // Showcase cards link projects hosted elsewhere; only this site's games count.
      cards: [...document.querySelectorAll(".game-card:not(.showcase-card) h2")].map((h) => h.textContent),
      previews: [...document.querySelectorAll(".game-card:not(.showcase-card) img")].map((i) => i.naturalWidth),
      links: [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")),
    })`);
    const games = (await Bun.file(join(SITE, "games.json")).json()) as {
      id: string; title: string; viewport: { policy: string }; rasterDensity: number;
    }[];
    expect(
      "landing: every game records a valid raster density",
      games.every((game) => Number.isInteger(game.rasterDensity) && game.rasterDensity >= 1 && game.rasterDensity <= 4),
      games.map((game) => `${game.id}=${game.rasterDensity}x`).join(", "),
    );
    expect("landing: one card per game", landing.cards.length === games.length, landing.cards.join(" | "));
    expect("landing: previews load", landing.previews.every((w) => w > 0), `widths ${landing.previews.join(", ")}`);
    const absolute = landing.links.filter((h) => h.startsWith("/"));
    expect("landing: relative links", absolute.length === 0, absolute.length ? absolute.join(", ") : `${landing.links.length} links`);
    await screenshot("landing", true);
    results.landing = landing;

    // ---- showcase: lobby -> two live halls -> lobby -----------------------
    if (games.some((g) => g.id === "showcase")) {
      await openGame(rootBase, "showcase");
      await checkRuns("showcase");
      const showcaseLoads = loadEvents;
      const showcaseErrors = consoleErrors.length;
      await installNoReloadSentinel();
      await clickElement('[data-demo-chapter="hall-streaming"]');
      await waitFor("showcase HTML chapter jump", `__rpgSessionState.mapId === "hall-streaming" &&
        __rpgSessionState.move.tx === 2 && __rpgSessionState.move.ty === 12 &&
        document.querySelector('[data-demo-chapter="hall-streaming"]').getAttribute("aria-current") === "true"`);
      const showcaseStable = await noReloadSentinel();
      const showcaseCurrent = await evaluate<string[]>(`[...document.querySelectorAll('[data-demo-chapter][aria-current="true"]')].map((button) => button.dataset.demoChapter)`);
      expect(
        "showcase: page chapter button jumps without reload",
        showcaseStable.stable && showcaseStable.advanced && loadEvents === showcaseLoads && showcaseCurrent.join() === "hall-streaming",
        `stable ${showcaseStable.stable}, frames advanced ${showcaseStable.advanced}, loads ${showcaseLoads} -> ${loadEvents}, current ${showcaseCurrent.join()}`,
      );
      expect(
        "showcase: page chapter jump has no console error",
        consoleErrors.length === showcaseErrors,
        `${consoleErrors.length - showcaseErrors} new error(s)`,
      );
      await screenshot("showcase-page-controls", true);

      // Reload once after the no-navigation assertion so the pre-existing
      // walk-through still starts in the authored lobby.
      await openGame(rootBase, "showcase");
      type ShowcasePosition = { mapId: string; tx: number; ty: number; moving: boolean; modal: string | null };
      const showcasePosition = () => evaluate<ShowcasePosition>(`(({ mapId, move, interp }) => ({
        mapId, tx: move.tx, ty: move.ty, moving: move.moving, modal: interp.modal?.kind ?? null,
      }))(__rpgSessionState)`);
      const walkShowcaseAxis = async (axis: "x" | "y", target: number, expectedMap: string) => {
        let state = await showcasePosition();
        const cell = axis === "x" ? "tx" : "ty";
        for (let guard = 0; guard < 40; guard++) {
          if (state.mapId !== expectedMap || (state[cell] === target && !state.moving)) return;
          const code = axis === "x"
            ? target > state.tx ? "ArrowRight" : "ArrowLeft"
            : target > state.ty ? "ArrowDown" : "ArrowUp";
          // Tap for one rendered frame, release, then let the committed tile
          // step finish. Holding while CDP polls can begin the next tile and
          // overshoot a one-cell portal on fast machines.
          await key("keyDown", code);
          await waitFrames(1);
          await key("keyUp", code);
          await waitFor("showcase tile boundary", `!__rpgSessionState.move.moving`, 3_000);
          state = await showcasePosition();
        }
        throw new Error(`showcase walk missed ${axis}=${target} on ${expectedMap}; at ${state.mapId}(${state.tx},${state.ty})`);
      };
      const walkShowcase = async (mapId: string, x: number, y: number, verticalFirst = false) => {
        if (verticalFirst) {
          await walkShowcaseAxis("y", y, mapId);
          if ((await showcasePosition()).mapId === mapId) await walkShowcaseAxis("x", x, mapId);
        } else {
          await walkShowcaseAxis("x", x, mapId);
          if ((await showcasePosition()).mapId === mapId) await walkShowcaseAxis("y", y, mapId);
        }
      };
      const pressShowcaseA = async () => {
        await holdKey("KeyA", 2);
        await waitFrames(2);
      };
      const finishShowcaseDemo = async () => {
        for (let guard = 0; guard < 80; guard++) {
          const status = await evaluate<{ idle: boolean; modal: string | null }>(`(({ interp, scene, fade, playerRoute }) => ({
            idle: interp.main === null && interp.modal === null && scene === null && fade === null && playerRoute === null,
            modal: interp.modal?.kind ?? null,
          }))(__rpgSessionState)`);
          if (status.idle) return;
          if (status.modal === "text") await pressShowcaseA();
          else await waitFrames(10);
        }
        throw new Error("showcase demonstration did not settle");
      };

      // Hall 1: top-left portal, then action at the centre curator. Wait for
      // the named tint so this proves the command ran, not merely the map.
      await walkShowcase("showcase-lobby", 2, 2);
      await waitFor("showcase hall 1", `__rpgSessionState.mapId === "showcase-screen-effects"`);
      await walkShowcase("showcase-screen-effects", 10, 8);
      await pressShowcaseA();
      for (let guard = 0; guard < 30; guard++) {
        if (await evaluate<boolean>(`!!__rpgSessionState.interp.screen?.tints?.["time-of-day"]`)) break;
        if ((await showcasePosition()).modal === "text") await pressShowcaseA();
        else await waitFrames(10);
      }
      const tint = await evaluate<boolean>(`!!__rpgSessionState.interp.screen?.tints?.["time-of-day"]`);
      expect("showcase: hall 1 demonstration runs", tint, `named time-of-day tint present: ${tint}`);
      await canvasShot("showcase-hall-1");
      await finishShowcaseDemo();
      await walkShowcase("showcase-screen-effects", 10, 12, true);
      await walkShowcase("showcase-screen-effects", 2, 12);
      await walkShowcaseAxis("y", 13, "showcase-screen-effects");
      await waitFor("showcase first return", `__rpgSessionState.mapId === "showcase-lobby"`);

      // Hall 8: bottom row's second portal. Its demo walks the player across
      // the streamed map and sets a completion switch after the live route.
      await walkShowcase("showcase-lobby", 5, 12);
      await waitFor("showcase hall 8", `__rpgSessionState.mapId === "hall-streaming"`);
      await walkShowcase("hall-streaming", 10, 8);
      await pressShowcaseA();
      await finishShowcaseDemo();
      const streamed = await evaluate<boolean>(`__rpgSessionState.sw.switches["showcase.streaming.complete"] === true`);
      expect("showcase: hall 8 demonstration runs", streamed, `streamed route completion switch: ${streamed}`);
      await canvasShot("showcase-hall-8");
      await walkShowcase("hall-streaming", 17, 12, true);
      await walkShowcase("hall-streaming", 2, 12);
      await walkShowcaseAxis("y", 13, "hall-streaming");
      await waitFor("showcase second return", `__rpgSessionState.mapId === "showcase-lobby"`);
      const returned = await showcasePosition();
      expect(
        "showcase: both hall exits return to the lobby",
        returned.mapId === "showcase-lobby",
        `returned to ${returned.mapId}(${returned.tx},${returned.ty})`,
      );
      await canvasShot("showcase-returned");
      await screenshot("showcase-returned");
      results.showcase = { tint, streamed, returned };
    }

    // ---- sunstone: attract, takeover, walk ----
    if (games.some((g) => g.id === "sunstone")) {
      await openGame(rootBase, "sunstone");
      await checkRuns("sunstone");
      const sunstoneLoads = loadEvents;
      const sunstoneErrors = consoleErrors.length;
      await installNoReloadSentinel();
      await clickElement('[data-demo-chapter="cave"]');
      await waitFor("sunstone HTML chapter jump", `__rpgSessionState.mapId === "cave" &&
        __rpgSessionState.move.tx === 9 && __rpgSessionState.move.ty === 11 &&
        __rpgSessionState.sw.switches["rune-lit"] === true &&
        __rpgSessionState.sw.items["thorn-key"] === 1 &&
        document.querySelector('[data-demo-chapter="cave"]').getAttribute("aria-current") === "true"`);

      // The in-game menu shares the same runtime. The HTML highlight must
      // follow a menu-driven Cave -> Forest jump, not just its own click.
      await evaluate(`document.getElementById("stage").focus()`);
      await holdKey("ShiftLeft", 2);
      await holdKey("ArrowUp", 2);
      await holdKey("KeyZ", 2);
      await waitFor("in-game chapter highlight", `__rpgSessionState.mapId === "forest" &&
        document.querySelector('[data-demo-chapter="forest"]').getAttribute("aria-current") === "true"`);

      const beforeFastFrame = await evaluate<number>("__rpgSessionState.frame");
      await clickElement('[data-demo-speed="4"]');
      await waitFor("4x page autoplay", `globalThis.__rpgkitDemo?.current().chapter === "forest" &&
        globalThis.__rpgkitDemo?.current().autoplay === true &&
        globalThis.__rpgkitDemo?.current().speed === 4 &&
        document.querySelector('[data-demo-speed="4"]').getAttribute("aria-pressed") === "true"`);
      await waitFrames(2);
      const afterFastFrame = await evaluate<number>("__rpgSessionState.frame");
      const sunstoneStable = await noReloadSentinel();
      const sunstoneCurrent = await evaluate<string[]>(`[...document.querySelectorAll('[data-demo-chapter][aria-current="true"]')].map((button) => button.dataset.demoChapter)`);
      expect(
        "sunstone: page controls and in-game menu stay synchronized without reload",
        sunstoneStable.stable && sunstoneStable.advanced && loadEvents === sunstoneLoads && sunstoneCurrent.join() === "forest",
        `stable ${sunstoneStable.stable}, frames advanced ${sunstoneStable.advanced}, loads ${sunstoneLoads} -> ${loadEvents}, current ${sunstoneCurrent.join()}`,
      );
      expect(
        "sunstone: 4x page autoplay advances the chapter tape",
        afterFastFrame - beforeFastFrame >= 4,
        `reducer frame ${beforeFastFrame} -> ${afterFastFrame}`,
      );
      expect(
        "sunstone: page demo controls have no console error",
        consoleErrors.length === sunstoneErrors,
        `${consoleErrors.length - sunstoneErrors} new error(s)`,
      );
      await screenshot("sunstone-page-controls", true);

      // Progressive enhancement: without a guest hook, the same anchor
      // performs its documented query reload and the new game consumes it.
      const fallbackLoads = loadEvents;
      await evaluate(`globalThis.__rpgkitDemo = undefined`);
      await clickElement('[data-demo-chapter="village"]');
      await waitFor("chapter link reload fallback", `location.search === "?chapter=village" &&
        globalThis.__pocketPlayer?.state === "running" && __rpgSessionState?.mapId === "village" &&
        globalThis.__rpgkitDemo?.current().chapter === "village"`);
      const fallbackHref = await evaluate<string>("location.href");
      expect(
        "sunstone: missing hook falls back to a chapter reload",
        loadEvents > fallbackLoads,
        `loads ${fallbackLoads} -> ${loadEvents}, ${fallbackHref}`,
      );

      // Start the original attract/takeover checks from a fresh default URL.
      await openGame(rootBase, "sunstone");
      await canvasShot("sunstone-start");
      const pos = () =>
        evaluate<{ px: number; py: number; mapId: string; modal: boolean }>(
          `(({ move, mapId, interp }) => ({ px: move.px, py: move.py, mapId, modal: !!interp.modal }))(__rpgSessionState)`);
      // 10 idle seconds (600 frames) start the demo from a clean world.
      await waitFor("10 idle seconds", "__pocketPlayer.frames > 610", 30_000);
      const a0 = await pos();
      const trail: string[] = [];
      let demoWalks = false;
      for (let i = 0; i < 15 && !demoWalks; i++) {
        await waitFrames(10);
        const a = await pos();
        trail.push(`${a.px},${a.py}`);
        demoWalks = a.px !== a0.px || a.py !== a0.py || a.mapId !== a0.mapId;
      }
      await canvasShot("sunstone-attract");
      await screenshot("sunstone-attract");
      expect("sunstone: attract mode after 10 idle seconds", demoWalks, `no input; the player walks ${a0.px},${a0.py} -> ${trail.join(" -> ")}`);
      // Any key takes over on the current frame.
      await holdKey("KeyZ", 2);
      await waitFrames(10);
      await canvasShot("sunstone-takeover");
      await screenshot("sunstone-takeover");
      // Close a dialog the demo may have left open with the A key: the
      // game prompts "A next" (CIRCLE in the web-app glyph set).
      let presses = 0;
      while ((await pos()).modal && presses < 12) {
        await holdKey("KeyA", 2);
        await waitFrames(40);
        presses++;
      }
      const t0 = await pos();
      await waitFrames(60);
      const t1 = await pos();
      expect(
        "sunstone: a key takes over (the demo stops)",
        !t1.modal && t0.px === t1.px && t0.py === t1.py,
        `after ${presses} A press(es) the dialog is ${t1.modal ? "open" : "closed"}; idle: ${t0.px},${t0.py} -> ${t1.px},${t1.py}`,
      );
      const moves: string[] = [];
      let right = 0;
      let wrong = 0;
      for (const dir of ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"]) {
        const before = await pos();
        await holdKey(dir, 40);
        await waitFrames(20);
        const after = await pos();
        moves.push(`${dir}: ${before.px},${before.py} -> ${after.px},${after.py}`);
        const dx = after.px - before.px;
        const dy = after.py - before.py;
        const want = { ArrowDown: [0, 1], ArrowUp: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[dir]!;
        if (Math.sign(dx) === want[0] && Math.sign(dy) === want[1]) right++;
        else if (dx !== 0 || dy !== 0) wrong++;
      }
      expect("sunstone: arrows walk the player", right >= 2 && wrong === 0, moves.join("; "));
      await canvasShot("sunstone-walk");
      await screenshot("sunstone-walk");
      results.sunstone = { moves };

      // ---- focus ----
      phase = "focus";
      const hint = async () => evaluate<boolean>(`!document.getElementById("focus-hint").hidden`);
      const heading = await toClientOf("#controls-heading");
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: heading.x, y: heading.y, button: "left", buttons: 1, clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: heading.x, y: heading.y, button: "left", buttons: 0, clickCount: 1 });
      await sleep(100);
      const blurred = await evaluate<boolean>(`document.activeElement !== document.getElementById("stage")`);
      expect("focus: clicking outside the game shows the hint", blurred && (await hint()), `hint visible: ${await hint()}`);
      await key("keyDown", "ArrowRight");
      await waitFrames(5);
      const maskUnfocused = await evaluate<number>("__pocketPlayer.buttons()");
      await key("keyUp", "ArrowRight");
      expect("focus: keys do not reach an unfocused game", maskUnfocused === 0, `button mask while → is down: ${maskUnfocused}`);
      await screenshot("focus-hint");
      const center = await toClient(240, 136);
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: center.x, y: center.y, button: "left", buttons: 1, clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: center.x, y: center.y, button: "left", buttons: 0, clickCount: 1 });
      await sleep(100);
      const refocused = await evaluate<boolean>(`document.activeElement === document.getElementById("stage")`);
      await key("keyDown", "ArrowRight");
      await waitFrames(2);
      const maskFocused = await evaluate<number>("__pocketPlayer.buttons()");
      await key("keyUp", "ArrowRight");
      expect(
        "focus: clicking the game gives it the keys again",
        refocused && !(await hint()) && maskFocused === 0x0020,
        `stage focused: ${refocused}; button mask while → is down: 0x${maskFocused.toString(16)}`,
      );
    }

    // ---- grow: growth, mouse drag, touch drag, keys ----
    if (games.some((g) => g.id === "grow")) {
      await openGame(rootBase, "grow");
      await checkRuns("grow");
      const grow = () => evaluate<{ tick: number; total: number; auto: boolean; mode: string }>(`(({ tick, total, auto, mode }) => ({ tick, total, auto, mode }))(__rpgGrowState)`);
      const g0 = await grow();
      await waitFrames(150);
      const g1 = await grow();
      expect("grow: grows on its own", g1.tick > g0.tick, `tick ${g0.tick} -> ${g1.tick} of ${g1.total}`);
      await canvasShot("grow-growing");
      await screenshot("grow-growing");
      // Mouse: press on the strip at 10%, drag to 60%, release.
      const view = await evaluate<{ w: number; h: number }>("({ w: __pocketPlayer.width, h: __pocketPlayer.height })");
      const stripY = view.h - 8;
      const at = (f: number) => Math.round(view.w * f);
      const from = await toClient(at(0.1), stripY);
      const to = await toClient(at(0.6), stripY);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y, button: "none", buttons: 0 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
      await waitFrames(3);
      const m0 = await grow();
      for (let i = 1; i <= 10; i++) {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + ((to.x - from.x) * i) / 10, y: from.y, button: "left", buttons: 1 });
        await waitFrames(1);
      }
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
      await waitFrames(3);
      const m1 = await grow();
      const gw = await evaluate<number>("__pocketPlayer.width");
      const want = (x: number, total: number) => Math.round((x / gw) * total);
      expect("grow: mouse press on the timeline seeks", Math.abs(m0.tick - want(at(0.1), m0.total)) <= 1, `tick ${m0.tick}, expected ~${want(at(0.1), m0.total)}`);
      expect("grow: mouse drag scrubs the timeline", Math.abs(m1.tick - want(at(0.6), m1.total)) <= 1, `tick ${m1.tick}, expected ~${want(at(0.6), m1.total)}`);
      await canvasShot("grow-mouse-scrub");
      await screenshot("grow-mouse-scrub");
      // Touch: a finger on the strip at 25%, sliding to 40%.
      const t0 = await toClient(at(0.25), stripY);
      const t1 = await toClient(at(0.4), stripY);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: t0.x, y: t0.y, id: 1 }] });
      await waitFrames(3);
      const f0 = await grow();
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: t1.x, y: t1.y, id: 1 }] });
      await waitFrames(3);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await waitFrames(3);
      const f1 = await grow();
      expect("grow: touch on the timeline seeks", Math.abs(f0.tick - want(at(0.25), f0.total)) <= 1, `tick ${f0.tick}, expected ~${want(at(0.25), f0.total)}`);
      expect("grow: touch drag scrubs the timeline", Math.abs(f1.tick - want(at(0.4), f1.total)) <= 1, `tick ${f1.tick}, expected ~${want(at(0.4), f1.total)}`);
      await holdKey("ArrowLeft", 2);
      await waitFrames(3);
      const k1 = await grow();
      expect("grow: ← steps one tick back", k1.tick === f1.tick - 1, `tick ${f1.tick} -> ${k1.tick}`);
      await canvasShot("grow-touch-scrub");
      // Live viewport: a smaller window runs a smaller logical viewport, and
      // the core's viewport fact follows the canvas.
      const viewNow = () => evaluate<{ w: number; h: number; vw: number; vh: number }>(
        `({ w: __pocketPlayer.width, h: __pocketPlayer.height, vw: ui.__viewport.w, vh: ui.__viewport.h })`);
      const v0 = await viewNow();
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
      await waitFor("grow resize", `__pocketPlayer.width !== ${v0.w}`, 5_000);
      await waitFrames(30);
      const v1 = await viewNow();
      const resized = await canvasStats();
      expect(
        "grow: the dynamic viewport follows the window",
        v1.w !== v0.w && v1.vw === v1.w && v1.vh === v1.h && resized.nonBlack > 0.3,
        `${v0.w}x${v0.h} -> ${v1.w}x${v1.h} (core ${v1.vw}x${v1.vh}), ${(resized.nonBlack * 100).toFixed(1)}% non-black`,
      );
      await canvasShot("grow-resized");
      await screenshot("grow-resized");
      await cdp.send("Emulation.clearDeviceMetricsOverride");
      results.grow = { g0, g1, m0, m1, f0, f1, k1, v0, v1 };
    }

    // ---- meadow: walk ----
    if (games.some((g) => g.id === "meadow")) {
      await openGame(rootBase, "meadow");
      await checkRuns("meadow");
      const pos = () => evaluate<{ px: number; py: number }>(`(({ move }) => ({ px: move.px, py: move.py }))(__rpgkitExample.state())`);
      const p0 = await pos();
      await holdKey("ArrowUp", 30);
      await waitFrames(20);
      const p1 = await pos();
      await holdKey("ArrowRight", 40);
      await waitFrames(20);
      const p2 = await pos();
      expect("meadow: ↑ walks up", p1.py < p0.py && p1.px === p0.px, `${p0.px},${p0.py} -> ${p1.px},${p1.py}`);
      expect("meadow: → walks right", p2.px > p1.px && p2.py === p1.py, `${p1.px},${p1.py} -> ${p2.px},${p2.py}`);
      await canvasShot("meadow-walk");
      await screenshot("meadow-walk");
      results.meadow = { p0, p1, p2 };
    }

    // ---- sizing at 2x and on a phone ----
    phase = "sizing";
    const first = games[0]!.id;
    const byPolicy = new Map<string, string>();
    for (const game of games) if (!byPolicy.has(game.viewport.policy)) byPolicy.set(game.viewport.policy, game.id);
    for (const [policy, id] of byPolicy) {
      for (const dpr of [2, 1.25]) {
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: dpr, mobile: false });
        await openGame(rootBase, id);
        const fit = await wholePixels(dpr);
        expect(`sizing: ${policy} ${id} at ${dpr}x uses whole device pixels`, fit.ok, fit.text);
      }
    }
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await openGame(rootBase, first);
    await sleep(300);
    const phone = await evaluate<{ pad: boolean; width: number }>(`({ pad: getComputedStyle(document.querySelector(".pad")).display !== "none", width: document.getElementById("stage").getBoundingClientRect().width })`);
    expect("sizing: the phone layout fits and shows touch buttons", phone.pad && phone.width <= 390, `pad ${phone.pad}, screen ${phone.width.toFixed(1)}px wide`);
    await screenshot("phone");
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await cdp.send("Emulation.clearDeviceMetricsOverride");

    // ---- subpath ----
    phase = "subpath";
    const before = requests.length;
    await navigate(subBase);
    await evaluate(`window.scrollTo(0, document.documentElement.scrollHeight)`);
    await waitFor("subpath previews", `[...document.querySelectorAll(".game-card:not(.showcase-card) img")].every((i) => i.complete && i.naturalWidth > 0)`);
    await evaluate(`window.scrollTo(0, 0)`);
    for (const game of games) {
      await openGame(subBase, game.id);
      const f0 = await frames();
      await sleep(500);
      const f1 = await frames();
      const stats = await canvasStats();
      const state = await evaluate<string>("__pocketPlayer.state");
      expect(
        `subpath: ${game.id} runs under ${PREFIX}`,
        state === "running" && f1 > f0,
        `${state}, frames ${f0} -> ${f1}, ${(stats.nonBlack * 100).toFixed(1)}% non-black`,
      );
    }
    await screenshot("subpath-last-game");
    const outside = requests.slice(before).filter((r) => r.status === 404);
    expect("subpath: every request stays under the prefix", outside.length === 0, outside.length ? outside.map((r) => r.url).join(", ") : `${requests.length - before} requests`);
  } catch (error) {
    failures.push({ check: phase, message: error instanceof Error ? error.message : String(error) });
    console.log(`  FAIL ${phase}: ${error instanceof Error ? error.message : error}`);
    await screenshot(`error-${phase}`).catch(() => {});
  } finally {
    const bad = requests.filter((r) => r.status >= 400);
    expect("network: no failed requests", bad.length === 0, bad.length ? bad.map((r) => `${r.status} ${r.url}`).join(", ") : `${requests.length} requests`);
    expect("console: no errors", consoleErrors.length === 0, consoleErrors.length ? consoleErrors.join("\n") : "clean");
    await Bun.write(join(OUT, "report.json"), JSON.stringify({ failures, results, consoleErrors, requests }, null, 2) + "\n");
    cdp.close();
    chrome.proc.kill();
    await chrome.proc.exited;
    rootServer.stop(true);
    subServer.stop(true);
    rmSync(profile, { recursive: true, force: true });
  }

  async function toClientOf(selector: string) {
    return evaluate<{ x: number; y: number }>(`(() => {
      const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
  }
}

await main();
console.log(`\nweb-verify: ${failures.length === 0 ? "PASS" : `FAIL (${failures.length})`}; screenshots and report.json in ${OUT}`);
process.exit(failures.length === 0 ? 0 : 1);
