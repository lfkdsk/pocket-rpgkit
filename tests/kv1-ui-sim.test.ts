import { describe, expect, test } from "bun:test";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { fnv1a } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { TILE } from "../src/engine/tiles.ts";
import {
  CANOPY_NPC,
  KV1_SUBJECT,
} from "./fixtures/r2-ui/fixture-data.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import {
  bootGameWorld,
  installGameSimIsolation,
  type BoundGameWorld,
} from "./helpers/sim-session.ts";

const preflight = appPreflight("r2-ui");
if (!preflight.ok) console.warn(`kv1 ui sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

type Rgba = readonly [number, number, number, number];
const WALKER_DOWN: Rgba = [246, 92, 92, 255];
const ALT_BLUE: Rgba = [74, 132, 246, 255];
const CANOPY: Rgba = [174, 48, 142, 255];
const FINAL_HASHES: Readonly<Record<string, string>> = {
  "480x272": "2f4c15c3",
  "640x360": "7eca97a3",
};

function pump(world: BoundGameWorld, frames: number, buttons = 0): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(buttons, 0x8080);
    for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  }
}

function action(world: BoundGameWorld): void {
  pump(world, 1, BTN.CIRCLE);
  pump(world, 1);
}

function rgbaAt(frame: Uint8Array, width: number, x: number, y: number): number[] {
  const i = (Math.round(y) * width + Math.round(x)) * 4;
  return [...frame.subarray(i, i + 4)];
}

function expectPixel(
  frame: Uint8Array,
  width: number,
  x: number,
  y: number,
  colour: Rgba,
): void {
  expect(rgbaAt(frame, width, x, y), `pixel (${x},${y})`).toEqual([...colour]);
}

function countColour(
  frame: Uint8Array,
  width: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  colour: Rgba,
): number {
  let count = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const pixel = rgbaAt(frame, width, x, y);
      if (pixel.every((value, channel) => value === colour[channel])) count++;
    }
  }
  return count;
}

function findNode(tree: unknown, name: string): any {
  const node = tree as { n?: string; k?: unknown[] };
  if (node?.n === name) return node;
  for (const child of node?.k ?? []) {
    const found = findNode(child, name);
    if (found) return found;
  }
  return undefined;
}

async function golden(
  name: string,
  frame: Uint8Array,
  width: number,
  height: number,
): Promise<string> {
  const url = new URL(`./goldens/${name}.png`, import.meta.url);
  if (process.env.KV1_UPDATE_GOLDENS) await Bun.write(url, encodePNG(frame, width, height));
  const bytes = new Uint8Array(await Bun.file(url).arrayBuffer());
  expect(frame).toEqual(decodePng(bytes).rgba);
  return fnv1a(frame);
}

simDescribe("KV1 runtime visuals", () => {
  for (const viewport of [
    { width: 480, height: 272 },
    { width: 640, height: 360 },
  ] as const) {
    test(`switches actor art and stable layer nodes at ${viewport.width}x${viewport.height}`, async () => {
      const world = await bootGameWorld(
        appBundle("r2-ui"),
        60,
        { __r2Kv1: true },
        undefined,
        viewport,
      );
      pump(world, 1);

      const point = (x: number, y: number, ox = 8, oy = 8) => {
        const camera = world.probes().camera;
        return { x: x * TILE - camera.x + ox, y: y * TILE - camera.y + oy };
      };
      const initial = world.render().slice();
      const player = world.probes().state.move;
      const playerHead = point(player.tx, player.ty - 1);
      const subjectHead = point(KV1_SUBJECT.x, KV1_SUBJECT.y - 1);
      const canopy = point(CANOPY_NPC.x, CANOPY_NPC.y - 1);
      expectPixel(initial, viewport.width, playerHead.x, playerHead.y, WALKER_DOWN);
      expectPixel(initial, viewport.width, subjectHead.x, subjectHead.y, WALKER_DOWN);
      expectPixel(initial, viewport.width, canopy.x, canopy.y, CANOPY);

      const initialTree = world.getTree();
      const stableIds = Object.fromEntries([
        "rpgkit-player",
        "rpgkit-npc-appearance-subject",
        "rpgkit-ground",
        "rpgkit-layer-extra-canopy",
        "rpgkit-screen-layer-screen-tint",
      ].map((name) => [name, findNode(initialTree, name)?.i]));
      expect(Object.values(stableIds).every((id) => typeof id === "number")).toBe(true);

      action(world);
      const appearance = world.render().slice();
      expect(world.probes().state.sw.playerAppearance?.sprite).toBe("alt");
      expect(world.probes().state.interp.eventAppearances?.["appearance-subject"]?.sprite).toBe("alt");
      const playerCell = point(player.tx, player.ty, 0, 0);
      const subjectCell = point(KV1_SUBJECT.x, KV1_SUBJECT.y, 0, 0);
      expect(countColour(appearance, viewport.width, playerCell.x, playerCell.y, TILE, TILE, ALT_BLUE))
        .toBeGreaterThan(20);
      expect(countColour(appearance, viewport.width, subjectCell.x, subjectCell.y, TILE, TILE, ALT_BLUE))
        .toBeGreaterThan(20);

      action(world);
      const replaced = world.render().slice();
      expect(world.probes().state.interp.layers).toMatchObject({
        ground: { variant: "void" },
        upper: { visible: false },
      });
      expect(world.probes().state.sw.playerAppearance?.opacity).toBe(128);
      expect(world.probes().state.interp.eventAppearances?.["appearance-subject"]?.visible).toBe(false);
      const quietGround = point(1, 5, 1, 1);
      expectPixel(replaced, viewport.width, quietGround.x, quietGround.y, [0, 0, 0, 255]);
      expect(rgbaAt(replaced, viewport.width, canopy.x, canopy.y)).not.toEqual([...CANOPY]);
      expect(countColour(replaced, viewport.width, subjectCell.x, subjectCell.y, TILE, TILE, ALT_BLUE)).toBe(0);

      action(world);
      const extra = world.render().slice();
      expect(world.probes().state.interp.layers?.["extra-canopy"]).toEqual({
        visible: true,
        variant: "on",
      });
      expectPixel(extra, viewport.width, canopy.x, canopy.y, CANOPY);

      action(world);
      const tinted = world.render().slice();
      expect(world.probes().state.interp.layers?.["screen-tint"]).toEqual({
        visible: true,
        variant: "blue",
      });
      const tintedCanopy = rgbaAt(tinted, viewport.width, canopy.x, canopy.y);
      expect(tintedCanopy).not.toEqual([...CANOPY]);
      expect(tintedCanopy[2]).toBeGreaterThan(tintedCanopy[0]!);

      const finalTree = world.getTree();
      for (const [name, id] of Object.entries(stableIds)) {
        expect(findNode(finalTree, name)?.i, name).toBe(id);
      }
      const hash = await golden(`kv1-runtime-${viewport.width}x${viewport.height}`, tinted, viewport.width, viewport.height);
      expect(hash).toBe(FINAL_HASHES[`${viewport.width}x${viewport.height}`]);
    }, 30_000);
  }
});
