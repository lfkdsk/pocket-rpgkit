// tests/helpers/boot.ts — boot the built example bundles (dist/<name>.js)
// on PocketJS's deterministic wasm sim host from the vendored submodule.
//
// The legacy meadow helper delegates to vendor/pocketjs/hosts/sim/sim.ts so
// every external-project bundle uses the same boot lifecycle. The bundle and
// pak live in THIS repo's dist/, and the wasm core lives in vendor/pocketjs.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { bootWorld } from "../../vendor/pocketjs/hosts/sim/sim.ts";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DIST = join(ROOT, "dist");
const WASM_PATH = join(ROOT, "vendor", "pocketjs", "hosts", "web", "pocketjs.wasm");

/** Whether the example sim tests can run: they need the built bundle
 *  (`bun run build:example`) and the vendored wasm core
 *  (`bun run build:wasm`). A fresh `bun install && bun test` reports the
 *  reducer suites green and skips these with the missing-artifact reason. */
export function simPreflight(): { ok: true } | { ok: false; reason: string } {
  const bundle = join(DIST, "meadow.js");
  if (!existsSync(bundle)) {
    return { ok: false, reason: `missing ${bundle} — run \`bun run build:example\`` };
  }
  if (!existsSync(WASM_PATH)) {
    return { ok: false, reason: `missing ${WASM_PATH} — run \`bun run build:wasm\`` };
  }
  return { ok: true };
}

export interface SimWorld {
  frame: (buttons: number, analog?: number) => void;
  tick: () => void;
  render: () => Uint8Array;
  resizeViewport: (w: number, h: number) => void;
}

/** FNV-1a 32 over RGBA bytes, identical to vendor hosts/sim sim.ts fnv1a. */
export function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export async function bootExample(
  hz = 60,
  extraGlobals?: Record<string, unknown>,
  viewport: { width: number; height: number } = { width: 480, height: 272 },
): Promise<SimWorld> {
  for (const [path, hint] of [
    [join(DIST, "meadow.js"), "run `bun run build:example meadow`"],
    [WASM_PATH, "run `(cd vendor/pocketjs && bun tools/wasm.ts)`"],
  ] as const) {
    if (!existsSync(path)) throw new Error(`missing ${path} — ${hint}`);
  }
  return bootWorld(appBundle("meadow"), hz, extraGlobals, undefined, viewport);
}

export interface ExampleState {
  frame: number;
  mapId: string;
  move: { tx: number; ty: number; px: number; py: number; facing: number; phase: number; walking: boolean };
  sw: { gold: number; items: Record<string, number>; switches: Record<string, boolean> };
  interp: { modal: unknown; cues: unknown[]; frame: number };
}

/** The live reducer state the example app exposes. */
export function exampleState(): any {
  return (globalThis as any).__rpgkitExample.state() as ExampleState;
}

/** Whether a sim test for example `name` can run (bundle + wasm core). */
export function appPreflight(name: string): { ok: true } | { ok: false; reason: string } {
  const bundle = join(DIST, `${name}.js`);
  if (!existsSync(bundle)) return { ok: false, reason: `missing ${bundle} — run \`bun run build:example ${name}\`` };
  if (!existsSync(WASM_PATH)) return { ok: false, reason: `missing ${WASM_PATH} — run \`bun run build:wasm\`` };
  return { ok: true };
}

/** Absolute bundle path (no extension) for the vendored sim's bootWorld,
 *  which boots external-project bundles by path:
 *    bootWorld(appBundle("sunstone"), 60)  */
export function appBundle(name: string): string {
  return join(DIST, name);
}
