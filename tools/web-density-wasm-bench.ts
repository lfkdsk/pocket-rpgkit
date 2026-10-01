// Measures the production browser core's incremental raster path at matching
// 1x/2x build, core, and output densities. JavaScript update cost is measured
// separately by web-density-quickjs-bench.rs; this file isolates WASM raster
// plus the framebuffer copy performed by tools/web/player.js.
import { join, resolve } from "node:path";
import { createWasmUi } from "../vendor/pocketjs/hosts/web/wasm-ops.js";

const ROOT = resolve(import.meta.dir, "..");
const WASM = join(ROOT, "vendor", "pocketjs", "hosts", "web", "pocketjs.wasm");
const VIEWPORT = { width: 480, height: 272 } as const;
const DOWN = 0x0040;
const LEFT = 0x0080;
const RIGHT = 0x0020;
const ANALOG_CENTER = 0x8080;

interface State {
  mapId: string;
  move: { px: number; py: number };
  scene?: { kind?: string };
}

interface BenchWorld {
  step(buttons: number): void;
  render(): Uint8Array;
  state(): State;
}

interface Sample {
  rasterMs: number;
  copyMs: number;
}

let wasmBytes: ArrayBuffer | undefined;

async function boot(bundle: string, density: number, battle: boolean): Promise<BenchWorld> {
  wasmBytes ??= await Bun.file(WASM).arrayBuffer();
  const wasm = await createWasmUi(wasmBytes, {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    rasterDensity: density,
  });
  const globals = globalThis as Record<string, unknown>;
  globals.ui = wasm.ops;
  globals.__pak = await Bun.file(bundle + ".pak").arrayBuffer();
  globals.__simHz = 60;
  globals.__pocketApp = "r2-ui";
  globals.frame = undefined;
  globals.offload = undefined;
  globals.audio = undefined;
  globals.db = undefined;
  globals.fs = undefined;
  globals.__r2Battle = battle;
  globals.__r2BattleDelay = battle ? 1 : 0;
  const source = await Bun.file(bundle + ".js").text();
  (0, eval)(source);
  const frame = globals.frame as ((buttons: number, analog: number) => void) | undefined;
  if (typeof frame !== "function") throw new Error(`${bundle}.js installed no frame()`);
  return {
    step(buttons) {
      frame(buttons, ANALOG_CENTER);
      wasm.tick();
    },
    render: () => wasm.renderScaledIncremental(density),
    state: () => (globalThis as { __rpgSessionState: State }).__rpgSessionState,
  };
}

function sample(world: BenchWorld, buttons: number, target: Uint8Array): Sample {
  world.step(buttons);
  const rasterStart = performance.now();
  const frame = world.render();
  const copyStart = performance.now();
  target.set(frame);
  const copyEnd = performance.now();
  return { rasterMs: copyStart - rasterStart, copyMs: copyEnd - copyStart };
}

function percentile(values: number[], fraction: number): number {
  values.sort((a, b) => a - b);
  return values[Math.ceil((values.length - 1) * fraction)]!;
}

function printStats(density: number, pass: string, name: string, samples: Sample[]): void {
  const raster = samples.map((entry) => entry.rasterMs);
  const copy = samples.map((entry) => entry.copyMs);
  const total = samples.map((entry) => entry.rasterMs + entry.copyMs);
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  console.log(
    `WEBTXT_WASM density=${density} pass=${pass} case=${name} n=${samples.length} ` +
      `framebuffer=${VIEWPORT.width * VIEWPORT.height * 4 * density * density}B ` +
      `raster_mean=${mean(raster).toFixed(4)}ms raster_p95=${percentile(raster, 0.95).toFixed(4)}ms ` +
      `copy_mean=${mean(copy).toFixed(4)}ms copy_p95=${percentile(copy, 0.95).toFixed(4)}ms ` +
      `total_mean=${mean(total).toFixed(4)}ms total_p95=${percentile(total, 0.95).toFixed(4)}ms`,
  );
}

function target(density: number): Uint8Array {
  return new Uint8Array(VIEWPORT.width * VIEWPORT.height * 4 * density * density);
}

async function walking(bundle: string, density: number, pass: string): Promise<void> {
  const world = await boot(bundle, density, false);
  const pixels = target(density);
  for (let i = 0; i < 90; i++) sample(world, 0, pixels);
  const before = world.state();
  const samples = Array.from({ length: 180 }, () => sample(world, DOWN, pixels));
  const after = world.state();
  if (before.mapId !== after.mapId || after.move.py <= before.move.py) {
    throw new Error("walking workload did not move south on one map");
  }
  printStats(density, pass, "walk", samples);
}

async function transfers(bundle: string, density: number, pass: string): Promise<void> {
  const world = await boot(bundle, density, false);
  const pixels = target(density);
  for (let i = 0; i < 90; i++) sample(world, 0, pixels);
  const firstMap = world.state().mapId;
  const samples: Sample[] = [];
  for (let transfer = 0; transfer < 16; transfer++) {
    const before = world.state().mapId;
    const button = before === firstMap ? RIGHT : LEFT;
    let changed = false;
    for (let frame = 0; frame < 80; frame++) {
      const measured = sample(world, button, pixels);
      if (world.state().mapId !== before) {
        samples.push(measured);
        changed = true;
        break;
      }
    }
    if (!changed) throw new Error("map-transfer workload did not cross maps");
    sample(world, 0, pixels);
  }
  printStats(density, pass, "map-transfer", samples);
}

async function battle(bundle: string, density: number, pass: string): Promise<void> {
  const world = await boot(bundle, density, true);
  const pixels = target(density);
  let entered = false;
  for (let frame = 0; frame < 180; frame++) {
    sample(world, 0, pixels);
    if (world.state().scene?.kind === "battle") {
      entered = true;
      break;
    }
  }
  if (!entered) throw new Error("battle workload never entered battle");
  for (let frame = 0; frame < 30; frame++) sample(world, 0, pixels);
  const samples = Array.from({ length: 180 }, () => sample(world, 0, pixels));
  if (world.state().scene?.kind !== "battle") throw new Error("battle workload exited unexpectedly");
  printStats(density, pass, "battle", samples);
}

async function main(): Promise<void> {
  const scratch = resolve(process.argv[2] ?? join(ROOT, "dist", "web-density-bench"));
  for (const [density, pass] of [[1, "a"], [2, "a"], [2, "b"], [1, "b"]] as const) {
    const bundle = join(scratch, `density-${density}`, "r2-ui");
    await walking(bundle, density, pass);
    await transfers(bundle, density, pass);
    await battle(bundle, density, pass);
  }
}

await main();
