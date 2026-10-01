// tools/build-example.ts — build the example apps, the editor and the sim
// test fixtures against the vendored PocketJS. External-project invocation:
//
//   bun tools/build-example.ts                 # every example, the editor, every fixture
//   bun tools/build-example.ts sunstone grow   # just these
//   bun tools/build-example.ts editor          # just the editor (build:editor)
//
// Each example is one entry `examples/<name>/<name>.tsx`, the editor is
// `editor/editor.tsx`, and each test fixture one entry
// `tests/fixtures/<name>/<name>.tsx`, so the build writes dist/<name>.js and
// dist/<name>.pak (the sim tests boot those). A fixture's gen-assets.ts,
// when it has one, runs first and writes the fixture's procedural art.
// Pass 1 resolves @pocketjs/framework/* into vendor/pocketjs/framework and
// walks every RELATIVE import from the entry (../../src/... included), so
// the Solid components in src/ui get their JSX transform even though they
// live outside the vendor tree. images.json / sprites.json are read from
// the entry's own directory. Outputs land in this repo's dist/, never in the
// submodule.

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const EXAMPLES = ["showcase", "meadow", "sunstone", "grow", "wander"] as const;
/** The examples plus the editor app. */
export const APPS = [...EXAMPLES, "editor"] as const;
/** Small apps that exist only for the sim suites. */
export const FIXTURES = ["ui-theme", "streamed", "event-model", "r2-ui", "kb4-battle", "rpgkit-shot", "km1-move-control", "ka1-anim", "kg1-name-input", "kau1-audio"] as const;
/** UI theme and Meadow are also built at web densities 2 and 3. The density
 *  regression test uses these variants to compare the same dialog and real
 *  tile art without rebuilding artifacts inside `bun test`. */
export const WEB_DENSITY_FIXTURES = [2, 3] as const;

const root = resolve(import.meta.dir, "..");

const buildTs = join(root, "vendor", "pocketjs", "tools", "build.ts");

function isFixture(name: string): boolean {
  return (FIXTURES as readonly string[]).includes(name);
}

/** The directory holding an app's or fixture's entry, images.json and assets. */
function appDir(name: string): string {
  if (name === "editor") return join(root, "editor");
  return isFixture(name) ? join(root, "tests", "fixtures", name) : join(root, "examples", name);
}

/** The entry module of an app named in APPS or FIXTURES. */
export function appEntry(name: string): string {
  return join(appDir(name), `${name}.tsx`);
}

if (import.meta.main) await buildExamples(process.argv.slice(2));

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn({ cmd, cwd: root, stdio: ["inherit", "inherit", "inherit"] });
  const exit = await proc.exited;
  if (exit !== 0) process.exit(exit);
}

async function buildExamples(wanted: string[]): Promise<void> {
  mkdirSync(join(root, "dist"), { recursive: true });
  const known: readonly string[] = [...APPS, ...FIXTURES];
  for (const name of wanted) {
    if (!known.includes(name)) {
      console.error(`build-example: unknown app "${name}" (have: ${known.join(", ")})`);
      process.exit(2);
    }
  }
  for (const name of wanted.length ? wanted : known) {
    const entry = appEntry(name);
    if (!existsSync(entry)) throw new Error(`build-example: missing ${entry}`);
    const gen = join(appDir(name), "gen-assets.ts");
    if (isFixture(name) && existsSync(gen)) await run([process.execPath, gen]);
    await run([
      process.execPath,
      buildTs,
      entry,
      `--project-root=${root}`,
      `--outdir=${join(root, "dist")}`,
      `--inputs-file=${join(root, "dist", `${name}.inputs.json`)}`,
    ]);
    if (name === "ui-theme" || name === "meadow") {
      for (const density of WEB_DENSITY_FIXTURES) {
        await run([
          process.execPath,
          buildTs,
          entry,
          `--project-root=${root}`,
          `--outdir=${join(root, "dist", `density-${density}`)}`,
          `--density=${density}`,
        ]);
      }
    }
  }
}
