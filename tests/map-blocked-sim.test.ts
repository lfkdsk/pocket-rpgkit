// tests/map-blocked-sim.test.ts — the async map-loading path through the real
// GameView frame loop. When the transfer target's shard bytes are not
// resident, the boundary reports MapNotReadyError and GameView waits on
// prepareSessionMap. A rejection — even with a falsy reason such as
// undefined — must surface a stable error instead of hanging on the loading
// screen forever.

import { describe, expect, test } from "bun:test";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { bootGameWorld, installGameSimIsolation } from "./helpers/sim-session.ts";
import { MAP_B_ID } from "./fixtures/map-blocked/fixture-data.ts";

const preflight = appPreflight("map-blocked");
if (!preflight.ok) console.warn(`map-blocked sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

simDescribe("GameView async map loading", () => {
  test.each([
    ["undefined", undefined],
    ["null", null],
    ["zero", 0],
    ["empty string", ""],
  ])("a falsy prepare rejection (%s) surfaces a stable error instead of hanging", async (_label, reason) => {
    const world = await bootGameWorld(appBundle("map-blocked"), 60, { __mapBlockedReject: reason });
    const step = (buttons = 0): void => {
      world.frame(buttons, 0x8080);
      world.tick();
    };
    step(); // settle the boot frame on map_a

    // Confirm at the door: the boundary reports not-ready, GameView enters
    // the loading path and prepareSessionMap rejects with the falsy reason.
    // Yield between frames so the rejection settles: production hosts get a
    // fresh event-loop turn per vblank, but a tight sim frame loop does not
    // drain microtasks on its own.
    const yieldToHost = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    let threw: unknown = null;
    for (let frame = 0; frame < 6; frame++) {
      try {
        step(frame === 0 ? BTN.CIRCLE : 0);
      } catch (error) {
        threw = error;
        break;
      }
      await yieldToHost();
    }
    // Before the fix the falsy reason left `blocked.error` empty and the
    // view returned on !ready every frame: no throw, an eternal loading
    // screen. The failure must be a stable Error, never a hang.
    expect(threw).toBeInstanceOf(Error);
    expect((threw as Error).message).toContain("map preparation rejected");
    const loading = (globalThis as { __mapBlockedLoading?: (string | null)[] }).__mapBlockedLoading ?? [];
    expect(loading).toContain(MAP_B_ID);
  });
});
