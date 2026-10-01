#!/usr/bin/env bun
// End-to-end example: author a one-shot greeter through the CLI, then load
// the saved document in the runtime interpreter and verify its behavior.

import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  activePage,
  createInterpState,
  createSwitchState,
  createWorld,
  stepInterp,
  type InterpInput,
} from "../../src/engine/interpreter.ts";
import { loadProject } from "../../editor/engine/document.ts";
import type { FileEditResponse } from "../../editor/api/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const CLI = join(HERE, "cli.ts");
const SOURCE = join(ROOT, "examples/sunstone/data/sunstone.json");

export const GREETER_LINES = [
  "GREETER: Welcome to Bramble Hollow.",
  "GREETER: Mind the northern road.",
  "GREETER: Take these ten gold.",
] as const;

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function invoke(file: string, command: string, args: Record<string, unknown>): FileEditResponse {
  const child = Bun.spawnSync({
    cmd: [process.execPath, CLI, command, "--file", file, "--json", JSON.stringify(args)],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = child.stdout.toString().trim();
  const stderr = child.stderr.toString().trim();
  check(stdout.length > 0, `${command} returned no JSON${stderr ? `: ${stderr}` : ""}`);
  const response = JSON.parse(stdout) as FileEditResponse;
  check(child.exitCode === 0 && response.ok, `${command} failed: ${stdout}${stderr ? `\n${stderr}` : ""}`);
  return response;
}

export interface SunstoneAgentExampleResult {
  output: string;
  event: string;
  cliEdits: number;
  dialogues: string[];
  initialGold: number;
  finalGold: number;
  selfSwitch: string | undefined;
  oneShot: boolean;
}

export function buildAndVerifySunstoneAgentTask(output: string): SunstoneAgentExampleResult {
  const target = resolve(output);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(SOURCE, target);

  const eventId = "agent-greeter";
  let cliEdits = 0;
  invoke(target, "add-event", {
    map: "village",
    event: {
      id: eventId,
      name: "Village Entrance Greeter",
      // Beside the north-gate return landing at (9,1).
      x: 10,
      y: 1,
      pages: [{ trigger: "action", sprite: "villager", blocks: true, commands: [] }],
    },
  });
  cliEdits++;

  for (const [index, line] of GREETER_LINES.entries()) {
    invoke(target, "insert-command", {
      map: "village",
      event: eventId,
      page: 0,
      address: { path: [], index },
      command: { op: "text", lines: [line] },
    });
    cliEdits++;
  }
  invoke(target, "insert-command", {
    map: "village",
    event: eventId,
    page: 0,
    address: { path: [], index: 3 },
    command: { op: "gold", set: "add", amount: 10 },
  });
  cliEdits++;
  invoke(target, "insert-command", {
    map: "village",
    event: eventId,
    page: 0,
    address: { path: [], index: 4 },
    command: { op: "selfSwitch", key: "A", value: true },
  });
  cliEdits++;
  invoke(target, "add-page", {
    map: "village",
    event: eventId,
    page: {
      condition: { selfSwitch: "A" },
      trigger: "action",
      sprite: "villager",
      blocks: true,
      commands: [],
    },
  });
  cliEdits++;

  const loaded = loadProject(readFileSync(target, "utf8"));
  check(loaded.errors.length === 0, `saved example is invalid: ${JSON.stringify(loaded.errors)}`);
  const project = loaded.project;
  const event = project.maps.find((map) => map.id === "village")?.events?.find((candidate) => candidate.id === eventId);
  check(event, "saved greeter event is missing");
  check(event.pages.length === 2, "saved greeter does not have its one-shot page");
  check(
    JSON.stringify(event.pages[1]!.condition) === JSON.stringify({ selfSwitch: "A" }),
    "saved greeter page two is not gated by self switch A",
  );

  const village = project.maps.find((map) => map.id === "village")!;
  const world = createWorld(village, project.commonEvents ?? [], 60);
  let state = createInterpState(createSwitchState({ gold: project.initialGold ?? 0 }));
  const initialGold = state.sw.gold;
  check(activePage(event, state.sw, "village")?.index === 0, "greeter reward page is not initially active");
  const input = (confirmEdge = false): InterpInput => ({
    confirmEdge,
    cancelEdge: false,
    upEdge: false,
    downEdge: false,
    playerCell: { x: 9, y: 1 },
    prevCell: { x: 9, y: 1 },
    facing: 3,
  });
  const step = (confirmEdge = false): void => {
    state = stepInterp(world, state, input(confirmEdge));
  };

  step(true);
  if (state.modal === null) step(false);
  for (const line of GREETER_LINES) {
    check(state.modal?.kind === "text", `expected dialogue ${JSON.stringify(line)}`);
    check(state.modal.lines.length === 1 && state.modal.lines[0] === line, `unexpected dialogue: ${JSON.stringify(state.modal.lines)}`);
    step(true); // reveal the whole typewriter line
    step(true); // dismiss and advance to the next command
  }
  check(state.modal === null && state.main === null, "greeter command list did not finish");
  check(state.sw.gold === initialGold + 10, `greeter should add 10 gold, got ${state.sw.gold - initialGold}`);
  check(state.sw.self[`village/${eventId}`] === "A", "greeter self switch A was not set");
  check(activePage(event, state.sw, "village")?.index === 1, "self switch A did not activate the inert second page");

  step(false); // synchronize the now-active empty page
  step(true); // a second interaction must be inert
  const oneShot = state.modal === null && state.main === null && state.sw.gold === initialGold + 10;
  check(oneShot, "greeter rewarded or spoke again after self switch A");

  return {
    output: target,
    event: eventId,
    cliEdits,
    dialogues: [...GREETER_LINES],
    initialGold,
    finalGold: state.sw.gold,
    selfSwitch: state.sw.self[`village/${eventId}`],
    oneShot,
  };
}

function outputArg(argv: readonly string[]): string {
  const at = argv.indexOf("--output");
  if (at >= 0) {
    const value = argv[at + 1];
    if (!value) throw new Error("--output requires a path");
    return value;
  }
  const equals = argv.find((value) => value.startsWith("--output="));
  if (equals) return equals.slice("--output=".length);
  if (argv.some((value) => value === "--help" || value === "-h")) {
    process.stdout.write("Usage: bun tools/rpgkit-edit/example-sunstone.ts [--output <copy.json>]\n");
    process.exit(0);
  }
  return join(ROOT, "dist/rpgkit-edit/sunstone-agent-task.json");
}

if (import.meta.main) {
  try {
    process.stdout.write(`${JSON.stringify(buildAndVerifySunstoneAgentTask(outputArg(process.argv.slice(2))))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
