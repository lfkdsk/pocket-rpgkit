#!/usr/bin/env bun
// JSON-only CLI for the headless RPG Kit editing API.

import { readFileSync } from "node:fs";
import { EDIT_COMMANDS } from "../../editor/api/types.ts";
import { runFileEdit } from "../../editor/api/file.ts";

export interface CliOptions {
  command: string;
  file: string;
  args: unknown;
  dryRun: boolean;
}

export const CLI_USAGE = `Usage:
  bun run rpgkit-edit <command> --file <project.json> [--json '<args>'] [--dry-run]

Commands:
  ${EDIT_COMMANDS.join("\n  ")}

--json accepts an inline JSON object or @path/to/args.json. Mutating commands
save atomically by default. --dry-run returns the same validated diff and
reversible patch without changing the file.`;

function optionValue(argv: readonly string[], index: number, name: string): { value: string; consumed: number } {
  const argument = argv[index]!;
  const prefix = `${name}=`;
  if (argument.startsWith(prefix)) return { value: argument.slice(prefix.length), consumed: 0 };
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return { value, consumed: 1 };
}

export function parseCliArgs(argv: readonly string[]): CliOptions | { help: true } {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) return { help: true };
  const command = argv[0]!;
  let file = "";
  let json = "{}";
  let dryRun = false;
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--file" || argument.startsWith("--file=")) {
      const parsed = optionValue(argv, index, "--file");
      file = parsed.value;
      index += parsed.consumed;
      continue;
    }
    if (argument === "--json" || argument.startsWith("--json=")) {
      const parsed = optionValue(argv, index, "--json");
      json = parsed.value;
      index += parsed.consumed;
      continue;
    }
    throw new Error(`unknown option ${argument}`);
  }
  if (!file) throw new Error("--file is required");
  const encoded = json.startsWith("@") ? readFileSync(json.slice(1), "utf8") : json;
  let args: unknown;
  try {
    args = JSON.parse(encoded);
  } catch (error) {
    throw new Error(`--json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { command, file, args, dryRun };
}

export function runCli(argv: readonly string[]): number {
  try {
    const options = parseCliArgs(argv);
    if ("help" in options) {
      process.stdout.write(`${CLI_USAGE}\n`);
      return 0;
    }
    const response = runFileEdit(options);
    process.stdout.write(`${JSON.stringify(response)}\n`);
    return response.ok ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: {
        code: "CLI_USAGE",
        message: error instanceof Error ? error.message : String(error),
        expected: CLI_USAGE,
      },
    })}\n`);
    return 2;
  }
}

if (import.meta.main) process.exitCode = runCli(process.argv.slice(2));
