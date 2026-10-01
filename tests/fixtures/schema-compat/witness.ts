// tests/fixtures/schema-compat/witness.ts — counterexamples for breaking
// schema generations.
//
//   bun tests/fixtures/schema-compat/witness.ts <engine-root> <case>
//
// Each case is a small document that is valid under both the old and the
// current schema but plays differently, which is why the old generation
// is refused instead of listed as compatible. The fixture directory of
// the refused generation keeps `witness.json`: the case name, the commit
// that recorded it, and the outcome printed by this script when
// <engine-root> is that commit (`git archive <rev> src tools/lib`).
// tests/schema-compat.test.ts runs the same case on the current runtime
// and requires a different outcome.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const WITNESS_CASES = [
  "stale-parallel-battle",
  "variable-beyond-safe-integer",
  "transfer-to-unknown-map",
  "route-through-marker",
] as const;
export type WitnessCase = typeof WITNESS_CASES[number];
export type WitnessOutcome = Record<string, unknown>;

const ground = (w: number, h: number) => new Array(w * h).fill("tiles.0");

function project(events: unknown[]): Record<string, unknown> {
  return {
    format: "rpgkit-project/v1",
    title: "schema witness",
    tileSize: 16,
    start: { map: "a", x: 1, y: 1, dir: "down" },
    sheets: [{ id: "tiles", pak: "tiles", cols: 1, rows: 1, defaultPassage: "pass" }],
    items: [],
    maps: [{ id: "a", name: "A", width: 4, height: 4, sheets: ["tiles"], ground: ground(4, 4), events }],
  };
}

const idle = (frame: number) => ({ buttons: 0, confirmEdge: false, frame });

export async function runWitness(rootArg: string, name: WitnessCase): Promise<WitnessOutcome> {
  const root = resolve(rootArg);
  const sess = await import(join(root, "src/engine/session.ts"));
  const save = await import(join(root, "src/engine/save.ts"));
  const interp = await import(join(root, "src/engine/interpreter.ts"));
  const { validateSchema } = await import(join(root, "src/engine/schema-validate.ts"));
  const schema = JSON.parse(readFileSync(join(root, "src/data/schema.json"), "utf8"));

  if (name === "stale-parallel-battle") {
    // The main event's battle ends by clearing `go`, which deactivates the
    // parallel page whose battle request is still queued behind it.
    const p = project([
      { id: "par", x: 0, y: 0, pages: [{ trigger: "parallel", condition: { switch: "go" }, commands: [{ op: "battle", setup: {} }] }] },
      {
        id: "main",
        x: 3,
        y: 3,
        pages: [
          {
            trigger: "autorun",
            commands: [{ op: "battle", setup: { clear: "go" } }, { op: "switch", id: "main.done", value: true }],
          },
          { trigger: "action", condition: { switch: "main.done" }, commands: [] },
        ],
      },
    ]);
    const started: unknown[] = [];
    const battle = {
      start(ext: unknown, setup: Record<string, unknown>) {
        started.push(setup);
        return { state: { t: 0, clear: setup.clear ?? null, ext }, ext };
      },
      step(state: Record<string, unknown>, _input: unknown, ticks: number) {
        return { ...state, t: (state.t as number) + ticks };
      },
      done(state: Record<string, unknown>) {
        if ((state.t as number) < 3) return null;
        const switches = state.clear === null ? {} : { [state.clear as string]: false };
        return { ext: state.ext, result: "win", switches };
      },
    };
    const session = sess.createSession(p, 60, { battle });
    let state = sess.startSession(p, session, interp.createSwitchState({ switches: { go: true } }));
    for (let frame = 0; frame < 60; frame++) state = sess.stepSession(session, state, idle(frame));
    return {
      schemaErrors: validateSchema(schema, p).length,
      battlesStarted: started,
      mainDone: state.interp.sw.switches["main.done"] === true,
    };
  }

  if (name === "variable-beyond-safe-integer") {
    const p = project([
      { id: "set", x: 0, y: 0, pages: [{ trigger: "autorun", commands: [
        { op: "variable", id: "route", set: { op: "set", value: 1e308 } },
        { op: "erase" },
      ] }] },
    ]);
    const session = sess.createSession(p, 60);
    let state = sess.startSession(p, session);
    for (let frame = 0; frame < 10; frame++) state = sess.stepSession(session, state, idle(frame));
    const snapshot = save.createSnapshot(state.mapId, state.move, state.interp, 0);
    return {
      schemaErrors: validateSchema(schema, p).length,
      route: state.interp.sw.variables.route,
      save: save.encodeEnvelope(snapshot),
    };
  }

  if (name === "route-through-marker") {
    // A walking event's route crosses a sprite-less `blocks: false` marker.
    const p = project([
      { id: "walker", x: 0, y: 2, pages: [{
        trigger: "action",
        blocks: true,
        moveRoute: { steps: ["moveRight", "moveRight"], repeat: false, skippable: false },
        commands: [],
      }] },
      { id: "mat", x: 1, y: 2, pages: [{ trigger: "playerTouch", blocks: false, commands: [] }] },
    ]);
    const session = sess.createSession(p, 60);
    let state = sess.startSession(p, session);
    for (let frame = 0; frame < 120; frame++) state = sess.stepSession(session, state, idle(frame));
    const walker = Object.values(state.chars.chars as Record<string, { id: string; tx: number; ty: number }>)
      .find((c) => c.id.endsWith("walker"))!;
    return { schemaErrors: validateSchema(schema, p).length, walker: { x: walker.tx, y: walker.ty } };
  }

  // transfer-to-unknown-map: a sharded project whose index has no `missing`.
  const repo = await import(join(root, "src/engine/map-repository.ts"));
  const splitter = await import(join(root, "tools/lib/map-project.ts"));
  const p = project([
    { id: "door", x: 0, y: 0, pages: [{ trigger: "autorun", commands: [{ op: "transfer", map: "missing", x: 0, y: 0 }] }] },
  ]);
  const split = splitter.splitProjectMaps(p);
  const files = new Map<string, string>(split.entries.map((e: { path: string; text: string }) => [e.path, e.text]));
  const maps = repo.createJsonMapRepository(split.shell.mapIndex, { read: (entry: string) => files.get(entry) });
  const outcome: WitnessOutcome = { schemaErrors: validateSchema(schema, p).length };
  try {
    const session = sess.createSession(split.shell, 60, maps);
    let state = sess.startSession(split.shell, session);
    for (let frame = 0; frame < 10; frame++) state = sess.stepSession(session, state, idle(frame));
    return { ...outcome, threw: false, error: state.interp.error ?? null, map: state.mapId };
  } catch (error) {
    return { ...outcome, threw: true, message: (error as Error).message };
  }
}

if (import.meta.main) {
  const [root, name] = process.argv.slice(2);
  if (!root || !WITNESS_CASES.includes(name as WitnessCase)) {
    console.error(`usage: bun witness.ts <engine-root> <${WITNESS_CASES.join("|")}>`);
    process.exit(2);
  }
  console.log(JSON.stringify(await runWitness(root, name as WitnessCase)));
}
