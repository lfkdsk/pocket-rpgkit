import { describe, expect, test } from "bun:test";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { bootGameWorld, installGameSimIsolation } from "./helpers/sim-session.ts";

const preflight = appPreflight("kau1-audio");
if (!preflight.ok) console.warn(`audio fixture sim test skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

const WIDTH = 480;

function rgbaAt(framebuffer: Uint8Array, x: number, y: number): number[] {
  const offset = (y * WIDTH + x) * 4;
  return [...framebuffer.subarray(offset, offset + 4)];
}

simDescribe("opt-in audio fixture", () => {
  test("renders its centered field and starts the declared BGM", async () => {
    const world = await bootGameWorld(appBundle("kau1-audio"), 60);
    for (let frame = 0; frame < 8; frame++) {
      world.frame(0, 0x8080);
      world.tick();
    }

    expect(world.probes().state.interp.audio?.bgm).toEqual({
      id: "tone",
      volume: 35,
      pitch: 100,
      positionTicks: 7,
    });
    expect(world.probes().state.interp.cues).toEqual([]);

    const framebuffer = world.render();
    // The 4x4 map is a centered 64px checkerboard with black letterboxing;
    // the authored gold walker occupies the player's middle tile.
    expect(rgbaAt(framebuffer, 207, 104)).toEqual([0, 0, 0, 255]);
    expect(rgbaAt(framebuffer, 208, 104)).toEqual([22, 58, 70, 255]);
    expect(rgbaAt(framebuffer, 229, 123)).toEqual([244, 190, 70, 255]);
    expect(rgbaAt(framebuffer, 272, 167)).toEqual([0, 0, 0, 255]);
  });
});
