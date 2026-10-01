// Integration proof for GameView's streamed path: a >512px field scrolls
// through several CLUT8 chunks, the upper layer occludes the player, old
// textures leave after one hysteresis chunk, and a transfer replaces both
// layers without growing the node pool.

import { describe, expect, test } from "bun:test";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { fnv1a } from "../vendor/pocketjs/hosts/sim/sim.ts";
import type { StreamedChunkLayerStats } from "../src/ui/StreamedChunkLayer.tsx";
import {
  FIELD_CHUNK_COLOURS,
  FIELD_ID,
  HARBOR_CHUNK_COLOURS,
  HARBOR_ID,
  PLAYER_COLOUR,
  ROOF_COLOUR,
} from "./fixtures/streamed/fixture-data.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { bootGameWorld, installGameSimIsolation } from "./helpers/sim-session.ts";

const preflight = appPreflight("streamed");
if (!preflight.ok) console.warn(`streamed sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

interface FixtureStats {
  ground?: StreamedChunkLayerStats;
  upper?: StreamedChunkLayerStats;
}

const stats = (): FixtureStats =>
  structuredClone((globalThis as { __streamedFixtureStats?: FixtureStats }).__streamedFixtureStats ?? {});

const pixel = (frame: Uint8Array, x: number, y: number): number[] => {
  const i = (y * 480 + x) * 4;
  return [...frame.subarray(i, i + 4)];
};
const expectPixel = (frame: Uint8Array, x: number, y: number, rgba: readonly number[]): void => {
  expect(pixel(frame, x, y)).toEqual([...rgba]);
};

function findNode(tree: unknown, name: string): any {
  const node = tree as { n?: string; k?: unknown[] };
  if (node?.n === name) return node;
  for (const child of node?.k ?? []) {
    const found = findNode(child, name);
    if (found) return found;
  }
  return undefined;
}

async function golden(name: string, frame: Uint8Array): Promise<string> {
  const url = new URL(`./goldens/${name}.png`, import.meta.url);
  if (process.env.STREAMED_UPDATE_GOLDENS) await Bun.write(url, encodePNG(frame, 480, 272));
  const bytes = new Uint8Array(await Bun.file(url).arrayBuffer());
  const expected = decodePng(bytes).rgba;
  expect(frame).toEqual(expected);
  return fnv1a(frame);
}

simDescribe("GameView streamed chunks", () => {
  test("scrolls, retains one chunk of hysteresis, pools nodes, and switches maps", async () => {
    const world = await bootGameWorld(appBundle("streamed"), 60);
    const step = (buttons = 0): void => {
      world.frame(buttons, 0x8080);
      world.tick();
    };
    step();

    expect(world.probes().state.mapId).toBe(FIELD_ID);
    expectPixel(world.render(), 10, 10, FIELD_CHUNK_COLOURS[0]!);
    expectPixel(world.render(), 300, 10, FIELD_CHUNK_COLOURS[1]!);
    expectPixel(world.render(), 40, 136, PLAYER_COLOUR);
    expect(stats().ground).toMatchObject({ resident: 4, textures: 4, created: 4, uploads: 4, frees: 0 });
    expect(stats().upper).toMatchObject({ resident: 1, textures: 1, created: 1, uploads: 1, frees: 0 });

    while (world.probes().state.move.tx < 28 || world.probes().state.move.moving) step(BTN.RIGHT);
    step();
    expect(world.probes().camera.x).toBe(216);
    const scrolled = world.render().slice();
    expectPixel(scrolled, 10, 10, FIELD_CHUNK_COLOURS[0]!);
    expectPixel(scrolled, 100, 10, FIELD_CHUNK_COLOURS[1]!);
    expectPixel(scrolled, 400, 10, FIELD_CHUNK_COLOURS[2]!);
    expectPixel(scrolled, 240, 136, ROOF_COLOUR);
    expect(await golden("streamed.scroll", scrolled)).toBe("993600c5");

    while (world.probes().state.move.tx < 48 || world.probes().state.move.moving) step(BTN.RIGHT);
    step();
    expect(world.probes().camera.x).toBe(536);
    // The one-chunk retention ring peaks at eight nodes before the oldest
    // column leaves; those nodes become the reusable pool after eviction.
    expect(stats().ground).toMatchObject({ resident: 6, textures: 6, created: 8, uploads: 8, frees: 2 });
    expect(stats().ground!.textureBytes).toBe(6 * (1024 + 256 * 256));

    while (world.probes().state.mapId === FIELD_ID) step(BTN.RIGHT);
    step();
    expect(world.probes().state.mapId).toBe(HARBOR_ID);
    expect(world.probes().camera.x).toBe(0);
    const switched = world.render().slice();
    expectPixel(switched, 10, 10, HARBOR_CHUNK_COLOURS[0]!);
    expectPixel(switched, 300, 10, HARBOR_CHUNK_COLOURS[1]!);
    expectPixel(switched, 40, 136, PLAYER_COLOUR);
    expect(stats().ground).toMatchObject({ resident: 4, textures: 4, created: 8, uploads: 12, frees: 8 });
    expect(stats().upper).toMatchObject({ resident: 0, textures: 0, created: 1, uploads: 1, frees: 1 });
    expect(await golden("streamed.switch", switched)).toBe("e6c27225");
  }, 30_000);

  test("a configured upload budget limits each layer on every frame", async () => {
    const world = await bootGameWorld(appBundle("streamed"), 60, { __streamedLoadBudget: 1 });
    let groundUploads = 0;
    let upperUploads = 0;
    for (let frame = 0; frame < 4; frame++) {
      world.frame(0, 0x8080);
      world.tick();
      const next = stats();
      expect((next.ground?.uploads ?? 0) - groundUploads).toBeLessThanOrEqual(1);
      expect((next.upper?.uploads ?? 0) - upperUploads).toBeLessThanOrEqual(1);
      groundUploads = next.ground?.uploads ?? 0;
      upperUploads = next.upper?.uploads ?? 0;
      if (frame === 0) {
        expect(next.ground).toMatchObject({ resident: 1, pending: 3 });
        expect(next.upper).toMatchObject({ resident: 1, pending: 0 });
      }
    }
    expect(stats().ground).toMatchObject({ resident: 4, textures: 4, uploads: 4, pending: 0 });
  });

  test("pauses pending uploads in extra streamed layers while a battle owns the scene", async () => {
    let uploads = 0;
    const world = await bootGameWorld(
      appBundle("streamed"),
      60,
      { __streamedBattle: true },
      (ops) => {
        for (const key of ["uploadImgEntry", "uploadTexture"] as const) {
          const original = ops[key];
          if (typeof original !== "function") continue;
          ops[key] = (...args: unknown[]) => {
            uploads++;
            return original(...args);
          };
        }
      },
    );
    const step = (buttons = 0): void => {
      world.frame(buttons, 0x8080);
      world.tick();
    };

    step();
    expect(world.probes().state.scene).toBeNull();
    const beforeBattle = uploads;
    step();
    expect(world.probes().state.scene?.kind).toBe("battle");
    expect(uploads).toBe(beforeBattle);
    for (let i = 0; i < 4; i++) step();
    expect(uploads).toBe(beforeBattle);

    step(BTN.CIRCLE);
    for (let i = 0; i < 20 && world.probes().state.scene; i++) step();
    expect(world.probes().state.scene).toBeNull();
    expect(uploads).toBeGreaterThan(beforeBattle);
  });

  test("rebinds a streamed variant and hides upper paint without rebuilding nodes", async () => {
    const world = await bootGameWorld(appBundle("streamed"), 60, { __streamedKv1: true });
    const step = (buttons = 0): void => {
      world.frame(buttons, 0x8080);
      world.tick();
    };
    step();
    const groundId = findNode(world.getTree(), "rpgkit-ground").i;
    const actorsId = findNode(world.getTree(), "rpgkit-actors-wide-field").i;
    expectPixel(world.render(), 10, 10, FIELD_CHUNK_COLOURS[0]!);
    expect(stats().ground).toMatchObject({ resident: 4, textures: 4, uploads: 4, frees: 0 });
    expect(stats().upper).toMatchObject({ resident: 1, textures: 1, uploads: 1, frees: 0 });

    step(BTN.CIRCLE);
    step();
    expect(world.probes().state.interp.layers).toEqual({
      ground: { variant: "sparse" },
      upper: { visible: false },
    });
    expectPixel(world.render(), 10, 10, [0, 0, 0, 255]);
    expect(stats().ground).toMatchObject({ resident: 1, textures: 1, uploads: 5, frees: 4 });
    // Visibility is paint-only: the upper texture remains resident and the
    // actor-bearing root must remain mounted.
    expect(stats().upper).toMatchObject({ resident: 1, textures: 1, uploads: 1, frees: 0 });
    expect(findNode(world.getTree(), "rpgkit-ground").i).toBe(groundId);
    expect(findNode(world.getTree(), "rpgkit-actors-wide-field").i).toBe(actorsId);

    step(BTN.CIRCLE);
    step();
    expect(world.probes().state.interp.layers).toBeUndefined();
    expectPixel(world.render(), 10, 10, FIELD_CHUNK_COLOURS[0]!);
    expect(stats().ground).toMatchObject({ resident: 4, textures: 4, uploads: 9, frees: 5 });
    expect(findNode(world.getTree(), "rpgkit-ground").i).toBe(groundId);
    expect(findNode(world.getTree(), "rpgkit-actors-wide-field").i).toBe(actorsId);
  }, 30_000);
});
