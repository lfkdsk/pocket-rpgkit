// tests/fixtures/schema-compat/generate-inflight.ts — write the CONSTRUCTED
// compatibility probe `inflight-common-constructed/`: a save whose main
// fiber is parked inside a called common event, using a labels-capable
// earlier schema generation's runtime, with the `unit` label-scope markers
// stripped from the saved frames by hand. This is NOT a save a real old
// runtime produced naturally (0f14c2e already serializes `unit`); it is a
// constructed probe that gives the current runtime a pre-`unit`-shaped save
// carrying a label program, to exercise the restore-time scope
// reconstruction. For a genuine old-generation in-flight save (no labels,
// written naturally by a pre-KRM3 runtime) see generate-inflight-oldgen.ts.
//
//   bun tests/fixtures/schema-compat/generate-inflight.ts <engine-root> <out-dir>
//
// <engine-root> is a checkout (or `git archive` of `src` + `tools/lib`) of
// the RPG Kit revision whose schema generation the fixture represents. The
// script plays a short script with that runtime, saves while the fiber is
// parked at the common event's wait, then runs the same runtime past the
// wait and records the resulting switch state so a test can prove the
// current runtime's restored continuation matches the old one.
//
// The page root and the common event both declare a label named "same", and
// the common event jumps to it. The old runtime resolves the jump in the
// common event's own scope (its frame is a unit root), setting
// `commonLanded`; the page root's own "same" label is only reachable by a
// jump that resolves against the page scope, so `pageLanded` stays unset.
// The save is taken BEFORE the jump runs, and the `unit` markers are
// stripped from the saved frames so the fixture has a pre-`unit` shape: the
// current runtime must rebuild the scope roots on restore for the jump to
// land in the common event instead of the page.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const [rootArg, outArg] = process.argv.slice(2);
if (!rootArg || !outArg) {
  console.error("usage: bun generate-inflight.ts <engine-root> <out-dir>");
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
    title: "in-flight common event fixture",
    tileSize: 16,
    start: { map: "hall", x: 2, y: 2, dir: "up" },
    sheets: [{ id: "tiles", pak: "tiles", cols: 1, rows: 1, defaultPassage: "pass" }],
    items: [],
    commonEvents: [
      {
        id: "ce1",
        trigger: "none",
        // A long waited fade so the save is taken while the fiber is parked
        // at its screenWait, then a jump to the "same" label. The label is
        // declared in BOTH the common event and the page root; the jump must
        // land in the common event's own scope (its frame is a unit root),
        // setting commonLanded and never reaching the page's pageLanded.
        commands: [
          { op: "screenFade", direction: "out", duration: 2, wait: true },
          { op: "jumpLabel", name: "same" },
          { op: "label", name: "same" },
          { op: "switch", id: "commonLanded", value: true },
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
              // After it returns, jump over the page's own "same" label so
              // pageLanded is only set by a jump that (wrongly) resolves
              // against the page scope.
              {
                trigger: "autorun",
                commands: [
                  { op: "selfSwitch", key: "A", value: true },
                  { op: "common", id: "ce1" },
                  { op: "jumpLabel", name: "end" },
                  { op: "label", name: "same" },
                  { op: "switch", id: "pageLanded", value: true },
                  { op: "label", name: "end" },
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
// A pre-`unit` save: strip the scope-root markers the labels-capable
// runtime wrote, so the current runtime must rebuild them on restore. The
// save is taken before the common event's jumpLabel runs, so stripping the
// markers does not change the run up to this point. The expected-result
// run below uses the ORIGINAL state (markers intact) to record what the
// restored continuation must produce.
const strippedInterp = JSON.parse(JSON.stringify(state.interp)) as typeof state.interp;
for (const frame of strippedInterp.main!.stack) {
  delete (frame as { unit?: true }).unit;
}

const snapshot = save.createSnapshot(state.mapId, state.move, strippedInterp, 0);
const envelope = save.encodeEnvelope(snapshot, session.content);

// Run the SAME old runtime past the wait to record what the restored
// continuation must produce: the common event's jump lands in its own
// scope (commonLanded), the page's label is skipped (pageLanded unset),
// and the fiber ends.
let continued = state;
for (let frame = 0; frame < 240; frame++) {
  continued = sess.stepSession(session, continued, { buttons: 0 });
  if (continued.interp.sw.switches.commonLanded === true) break;
}
const expected = {
  commonLanded: continued.interp.sw.switches.commonLanded === true,
  pageLanded: continued.interp.sw.switches.pageLanded === true,
  mainEnded: continued.interp.main === null,
};
if (!expected.commonLanded) throw new Error("fixture script: the old runtime never set commonLanded");
if (expected.pageLanded) throw new Error("fixture script: the old runtime wrongly set pageLanded (scope leak)");

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
