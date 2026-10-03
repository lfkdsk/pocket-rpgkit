// tests/text-tokens-ui-sim.test.ts — the {x:} text-token resolver wired
// through the real GameView on the deterministic wasm sim host
// (tests/fixtures/text-tokens). The fixture's autorun page opens a text
// box whose {x:} tokens the GameView `textTokens` prop answers from the
// game's ext state, then an extChoice whose prompt carries one. The
// default boot covers the live createSession path; setting
// __textTokensAttract covers GameView's AttractController path (the same
// resolver must reach both).

import { describe, expect, test } from "bun:test";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { bootGameWorld, installGameSimIsolation, type BoundGameWorld } from "./helpers/sim-session.ts";

const preflight = appPreflight("text-tokens");
if (!preflight.ok) console.warn(`text tokens sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

function pump(world: BoundGameWorld, frames: number, buttons = 0): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(buttons, 0x8080);
    for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  }
}

function tap(world: BoundGameWorld, button: number): void {
  pump(world, 1, button);
  pump(world, 2);
}

function modal(world: BoundGameWorld): { kind?: string; prompt?: string; lines?: string[]; options?: string[] } {
  return (world.probes().state.interp.modal ?? {}) as never;
}

async function boot(attract = false): Promise<BoundGameWorld> {
  const world = await bootGameWorld(appBundle("text-tokens"), 60, { __textTokensAttract: attract });
  pump(world, 30);
  return world;
}

simDescribe("{x:} tokens through the real GameView", () => {
  test("live path: the text box and extChoice prompt expand from ext state", async () => {
    const world = await boot();
    // The autorun page's text box opens on frame 1.
    expect(modal(world)).toMatchObject({
      kind: "text",
      lines: ["Leader: Aardling Lv5 (2 mon)."],
    });
    // Confirm past the text box (the typewriter finished during the pump):
    // the extChoice then opens with its {x:rev} prompt expanded (rev is 0)
    // and the extension's rows.
    pump(world, 60);
    tap(world, BTN.CIRCLE);
    pump(world, 4);
    expect(modal(world)).toMatchObject({
      kind: "choices",
      prompt: "Pick for 0",
      options: ["Aardling", "Rockitten"],
    });
    // The prompt is an open-box snapshot: idling keeps it.
    const opened = modal(world).prompt;
    pump(world, 10);
    expect(modal(world).prompt).toBe(opened);
  });

  test("attract path: GameView forwards the resolver to its AttractController", async () => {
    // The same fixture under GameView's attract controller: the resolver
    // must reach the attract createSession path, so the demo/rewind
    // timeline expands text identically to live play.
    const world = await boot(true);
    expect(modal(world)).toMatchObject({
      kind: "text",
      lines: ["Leader: Aardling Lv5 (2 mon)."],
    });
    pump(world, 60);
    tap(world, BTN.CIRCLE);
    pump(world, 4);
    expect(modal(world)).toMatchObject({
      kind: "choices",
      prompt: "Pick for 0",
      options: ["Aardling", "Rockitten"],
    });
  });
});
