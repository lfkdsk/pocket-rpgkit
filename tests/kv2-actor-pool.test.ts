// tests/kv2-actor-pool.test.ts — the per-map growable actor node pool.
//
// KV1 prebuilt one image node per GameAssets.maxActors slot, so a project
// whose biggest map has 205 events mounted 205 nodes on EVERY map (and
// rebuilt them on every battle-exit remount). KV2 sizes the pool to the
// current map's event count, grows it (delta nodes only) on transfer to a
// denser map, and never shrinks. These sim tests boot the built r2-ui
// fixture (4 events on the field, 21 on the second map) and assert the
// pool size, node identity across transfers, multi-hz and rewind visual
// consistency through the real DevTools tree and framebuffers.

import { describe, expect, test } from "bun:test";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { fnv1a } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import {
  bootGameWorld,
  installGameSimIsolation,
  type BoundGameWorld,
} from "./helpers/sim-session.ts";

const preflight = appPreflight("r2-ui");
if (!preflight.ok) console.warn(`kv2 actor pool tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

const FIELD_MAP = "r2-ui-field";
const SECOND_MAP = "r2-ui-second";
const BTN_RIGHT = 0x0020;
const BTN_LEFT = 0x0080;
const BTN_LTRIGGER = 0x0100;

function pump(world: BoundGameWorld, frames: number, buttons = 0): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(buttons);
    for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  }
}

interface TreeNode {
  i: number;
  t: string;
  n?: string;
  k?: TreeNode[];
}

function findNode(tree: unknown, name: string): TreeNode | undefined {
  const node = tree as TreeNode | undefined;
  if (node?.n === name) return node;
  for (const child of node?.k ?? []) {
    const found = findNode(child, name);
    if (found) return found;
  }
  return undefined;
}

/** Direct image children of the upper-plane root: the player plus the
 *  actor pool (upper rows are views, above-tile sprites live inside rows). */
function actorImageCount(world: BoundGameWorld, mapId: string): number {
  const root = findNode(world.getTree(), `rpgkit-actors-${mapId}`);
  if (!root) return -1;
  return (root.k ?? []).filter((child) => child.t === "image").length;
}

function actorIds(world: BoundGameWorld, mapId: string): Record<string, number> {
  const root = findNode(world.getTree(), `rpgkit-actors-${mapId}`);
  const ids: Record<string, number> = {};
  for (const child of root?.k ?? []) {
    if (child.t === "image" && child.n?.startsWith("rpgkit-npc-")) ids[child.n] = child.i;
  }
  return ids;
}

async function bootKv2(viewport = { width: 480, height: 272 }): Promise<BoundGameWorld> {
  return bootGameWorld(appBundle("r2-ui"), 60, { __r2Kv2: true }, undefined, viewport);
}

simDescribe("KV2 per-map actor pool", () => {
  test("rejects a sharded start map that exceeds maxActors", async () => {
    // The r2-ui field has 4 events; the cap-repro fixture serves the same
    // project as a ProjectShell with maxActors 1. The start map's slots are
    // precached and mounted directly, so they must pass the same cap check
    // as a cache miss instead of silently overshooting the resource budget.
    await expect(
      bootGameWorld(appBundle("r2-ui"), 60, { __r2CapRepro: true }),
    ).rejects.toThrow("needs 4 actor slots; GameAssets.maxActors is 1");
  });

  test("mounts one node per current-map event, not the global max", async () => {
    const world = await bootKv2();
    pump(world, 5);
    // The field has 4 events; the second map's 21 must not be prebuilt.
    expect(world.probes().state.mapId).toBe(FIELD_MAP);
    expect(actorImageCount(world, FIELD_MAP)).toBe(5); // 4 actors + player
    const ids = actorIds(world, FIELD_MAP);
    expect(Object.keys(ids).sort()).toEqual([
      "rpgkit-npc-canopy-npc",
      "rpgkit-npc-late-npc",
      "rpgkit-npc-to-second-map",
      "rpgkit-npc-walking-npc",
    ]);
  });

  test("grows on transfer to a denser map and never shrinks", async () => {
    const world = await bootKv2();
    pump(world, 5);
    expect(actorImageCount(world, FIELD_MAP)).toBe(5);

    // Walk right onto the playerTouch transfer to the 21-event map.
    pump(world, 60, BTN_RIGHT);
    pump(world, 30);
    expect(world.probes().state.mapId).toBe(SECOND_MAP);
    expect(actorImageCount(world, SECOND_MAP)).toBe(22); // 21 actors + player

    // Walk left onto the return transfer; the pool stays grown.
    pump(world, 60, BTN_LEFT);
    pump(world, 30);
    expect(world.probes().state.mapId).toBe(FIELD_MAP);
    expect(actorImageCount(world, FIELD_MAP)).toBe(22); // not 5: no shrink
    // Only the field's 4 events are bound (named); the rest are parked hidden.
    expect(Object.keys(actorIds(world, FIELD_MAP))).toHaveLength(4);
  });

  test("does not rebuild existing actor nodes across transfers", async () => {
    const world = await bootKv2();
    pump(world, 5);
    const before = actorIds(world, FIELD_MAP);
    const beforeIds = new Set(Object.values(before));

    pump(world, 60, BTN_RIGHT);
    pump(world, 30);
    expect(world.probes().state.mapId).toBe(SECOND_MAP);
    const second = actorIds(world, SECOND_MAP);
    const secondIds = new Set(Object.values(second));
    // The field's nodes are REBOUND to the denser map's first slots, not
    // rebuilt: every field node id is still in service.
    for (const id of beforeIds) expect(secondIds.has(id)).toBe(true);
    // Growth added new nodes for the remaining 17 events.
    expect(secondIds.size).toBeGreaterThan(beforeIds.size);

    pump(world, 60, BTN_LEFT);
    pump(world, 30);
    expect(world.probes().state.mapId).toBe(FIELD_MAP);
    const after = actorIds(world, FIELD_MAP);
    // Every field actor got its original native node back across the round trip.
    for (const [name, id] of Object.entries(before)) {
      expect(after[name], name).toBe(id);
    }
  });

  test("grows the pool when a battle closes onto a denser map, without rebuilding", async () => {
    // KV2+KB6 merge: the world (and its actor pool) stays mounted across the
    // battle, hidden with display:none. When the battle's win branch transfers
    // to the 21-event second map, the pool must GROW (delta nodes only) and
    // rebind the field's nodes, not rebuild them.
    const world = await bootGameWorld(appBundle("r2-ui"), 60, { __r2Kv2BattleGrow: true });
    const step = (buttons = 0): void => {
      world.frame(buttons, 0x8080);
      world.tick();
    };

    // The field has 5 events (4 NPCs + the battle autorun); record their
    // native node ids before the battle opens.
    const before = actorIds(world, FIELD_MAP);
    const beforeIds = new Set(Object.values(before));
    expect(actorImageCount(world, FIELD_MAP)).toBe(6); // 5 actors + player

    // The autorun battle opens within a few frames.
    for (let guard = 0; !world.probes().state.scene && guard < 30; guard++) step();
    expect(world.probes().state.scene?.kind).toBe("battle");

    // Win the toy battle; its onWin branch transfers to the denser map.
    step(BTN.CIRCLE);
    for (let guard = 0; world.probes().state.scene && guard < 30; guard++) step();
    expect(world.probes().state.scene).toBeNull();
    for (let guard = 0; world.probes().state.mapId !== SECOND_MAP && guard < 30; guard++) step();
    expect(world.probes().state.mapId).toBe(SECOND_MAP);

    // The pool GREW to the denser map's size and rebound the field's nodes
    // instead of rebuilding them: every field node id is still in service.
    expect(actorImageCount(world, SECOND_MAP)).toBe(22); // 21 actors + player
    const second = actorIds(world, SECOND_MAP);
    const secondIds = new Set(Object.values(second));
    for (const id of beforeIds) expect(secondIds.has(id)).toBe(true);
    expect(secondIds.size).toBeGreaterThan(beforeIds.size);
  });

  test("framebuffers match at 60/30/20 Hz across the transfer chain", async () => {
    const RIGHT_SECONDS = 2;
    const SETTLE_SECONDS = 1;
    const LEFT_SECONDS = 2;
    const checkpoints: { hz: number; afterRight: string; afterLeft: string }[] = [];
    for (const hz of [60, 30, 20] as const) {
      const world = await bootGameWorld(appBundle("r2-ui"), hz, { __r2Kv2: true });
      pump(world, RIGHT_SECONDS * hz, BTN_RIGHT);
      pump(world, SETTLE_SECONDS * hz);
      expect(world.probes().state.mapId, `hz ${hz} after right`).toBe(SECOND_MAP);
      const afterRight = fnv1a(world.render());
      pump(world, LEFT_SECONDS * hz, BTN_LEFT);
      pump(world, SETTLE_SECONDS * hz);
      expect(world.probes().state.mapId, `hz ${hz} after left`).toBe(FIELD_MAP);
      checkpoints.push({ hz, afterRight, afterLeft: fnv1a(world.render()) });
    }
    for (const point of checkpoints.slice(1)) {
      expect(point.afterRight, `hz ${point.hz} after right`).toBe(checkpoints[0]!.afterRight);
      expect(point.afterLeft, `hz ${point.hz} after left`).toBe(checkpoints[0]!.afterLeft);
    }
  });

  test("rewind across a transfer restores the map and replay reproduces pixels", async () => {
    const world = await bootKv2();
    // 600 idle frames: attract starts from a clean world (attract frame 0).
    pump(world, 600);
    expect(world.probes().state.mapId).toBe(FIELD_MAP);

    // The tape holds RIGHT: the demo walks onto the transfer. Attract frame
    // 60 is settled on the second map.
    pump(world, 60);
    expect(world.probes().state.mapId).toBe(SECOND_MAP);
    const f60 = fnv1a(world.render());
    pump(world, 70);
    expect(world.probes().state.mapId).toBe(SECOND_MAP);

    // L rewinds 3 s; fewer than 180 attract frames are logged, so it scrubs
    // to attract frame 0 — the pre-transfer field. The REWIND notice overlay
    // paints this frame, so assert the scrubbed state (map + player cell),
    // then let the replay reproduce a settled framebuffer below.
    pump(world, 1, BTN_LTRIGGER);
    expect(world.probes().state.mapId).toBe(FIELD_MAP);
    expect([world.probes().state.move.tx, world.probes().state.move.ty]).toEqual([15, 12]);

    // The replay reproduces the same frame at the same attract offset.
    pump(world, 60);
    expect(world.probes().state.mapId).toBe(SECOND_MAP);
    expect(fnv1a(world.render())).toBe(f60);
  });
});
