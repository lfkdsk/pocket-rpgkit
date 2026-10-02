// tools/rpgkit-check/src/shot/render.ts — the screenshot driver. Boots the
// rpgkit-shot sim fixture (tests/fixtures/rpgkit-shot) on the deterministic
// wasm sim host with the project injected as a global, renders the
// schematic at each requested resolution, and writes PNGs. The fixture does
// the engine work (passage table with live bodies, active-page selection);
// this module only owns boot/encode/write.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { bootWorld } from "../../../../vendor/pocketjs/hosts/sim/sim.ts";
import { encodePNG } from "../../../../vendor/pocketjs/tests/png.ts";
import type { SessionOptions } from "../../../../src/engine/session.ts";
import type { Dir, Project } from "../../../../src/engine/types.ts";
import type { ShotConfig, ShotSwitchBank } from "../../../../tests/fixtures/rpgkit-shot/rpgkit-shot.tsx";

export interface ShotResolution {
  width: number;
  height: number;
}

/** PSP (480x272) and desktop (960x544). */
export const DEFAULT_RESOLUTIONS: readonly ShotResolution[] = [
  { width: 480, height: 272 },
  { width: 960, height: 544 },
];

export interface RenderShotsOptions {
  map: string;
  x: number;
  y: number;
  dir?: Dir;
  sw?: ShotSwitchBank;
  /** "map@x,y" node keys to tint as reachable (e.g. from the reach check). */
  reach?: readonly string[];
  resolutions?: readonly ShotResolution[];
  /** Game-owned registrations loaded by the CLI's --session module. */
  sessionOptions?: SessionOptions;
}

export interface ShotOutput {
  resolution: ShotResolution;
  file: string;
  bytes: number;
  sha256: string;
}

function repoRoot(): string {
  // tools/rpgkit-check/src/shot -> repo root is four levels up.
  return resolve(import.meta.dir, "../../../..");
}

/** Whether screenshots can be taken: the fixture bundle (`bun run
 *  build:example`) and the wasm core (`bun run build:wasm`) must exist. */
export function shotPreflight(root: string = repoRoot()): { ok: true } | { ok: false; reason: string } {
  const bundle = join(root, "dist", "rpgkit-shot.js");
  if (!existsSync(bundle)) return { ok: false, reason: `missing ${bundle} — run \`bun run build:example\`` };
  const wasm = join(root, "vendor", "pocketjs", "hosts", "web", "pocketjs.wasm");
  if (!existsSync(wasm)) return { ok: false, reason: `missing ${wasm} — run \`bun run build:wasm\`` };
  return { ok: true };
}

/** Render one PNG per resolution into outDir. Filenames are
 *  `<map>-<x>-<y>.<width>x<height>.png`. Deterministic: the same project +
 *  options produce byte-identical PNGs. */
export async function renderShots(
  project: Project,
  options: RenderShotsOptions,
  outDir: string,
  root: string = repoRoot(),
): Promise<ShotOutput[]> {
  const preflight = shotPreflight(root);
  if (!preflight.ok) throw new Error(`rpgkit-check shot: ${preflight.reason}`);
  mkdirSync(outDir, { recursive: true });
  const resolutions = options.resolutions ?? DEFAULT_RESOLUTIONS;
  const bundle = join(root, "dist", "rpgkit-shot");
  const outputs: ShotOutput[] = [];
  for (const resolution of resolutions) {
    const cfg: ShotConfig = {
      project,
      map: options.map,
      x: options.x,
      y: options.y,
      dir: options.dir,
      sw: options.sw,
      reach: options.reach,
      sessionOptions: options.sessionOptions,
      resolution,
    };
    const world = await bootWorld(
      bundle,
      60,
      { __rpgkitShot: cfg },
      undefined,
      { width: resolution.width, height: resolution.height },
    );
    world.frame(0);
    for (let t = 0; t < world.ticksPerFrame; t++) world.tick();
    const fb = world.render();
    const file = join(outDir, `${options.map}-${options.x}-${options.y}.${resolution.width}x${resolution.height}.png`);
    const png = encodePNG(fb, resolution.width, resolution.height);
    writeFileSync(file, png);
    outputs.push({
      resolution,
      file,
      bytes: png.length,
      sha256: createHash("sha256").update(png).digest("hex"),
    });
  }
  return outputs;
}
