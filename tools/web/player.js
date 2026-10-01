// tools/web/player.js — runs one PocketJS app bundle on a player page.
//
// tools/web.ts bundles this file, together with the vendored wasm binding
// (hosts/web/wasm-ops.js) and the touch wire helpers
// (framework/src/touch.ts), into dist/web/player.js. A player page keeps
// its settings as JSON in <script id="pocket-game">. Every URL in it is
// relative to the page, so the site also works under a subpath such as
// /pocket-rpgkit/.
//
// The loop is PocketJS's browser dev host (hosts/web/engine.js), cut down
// to one fixed app:
//   boot     createWasmUi(viewport, density). globalThis.ui is the core's
//            HostOps and globalThis.__pak is the pak; the bundle is
//            evaluated in a fresh function scope and installs
//            globalThis.frame.
//   clock    fixed 60 Hz steps on requestAnimationFrame. Elapsed time is
//            clamped to 250 ms and one animation frame runs at most 4 steps.
//   step     frame(buttons, analog, touches, hits), then one core tick. The
//            canvas is repainted once per animation frame that stepped.
// Sizing: fit.ts picks the logical viewport and a whole number of device
// pixels per game pixel that is divisible by rasterDensity. The canvas owns
// density physical samples per logical pixel, so neither high-density text
// nor nearest-neighbour pixel art lands between device pixels. A fixed
// viewport keeps its size; a dynamic one follows the page. A new logical
// size goes to the core first, then to the app's resize hook, as the desktop
// host and hosts/sim do.
// Input:
//   keys     the page's key table (keys.ts KEYMAP plus the game's changes)
//            -> the held button mask, while the game screen has focus. It
//            takes focus on load and when clicked.
//   mouse    service lines {t:"mouse",x,y,d[,b],sh} read through
//            ui.svcPoll, the form the desktop host and
//            hosts/web/system-engine.js send. ui.svcOpen(name) is true for
//            the plan's companions.
//   touch    per-frame touch contacts (frame arguments 3 and 4, with hit
//            facts), as site/playground/embed.js sends them. The primary
//            touch also sends mouse lines, the way a browser derives
//            compatibility mouse events from it, so an app that only reads
//            the mouse (Alpine Post's click-to-walk) answers a tap.
//   pad      the on-screen buttons, for devices without a keyboard.

import { createWasmUi } from "../../vendor/pocketjs/hosts/web/wasm-ops.js";
import {
  __packTouch,
  __packTouchWide,
  createTouchHitFacts,
} from "../../vendor/pocketjs/framework/src/touch.ts";
import { rpgkitBootFromSearch } from "./boot.ts";
import { fitViewport } from "./fit.ts";
import { BTN } from "./keys.ts";

const STEP_MS = 1000 / 60;
const MAX_ELAPSED_MS = 250;
const MAX_CATCH_UP = 4;
/** spec ANALOG_CENTER on both axes: no nub on this host. */
const ANALOG_CENTER = 0x8080;
/** framework/src/touch.ts caps a frame at 8 live contacts. */
const MAX_CONTACTS = 8;
/** The wide touch wire form carries 10 bits per axis. */
const TOUCH_LIMIT = 1024;
/** Mouse lines kept for an app that does not poll every frame. */
const SVC_LIMIT = 256;
/** Room under the screen for the caption line. */
const RESERVE_PX = 56;

const $ = (id) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`player page has no #${id}`);
  return element;
};

/**
 * Pointer ids -> touch contacts. The guest reads a level snapshot every
 * frame, so the pool holds contacts rather than events and every step packs
 * the whole table (the shape of site/playground/embed.js). A release waits
 * until the contact has been sent at least once, so a tap shorter than one
 * step still reaches the app.
 */
class ContactPool {
  constructor() {
    this.slots = new Array(MAX_CONTACTS).fill(null);
    this.bySource = new Map();
    this.wide = false;
  }

  resize(width, height) {
    this.wide = width > 512 || height > 512;
  }

  down(pointerId, x, y) {
    if (this.bySource.has(pointerId)) return this.move(pointerId, x, y);
    const slot = this.slots.indexOf(null);
    if (slot < 0) return false;
    this.slots[slot] = { x, y, sent: 0, lifted: false };
    this.bySource.set(pointerId, slot);
    return true;
  }

  move(pointerId, x, y) {
    const slot = this.bySource.get(pointerId);
    if (slot === undefined) return false;
    const contact = this.slots[slot];
    if (contact.lifted) return false;
    contact.x = x;
    contact.y = y;
    return true;
  }

  up(pointerId, x, y) {
    const slot = this.bySource.get(pointerId);
    if (slot === undefined) return false;
    this.bySource.delete(pointerId);
    const contact = this.slots[slot];
    if (typeof x === "number") {
      contact.x = x;
      contact.y = y;
    }
    contact.lifted = true;
    return true;
  }

  clear() {
    this.slots.fill(null);
    this.bySource.clear();
  }

  pack() {
    const packed = [];
    for (let slot = 0; slot < MAX_CONTACTS; slot++) {
      const contact = this.slots[slot];
      if (!contact) continue;
      const x = Math.min(contact.x, TOUCH_LIMIT - 1);
      const y = Math.min(contact.y, TOUCH_LIMIT - 1);
      packed.push(this.wide ? __packTouchWide(slot, x, y) : __packTouch(slot, x, y));
      contact.sent++;
    }
    for (let slot = 0; slot < MAX_CONTACTS; slot++) {
      const contact = this.slots[slot];
      if (contact && contact.lifted && contact.sent > 0) this.slots[slot] = null;
    }
    return packed.length > 0 ? packed : undefined;
  }
}

async function fetchOk(url, what) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${what} could not be loaded (${response.status} ${url})`);
  return response;
}

class Player {
  constructor(config) {
    this.config = config;
    this.stage = $("stage");
    this.canvas = $("screen");
    this.overlay = $("overlay");
    this.message = $("overlay-message");
    this.hint = $("focus-hint");
    this.context = this.canvas.getContext("2d");
    this.pool = new ContactPool();
    this.width = 0;
    this.height = 0;
    this.image = null;
    this.companions = new Set(config.companions ?? []);
    this.svc = [];
    this.keyMasks = config.keys;
    this.keys = new Map();
    this.pad = new Map();
    this.mouseDown = false;
    this.lastMouse = null;
    this.frameFn = null;
    this.wasm = null;
    this.hitFacts = null;
    this.state = "loading";
    this.running = false;
    this.raf = 0;
    this.last = 0;
    this.acc = 0;
    this.frames = 0;
    this.scale = { device: 1, css: 1 };
    this.tick = this.tick.bind(this);
  }

  setState(state, message = "") {
    this.state = state;
    this.stage.dataset.state = state;
    this.message.textContent = message;
    this.overlay.hidden = state === "running";
    this.updateHint();
  }

  // ---- boot ---------------------------------------------------------------

  bindInput() {
    this.bindKeys();
    this.bindPointer();
    this.bindPad();
    this.bindDemoControls();
  }

  async boot() {
    const { config } = this;
    const base = document.baseURI;
    const [wasmBytes, pak, source] = await Promise.all([
      fetchOk(new URL(config.wasm, base), "The PocketJS core").then((r) => r.arrayBuffer()),
      config.pak ? fetchOk(new URL(config.pak, base), "The asset pack").then((r) => r.arrayBuffer()) : undefined,
      fetchOk(new URL(config.bundle, base), "The game bundle").then((r) => r.text()),
    ]);
    this.fit();
    this.wasm = await createWasmUi(wasmBytes, {
      width: this.width,
      height: this.height,
      rasterDensity: config.rasterDensity ?? 1,
    });
    const ops = this.wasm.ops;
    ops.svcOpen = (name) => this.companions.has(name);
    ops.svcPoll = () => (this.svc.length > 0 ? `${this.svc.splice(0).join("\n")}\n` : null);
    ops.svcSend = (line) => this.onServiceLine(line);
    // The host contract (engine.js load()): every global before the eval.
    globalThis.ui = ops;
    globalThis.__pak = pak;
    globalThis.__simHz = config.simHz ?? 60;
    globalThis.__pocketApp = config.app;
    globalThis.__rpgkitBoot = rpgkitBootFromSearch(location.search);
    globalThis.__rpgkitDemo = undefined;
    globalThis.frame = undefined;
    new Function(`${source}\n//# sourceURL=${config.app}.js`)();
    if (typeof globalThis.frame !== "function") {
      throw new Error(`${config.app}.js ran but did not install frame()`);
    }
    this.frameFn = globalThis.frame;
    this.hitFacts = createTouchHitFacts((x, y) => {
      const query = ops.hitTestBounds ?? ops.hitTest;
      return query ? query(x, y) : 0;
    });
    this.step();
    this.paint();
    this.setState("running");
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.pause();
      else this.resume();
    });
    this.resume();
    this.focus();
  }

  fail(error) {
    this.pause();
    this.frameFn = null;
    console.error(`${this.config.app}:`, error);
    const text = error && error.message ? error.message : String(error);
    this.setState("error", `The game stopped: ${text}`);
    $("overlay-reload").hidden = false;
  }

  // ---- clock --------------------------------------------------------------

  resume() {
    if (this.running || this.state !== "running") return;
    this.running = true;
    this.last = performance.now();
    this.acc = 0;
    this.raf = requestAnimationFrame(this.tick);
  }

  pause() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.releaseAll();
  }

  tick(now) {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.tick);
    this.acc += Math.min(MAX_ELAPSED_MS, now - this.last);
    this.last = now;
    let steps = 0;
    try {
      while (this.acc >= STEP_MS && steps < MAX_CATCH_UP) {
        this.step();
        this.acc -= STEP_MS;
        steps++;
      }
      // A slow machine runs at most MAX_CATCH_UP steps per animation frame;
      // drop the rest instead of carrying a growing debt.
      if (this.acc > STEP_MS * MAX_CATCH_UP) this.acc = 0;
      if (steps > 0) this.paint();
    } catch (error) {
      this.fail(error);
    }
  }

  buttons() {
    let mask = 0;
    for (const bit of this.keys.values()) mask |= bit;
    for (const bit of this.pad.values()) mask |= bit;
    return mask;
  }

  step() {
    const packed = this.pool.pack();
    const hits = this.hitFacts(packed);
    this.frameFn(this.buttons(), ANALOG_CENTER, packed, hits);
    this.wasm.tick();
    this.frames++;
    this.syncDemoControls();
  }

  paint() {
    this.image.data.set(this.wasm.renderScaledIncremental(this.config.rasterDensity ?? 1));
    this.context.putImageData(this.image, 0, 0);
  }

  onServiceLine(line) {
    // Apps talk to their host over the same mailbox. The only line a page
    // can act on is the cursor shape (hosts/web/system-engine.js).
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message && message.t === "cursor" && typeof message.k === "string") {
      this.canvas.style.cursor = message.k;
    }
  }

  // ---- focus and keyboard -------------------------------------------------

  focus() {
    this.stage.focus({ preventScroll: true });
    this.updateHint();
  }

  updateHint() {
    const focused = document.activeElement === this.stage;
    this.hint.hidden = focused || this.state !== "running";
    this.stage.dataset.focused = focused ? "true" : "false";
  }

  releaseAll() {
    this.keys.clear();
    this.pad.clear();
    for (const button of document.querySelectorAll("[data-button].held")) button.classList.remove("held");
    if (this.mouseDown) {
      this.mouseDown = false;
      this.pushMouse({ t: "mouse", x: null, y: null, d: false });
    }
    this.pool.clear();
  }

  bindKeys() {
    const stage = this.stage;
    stage.addEventListener("keydown", (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const bit = Object.hasOwn(this.keyMasks, event.code) ? this.keyMasks[event.code] : undefined;
      if (bit === undefined) return;
      event.preventDefault();
      this.keys.set(event.code, bit);
    });
    stage.addEventListener("keyup", (event) => {
      if (!this.keys.has(event.code)) return;
      event.preventDefault();
      this.keys.delete(event.code);
    });
    stage.addEventListener("focus", () => this.updateHint());
    stage.addEventListener("blur", () => {
      this.keys.clear();
      this.updateHint();
    });
    window.addEventListener("blur", () => this.releaseAll());
  }

  // ---- pointer ------------------------------------------------------------

  /** Client coordinates -> logical pixels, clamped to the viewport. */
  logical(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.floor(((event.clientX - rect.left) * this.width) / (rect.width || 1));
    const y = Math.floor(((event.clientY - rect.top) * this.height) / (rect.height || 1));
    return {
      x: Math.max(0, Math.min(this.width - 1, x)),
      y: Math.max(0, Math.min(this.height - 1, y)),
    };
  }

  pushMouse(message) {
    this.svc.push(JSON.stringify(message));
    if (this.svc.length > SVC_LIMIT) this.svc.splice(0, this.svc.length - SVC_LIMIT);
  }

  bindPointer() {
    const canvas = this.canvas;
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    canvas.addEventListener("pointerdown", (event) => {
      this.focus();
      if (this.state !== "running") return;
      const point = this.logical(event);
      if (event.pointerType === "mouse") {
        if (event.button !== 0 && event.button !== 2) return;
        if (event.button === 0) this.mouseDown = true;
        this.lastMouse = point;
        this.pushMouse({ t: "mouse", x: point.x, y: point.y, d: true, b: event.button, sh: event.shiftKey });
      } else {
        if (!this.pool.down(event.pointerId, point.x, point.y)) return;
        if (event.isPrimary) this.pushMouse({ t: "mouse", x: point.x, y: point.y, d: true, b: 0, sh: false });
      }
      event.preventDefault();
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic events have no active pointer to capture.
      }
    });
    canvas.addEventListener("pointermove", (event) => {
      if (this.state !== "running") return;
      const point = this.logical(event);
      if (event.pointerType === "mouse") {
        const last = this.lastMouse;
        if (last && last.x === point.x && last.y === point.y) return;
        this.lastMouse = point;
        this.pushMouse({ t: "mouse", x: point.x, y: point.y, d: this.mouseDown, sh: event.shiftKey });
      } else if (this.pool.move(event.pointerId, point.x, point.y)) {
        event.preventDefault();
        if (event.isPrimary) this.pushMouse({ t: "mouse", x: point.x, y: point.y, d: true, sh: false });
      }
    });
    const up = (event) => {
      if (this.state !== "running") return;
      const point = this.logical(event);
      if (event.pointerType === "mouse") {
        if (event.button !== 0 && event.button !== 2) return;
        if (event.button === 0) {
          if (!this.mouseDown) return;
          this.mouseDown = false;
        }
        this.lastMouse = point;
        this.pushMouse({ t: "mouse", x: point.x, y: point.y, d: false, b: event.button, sh: event.shiftKey });
      } else if (this.pool.up(event.pointerId, point.x, point.y) && event.isPrimary) {
        this.pushMouse({ t: "mouse", x: point.x, y: point.y, d: false, b: 0, sh: false });
      }
    };
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", (event) => {
      if (event.pointerType === "mouse") up(event);
      else if (this.pool.up(event.pointerId) && event.isPrimary) this.pushMouse({ t: "mouse", x: null, y: null, d: false });
    });
  }

  // ---- on-screen buttons --------------------------------------------------

  bindPad() {
    for (const element of document.querySelectorAll("[data-button]")) {
      const bit = BTN[element.dataset.button];
      if (bit === undefined) continue;
      const release = (event) => {
        if (!this.pad.delete(event.pointerId)) return;
        element.classList.remove("held");
      };
      element.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        this.pad.set(event.pointerId, bit);
        element.classList.add("held");
        try {
          element.setPointerCapture(event.pointerId);
        } catch {
          // Synthetic events have no active pointer to capture.
        }
      });
      element.addEventListener("pointerup", release);
      element.addEventListener("pointercancel", release);
      element.addEventListener("lostpointercapture", release);
      element.addEventListener("contextmenu", (event) => event.preventDefault());
    }
  }

  // ---- HTML demo controls ------------------------------------------------

  demoHook() {
    const hook = globalThis.__rpgkitDemo;
    return hook && typeof hook.jump === "function" && typeof hook.autoplay === "function" && typeof hook.current === "function"
      ? hook
      : null;
  }

  replaceDemoQuery(values) {
    const url = new URL(location.href);
    url.search = "";
    for (const [key, value] of Object.entries(values)) url.searchParams.set(key, String(value));
    history.replaceState(history.state, "", url);
  }

  syncDemoControls() {
    const root = document.querySelector("[data-demo-controls]");
    if (!root) return;
    const hook = this.demoHook();
    let current = null;
    if (hook) {
      try {
        current = hook.current();
      } catch {
        current = null;
      }
    }
    const boot = rpgkitBootFromSearch(location.search);
    const chapter = typeof current?.chapter === "string"
      ? current.chapter
      : typeof boot.chapter === "string"
        ? boot.chapter
        : typeof boot.autoplay === "string" ? boot.autoplay : null;
    const speed = current?.speed ?? (boot.speed === "2" ? 2 : boot.speed === "4" ? 4 : 1);
    root.dataset.hook = hook ? "ready" : "fallback";
    root.dataset.chapter = chapter ?? "";
    root.dataset.speed = String(speed);
    for (const button of root.querySelectorAll("[data-demo-chapter]")) {
      const active = button.dataset.demoChapter === chapter;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
      if (active) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    }
    const activeChapter = root.querySelector(`[data-demo-chapter="${CSS.escape(chapter ?? "")}"][data-demo-autoplay="true"]`);
    const fallbackChapter = activeChapter?.dataset.demoChapter ?? root.querySelector('[data-demo-chapter][data-demo-autoplay="true"]')?.dataset.demoChapter;
    for (const button of root.querySelectorAll("[data-demo-speed]")) {
      const active = Number(button.dataset.demoSpeed) === speed;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
      if (fallbackChapter) {
        button.href = `?${new URLSearchParams({ autoplay: fallbackChapter, speed: button.dataset.demoSpeed })}`;
      }
    }
  }

  bindDemoControls() {
    const root = document.querySelector("[data-demo-controls]");
    if (!root) return;
    for (const button of root.querySelectorAll("[data-demo-chapter]")) {
      button.addEventListener("click", (event) => {
        const hook = this.demoHook();
        if (!hook) return;
        event.preventDefault();
        const id = button.dataset.demoChapter;
        hook.jump(id);
        this.replaceDemoQuery({ chapter: id });
        this.syncDemoControls();
      });
    }
    for (const button of root.querySelectorAll("[data-demo-speed]")) {
      button.addEventListener("click", (event) => {
        const hook = this.demoHook();
        if (!hook) return;
        const current = hook.current();
        const currentButton = current.chapter
          ? root.querySelector(`[data-demo-chapter="${CSS.escape(current.chapter)}"][data-demo-autoplay="true"]`)
          : null;
        const id = currentButton?.dataset.demoChapter ?? root.querySelector('[data-demo-chapter][data-demo-autoplay="true"]')?.dataset.demoChapter;
        if (!id) return;
        event.preventDefault();
        const speed = Number(button.dataset.demoSpeed);
        hook.autoplay(id, speed);
        this.replaceDemoQuery({ autoplay: id, speed });
        this.syncDemoControls();
      });
    }
    this.syncDemoControls();
  }

  // ---- sizing -------------------------------------------------------------

  fit() {
    const dpr = window.devicePixelRatio || 1;
    const area = this.stage.parentElement;
    // clientWidth includes the area's side padding; the stage gets the rest.
    const style = getComputedStyle(area);
    const areaWidth = area.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const top = this.stage.getBoundingClientRect().top + window.scrollY;
    const areaHeight = Math.max(window.innerHeight - top - RESERVE_PX, window.innerHeight * 0.5);
    const density = this.config.rasterDensity ?? 1;
    const { size, k } = fitViewport(this.config.viewport, areaWidth, areaHeight, dpr, density);
    const [w, h] = size;
    const cssWidth = k >= 1 ? (w * k) / dpr : Math.min(areaWidth, (areaHeight * w) / h);
    this.stage.style.width = `${cssWidth}px`;
    this.stage.style.height = `${(cssWidth * h) / w}px`;
    this.stage.style.aspectRatio = `${w} / ${h}`;
    this.scale = { device: k, raster: k > 0 ? k / density : 0, css: cssWidth / w };
    this.stage.dataset.scale = String(k);
    this.stage.dataset.density = String(density);
    if (w !== this.width || h !== this.height) this.resize(w, h);
  }

  /** A new logical size: canvas, touch wire, and (once booted) core and app. */
  resize(width, height) {
    this.width = width;
    this.height = height;
    const density = this.config.rasterDensity ?? 1;
    this.canvas.width = width * density;
    this.canvas.height = height * density;
    this.context.imageSmoothingEnabled = false;
    this.image = this.context.createImageData(width * density, height * density);
    this.pool.resize(width, height);
    this.pool.clear();
    this.stage.dataset.logical = `${width}x${height}`;
    if (!this.wasm) return;
    // Core first, app hook second, so hostViewport() already reads the new
    // size when the app reacts (hosts/desktop, hosts/sim).
    this.wasm.resizeViewport(width, height);
    if (typeof globalThis.__pocketResizeViewport === "function") globalThis.__pocketResizeViewport(width, height);
    if (this.state === "running") this.paint();
  }

  bindSizing() {
    const refit = () => {
      try {
        this.fit();
      } catch (error) {
        this.fail(error);
      }
    };
    refit();
    window.addEventListener("resize", refit);
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(refit).observe(this.stage.parentElement);
    const watchDensity = () => {
      const query = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      query.addEventListener("change", () => {
        refit();
        watchDensity();
      }, { once: true });
    };
    watchDensity();
  }
}

const player = new Player(JSON.parse($("pocket-game").textContent));
// Read by tools/web-verify.ts.
globalThis.__pocketPlayer = player;
$("overlay-reload").addEventListener("click", () => location.reload());
player.bindSizing();
player.bindInput();
if (location.protocol === "file:") {
  player.setState("error", "Open this page through a web server; browsers do not load WebAssembly from file:// pages.");
} else {
  player.setState("loading", "Loading…");
  player.boot().catch((error) => player.fail(error));
}
