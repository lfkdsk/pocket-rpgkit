// tools/editor.ts — open the tile-map editor (editor/) in a PocketJS
// desktop host window: macos-app on a Mac, linux-app elsewhere.
//
//   bun run editor                          # dist/editor/sunstone.json
//   bun run editor meadow                   # dist/editor/meadow.json
//   bun run editor sunstone --file my.json  # edit another file; seeded from
//                                           # the example document if missing
//                                           # (relative to the repo root:
//                                           # `bun run` starts scripts there)
//   bun run editor --build-only             # bundle + release host, no window
//   bun run editor meadow -- --quit-after 600   # extra host flags pass through
//
// The host runs with the rpgkit-editor companion that editor/pocket.json
// declares, plus --file: it forwards the real mouse and keyboard to the
// editor as svc lines, sends the file's text as a {t:"load"} line at boot,
// while the data.fs bridge commits SAVE requests with an exact-source CAS.
// Build and host flags come from tools/lib/desktop.ts, like the examples.
//
// By default the editor works on a copy in dist/editor/, seeded from the
// example's document: the examples build their documents from code, and
// `bun run gen-assets` would overwrite edits made in examples/*/data/.

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { DEFAULT_SOURCE, EDITOR_SOURCES } from "../editor/sources.ts";
import { DESKTOP_TARGET, buildForDesktop, runDesktopHost } from "./lib/desktop.ts";
import {
  editorProposalBridgePaths,
  syncEditorProposalBridge,
} from "./lib/editor-proposal-bridge.ts";

const root = resolve(import.meta.dir, "..");

const argv = process.argv.slice(2).filter((a) => a !== "--");
const buildOnly = argv.includes("--build-only");
const rest = argv.filter((a) => a !== "--build-only");
let fileArg: string | undefined;
const fileAt = rest.indexOf("--file");
if (fileAt >= 0) {
  fileArg = rest[fileAt + 1];
  if (!fileArg) throw new Error("editor: --file needs a path");
  rest.splice(fileAt, 2);
}
const name = rest[0] && !rest[0].startsWith("--") ? rest.shift()! : DEFAULT_SOURCE;
const source = EDITOR_SOURCES.find((s) => s.id === name);
if (!source) {
  throw new Error(`editor: unknown project "${name}" (have: ${EDITOR_SOURCES.map((s) => s.id).join(", ")})`);
}

const exampleDoc = join(root, source.document);
const file = fileArg ? resolve(process.cwd(), fileArg) : join(root, "dist", "editor", `${source.id}.json`);

const build = await buildForDesktop(join(root, "editor", "pocket.json"));
if (buildOnly) {
  console.log(`editor: built ${build.plan.app.output} for ${DESKTOP_TARGET} + release host (${build.bin})`);
  process.exit(0);
}

if (!existsSync(file)) {
  mkdirSync(dirname(file), { recursive: true });
  copyFileSync(exampleDoc, file);
  console.log(`editor: seeded ${file} from ${source.document}`);
}
console.log(`editor: SAVE writes ${relative(root, file) || file}`);
if (rest.includes("--data-root")) {
  throw new Error("editor: --data-root is managed by the proposal bridge");
}
const bridge = editorProposalBridgePaths(root, build.plan.app.id, file);
let lastBridgeStatus = "";
const syncProposals = (): void => {
  try {
    const result = syncEditorProposalBridge(file, bridge.sessionFile, bridge.hostStateFile);
    const status = result.conflicts.length > 0
      ? `refused ${result.conflicts.length} conflicting acceptance(s)`
      : `${result.pending} pending, ${result.persisted} review update(s)`;
    if ((result.conflicts.length > 0 || result.persisted > 0) && status !== lastBridgeStatus) {
      console.log(`editor: proposal bridge ${status}`);
    }
    lastBridgeStatus = status;
  } catch (error) {
    const status = `error: ${error instanceof Error ? error.message : String(error)}`;
    if (status !== lastBridgeStatus) console.error(`editor: proposal bridge ${status}`);
    lastBridgeStatus = status;
  }
};
syncProposals();
const bridgeTimer = setInterval(syncProposals, 200);
try {
  await runDesktopHost(build, ["--data-root", bridge.dataRoot, "--file", file, ...rest]);
} finally {
  clearInterval(bridgeTimer);
  syncProposals();
}
