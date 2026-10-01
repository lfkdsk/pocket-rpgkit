// tools/rpgkit-check/src/registry.ts — the rpgkit-check tools as pure
// descriptors an MCP server can mount. AI1's editing server merges these into
// its own tool list; this module deliberately starts NO server of its own.
//
// Each tool is { name, description, inputSchema, run }: `run` takes the
// parsed args (always including `file`, the project document path) and
// returns a JSON-serializable report. The CLI (cli.ts) is a thin wrapper
// over this registry.

import { lintProject } from "./lint.ts";
import { loadProjectFile } from "./doc.ts";
import { checkLocks, type LockReport } from "./dynamic/locks.ts";
import { checkFreeze, type FreezeReport } from "./dynamic/freeze.ts";
import { checkReach, type ReachReport } from "./dynamic/reach.ts";
import { checkExplore, type ExploreReport } from "./dynamic/explore.ts";
import { renderShots, type ShotOutput, type RenderShotsOptions } from "./shot/render.ts";
import type { CheckReport, Finding } from "./finding.ts";
import type { Dir, Project } from "../../../src/engine/types.ts";
import { validateSchema, type Schema, type VError } from "../../../src/engine/schema-validate.ts";

export interface CheckTool {
  name: string;
  description: string;
  /** JSON Schema (draft 2020-12 subset) for the tool's args object. */
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<unknown>;
}

/** Args failed the tool's inputSchema. Entry points (CLI/MCP) report this
 *  as a usage error, never a server crash. */
export class CheckArgsError extends Error {
  readonly details: VError[];
  constructor(message: string, details: VError[]) {
    super(message);
    this.name = "CheckArgsError";
    this.details = details;
  }
}

/** The project file could not be loaded. Carries the doc/* findings so the
 *  CLI/MCP can emit them as a JSON report instead of a plain crash. */
export class CheckLoadError extends Error {
  readonly findings: Finding[];
  constructor(message: string, findings: Finding[]) {
    super(message);
    this.name = "CheckLoadError";
    this.findings = findings;
  }
}

/** Validate `args` against the tool's own inputSchema. Every entry point
 *  (CLI and MCP) goes through this, so a bad arg is a usage error caught
 *  before the check runs. */
export function validateCheckArgs(tool: CheckTool, args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new CheckArgsError("args must be a JSON object", []);
  }
  const errors = validateSchema(tool.inputSchema as Schema, args);
  if (errors.length > 0) {
    throw new CheckArgsError(`${errors[0]!.path}: ${errors[0]!.msg}`, errors);
  }
  return args as Record<string, unknown>;
}

function loadProject(file: unknown): { project: Project; schemaErrors: Finding[] } {
  if (typeof file !== "string" || file.length === 0) {
    throw new CheckArgsError("args.file must be a path to an rpgkit-project/v1 JSON document", []);
  }
  const loaded = loadProjectFile(file);
  if (!loaded.project) {
    const findings = loaded.schemaErrors;
    throw new CheckLoadError(
      `rpgkit-check: ${findings[0]?.message ?? "could not load project"}`,
      findings,
    );
  }
  return { project: loaded.project, schemaErrors: loaded.schemaErrors };
}

function numArg(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

const FILE_PROP = {
  type: "string",
  description: "Path to the rpgkit-project/v1 JSON document to check.",
} as const;

const CHECK_TOOL_DEFS: CheckTool[] = [
  {
    name: "rpgkit-lint",
    description:
      "Static health check of an rpgkit-project/v1 document: switches/variables read but never set " +
      "(or set but never read), dead pages (shadowed or contradictory conditions), missing references " +
      "(transfer/place/common-event/item/sprite/sheet), empty choices, unreachable maps. " +
      "Returns findings with severity, location and a suggestion.",
    inputSchema: {
      type: "object",
      properties: { file: FILE_PROP },
      required: ["file"],
      additionalProperties: false,
    },
    run: async (args) => {
      const { project, schemaErrors } = loadProject(args.file);
      return lintProject(project, schemaErrors) satisfies CheckReport;
    },
  },
  {
    name: "rpgkit-locks",
    description:
      "Dynamic permanent-input-lock check: every page containing a lockInput is executed in isolation " +
      "on the real engine; the lock must be released (unlockInput or a map transfer) within the frame " +
      "budget. Returns per-page outcomes and error findings for permanent locks.",
    inputSchema: {
      type: "object",
      properties: {
        file: FILE_PROP,
        frames: { type: "number", description: "Frame budget per lock page (default 12000)." },
      },
      required: ["file"],
      additionalProperties: false,
    },
    run: async (args) => {
      const { project } = loadProject(args.file);
      return checkLocks(project, { frames: numArg(args, "frames") }) satisfies LockReport;
    },
  },
  {
    name: "rpgkit-freeze",
    description:
      "Dynamic freeze scan: enter every map (at a transfer landing or its centre), auto-advance " +
      "dialogs and drive the d-pad for a long window. Flags maps where the input lock holds for the " +
      "whole window, a busy fiber makes no world progress, or the interpreter errors.",
    inputSchema: {
      type: "object",
      properties: {
        file: FILE_PROP,
        windowFrames: { type: "number", description: "Detection window in frames (default 6000)." },
      },
      required: ["file"],
      additionalProperties: false,
    },
    run: async (args) => {
      const { project } = loadProject(args.file);
      return checkFreeze(project, { windowFrames: numArg(args, "windowFrames") }) satisfies FreezeReport;
    },
  },
  {
    name: "rpgkit-reach",
    description:
      "EXPERIMENTAL state-based reachability: builds the multi-map walk graph from a real session state " +
      "(dry-run entry per map, live character bodies, engine-selected active pages, transfer edges) and BFSes " +
      "from the start. Returns reachable tile counts per map and the list of unreachable maps. A 'reachable' " +
      "verdict is reliable; an 'unreachable' verdict is a LEAD, NOT A PROOF — the report always carries " +
      "experimental:true and an assumptions list. Known imprecisions: story state is frozen except through " +
      "forced entry transfers; entry pages are dry-run for a fixed 10-tick window (delayed forced transfers " +
      "lose pre-transfer state set after the window); non-zero item/gold baselines can disagree with arrivals " +
      "into unknown; recursive common events are not re-expanded (the real interpreter runaways on them); " +
      "battle outcomes are not modelled.",
    inputSchema: {
      type: "object",
      properties: {
        file: FILE_PROP,
        start: {
          type: "object",
          description: "Start state (defaults to the project start with a fresh bank).",
          properties: {
            map: { type: "string" },
            x: { type: "number" },
            y: { type: "number" },
            dir: { type: "string", enum: ["down", "left", "up", "right"] },
            switches: { type: "object", additionalProperties: { type: "boolean" } },
            variables: { type: "object", additionalProperties: { type: "number" } },
            items: { type: "object", additionalProperties: { type: "number" } },
            gold: { type: "number" },
          },
        },
      },
      required: ["file"],
      additionalProperties: false,
    },
    run: async (args) => {
      const { project } = loadProject(args.file);
      const start = args.start as Parameters<typeof checkReach>[1] extends { start?: infer S } ? S : never;
      return checkReach(project, { start }) satisfies ReachReport;
    },
  },
  {
    name: "rpgkit-explore",
    description:
      "Headless exploration coverage: from the project start, walk to every reachable action/playerTouch " +
      "event (BFS on the engine's passage table with live bodies), trigger it, auto-advance dialogs " +
      "(choices pick option 0), and follow static transfers to the next map. Returns which event pages " +
      "ran and which never did, with a reason.",
    inputSchema: {
      type: "object",
      properties: {
        file: FILE_PROP,
        frames: { type: "number", description: "Total frame budget (default 6000)." },
        stuckFrames: { type: "number", description: "Frames without progress before giving up (default 600)." },
      },
      required: ["file"],
      additionalProperties: false,
    },
    run: async (args) => {
      const { project } = loadProject(args.file);
      return checkExplore(project, {
        frames: numArg(args, "frames"),
        stuckFrames: numArg(args, "stuckFrames"),
      }) satisfies ExploreReport;
    },
  },
  {
    name: "rpgkit-shot",
    description:
      "Schematic screenshots: renders a map at a given state as a PNG at two resolutions (PSP 480x272 " +
      "and desktop 960x544) — passable/blocked/void cells from the engine's passage table, event markers " +
      "colored by the active page's trigger, the player, and an optional reachability overlay. Writes " +
      "PNG files and returns their paths and hashes. Requires `bun run build:example` and `bun run build:wasm`.",
    inputSchema: {
      type: "object",
      properties: {
        file: FILE_PROP,
        map: { type: "string", description: "Map id to render." },
        x: { type: "number" },
        y: { type: "number" },
        dir: { type: "string", enum: ["down", "left", "up", "right"] },
        sw: {
          type: "object",
          description: "Switch bank to seed (switches/variables/items/gold).",
          properties: {
            switches: { type: "object", additionalProperties: { type: "boolean" } },
            variables: { type: "object", additionalProperties: { type: "number" } },
            items: { type: "object", additionalProperties: { type: "number" } },
            gold: { type: "number" },
          },
        },
        reach: {
          type: "array",
          items: { type: "string" },
          description: "Optional 'map@x,y' node keys to tint as reachable (from rpgkit-reach).",
        },
        out: { type: "string", description: "Output directory for the PNGs (default: current directory)." },
      },
      required: ["file", "map", "x", "y"],
      additionalProperties: false,
    },
    run: async (args) => {
      const { project } = loadProject(args.file);
      const options: RenderShotsOptions = {
        map: String(args.map ?? ""),
        x: numArg(args, "x") ?? 0,
        y: numArg(args, "y") ?? 0,
        dir: args.dir as Dir | undefined,
        sw: args.sw as RenderShotsOptions["sw"],
        reach: args.reach as string[] | undefined,
      };
      const out = typeof args.out === "string" ? args.out : ".";
      const outputs: ShotOutput[] = await renderShots(project, options, out);
      return outputs;
    },
  },
];

/** The mounted tools: every run validates its args against the tool's own
 *  inputSchema first, so a bad arg is a CheckArgsError the entry point
 *  reports, never a crash inside the check. */
export const CHECK_TOOLS: CheckTool[] = CHECK_TOOL_DEFS.map((tool) => ({
  ...tool,
  // async so a CheckArgsError thrown by validation surfaces as a rejected
  // promise (what callers awaiting tool.run expect), not a sync throw.
  run: async (args: Record<string, unknown>) => tool.run(validateCheckArgs(tool, args)),
}));

/** Look up a tool by name (for the CLI). Accepts both the full
 *  "rpgkit-<check>" name and the short "<check>" alias. */
export function checkTool(name: string): CheckTool | undefined {
  return CHECK_TOOLS.find((tool) => tool.name === name) ??
    CHECK_TOOLS.find((tool) => tool.name === `rpgkit-${name}`);
}
