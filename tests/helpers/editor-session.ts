// tests/helpers/editor-session.ts — lifecycle guard for sim tests that boot
// the editor bundle (dist/editor.js, `bun run build:editor`).
//
// Same contract as sim-session.ts for GameView bundles: the longer timeout
// and reset hooks keep a slow cold boot from leaking its probes into the
// next test, and every boot returns a world bound to its own session that
// throws if a test drives a superseded one. The editor's probes are the
// three test hooks editor/app.tsx installs on globalThis.

import { afterEach, beforeEach, setDefaultTimeout } from "bun:test";
import { bootWorld, type SimViewportOptions, type SimWorld } from "../../vendor/pocketjs/hosts/sim/sim.ts";
import { appBundle } from "./boot.ts";

interface EditorGlobals {
  frame?: unknown;
  ui?: unknown;
  fs?: unknown;
  __rpgkitEditorState?: () => any;
  __rpgkitEditorInject?: (json: string) => unknown;
  __rpgkitEditorExport?: () => { ok: boolean; errors: unknown[]; text: string };
  __rpgSessionState?: unknown;
  __rpgGameCamera?: unknown;
  __rpgSimSessionToken?: object;
}

export interface EditorProbes {
  state: () => any;
  inject: (json: string) => unknown;
  export: () => { ok: boolean; errors: unknown[]; text: string };
}

export interface BoundEditorWorld extends SimWorld {
  probes: () => EditorProbes;
}

const globals = globalThis as EditorGlobals;

export function resetEditorGlobals(): void {
  // A data.fs test mounts the sim fs namespace on globalThis; unmount it so
  // later suites (and files) see a host without the fs module.
  globals.fs = undefined;
  delete globals.__rpgkitEditorState;
  delete globals.__rpgkitEditorInject;
  delete globals.__rpgkitEditorExport;
  delete globals.__rpgSessionState;
  delete globals.__rpgGameCamera;
  delete globals.__rpgSimSessionToken;
}

export function installEditorSimIsolation(): void {
  setDefaultTimeout(15_000);
  beforeEach(resetEditorGlobals);
  afterEach(resetEditorGlobals);
}

function readProbes(): EditorProbes | null {
  const state = globals.__rpgkitEditorState;
  const inject = globals.__rpgkitEditorInject;
  const exportProject = globals.__rpgkitEditorExport;
  return state && inject && exportProject ? { state, inject, export: exportProject } : null;
}

/** Boot the editor bundle on the wasm sim host. `mutateOps` injects host
 *  op extensions before eval (the svc companion ops in pointer tests). */
export async function bootEditorWorld(
  hz: number,
  extraGlobals?: Record<string, unknown>,
  mutateOps?: (ops: Record<string, unknown>) => void,
  viewport?: SimViewportOptions,
): Promise<BoundEditorWorld> {
  resetEditorGlobals();
  const token = {};
  let opsIdentity: Record<string, unknown> | undefined;
  const world = await bootWorld(
    appBundle("editor"),
    hz,
    { ...extraGlobals, __rpgSimSessionToken: token },
    (ops) => {
      opsIdentity = ops;
      mutateOps?.(ops);
    },
    viewport,
  );
  const initial = readProbes();
  const frameIdentity = globals.frame;
  if (
    !initial ||
    typeof frameIdentity !== "function" ||
    globals.__rpgSimSessionToken !== token ||
    globals.ui !== opsIdentity
  ) {
    throw new Error("sim: editor boot did not install its probes");
  }
  // The app re-installs its hooks on every mount; a different state
  // closure means another boot replaced this world.
  const identity = initial.state;

  const current = (): EditorProbes => {
    const probes = readProbes();
    if (
      !probes ||
      probes.state !== identity ||
      globals.__rpgSimSessionToken !== token ||
      globals.frame !== frameIdentity ||
      globals.ui !== opsIdentity
    ) {
      throw new Error("sim: attempted to drive a superseded editor world");
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
