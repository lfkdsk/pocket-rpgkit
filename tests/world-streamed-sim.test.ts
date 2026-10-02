// Component-world rendering proof: signed placement origins, seams, world
// plane ordering, viewport-bounded pools and deterministic full-frame pixels.

import { describe, expect, test } from "bun:test";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import type { WorldStreamedTerrainStats } from "../src/ui/WorldStreamedTerrain.tsx";
import {
  ABOVE_ANIM_COLOUR,
  BELOW_ANIM_COLOUR,
  MAPS,
  PLAYER_COLOUR,
  type Rgba,
} from "./fixtures/world-streamed/fixture-data.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { bootGameWorld, installGameSimIsolation } from "./helpers/sim-session.ts";

const preflight = appPreflight("world-streamed");
if (!preflight.ok) console.warn(`world-streamed sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

interface FixtureStats {
  ground?: WorldStreamedTerrainStats;
  upper?: WorldStreamedTerrainStats;
  below?: { mounted: number; created: number; pooled: number };
  above?: { mounted: number; created: number; pooled: number };
}
interface Viewport {
  width: number;
  height: number;
}

interface Shot {
  name: "horizontal" | "vertical" | "negative-origin" | "four-corner" | "small-edge";
  camera: (viewport: Viewport) => { x: number; y: number };
}

const SHOTS: readonly Shot[] = [
  { name: "horizontal", camera: ({ width, height }) => ({ x: -width / 2, y: -320 - height / 2 }) },
  { name: "vertical", camera: ({ width, height }) => ({ x: -512 - width / 2, y: -height / 2 }) },
  { name: "negative-origin", camera: () => ({ x: -1024, y: -640 }) },
  { name: "four-corner", camera: ({ width, height }) => ({ x: -width / 2, y: -height / 2 }) },
  { name: "small-edge", camera: ({ width, height }) => ({ x: 1280 - width, y: 320 - height / 2 }) },
];

const rgbaAt = (frame: Uint8Array, width: number, x: number, y: number): number[] => {
  expect(x).toBeGreaterThanOrEqual(0);
  expect(y).toBeGreaterThanOrEqual(0);
  const offset = (Math.floor(y) * width + Math.floor(x)) * 4;
  return [...frame.subarray(offset, offset + 4)];
};

const expectPixel = (
  frame: Uint8Array,
  viewport: Viewport,
  x: number,
  y: number,
  colour: Rgba,
): void => {
  expect(rgbaAt(frame, viewport.width, x, y)).toEqual([...colour]);
};

const screenPoint = (camera: { x: number; y: number }, worldX: number, worldY: number) => ({
  x: worldX - camera.x,
  y: worldY - camera.y,
});

async function golden(name: string, viewport: Viewport, frame: Uint8Array): Promise<void> {
  const size = `${viewport.width}x${viewport.height}`;
  const url = new URL(`./goldens/world-streamed.${name}.${size}.png`, import.meta.url);
  if (process.env.WORLD_STREAMED_UPDATE_GOLDENS) {
    await Bun.write(url, encodePNG(frame, viewport.width, viewport.height));
  }
  const expected = decodePng(new Uint8Array(await Bun.file(url).arrayBuffer()));
  expect({ width: expected.width, height: expected.height }).toEqual(viewport);
  expect(frame).toEqual(expected.rgba);
}

const fixtureStats = (): FixtureStats =>
  structuredClone((globalThis as { __worldStreamedStats?: FixtureStats }).__worldStreamedStats ?? {});

const preFrameCleanupReads = (): number | undefined =>
  (globalThis as { __worldStreamedPreFrameCleanupReads?: number })
    .__worldStreamedPreFrameCleanupReads;

function expectSolidRow(
  frame: Uint8Array,
  viewport: Viewport,
  y: number,
  colour: Rgba,
): void {
  const row = Math.floor(y);
  expect(row).toBeGreaterThanOrEqual(0);
  expect(row).toBeLessThan(viewport.height);
  for (let x = 0; x < viewport.width; x++) {
    const offset = (row * viewport.width + x) * 4;
    for (let channel = 0; channel < 4; channel++) {
      if (frame[offset + channel] !== colour[channel]) {
        throw new Error(
          `expected solid ${colour.join(",")} row at (${x}, ${row}), got ` +
          [...frame.subarray(offset, offset + 4)].join(","),
        );
      }
    }
  }
}

function expectSolidColumn(
  frame: Uint8Array,
  viewport: Viewport,
  x: number,
  colour: Rgba,
): void {
  const column = Math.floor(x);
  expect(column).toBeGreaterThanOrEqual(0);
  expect(column).toBeLessThan(viewport.width);
  for (let y = 0; y < viewport.height; y++) {
    const offset = (y * viewport.width + column) * 4;
    for (let channel = 0; channel < 4; channel++) {
      if (frame[offset + channel] !== colour[channel]) {
        throw new Error(
          `expected solid ${colour.join(",")} column at (${column}, ${y}), got ` +
          [...frame.subarray(offset, offset + 4)].join(","),
        );
      }
    }
  }
}

const map = (id: string) => MAPS.find((entry) => entry.id === id)!;

function assertShotPixels(
  name: Shot["name"],
  frame: Uint8Array,
  viewport: Viewport,
  camera: { x: number; y: number },
): void {
  const at = (worldX: number, worldY: number, colour: Rgba): void => {
    const point = screenPoint(camera, worldX, worldY);
    expectPixel(frame, viewport, point.x, point.y, colour);
  };
  if (name === "horizontal") {
    at(-8, -320, map("a-northwest").ground);
    at(8, -320, map("b-northeast").ground);
  } else if (name === "vertical") {
    at(-512, -8, map("a-northwest").ground);
    at(-512, 8, map("c-southwest").ground);
  } else if (name === "negative-origin") {
    expectPixel(frame, viewport, 8, 8, map("a-northwest").ground);
  } else if (name === "four-corner") {
    // The four authored upper markers meet with no crack or overlap.
    at(-8, -8, map("a-northwest").upper);
    at(8, -8, map("b-northeast").upper);
    at(-8, 8, map("c-southwest").upper);
    at(8, 8, map("d-southeast").upper);
    // Ground -> player -> upper is observable on one active-map tile.
    at(-28, -24, PLAYER_COLOUR);
    at(-20, -24, map("a-northwest").upper);
    at(-40, -24, map("a-northwest").ground);
    // Both animation bands use placement-qualified coordinates on all four maps.
    for (const [worldX, worldY] of [[-72, -56], [56, -56], [-72, 56], [56, 56]] as const) {
      at(worldX, worldY, BELOW_ANIM_COLOUR);
    }
    for (const [worldX, worldY] of [[-56, -56], [72, -56], [-56, 56], [72, 56]] as const) {
      at(worldX, worldY, ABOVE_ANIM_COLOUR);
    }
  } else {
    at(1016, 320, map("d-southeast").ground);
    at(1152, 320, map("e-small").ground);
    at(1048, 312, map("e-small").upper);
    // The unplaced world area above the small edge map remains transparent,
    // revealing the black frame instead of stretching its terrain.
    at(1152, 224, [0, 0, 0, 255]);
  }
}

for (const viewport of [{ width: 480, height: 272 }, { width: 960, height: 544 }] as const) {
  simDescribe(`connected world renderer ${viewport.width}x${viewport.height}`, () => {
    test("renders signed seams, the four-map corner and the small component edge", async () => {
      const debugCamera = { ...SHOTS[0]!.camera(viewport) };
      const world = await bootGameWorld(
        appBundle("world-streamed"),
        60,
        { __worldStreamedCamera: debugCamera },
        undefined,
        viewport,
      );
      expect(preFrameCleanupReads()).toBe(0);
      const step = (): void => {
        world.frame(0, 0x8080);
        world.tick();
      };
      step();

      for (const shot of SHOTS) {
        Object.assign(debugCamera, shot.camera(viewport));
        step();
        expect(world.probes().camera).toMatchObject(debugCamera);
        const frame = world.render().slice();
        assertShotPixels(shot.name, frame, viewport, debugCamera);
        await golden(shot.name, viewport, frame);
      }
    }, 60_000);

    test("one-pixel seam scrolling on both axes never clears or grows the warmed pools", async () => {
      const debugCamera = { x: -viewport.width / 2 - 32, y: -320 - viewport.height / 2 };
      const world = await bootGameWorld(
        appBundle("world-streamed"),
        60,
        { __worldStreamedCamera: debugCamera },
        undefined,
        viewport,
      );
      const step = (): void => {
        world.frame(0, 0x8080);
        world.tick();
      };
      step();
      debugCamera.x = -viewport.width / 2 + 32;
      step();
      debugCamera.x = -viewport.width / 2 - 32;
      step();
      const warmGround = fixtureStats().ground!;
      const warmUpper = fixtureStats().upper!;

      for (let delta = -32; delta <= 32; delta++) {
        debugCamera.x = -viewport.width / 2 + delta;
        step();
        const frame = world.render();
        const seamX = -debugCamera.x;
        expectSolidColumn(frame, viewport, seamX - 1, map("a-northwest").ground);
        expectSolidColumn(frame, viewport, seamX, map("b-northeast").ground);
        const stats = fixtureStats();
        expect(stats.ground).toMatchObject({
          created: warmGround.created,
          uploads: warmGround.uploads,
          frees: warmGround.frees,
          pending: 0,
        });
        expect(stats.upper).toMatchObject({
          created: warmUpper.created,
          uploads: warmUpper.uploads,
          frees: warmUpper.frees,
          pending: 0,
        });
        expect(stats.ground!.resident).toBeGreaterThan(0);
        expect(stats.ground!.textures).toBeGreaterThan(0);
        expect(stats.ground!.visibleMaps).toEqual(["a-northwest", "b-northeast"]);
      }

      debugCamera.x = -512 - viewport.width / 2;
      debugCamera.y = -viewport.height / 2 - 32;
      step();
      debugCamera.y = -viewport.height / 2 + 32;
      step();
      debugCamera.y = -viewport.height / 2 - 32;
      step();
      const warmVerticalGround = fixtureStats().ground!;
      const warmVerticalUpper = fixtureStats().upper!;

      for (let delta = -32; delta <= 32; delta++) {
        debugCamera.y = -viewport.height / 2 + delta;
        step();
        const frame = world.render();
        const seamY = -debugCamera.y;
        expectSolidRow(frame, viewport, seamY - 1, map("a-northwest").ground);
        expectSolidRow(frame, viewport, seamY, map("c-southwest").ground);
        const stats = fixtureStats();
        expect(stats.ground).toMatchObject({
          created: warmVerticalGround.created,
          uploads: warmVerticalGround.uploads,
          frees: warmVerticalGround.frees,
          pending: 0,
        });
        expect(stats.upper).toMatchObject({
          created: warmVerticalUpper.created,
          uploads: warmVerticalUpper.uploads,
          frees: warmVerticalUpper.frees,
          pending: 0,
        });
        expect(stats.ground!.resident).toBeGreaterThan(0);
        expect(stats.ground!.textures).toBeGreaterThan(0);
        expect(stats.ground!.visibleMaps).toEqual(["a-northwest", "c-southwest"]);
      }
    }, 60_000);
  });
}
