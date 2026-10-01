// tests/fixtures/schema-compat/generate.ts — write one schema generation's
// sharded shell, map entries and a mid-game save.
//
//   bun tests/fixtures/schema-compat/generate.ts <engine-root> <out-dir>
//
// <engine-root> is a checkout (or `git archive` of `src` + `tools/lib`) of
// the RPG Kit revision whose schema generation the fixture represents. The
// script only uses the sharding/session/save API that every sharded
// generation has, so the same file reproduces every fixture in this
// directory. The project sticks to commands that exist in the oldest
// admitted generation.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const [rootArg, outArg] = process.argv.slice(2);
if (!rootArg || !outArg) {
  console.error("usage: bun generate.ts <engine-root> <out-dir>");
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

function compatProject(): Record<string, unknown> {
  const ground = (w: number, h: number) => new Array(w * h).fill("tiles.0");
  return {
    format: "rpgkit-project/v1",
    title: "schema compatibility fixture",
    tileSize: 16,
    start: { map: "hall", x: 2, y: 2, dir: "up" },
    sheets: [{ id: "tiles", pak: "tiles", cols: 1, rows: 1, defaultPassage: "pass" }],
    items: [{ id: "key", name: "Key", sprite: "tiles.0" }],
    maps: [
      {
        id: "hall",
        name: "Hall",
        width: 5,
        height: 5,
        sheets: ["tiles"],
        ground: ground(5, 5),
        events: [{
          id: "guide",
          x: 2,
          y: 1,
          pages: [
            {
              trigger: "action",
              commands: [
                { op: "text", lines: ["Pick a door."] },
                {
                  op: "choices",
                  prompt: "Which way?",
                  options: [
                    {
                      text: "North",
                      commands: [
                        { op: "variable", id: "route", set: { op: "set", value: 7 } },
                        { op: "gold", set: "add", amount: 25 },
                        { op: "item", item: "key", set: "add", count: 2 },
                      ],
                    },
                    {
                      text: "South",
                      commands: [{ op: "variable", id: "route", set: { op: "set", value: 1 } }],
                    },
                  ],
                },
                { op: "switch", id: "met", value: true },
                { op: "selfSwitch", key: "A", value: true },
                { op: "transfer", map: "yard", x: 1, y: 2, dir: "right" },
              ],
            },
            {
              trigger: "action",
              condition: { selfSwitch: "A" },
              commands: [{ op: "text", lines: ["Already chosen."] }],
            },
          ],
        }],
      },
      {
        id: "yard",
        name: "Yard",
        width: 6,
        height: 4,
        sheets: ["tiles"],
        ground: ground(6, 4),
        events: [{
          id: "sign",
          x: 2,
          y: 2,
          pages: [{
            trigger: "action",
            commands: [
              { op: "variable", id: "route", set: { op: "add", value: 100 } },
              { op: "transfer", map: "hall", x: 2, y: 3, dir: "up" },
            ],
          }],
        }],
      },
      {
        id: "attic",
        name: "Attic",
        width: 3,
        height: 3,
        sheets: ["tiles"],
        ground: ground(3, 3),
        events: [],
      },
    ],
  };
}

const project = compatProject();
const problems = validateSchema(schema, project);
if (problems.length > 0) throw new Error(`fixture project is invalid: ${JSON.stringify(problems)}`);
const split = splitter.splitProjectMaps(project);
const files = new Map<string, string>(split.entries.map((e: { path: string; text: string }) => [e.path, e.text]));
const maps = repo.createJsonMapRepository(split.shell.mapIndex, { read: (entry: string) => files.get(entry) });
const session = sess.createSession(split.shell, 60, maps);
let state = sess.startSession(split.shell, session);
// Talk to the guide, take the first option and follow the transfer. The
// save is taken standing in the yard, facing the sign that leads back.
for (let frame = 0; frame < 80; frame++) {
  state = sess.stepSession(session, state, { buttons: 0, confirmEdge: frame <= 60 && frame % 20 === 0 });
}
if (state.mapId !== "yard") throw new Error(`fixture script ended on ${state.mapId}, not yard`);
const snapshot = save.createSnapshot(state.mapId, state.move, state.interp, 0);
const envelope = save.encodeEnvelope(snapshot, session.content);

const write = (path: string, text: string) => {
  const full = join(out, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
};
write("project.json", split.shellText);
for (const entry of split.entries) write(entry.path, entry.text);
write("save.json", envelope);
console.log(`${out}: schema ${split.shell.mapSchemaHash} manifest ${split.shell.mapManifestHash}`);
