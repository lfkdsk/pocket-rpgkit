// editor/api/types.ts — stable JSON wire types for headless project editing.

import type { JsonValue } from "../../src/engine/types.ts";

export const EDIT_COMMANDS = [
  "open",
  "list-maps",
  "list-events",
  "list-pages",
  "list-commands",
  "paint-tile",
  "paint-rect",
  "fill-region",
  "add-event",
  "update-event",
  "delete-event",
  "add-page",
  "update-page",
  "delete-page",
  "insert-command",
  "delete-command",
  "update-command",
  "validate",
  "save",
] as const;

export type EditCommandName = (typeof EDIT_COMMANDS)[number];

/** One side of a patch change. `exists` distinguishes a missing property
 * from a property whose JSON value is null. */
export type PatchValue =
  | { exists: false }
  | { exists: true; value: JsonValue };

/** A reversible JSON change. Paths use RFC 6901 JSON Pointer spelling. */
export interface EditChange {
  path: string;
  before: PatchValue;
  after: PatchValue;
}

/** Semantic hashes make a patch fail closed when the document has drifted.
 * Each change contains both values, so the same patch applies forward or in
 * reverse without a separate undo payload. */
export interface EditPatch {
  format: "rpgkit-edit/patch-v1";
  beforeHash: string;
  afterHash: string;
  changes: EditChange[];
}

export interface ProjectSummary {
  format: string;
  title: string;
  documentKind: "inline" | "shell";
  editable: boolean;
  mapCount: number;
  /** SHA-256 of canonical semantic JSON. Positional page/command addresses
   * are reusable while this revision still matches. */
  revision: string;
}

export interface EditErrorBody {
  code: string;
  message: string;
  path?: string;
  expected?: unknown;
  actual?: unknown;
  details?: unknown;
}

export interface EditSuccess {
  ok: true;
  command: EditCommandName;
  project: ProjectSummary;
  changed: boolean;
  addresses: string[];
  diff: EditChange[];
  patch?: EditPatch;
  result: unknown;
}

export interface EditFailure {
  ok: false;
  command?: string;
  error: EditErrorBody;
}

export type EditResponse = EditSuccess | EditFailure;

export interface EditExecution {
  response: EditResponse;
  /** Present for a successful modifying operation. The file adapter decides
   * whether to persist it (normal mode) or discard it (dry-run). */
  output?: string;
}

export interface FileEditSuccess extends EditSuccess {
  file: string;
  dryRun: boolean;
  written: boolean;
}

export type FileEditResponse = FileEditSuccess | (EditFailure & {
  file?: string;
  dryRun?: boolean;
  written?: false;
});
