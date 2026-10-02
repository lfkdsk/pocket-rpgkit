// W2+W3 bounded-residency regression: the real GameView, connected-world
// renderer and cache driver run together on a line of twelve placed maps.
// The sim walks the player the whole line and back (22 crossings) and
// samples residency EVERY frame — including the frames between map
// switches, where transient peaks show up — and asserts every session and
// terrain layer stays bounded by the working set rather than growing with
// the visit count. This is the component repo's own acceptance; it does not
// depend on the game repo.

import { describe, expect, test } from "bun:test";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { bootGameWorld, installGameSimIsolation } from "./helpers/sim-session.ts";
import { MAP_IDS } from "./fixtures/world-bounded/fixture-data.ts";
import { validateWorldLayout } from "../src/engine/world-layout.ts";
import { WORLD_BOUNDED_PROJECT } from "./fixtures/world-bounded/fixture-data.ts";
import type { WorldCacheStats } from "../src/ui/world-cache-driver.ts";
import type { WorldStreamedTerrainStats } from "../src/ui/WorldStreamedTerrain.tsx";

const preflight = appPreflight("world-bounded");
if (!preflight.ok) console.warn(`world-bounded sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

interface FixtureStats {
  driver?: WorldCacheStats;
  ground?: WorldStreamedTerrainStats;
  upper?: WorldStreamedTerrainStats;
}

const readStats = (): FixtureStats =>
  structuredClone((globalThis as { __worldBoundedStats?: FixtureStats }).__worldBoundedStats ?? {});

interface ResidencySnapshot {
  mapId: string;
  // Session layers (driver stats).
  maps: number;
  worlds: number;
  tables: number;
  staged: number;
  pending: number;
  preparing: number;
  runtime: number;
  repoCached: number;
  parsedKeep: number;
  compiledKeep: number;
  // Terrain node/texture residency, per band.
  groundTextures: number;
  groundResident: number;
  groundPooled: number;
  groundCreated: number;
  upperTextures: number;
  upperResident: number;
  upperPooled: number;
  upperCreated: number;
  // Renderer.
  visibleMaps: number;
  driverVisible: number;
}

const snapshot = (mapId: string): ResidencySnapshot => {
  const s = readStats();
  return {
    mapId,
    maps: s.driver?.maps ?? 0,
    worlds: s.driver?.worlds ?? 0,
    tables: s.driver?.tables ?? 0,
    staged: s.driver?.staged ?? 0,
    pending: s.driver?.pending ?? 0,
    preparing: s.driver?.preparing ?? 0,
    runtime: s.driver?.runtime ?? 0,
    repoCached: s.driver?.repoCached ?? 0,
    parsedKeep: s.driver?.parsedKeep.length ?? 0,
    compiledKeep: s.driver?.compiledKeep.length ?? 0,
    groundTextures: s.ground?.textures ?? 0,
    groundResident: s.ground?.resident ?? 0,
    groundPooled: s.ground?.pooled ?? 0,
    groundCreated: s.ground?.created ?? 0,
    upperTextures: s.upper?.textures ?? 0,
    upperResident: s.upper?.resident ?? 0,
    upperPooled: s.upper?.pooled ?? 0,
    upperCreated: s.upper?.created ?? 0,
    visibleMaps: s.ground?.visibleMaps.length ?? 0,
    driverVisible: s.driver?.visible.length ?? 0,
  };
};

const max = (values: readonly number[]): number => values.reduce((a, b) => Math.max(a, b), 0);

/** Layers whose residency the revisit pass must not grow. `created` is a
 *  cumulative counter, so it is bounded by a constant cap instead. */
const REVISIT_LAYERS = [
  "maps", "worlds", "tables", "staged", "pending", "preparing", "runtime", "repoCached",
  "groundTextures", "groundResident", "groundPooled", "groundCreated",
  "upperTextures", "upperResident", "upperPooled", "upperCreated",
] as const;
type RevisitLayer = (typeof REVISIT_LAYERS)[number];

simDescribe("connected world + cache driver bounded residency", () => {
  test("the layout validates", () => {
    expect(() => validateWorldLayout(WORLD_BOUNDED_PROJECT.worldLayout!)).not.toThrow();
  });

  test("walking the line and back keeps every layer bounded", async () => {
    const world = await bootGameWorld(appBundle("world-bounded"), 60, undefined, undefined, {
      width: 480,
      height: 272,
    });
    const step = (buttons: number): void => {
      world.frame(buttons, 0x8080);
      world.tick();
    };

    // One idle frame so the driver's first sync publishes stats.
    step(0);
    expect(readStats().driver).toBeDefined();
    expect(readStats().ground).toBeDefined();
    expect(readStats().upper).toBeDefined();

    /** Hold `direction` until the active map id changes (or the frame budget
     *  runs out). Returns EVERY frame's snapshot, so transient peaks between
     *  map switches are captured, not just the switch instant. */
    const walkUntilMapChange = (
      direction: number,
      fromMap: string,
      budget = 240,
    ): ResidencySnapshot[] => {
      const frames: ResidencySnapshot[] = [];
      for (let f = 0; f < budget; f++) {
        step(direction);
        frames.push(snapshot(world.probes().state.mapId));
        if (world.probes().state.mapId !== fromMap) return frames;
      }
      throw new Error(`walkUntilMapChange: never left ${fromMap}`);
    };

    // Eastbound: walk the whole line. Each crossing is ~16 frames.
    const eastbound: ResidencySnapshot[] = [];
    for (let i = 0; i < MAP_IDS.length - 1; i++) {
      eastbound.push(...walkUntilMapChange(BTN.RIGHT, MAP_IDS[i]!));
    }
    expect(world.probes().state.mapId).toBe(MAP_IDS[MAP_IDS.length - 1]!);

    // Westbound: walk all the way back.
    const westbound: ResidencySnapshot[] = [];
    for (let i = MAP_IDS.length - 1; i > 0; i--) {
      westbound.push(...walkUntilMapChange(BTN.LEFT, MAP_IDS[i]!));
    }
    expect(world.probes().state.mapId).toBe(MAP_IDS[0]!);

    // Twelve maps in a line: 11 crossings each way, 22 total.
    const crossings = (frames: readonly ResidencySnapshot[]): number =>
      frames.filter((s, i) => i === 0 || s.mapId !== frames[i - 1]!.mapId).length - 1;
    expect(crossings(eastbound)).toBe(MAP_IDS.length - 1);
    expect(crossings(westbound)).toBe(MAP_IDS.length - 1);

    const all = [...eastbound, ...westbound];

    // --- Session layers follow their keep-sets, every frame ---
    // The parsed layer (MapDefs + repository bytes) follows parsedKeep.
    for (const s of all) {
      expect(s.maps).toBeLessThanOrEqual(s.parsedKeep);
      expect(s.repoCached).toBeLessThanOrEqual(s.parsedKeep);
      expect(s.preparing).toBeLessThanOrEqual(s.parsedKeep);
    }
    // The compiled layer (worlds + passage tables) follows compiledKeep.
    for (const s of all) {
      expect(s.worlds).toBeLessThanOrEqual(s.compiledKeep);
      expect(s.tables).toBeLessThanOrEqual(s.compiledKeep);
      expect(s.staged).toBeLessThanOrEqual(s.compiledKeep);
      expect(s.pending).toBeLessThanOrEqual(s.compiledKeep);
    }
    // The mutable layer (runtime passage overrides) follows the active map.
    for (const s of all) expect(s.runtime).toBeLessThanOrEqual(1);

    // --- Bounded by a constant, not by the visit count ---
    // Twelve maps are visited (22 crossings with the return), yet the
    // session layers stay at the compiled keep-set capacity (active + the
    // one imminent neighbour) instead of growing with the visit count. The
    // line is wider than the 480px viewport, so maps behind the player
    // are evicted.
    expect(max(all.map((s) => s.maps))).toBeLessThanOrEqual(3);
    expect(max(all.map((s) => s.repoCached))).toBeLessThanOrEqual(4);
    expect(max(all.map((s) => s.worlds))).toBeLessThanOrEqual(2); // active + ≤1 imminent
    expect(max(all.map((s) => s.tables))).toBeLessThanOrEqual(2);
    expect(max(all.map((s) => s.staged))).toBeLessThanOrEqual(2);
    expect(max(all.map((s) => s.pending))).toBeLessThanOrEqual(2);
    expect(max(all.map((s) => s.preparing))).toBeLessThanOrEqual(10); // ≤ visible set
    expect(max(all.map((s) => s.runtime))).toBeLessThanOrEqual(1);

    // --- Terrain textures and nodes: bounded by the viewport, not visits ---
    // Each map is one 256px chunk; the viewport + margin shows at most a
    // handful of maps at once. The pool frees chunks as the camera moves.
    // `created` is the cumulative node total (resident + pooled): it must
    // stay at the visible-set size, so a renderer that stops reusing its
    // pool (created grows with every crossing) fails this cap. 12 leaves
    // headroom for the hysteresis window without allowing visit-count
    // growth. The upper band carries a real (non-null) canopy texture per
    // map, so its residency path is exercised too.
    const TEX_CAP = 12;
    expect(max(all.map((s) => s.groundTextures))).toBeLessThanOrEqual(TEX_CAP);
    expect(max(all.map((s) => s.groundResident))).toBeLessThanOrEqual(TEX_CAP);
    expect(max(all.map((s) => s.groundCreated))).toBeLessThanOrEqual(TEX_CAP);
    expect(max(all.map((s) => s.upperTextures))).toBeLessThanOrEqual(TEX_CAP);
    expect(max(all.map((s) => s.upperResident))).toBeLessThanOrEqual(TEX_CAP);
    expect(max(all.map((s) => s.upperCreated))).toBeLessThanOrEqual(TEX_CAP);
    // The upper fixture really loads upper resources.
    expect(max(all.map((s) => s.upperTextures))).toBeGreaterThan(0);
    expect(max(all.map((s) => s.upperResident))).toBeGreaterThan(0);

    // --- Node accounting: every created node is either live or pooled ---
    // Nodes are never destroyed, so resident + pooled must equal the
    // cumulative created count in every frame. A leak or a double release
    // breaks this; a renderer that stops reusing its pool still satisfies
    // it but blows the created cap above.
    for (const s of all) {
      expect(s.groundResident + s.groundPooled).toBe(s.groundCreated);
      expect(s.upperResident + s.upperPooled).toBe(s.upperCreated);
    }

    // --- Revisit does not grow residency ---
    // The westbound pass revisits every map; its max residency must not
    // exceed the eastbound pass's (the working set is the same size).
    for (const layer of REVISIT_LAYERS) {
      const eastMax = max(eastbound.map((s) => s[layer]));
      const westMax = max(westbound.map((s) => s[layer]));
      expect(westMax, `revisit grew ${layer}: east=${eastMax} west=${westMax}`)
        .toBeLessThanOrEqual(eastMax);
    }

    // --- The driver and the renderer agree on what is visible ---
    // Both derive the visible set from the same component-world camera;
    // the renderer adds a small texture margin, so it may report one map
    // more than the driver's logical set. The driver's parsed keep-set is
    // structurally a superset of its own visible set.
    for (const s of all) {
      expect(s.visibleMaps).toBeGreaterThan(0);
      expect(s.driverVisible).toBeGreaterThan(0);
      expect(s.parsedKeep).toBeGreaterThanOrEqual(s.driverVisible);
    }
  }, 60_000);
});
