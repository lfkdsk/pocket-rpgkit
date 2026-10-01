// tools/rpgkit-check/cli.ts — command-line entry for the rpgkit-check tools.
//
//   bun run rpgkit-check <check> --file <doc.json> [--json '<args>'] [--out <dir>]
//
// <check> is one of: lint, locks, freeze, reach, explore, shot (or the full
// rpgkit-<check> tool name). The report is printed to stdout as JSON. Exit
// code is 0 when the report has no error-severity findings, 1 when it does,
// and 2 for usage or load errors (a load error still prints its findings as
// a JSON report). The same tools are exposed as MCP descriptors in
// src/registry.ts for the editing server to mount.

import { CHECK_TOOLS, CheckArgsError, CheckLoadError, checkTool } from "./src/registry.ts";
import { countBySeverity, type CheckReport } from "./src/finding.ts";

function usage(): never {
  console.error(
    `usage: bun run rpgkit-check <check> --file <doc.json> [--json '<args>'] [--out <dir>]\n` +
      `checks: ${CHECK_TOOLS.map((t) => t.name.replace(/^rpgkit-/, "")).join(", ")}\n` +
      `note: reach is experimental — its unreachable verdicts are leads, not proofs; the report lists its assumptions.`,
  );
  process.exit(2);
}

const argv = process.argv.slice(2);
if (argv.length === 0) usage();

const checkName = argv[0]!;
let file: string | undefined;
let argsJson: string | undefined;
let out: string | undefined;
for (let i = 1; i < argv.length; i++) {
  const arg = argv[i]!;
  // A flag must be followed by its value; a missing or empty value is a
  // usage error, not a silent ignore (an empty --json would otherwise be
  // treated as "no args" and exit 0).
  const takeValue = (flag: string): string => {
    const value = argv[++i];
    if (value === undefined || value === "" || value.startsWith("--")) {
      console.error(`${flag} requires a value`);
      usage();
    }
    return value;
  };
  // A `--flag=value` form with an empty value is the same usage error as a
  // missing value, not a silent empty string.
  const takeEquals = (flag: string, arg: string): string => {
    const value = arg.slice(arg.indexOf("=") + 1);
    if (value === "") {
      console.error(`${flag} requires a value`);
      usage();
    }
    return value;
  };
  if (arg === "--file") file = takeValue("--file");
  else if (arg === "--json" || arg === "--args") argsJson = takeValue(arg);
  else if (arg === "--out") out = takeValue("--out");
  else if (arg.startsWith("--file=")) file = takeEquals("--file", arg);
  else if (arg.startsWith("--json=") || arg.startsWith("--args=")) {
    argsJson = takeEquals(arg.startsWith("--json=") ? "--json" : "--args", arg);
  } else if (arg.startsWith("--out=")) out = takeEquals("--out", arg);
  else {
    console.error(`unknown argument: ${arg}`);
    usage();
  }
}

if (!file) {
  console.error("missing --file <doc.json>");
  usage();
}

const tool = checkTool(checkName);
if (!tool) {
  console.error(`unknown check: ${checkName}`);
  usage();
}

let extraArgs: Record<string, unknown> = {};
if (argsJson) {
  try {
    const parsed = JSON.parse(argsJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.error("--json must be a JSON object");
      process.exit(2);
    }
    extraArgs = parsed as Record<string, unknown>;
  } catch (err) {
    console.error(`invalid --json: ${String(err)}`);
    process.exit(2);
  }
}

// Explicit CLI flags win over the JSON args object: a --file on the command
// line can never be overridden by a "file" key inside --json.
const callArgs = { ...extraArgs, ...(out ? { out } : {}), file };

try {
  const result = await tool.run(callArgs);
  console.log(JSON.stringify(result, null, 2));
  const report = result as Partial<CheckReport>;
  if (Array.isArray(report.findings)) {
    const { error } = countBySeverity(report.findings);
    process.exit(error > 0 ? 1 : 0);
  }
  process.exit(0);
} catch (err) {
  if (err instanceof CheckLoadError) {
    // A load failure is still a structured report: the doc/* findings say
    // exactly what could not be read, so an agent can act on them.
    console.log(JSON.stringify({
      check: tool.name,
      findings: err.findings,
      summary: { loadError: 1 },
    } satisfies CheckReport, null, 2));
    process.exit(2);
  }
  if (err instanceof CheckArgsError) {
    console.error(`invalid args: ${err.message}`);
    process.exit(2);
  }
  console.error(String(err));
  process.exit(2);
}
