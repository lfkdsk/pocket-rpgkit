import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import type { Host, HostOps } from "@pocketjs/framework/host";
import { installHost } from "@pocketjs/framework/host";
import { resetRendererState, type NodeMirror } from "@pocketjs/framework/renderer";
import { resetFrameHooks, runFrameHooks } from "../vendor/pocketjs/framework/src/frame.ts";
import { PROP } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { compileAnim } from "../src/engine/interpreter.ts";
import type { SessionState } from "../src/engine/session.ts";
import type { GameAssets } from "../src/ui/game-assets.ts";
import { MapAnimLayer } from "../src/ui/MapAnimLayer.tsx";
import { gameManifestSource } from "../tools/lib/chunks.ts";

type HostCall = readonly [name: string, ...args: number[]];
let calls: HostCall[] = [];
let dispose: (() => void) | undefined;

function testHost(): Host {
  let nextId = 2;
  const record = (name: string) => (...args: number[]) => { calls.push([name, ...args]); };
  const ops = {
    createNode: () => nextId++,
    destroyNode: record("destroyNode"),
    insertBefore: record("insertBefore"),
    removeChild: record("removeChild"),
    setStyle: record("setStyle"),
    setProp: record("setProp"),
    setText: () => {},
    replaceText: () => {},
    uploadTexture: () => -1,
    setImage: record("setImage"),
    setSprite: record("setSprite"),
    animate: () => 1,
    cancelAnim: () => {},
    setFocus: () => {},
    measureText: () => 0,
  } as HostOps;
  return { ops, kind: "injected", target: "test", strict: false };
}

beforeEach(() => {
  calls = [];
  installHost(testHost());
  resetRendererState();
  resetFrameHooks();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  resetFrameHooks();
});

describe("KRM3V cooked animation rendering", () => {
  test("uses the cooked canvas offsets as the image top-left", () => {
    const state = {
      mapId: "map",
      interp: {
        frame: 0,
        anims: [{
          id: "burst-1",
          anim: "burst",
          start: 0,
          x: 2,
          y: 3,
          target: null,
          layer: "below",
          loop: false,
        }],
      },
      move: { px: 0, py: 0 },
      chars: { chars: {} },
    } as unknown as SessionState;
    const timing = compileAnim({
      id: "burst",
      sheet: "animations/burst.png",
      count: 1,
      frameDuration: 1,
    }, 60);
    const assets = {
      anims: {
        burst: {
          frames: ["animations/burst-0.png"],
          w: 20,
          h: 30,
          offsetX: -2,
          offsetY: -10,
        },
      },
    } as unknown as GameAssets;
    let root!: NodeMirror;
    createRoot((close) => {
      dispose = close;
      root = MapAnimLayer({
        above: false,
        state: () => state,
        anims: () => new Map([["burst", timing]]),
        assets,
        debugName: "test-anim",
      }) as unknown as NodeMirror;
    });

    runFrameHooks(0);
    expect(root.children).toHaveLength(1);
    const image = root.children[0]!;
    expect(image.debugName).toBe("test-anim-burst-1");
    expect(image.domAttrs?.src).toBe("animations/burst-0.png");
    expect(image.domAttrs?.style).toEqual({
      posType: 1,
      insetL: 0,
      insetT: 0,
      width: 20,
      height: 30,
    });
    expect(calls).toContainEqual(["setProp", image.id, PROP.translateX, 30]);
    expect(calls).toContainEqual(["setProp", image.id, PROP.translateY, 38]);
  });
});

describe("KRM3V optional manifest tables", () => {
  const base = {
    generator: "krm3v-test",
    typesImport: "../src/ui/game-assets.ts",
    maps: [{ id: "map", width: 4, height: 3, events: [] }],
    npcSrc: [] as readonly (readonly [string, string])[],
    player: {
      idle: ["d", "l", "u", "r"],
      walkL: ["d", "l", "u", "r"],
      walkR: ["d", "l", "u", "r"],
    },
  };

  test("omits every optional path when no visual assets were cooked", () => {
    const source = gameManifestSource(base);
    expect(source).not.toContain("ANIM_FRAMES");
    expect(source).not.toContain("ITEM_SRC");
    expect(source).not.toContain("PARALLAXES");
    expect(source).not.toContain("itemSrc:");
    expect(source).not.toContain("parallaxes:");
  });

  test("emits cooked offsets, item sources, and parallax dimensions", () => {
    const source = gameManifestSource({
      ...base,
      anims: [["burst", {
        frames: ["animations/burst-0.png"],
        w: 20,
        h: 30,
        offsetX: -2,
        offsetY: -10,
      }]],
      itemSrc: [["iconset.7", "items/iconset-7.png"]],
      parallaxes: [["clouds", { image: "parallaxes/clouds.png", w: 408, h: 312 }]],
    });
    expect(source).toContain(
      '"burst": { frames: ["animations/burst-0.png"], w: 20, h: 30, offsetX: -2, offsetY: -10 }',
    );
    expect(source).toContain('"iconset.7": "items/iconset-7.png"');
    expect(source).toContain(
      '"clouds": { image: "parallaxes/clouds.png", w: 408, h: 312 }',
    );
    expect(source).toContain("  anims: ANIM_FRAMES,");
    expect(source).toContain("  itemSrc: ITEM_SRC,");
    expect(source).toContain("  parallaxes: PARALLAXES,");
  });
});
