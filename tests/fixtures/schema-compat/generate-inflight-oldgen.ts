// tests/fixtures/schema-compat/generate-inflight-oldgen.ts — write the
// GENUINE old-generation in-flight save `inflight-common-oldgen/`: a save
// whose main fiber is parked inside a called common event (a waited fade),
// written naturally by the pre-KRM3 runtime `db2de159` (the generation that
// produced `gen-0e510772`). That runtime has no `label`/`jumpLabel` commands
// at all, so unlike `inflight-common-constructed` this save needs no hand
// editing: it is exactly what a real old runtime produced. It proves the
// current runtime's restore migrations (including the label-scope
// reconstruction) leave a genuine old save's behavior unchanged.
//
//   bun tests/fixtures/schema-compat/generate-inflight-oldgen.ts <engine-root> <out-dir>
//
// <engine-root> is a checkout (or `git archive` of `src` + `tools/lib`) of
// the pre-KRM3 revision (db2de159). The script plays a short script with
// that runtime, saves while the fiber is parked at the common event's wait,
// then runs the same runtime past the wait and records the resulting switch
// state so a test can prove the current runtime's restored continuation
// matches the old one.
//
// The page calls the common event and then sets `pageContinued`; the common
// event fades (waited) and sets `commonDone`. The save is taken while the
// fiber is parked at the fade, so it has two frames (page root + common
// event) and no label program anywhere. The expected continuation is that
// both switches end set and the fiber ends.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const [rootArg, outArg] = process.argv.slice(2);
if (!rootArg || !outArg) {
  console.error("usage: bun generate-inflight-oldgen.ts <engine-root> <out-dir>");
  process.exit(2);
}
const root = resolve(rootArg);
const out = resolve(outArg);

const repo = await import(join(root, "src/engine/map-repository.ts"));
const sess = await import(join(root, "src/engine/session.ts"));
const save = await import(join(root, "src/engine/save.ts"));
const splitter = await import(join(root, "tools/lib/map-project.ts"));
const { validateSchema } = await import(join(root, "src/engine/schema-validate.ts"));
const schema = JSON.parse(readFileSync(join(root, "src/data/schema.json"), "utf8"));

function project(): Record<string, unknown> {
  const ground = (w: number, h: number) => new Array(w * h).fill("tiles.0");
  return {
    format: "rpgkit-project/v1",
    title: "in-flight common event fixture (old generation)",
    tileSize: 16,
    start: { map: "hall", x: 2, y: 2, dir: "up" },
    sheets: [{ id: "tiles", pak: "tiles", cols: 1, rows: 1, defaultPassage: "pass" }],
    items: [],
    commonEvents: [
      {
        id: "ce1",
        trigger: "none",
        // A long waited fade so the save is taken while the fiber is parked
        // at its screenWait, then a switch the continuation must set.
        commands: [
          { op: "screenFade", direction: "out", duration: 2, wait: true },
          { op: "switch", id: "commonDone", value: true },
        ],
      },
    ],
    maps: [
      {
        id: "hall",
        name: "Hall",
        width: 5,
        height: 5,
        sheets: ["tiles"],
        ground: ground(5, 5),
        events: [
          {
            id: "caller",
            x: 2,
            y: 2,
            pages: [
              // Run once: set a self switch, then call the common event.
              // After it returns, set a switch the continuation must set.
              {
                trigger: "autorun",
                commands: [
                  { op: "selfSwitch", key: "A", value: true },
                  { op: "common", id: "ce1" },
                  { op: "switch", id: "pageContinued", value: true },
                ],
              },
              { trigger: "action", condition: { selfSwitch: "A" }, commands: [] },
            ],
          },
        ],
      },
    ],
  };
}

const p = project();
const problems = validateSchema(schema, p);
if (problems.length > 0) throw new Error(`fixture project is invalid: ${JSON.stringify(problems)}`);
const split = splitter.splitProjectMaps(p);
const files = new Map<string, string>(split.entries.map((e: { path: string; text: string }) => [e.path, e.text]));
const maps = repo.createJsonMapRepository(split.shell.mapIndex, { read: (entry: string) => files.get(entry) });
const session = sess.createSession(split.shell, 60, maps);
let state = sess.startSession(split.shell, session);

// Step until the autorun has called ce1 and the fiber is parked at its
// waited fade (screenWait — the blocking mode the old runtime's canSave
// allows).
let parked = false;
for (let frame = 0; frame < 60; frame++) {
  state = sess.stepSession(session, state, { buttons: 0 });
  const main = state.interp.main;
  if (main && main.mode === "screenWait" && main.stack.length >= 2) {
    parked = true;
    break;
  }
}
if (!parked) throw new Error("fixture script never parked the fiber inside the common event");
const main = state.interp.main!;
if (main.stack[0]!.prog === main.stack[main.stack.length - 1]!.prog) {
  throw new Error("fixture script: the top frame is not a common-event frame");
}
// A genuine old-generation save: the pre-KRM3 runtime wrote no `unit`
// markers (the field did not exist yet) and the program has no labels.
const snapshot = save.createSnapshot(state.mapId, state.move, state.interp, 0);
const envelope = save.encodeEnvelope(snapshot, session.content);

// Run the SAME old runtime past the wait to record what the restored
// continuation must produce: the common event sets commonDone, the page
// sets pageContinued, and the fiber ends.
let continued = state;
for (let frame = 0; frame < 240; frame++) {
  continued = sess.stepSession(session, continued, { buttons: 0 });
  if (continued.interp.sw.switches.commonDone === true) break;
}
const expected = {
  commonDone: continued.interp.sw.switches.commonDone === true,
  pageContinued: continued.interp.sw.switches.pageContinued === true,
  mainEnded: continued.interp.main === null,
};
if (!expected.commonDone) throw new Error("fixture script: the old runtime never set commonDone");
if (!expected.pageContinued) throw new Error("fixture script: the old runtime never set pageContinued");
if (!expected.mainEnded) throw new Error("fixture script: the old runtime fiber did not end");

const write = (path: string, text: string) => {
  const full = join(out, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
};
write("project.json", split.shellText);
for (const entry of split.entries) write(entry.path, entry.text);
write("save.json", envelope);
write("expected.json", JSON.stringify(expected, null, 2) + "\n");
console.log(`${out}: schema ${split.shell.mapSchemaHash} parked frames ${main.stack.length} expected ${JSON.stringify(expected)}`);
