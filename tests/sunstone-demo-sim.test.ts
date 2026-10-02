// Demo controls through the built Sunstone bundle: the overlay owns input
// without folding the reducer, menu warp is immediate, and host-provided web
// boot values select chapters/maps/autoplay before the first rendered frame.

import { describe, expect, test } from "bun:test";
import { bootWorld, fnv1a, treeHasText, type SimWorld } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { DEFAULT_UI_THEME } from "../src/ui/theme.ts";
import type { SessionState } from "../src/engine/session.ts";
import type { RpgkitDemoHook } from "../src/ui/demo/index.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { SUNSTONE_DEMO_ORIGINS } from "../examples/sunstone/demo-chapters.ts";

// Chapters resume on the full run's global frame (timelineFrame).
const FOREST: number = SUNSTONE_DEMO_ORIGINS.forest;
const CAVE: number = SUNSTONE_DEMO_ORIGINS.cave;

const preflight = appPreflight("sunstone");
if (!preflight.ok) console.warn(`sunstone demo sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

const W = 480;
const H = 272;
const BTN_SELECT = 0x0001;
const BTN_RIGHT = 0x0020;
const BTN_DOWN = 0x0040;
const BTN_CIRCLE = 0x2000;
const MENU_HASH = "5484d172";

function state(): SessionState {
  return (globalThis as { __rpgSessionState?: SessionState }).__rpgSessionState!;
}

function demoHook(): RpgkitDemoHook {
  const hook = (globalThis as { __rpgkitDemo?: RpgkitDemoHook }).__rpgkitDemo;
  if (!hook) throw new Error("Sunstone did not register globalThis.__rpgkitDemo");
  return hook;
}

function tick(world: SimWorld, buttons: number): void {
  world.frame(buttons, 0x8080);
  world.tick();
}

async function boot(request?: Record<string, unknown>): Promise<SimWorld> {
  const world = await bootWorld(appBundle("sunstone"), 60, { __rpgkitBoot: request });
  delete (globalThis as { __rpgkitBoot?: unknown }).__rpgkitBoot;
  return world;
}

function rgb(hex: string): readonly [number, number, number] {
  return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)) as unknown as readonly [number, number, number];
}

function pixel(frame: Uint8Array, x: number, y: number): readonly [number, number, number] {
  const offset = (y * W + x) * 4;
  return [frame[offset]!, frame[offset + 1]!, frame[offset + 2]!];
}

async function checkGolden(frame: Uint8Array): Promise<void> {
  const url = new URL("./goldens/sunstone-demo.menu.png", import.meta.url);
  if (process.env.DEMO1_UPDATE_GOLDEN) await Bun.write(url, encodePNG(frame, W, H));
  const png = new Uint8Array(await Bun.file(url).arrayBuffer());
  expect(fnv1a(decodePng(png).rgba), "committed menu PNG").toBe(MENU_HASH);
}

simDescribe("Sunstone opt-in demo menu through the built bundle", () => {
  test("opening the menu folds zero world frames and renders the themed golden", async () => {
    const world = await boot();
    tick(world, 0);
    const before = structuredClone(state());
    tick(world, BTN_SELECT);
    const menu = world.render().slice();

    expect(state()).toEqual(before);
    expect(fnv1a(menu)).toBe(MENU_HASH);
    expect(pixel(menu, 0, 0)).toEqual(rgb(DEFAULT_UI_THEME.backdrop));
    expect(pixel(menu, 25, 15)).toEqual(rgb(DEFAULT_UI_THEME.border));
    expect(pixel(menu, 27, 17)).toEqual(rgb(DEFAULT_UI_THEME.paper));
    await checkGolden(menu);

    const tree = world.getTree();
    expect(treeHasText(tree, "DEMO CONTROLS")).toBe(true);
    expect(treeHasText(tree, "[CHAPTERS]")).toBe(true);
    expect(treeHasText(tree, "> Village beginning")).toBe(true);
    expect(state()).toEqual(before);
  });

  test("menu navigation warps immediately while preserving the current story bank", async () => {
    const world = await boot();
    tick(world, 0);
    const beforeFrame = state().frame;
    const beforeStory = structuredClone(state().sw);

    tick(world, BTN_SELECT);
    tick(world, 0);
    tick(world, BTN_RIGHT); // map page
    tick(world, 0);
    tick(world, BTN_DOWN); // forest
    tick(world, 0);
    tick(world, BTN_DOWN); // cave
    tick(world, 0);
    tick(world, BTN_CIRCLE);

    expect(state()).toMatchObject({ mapId: "cave", frame: beforeFrame, move: { tx: 9, ty: 10, facing: 2 } });
    expect(state().sw).toEqual(beforeStory);
    expect(state().interp.modal).toBeNull();
    expect(demoHook().current()).toMatchObject({ chapter: "cave", map: "cave", autoplay: false, speed: 1 });

    // The fixed-height absolute wrapper anchors the complete 38 px toast
    // above the 12 px bottom margin. Without its height, layout placed the
    // panel below the viewport and only its top border leaked onto row 260.
    const toast = world.render().slice();
    expect(pixel(toast, 60, 222)).toEqual(rgb(DEFAULT_UI_THEME.border));
    expect(pixel(toast, 62, 224)).toEqual(rgb(DEFAULT_UI_THEME.paper));
    expect(treeHasText(world.getTree(), "Warped — story state may not match this map")).toBe(true);
  });

  test("the page hook jumps and autoplays through the same frame-safe path", async () => {
    const world = await boot();
    tick(world, 0);
    const hook = demoHook();
    const before = structuredClone(state());

    hook.jump("forest");
    expect(state()).toEqual(before);
    expect(hook.current()).toEqual({ chapter: "village", map: "village", autoplay: false, speed: 1 });
    tick(world, 0);
    expect(state()).toMatchObject({ mapId: "forest", frame: FOREST, move: { tx: 10, ty: 13 } });
    expect(hook.current()).toEqual({ chapter: "forest", map: "forest", autoplay: false, speed: 1 });

    hook.autoplay("cave", 4);
    tick(world, 0);
    expect(state()).toMatchObject({ mapId: "cave", frame: CAVE, move: { tx: 9, ty: 11 } });
    expect(hook.current()).toEqual({ chapter: "cave", map: "cave", autoplay: true, speed: 4 });
    tick(world, 0);
    expect(state().frame).toBe(CAVE + 4);

    hook.warp("village", 9, 9);
    tick(world, 0);
    expect(state()).toMatchObject({ mapId: "village", move: { tx: 9, ty: 9 } });
    expect(hook.current()).toEqual({ chapter: "village", map: "village", autoplay: false, speed: 4 });
  });
});

simDescribe("Sunstone demo boot requests", () => {
  test("chapter and map requests apply before the first session fold", async () => {
    await boot({ chapter: "forest" });
    expect(state()).toMatchObject({ mapId: "forest", frame: FOREST, move: { tx: 10, ty: 13 } });
    expect(state().sw.items["thorn-key"]).toBe(1);
    expect(demoHook().current()).toMatchObject({ chapter: "forest", map: "forest", autoplay: false });

    await boot({ map: "cave", x: "9", y: "10" });
    expect(state()).toMatchObject({ mapId: "cave", frame: 0, move: { tx: 9, ty: 10 } });
    expect(state().sw.gold).toBe(5);
    expect(state().sw.items["thorn-key"]).toBeUndefined();
  });

  test("autoplay speed is active on the first host frame", async () => {
    const world = await boot({ autoplay: "cave", speed: "4" });
    expect(state()).toMatchObject({ mapId: "cave", frame: CAVE, move: { tx: 9, ty: 11, phase: 0 } });
    tick(world, 0);
    expect(state()).toMatchObject({ mapId: "cave", frame: CAVE + 4, move: { phase: 4 } });
  });

  test("a bad request is a visible menu error and leaves the fresh world unchanged", async () => {
    const world = await boot({ chapter: "missing" });
    const before = structuredClone(state());
    const tree = world.getTree();
    expect(treeHasText(tree, "BAD DEMO LINK")).toBe(true);
    expect(treeHasText(tree, "unknown chapter")).toBe(true);
    expect(state()).toEqual(before);
  });
});
