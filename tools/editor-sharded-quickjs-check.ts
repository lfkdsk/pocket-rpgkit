// tools/editor-sharded-quickjs-check.ts — driver for
// editor-sharded-quickjs-check.sh. Usage:
//
//   bun tools/editor-sharded-quickjs-check.ts <host-test-binary> [--write-globals]
//
// 1. Runs `guest_globals` in the real desktop QuickJS guest and compares its
//    inventory with tests/fixtures/quickjs-guest-globals.json (the allowlist
//    the guest globals test reads). --write-globals refreshes that file.
// 2. Writes a sharded project (12 maps of 40x40, the last one 100x100) to a scratch
//    directory, starts the real filesystem companion (tools/editor-files.ts),
//    and runs `sharded_open_paint_save`: the editor bundle opens the project
//    over --svc-connect, paints map 0 and the last map, and saves.
// 3. Checks the files the companion wrote: exactly the two painted shards and
//    the shell changed, the shell's manifest matches the new shards, and a
//    fresh verifying repository reads the painted cells back.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BUNDLED_PROJECTS } from "../editor/engine/projects.ts";
import { fittedView, headerButtons, HEADER_H, TILE } from "../editor/engine/layout.ts";
import { createJsonMapRepository } from "../src/engine/map-repository.ts";
import type { MapDef, Project, ProjectShell } from "../src/engine/types.ts";
import { startEditorFilesServer } from "./editor-files.ts";
import { splitProjectMaps } from "./lib/map-project.ts";

const root = resolve(import.meta.dir, "..");
const GLOBALS_FILE = join(root, "tests", "fixtures", "quickjs-guest-globals.json");
const W = 480;
const H = 272;

const [bin, ...flags] = process.argv.slice(2);
if (!bin) {
  console.error("usage: bun tools/editor-sharded-quickjs-check.ts <host-test-binary> [--write-globals]");
  process.exit(2);
}
const writeGlobals = flags.includes("--write-globals");
const dist = process.env.POCKETJS_DIST ?? join(root, "dist");
const scratchRoot = process.env.SHARDED_QJS_ROOT ?? join(root, "dist", "editor-sharded-quickjs-check");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "run-"));

function fail(message: string): never {
  console.error(`editor-sharded-quickjs-check: FAIL ${message}`);
  process.exit(1);
}

async function runTest(name: string, env: Record<string, string>): Promise<string> {
  const proc = Bun.spawn({
    cmd: [bin!, `editor_sharded_quickjs_check::${name}`, "--ignored", "--exact", "--nocapture"],
    env: { ...process.env, POCKETJS_DIST: dist, SHARDED_QJS_SCRATCH: scratch, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exit !== 0) {
    process.stderr.write(stdout + stderr);
    fail(`${name} exited ${exit}`);
  }
  return stdout;
}

function sortedJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function checkGlobals(): Promise<void> {
  const out = await runTest("guest_globals", {});
  const line = out.split("\n").find((text) => text.startsWith("SHARDED_QJS_GLOBALS "));
  if (!line) fail("guest_globals printed no inventory");
  const measured = JSON.parse(line.slice("SHARDED_QJS_GLOBALS ".length)) as {
    globals: string[];
    members: Record<string, string[]>;
  };
  const text = sortedJson({
    source: "PocketJS desktop host, QuickJS guest realm with the editor bundle loaded (tools/editor-sharded-quickjs-check.sh)",
    globals: measured.globals,
    members: measured.members,
  });
  if (writeGlobals) {
    writeFileSync(GLOBALS_FILE, text);
    console.log(`editor-sharded-quickjs-check: wrote ${GLOBALS_FILE} (${measured.globals.length} globals)`);
    return;
  }
  let committed = "";
  try {
    committed = readFileSync(GLOBALS_FILE, "utf8");
  } catch {
    fail(`${GLOBALS_FILE} is missing; run with --write-globals`);
  }
  if (committed !== text) {
    const before = (JSON.parse(committed) as { globals: string[] }).globals;
    const added = measured.globals.filter((name) => !before.includes(name));
    const removed = before.filter((name) => !measured.globals.includes(name));
    fail(`guest inventory differs from the committed allowlist (globals +[${added.join(", ")}] -[${removed.join(", ")}]); review and rerun with --write-globals`);
  }
  console.log(`editor-sharded-quickjs-check: guest globals match the allowlist (${measured.globals.length} globals)`);
}

function fixture(): ReturnType<typeof splitProjectMaps> {
  const example = JSON.parse(BUNDLED_PROJECTS[0]!.json) as Project;
  const sheet = example.sheets[0]!.id;
  const maps: MapDef[] = Array.from({ length: 12 }, (_, index) => {
    const size = index === 11 ? 100 : 40;
    return {
      id: `map_${String(index).padStart(2, "0")}`,
      name: `Map ${index}`,
      width: size,
      height: size,
      sheets: [sheet],
      ground: new Array(size * size).fill(`${sheet}.0`),
      events: [],
    };
  });
  return splitProjectMaps({
    ...example,
    title: "Sharded QuickJS check",
    start: { map: maps[0]!.id, x: 0, y: 0, dir: "down" },
    maps,
  });
}

async function checkSharded(): Promise<void> {
  const split = fixture();
  const projectDir = join(scratch, "project");
  const shellFile = join(projectDir, "project.json");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(shellFile, split.shellText);
  for (const entry of split.entries) {
    const path = join(projectDir, entry.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, entry.text);
  }
  const sheet = split.shell.sheets[0]!.id;
  const map = headerButtons(W).find((button) => button.id === "map");
  if (!map) fail("the MAP header button is not on a 480-wide header");
  const canvas = fittedView(W, H, false).frame;
  const plan = {
    painted: `${sheet}.1`,
    lastIndex: split.entries.length - 1,
    tile: [3 + 2 * 13 + 6, HEADER_H + 33 + 6],
    cell: [canvas.x + TILE / 2, canvas.y + TILE / 2],
    mapButton: [map.x + Math.floor(map.w / 2), map.y + Math.floor(map.h / 2)],
  };
  const server = await startEditorFilesServer(shellFile, { root: projectDir });
  let out: string;
  try {
    out = await runTest("sharded_open_paint_save", {
      SHARDED_QJS_ADDR: server.address,
      SHARDED_QJS_TOKEN: server.authToken,
      SHARDED_QJS_PLAN: JSON.stringify(plan),
    });
  } finally {
    await server.close();
  }
  for (const line of out.split("\n")) if (line.startsWith("SHARDED_QJS ")) console.log(line);
  if (!out.includes("SHARDED_QJS PASS")) fail("the guest session did not finish");

  const shellText = readFileSync(shellFile, "utf8");
  if (shellText === split.shellText) fail("the shell was not rewritten");
  const shell = JSON.parse(shellText) as ProjectShell;
  const changed: string[] = [];
  for (const entry of split.entries) {
    if (readFileSync(join(projectDir, entry.path), "utf8") !== entry.text) changed.push(entry.path);
  }
  const expected = [split.entries[0]!.path, split.entries[split.entries.length - 1]!.path];
  if (JSON.stringify(changed) !== JSON.stringify(expected)) {
    fail(`changed shards ${JSON.stringify(changed)}, expected ${JSON.stringify(expected)}`);
  }
  const repository = createJsonMapRepository(shell.mapIndex, {
    read: (entry) => readFileSync(join(projectDir, entry), "utf8"),
  }, { verify: true, validate: "full" });
  for (const meta of shell.mapIndex) {
    const loaded = repository.acquire(meta.id);
    const want = meta.id === "map_00" || meta.id === "map_11" ? plan.painted : `${sheet}.0`;
    if (loaded.ground[0] !== want) fail(`${meta.id} ground[0] = ${loaded.ground[0]}, expected ${want}`);
    if (loaded.ground.slice(1).some((tile) => tile !== `${sheet}.0`)) fail(`${meta.id} has stray painted cells`);
  }
  console.log(`editor-sharded-quickjs-check: files on disk: shell + ${changed.join(", ")} rewritten; all ${shell.mapIndex.length} shards verify`);
}

try {
  await checkGlobals();
  await checkSharded();
  console.log("editor-sharded-quickjs-check: PASS");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
