// tests/helpers/sim-session.ts — lifecycle guard for sim tests that boot a
// GameView bundle (examples/sunstone, examples/grow play mode).
//
// A cold boot may take long enough that Bun's per-test timeout fires while
// the async boot keeps running and replaces the process-global probes under
// the next test's world. Every sim file installs the longer timeout and the
// reset hooks below; every boot clears stale probes and returns a world
// bound to its own session, which throws if a test drives a superseded one.

import { afterEach, beforeEach, setDefaultTimeout } from "bun:test";
import { bootWorld, type SimViewportOptions, type SimWorld } from "../../vendor/pocketjs/hosts/sim/sim.ts";
import type { SessionState } from "../../src/engine/session.ts";
import type { CameraState } from "../../src/engine/types.ts";

interface GameGlobals {
  frame?: unknown;
  ui?: unknown;
  __rpgSessionState?: SessionState;
  __rpgGameCamera?: CameraState;
  __rpgkitBoot?: unknown;
  __rpgkitDemo?: unknown;
  __rpgSimSessionToken?: object;
}

export interface GameProbes {
  state: SessionState;
  camera: CameraState;
}

export interface BoundGameWorld extends SimWorld {
  probes: () => GameProbes;
}

const globals = globalThis as GameGlobals;

export function resetGameGlobals(): void {
  delete globals.__rpgSessionState;
  delete globals.__rpgGameCamera;
  delete globals.__rpgkitBoot;
  delete globals.__rpgkitDemo;
  delete globals.__rpgSimSessionToken;
}

export function installGameSimIsolation(): void {
  setDefaultTimeout(15_000);
  beforeEach(resetGameGlobals);
  afterEach(resetGameGlobals);
}

function readProbes(): GameProbes | null {
  return globals.__rpgSessionState && globals.__rpgGameCamera
    ? { state: globals.__rpgSessionState, camera: globals.__rpgGameCamera }
    : null;
}

/** Boot a GameView bundle (an absolute path from appBundle()). */
export async function bootGameWorld(
  bundle: string,
  hz: number,
  extraGlobals?: Record<string, unknown>,
  mutateOps?: (ops: Record<string, unknown>) => void,
  viewport?: SimViewportOptions,
): Promise<BoundGameWorld> {
  resetGameGlobals();
  const token = {};
  let opsIdentity: Record<string, unknown> | undefined;
  const world = await bootWorld(
    bundle,
    hz,
    { ...extraGlobals, __rpgSimSessionToken: token },
    (ops) => {
      opsIdentity = ops;
      mutateOps?.(ops);
    },
    viewport,
  );
  const frameIdentity = globals.frame;
  if (
    !readProbes() ||
    typeof frameIdentity !== "function" ||
    globals.__rpgSimSessionToken !== token ||
    globals.ui !== opsIdentity
  ) {
    throw new Error(`sim: ${bundle} boot did not install its session probes`);
  }

  const current = (): GameProbes => {
    const probes = readProbes();
    if (
      !probes ||
      globals.__rpgSimSessionToken !== token ||
      globals.frame !== frameIdentity ||
      globals.ui !== opsIdentity
    ) {
      throw new Error("sim: attempted to drive a superseded world");
    }
    return probes;
  };

  return {
    ...world,
    frame: (...args) => {
      current();
      world.frame(...args);
      current();
    },
    tick: () => {
      current();
      world.tick();
      current();
    },
    render: () => {
      current();
      return world.render();
    },
    resizeViewport: (width, height) => {
      current();
      world.resizeViewport(width, height);
      current();
    },
    getTree: () => {
      current();
      const tree = world.getTree();
      current();
      return tree;
    },
    probes: current,
  };
}
