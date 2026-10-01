// tools/rpgkit-check/src/finding.ts — the one shape every rpgkit-check
// finding shares, plus the JSON report envelope the CLI and the MCP tools
// emit. A finding always says WHERE in the document it was found and WHAT
// to do about it, so an agent (or a human) can act without re-reading the
// project.

export type Severity = "error" | "warning" | "info";

/** Where a finding lives. Every field is optional except what is known:
 *  a schema error may only have a JSON pointer; a dead page has map/event/
 *  page; a bad command has its index path inside the page's command tree. */
export interface FindingLocation {
  map?: string;
  event?: string;
  /** Common event id (for findings inside project.commonEvents). */
  common?: string;
  /** Page index within the event's pages array. */
  page?: number;
  /** Command index path from the page root, with branch tags through
   *  if/choices/battle/common (see walk.ts). */
  commandPath?: readonly (number | string)[];
  /** JSON pointer for document-level findings (schema errors etc.). */
  pointer?: string;
}

export interface Finding {
  /** Stable check id, e.g. "lint/transfer-target-missing". */
  check: string;
  severity: Severity;
  /** One sentence, human readable. */
  message: string;
  /** What to change (or why it is safe to ignore). */
  suggestion: string;
  loc: FindingLocation;
}

export function makeFinding(
  check: string,
  severity: Severity,
  message: string,
  suggestion: string,
  loc: FindingLocation = {},
): Finding {
  return { check, severity, message, suggestion, loc };
}

/** The envelope every check returns. `summary` carries check-specific
 *  numbers (counts scanned, outcomes) for the report; `findings` is the
 *  actionable list. */
export interface CheckReport {
  check: string;
  findings: Finding[];
  summary: Record<string, number | string | boolean>;
}

export function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  const out: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) out[finding.severity]++;
  return out;
}

/** CLI exit policy: any error-severity finding fails the check. */
export function hasErrors(report: CheckReport): boolean {
  return report.findings.some((finding) => finding.severity === "error");
}
