import { describe, expect, test } from "bun:test";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { fnv1a, treeHasText } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { bootGameWorld, installGameSimIsolation } from "./helpers/sim-session.ts";
import { toyState } from "./fixtures/toy-battle.ts";

const preflight = appPreflight("r2-ui");
if (!preflight.ok) console.warn(`battle scene sim test skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

interface AnimationStats {
  below?: { mounted: number; created: number; pooled: number };
  above?: { mounted: number; created: number; pooled: number };
}

const animationStats = (): AnimationStats =>
  structuredClone((globalThis as { __r2UiStats?: AnimationStats }).__r2UiStats ?? {});

function pixelAt(frame: Uint8Array, width: number, x: number, y: number): number[] {
  const offset = (Math.round(y) * width + Math.round(x)) * 4;
  return [...frame.subarray(offset, offset + 4)];
}

simDescribe("GameView battle scene host", () => {
  test("gives a battle sole visibility and input ownership over a parked non-cancellable choice", async () => {
    const atBattle = async (extraGlobals: Record<string, unknown>) => {
      const world = await bootGameWorld(appBundle("r2-ui"), 60, extraGlobals);
      world.frame(0, 0x8080);
      world.tick();
      expect(world.probes().state.scene?.kind).toBe("battle");
      return world;
    };

    const plain = await atBattle({ __r2Battle: true, __r2TransparentBattle: true });
    const unobstructedBattle = plain.render().slice();

    const world = await atBattle({ __r2BattleModal: true, __r2TransparentBattle: true });
    const parked = structuredClone(world.probes().state.interp.modal);
    expect(parked).toMatchObject({
      kind: "choices",
      prompt: "PARKED MAP CHOICE",
      cancellable: false,
      index: 0,
    });
    // The translucent battle would expose any painted map dialog beneath it.
    expect(world.render()).toEqual(unobstructedBattle);

    world.frame(BTN.CROSS, 0x8080);
    world.tick();
    expect(toyState(world.probes().state.scene!.state).pending).toBe("escape");
    expect(world.probes().state.interp.modal).toEqual(parked);
    world.frame(0, 0x8080);
    world.tick();
    for (let guard = 0; world.probes().state.scene && guard < 30; guard++) {
      world.frame(0, 0x8080);
      world.tick();
    }

    expect(world.probes().state.scene).toBeNull();
    expect(world.probes().state.sw.variables["toy.result"]).toBe("escape");
    expect(world.probes().state.interp.modal).toEqual(parked);
    expect(treeHasText(world.getTree(), "PARKED MAP CHOICE")).toBe(true);
    expect(pixelAt(world.render(), 480, 220, 78)).toEqual([93, 127, 163, 255]);
  });

  test("keeps the map mounted but hidden, renders only reducer state plus resolution, then restores the map", async () => {
    const world = await bootGameWorld(appBundle("r2-ui"), 60, { __r2Battle: true });
    const step = (buttons = 0): void => {
      world.frame(buttons, 0x8080);
      world.tick();
    };
    step();

    expect(world.probes().state.scene?.kind).toBe("battle");
    let tree = world.getTree();
    expect(treeHasText(tree, "TOY BATTLE")).toBe(true);
    expect(treeHasText(tree, "480x272")).toBe(true);
    expect(JSON.stringify(tree)).toContain("toy-battle-scene");
    // KB6: the world subtree stays mounted across the battle, hidden with
    // display:none — the pixels below prove it is not painted.
    expect(JSON.stringify(tree)).toContain("rpgkit-world-frame");
    const frame = world.render();
    expect([...frame.subarray(0, 4)]).toEqual([0x39, 0x16, 0x4f, 0xff]);

    step(BTN.CIRCLE);
    step();
    for (let i = 0; i < 16; i++) step();
    expect(world.probes().state.scene).toBeNull();
    expect(world.probes().state.sw.switches["battle-ui-won"]).toBe(true);
    tree = world.getTree();
    // The battle scene also stays mounted (hidden) after closing, so the
    // next battle entry pays no mount cost; the world is visible again.
    expect(JSON.stringify(tree)).toContain("toy-battle-scene");
    expect(JSON.stringify(tree)).toContain("rpgkit-world-frame");
    const restored = world.render();
    expect([...restored.subarray(0, 4)]).not.toEqual([0x39, 0x16, 0x4f, 0xff]);
  });

  test("freezes native atlas pixels across battle and restores their rewind phase", async () => {
    const world = await bootGameWorld(appBundle("r2-ui"), 60, {
      __r2Battle: true,
      __r2BattleDelay: 3.5,
      __r2StaticBattle: true,
      __r2Rewind: true,
    });
    const masks: number[] = [];
    const step = (buttons = 0, record = true): void => {
      if (record) masks.push(buttons);
      world.frame(buttons, 0x8080);
      world.tick();
    };

    step();
    let beforeBattle = world.render().slice();
    for (let guard = 0; !world.probes().state.scene && guard < 240; guard++) {
      beforeBattle = world.render().slice();
      step();
    }
    expect(world.probes().state.scene?.kind).toBe("battle");

    step(BTN.CIRCLE);
    step();
    for (let guard = 0; world.probes().state.scene && guard < 30; guard++) step();
    expect(world.probes().state.scene).toBeNull();
    const afterBattle = world.render().slice();
    const { state, camera } = world.probes();
    const playerHead = [state.move.px - camera.x + 8, state.move.py - camera.y - 8] as const;
    expect(pixelAt(beforeBattle, 480, ...playerHead)).toEqual([246, 92, 92, 255]);
    expect(pixelAt(afterBattle, 480, ...playerHead)).toEqual([246, 92, 92, 255]);
    expect(afterBattle).toEqual(beforeBattle);
    expect(fnv1a(afterBattle)).toBe(fnv1a(beforeBattle));

    const baselineState = structuredClone(world.probes().state);
    expect(masks.length).toBeGreaterThan(180);
    step(BTN.LTRIGGER, false);
    expect(world.probes().state.scene).toBeNull();
    for (const buttons of masks.slice(-180)) step(buttons, false);
    expect(world.probes().state).toEqual(baselineState);
    expect(world.render()).toEqual(afterBattle);
  }, 30_000);

  test("defers animated-tile viewport resync until the battle releases the world", async () => {
    const world = await bootGameWorld(
      appBundle("r2-ui"),
      60,
      { __r2Battle: true, __r2BattleDelay: 0.2 },
      undefined,
      { width: 480, height: 272 },
    );
    const step = (buttons = 0): void => {
      world.frame(buttons, 0x8080);
      world.tick();
    };
    step();
    for (let guard = 0; !world.probes().state.scene && guard < 20; guard++) step();
    expect(world.probes().state.scene?.kind).toBe("battle");
    const before = animationStats();
    expect(before.below?.mounted).toBeGreaterThan(0);

    world.resizeViewport(960, 544);
    step();
    step();
    expect(animationStats()).toEqual(before);

    step(BTN.CIRCLE);
    step();
    for (let guard = 0; world.probes().state.scene && guard < 30; guard++) step();
    expect(world.probes().state.scene).toBeNull();
    step();
    expect(animationStats().below!.created).toBeGreaterThan(before.below!.created);
  }, 30_000);

  test("shows a fatal content error and keeps the reducer frozen", async () => {
    const world = await bootGameWorld(appBundle("r2-ui"), 60, { __r2FatalTransfer: true });
    const step = (): void => {
      world.frame(0, 0x8080);
      world.tick();
    };
    step();

    const failed = structuredClone(world.probes().state);
    expect(failed.interp.error).toEqual({
      kind: "content",
      message: "transfer in r2-ui-field/fatal-transfer: map variable must hold a non-empty string",
    });
    const tree = world.getTree();
    expect(treeHasText(tree, "EVENT ERROR")).toBe(true);
    expect(treeHasText(tree, "transfer in r2-ui-field/fatal-transfer:")).toBe(true);
    expect(JSON.stringify(tree)).toContain("rpgkit-fatal-error");

    step();
    const frozen = world.probes().state;
    expect(frozen.frame).toBeGreaterThan(failed.frame);
    expect(frozen.interp).toEqual(failed.interp);
    expect(frozen.move).toEqual(failed.move);
  });
});
