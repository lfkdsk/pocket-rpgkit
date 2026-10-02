import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import type { Host, HostOps } from "@pocketjs/framework/host";
import { installHost } from "@pocketjs/framework/host";
import { resetRendererState, type NodeMirror } from "@pocketjs/framework/renderer";
import { resetFrameHooks, runFrameHooks } from "../vendor/pocketjs/framework/src/frame.ts";
import type { SessionState } from "../src/engine/session.ts";
import {
  ParallaxLayer,
  projectParallaxAxis,
} from "../src/ui/ParallaxLayer.tsx";

type HostCall = readonly [name: string, ...args: number[]];

function testHost(calls: HostCall[]): Host {
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

let dispose: (() => void) | undefined;

beforeEach(() => {
  const calls: HostCall[] = [];
  installHost(testHost(calls));
  resetRendererState();
  resetFrameHooks();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  resetFrameHooks();
});

describe("KRM3V MV parallax projection", () => {
  test("normal, looping, and !zero images use MV's distinct camera origins", () => {
    expect(projectParallaxAxis(40, 8, 64, 100, 300, false, false).positions)
      .toEqual([0, 64]);
    expect(projectParallaxAxis(40, 8, 64, 100, 300, false, true).positions)
      .toEqual([-40, 24, 88]);
    expect(projectParallaxAxis(40, 8, 64, 100, 300, true, false).positions)
      .toEqual([-24, 40]);
    expect(projectParallaxAxis(40, 8, 64, 100, 300, true, true).positions)
      .toEqual([-48, 16, 80]);
  });

  test("a non-looping whole-map picture follows map travel by its overflow ratio", () => {
    // The map can travel 200 px while this image can travel 100 px. A 40 px
    // camera move therefore reveals the image from x=20, not x=0 or x=40.
    expect(projectParallaxAxis(40, 0, 200, 100, 300, false, false).positions)
      .toEqual([-20]);
    expect(projectParallaxAxis(200, 0, 200, 100, 300, false, false).positions)
      .toEqual([-100]);
  });

  test("a connected-world local camera clips projection to the active map only", () => {
    // The component camera begins 24 px left of this 60 px map: its active
    // interval is screen x [24,84), not the whole connected viewport.
    expect(projectParallaxAxis(-24, 0, 32, 100, 60, false, false)).toEqual({
      inset: 24,
      size: 60,
      positions: [0, 32],
    });
    // At the other edge only the final 20 px of the active map are visible.
    expect(projectParallaxAxis(40, 0, 32, 100, 60, false, true)).toEqual({
      inset: 0,
      size: 20,
      positions: [-8],
    });
    expect(projectParallaxAxis(100, 0, 32, 100, 60, true, true).size).toBe(0);
  });
});

describe("KRM3V ParallaxLayer tree", () => {
  test("mounts no image path until configured, then tiles only the active-map clip", () => {
    const state = {
      mapId: "active",
      interp: {},
    } as unknown as SessionState;
    let root!: NodeMirror;
    createRoot((close) => {
      dispose = close;
      root = ParallaxLayer({
        state: () => state,
        camera: () => ({ x: -16, y: 0, facing: 0 }),
        viewport: () => ({ w: 64, h: 48 }),
        mapSize: () => ({ w: 48, h: 32 }),
        assets: { fog: { image: "parallaxes/fog.png", w: 32, h: 32 } },
        debugName: "test-parallax",
      }) as unknown as NodeMirror;
    });

    runFrameHooks(0);
    expect(root.children).toHaveLength(0);

    state.interp.parallax = {
      image: "fog",
      loopX: false,
      loopY: false,
      sx: 0,
      sy: 0,
      zero: true,
      phaseX: 0,
      phaseY: 0,
    };
    runFrameHooks(0);

    expect(root.debugName).toBe("test-parallax");
    expect(root.domAttrs?.style).toEqual({
      posType: 1,
      insetL: 16,
      insetT: 0,
      width: 48,
      height: 32,
      overflow: 1,
    });
    expect(root.children.map((node) => node.debugName)).toEqual([
      "test-parallax-0",
      "test-parallax-1",
    ]);
    expect(root.children.map((node) => node.domAttrs?.src)).toEqual([
      "parallaxes/fog.png",
      "parallaxes/fog.png",
    ]);

    delete state.interp.parallax;
    runFrameHooks(0);
    expect(root.children.map((node) => (node.domAttrs?.style as { display: number }).display))
      .toEqual([1, 1]);
  });
});
