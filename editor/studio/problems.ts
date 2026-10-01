// editor/studio/problems.ts — one list for schema validation problems (the
// protocol's `validate`) and rpgkit-check lint findings, each with a
// location Studio can jump to. Pure (no DOM) so it is unit-tested.

import type { Project } from "../../src/engine/types.ts";
import type { SessionProblem } from "../api/session.ts";
import { lintProject } from "../../tools/rpgkit-check/src/lint.ts";

export interface StudioProblem {
  severity: "error" | "warning" | "info";
  source: "schema" | "check";
  message: string;
  /** Check id (rpgkit-check) or the JSON path (schema). */
  code: string;
  map?: string;
  event?: string;
  page?: number;
}

/** Resolve "$.maps[2].events[0].pages[1]…" against the document. */
export function locateSchemaPath(project: Pick<Project, "maps"> | null, path: string): Pick<StudioProblem, "map" | "event" | "page"> {
  const out: Pick<StudioProblem, "map" | "event" | "page"> = {};
  const mapMatch = /^\$\.maps\[(\d+)\]/.exec(path);
  if (!mapMatch || !project) return out;
  const map = project.maps[Number(mapMatch[1])];
  if (!map) return out;
  out.map = map.id;
  const eventMatch = /^\$\.maps\[\d+\]\.events\[(\d+)\]/.exec(path);
  const event = eventMatch ? map.events?.[Number(eventMatch[1])] : undefined;
  if (!event) return out;
  out.event = event.id;
  const pageMatch = /^\$\.maps\[\d+\]\.events\[\d+\]\.pages\[(\d+)\]/.exec(path);
  if (pageMatch && event.pages[Number(pageMatch[1])]) out.page = Number(pageMatch[1]);
  return out;
}

export function schemaProblems(project: Pick<Project, "maps"> | null, problems: readonly SessionProblem[]): StudioProblem[] {
  return problems.map((problem) => ({
    severity: "error",
    source: "schema",
    message: problem.msg,
    code: problem.path,
    ...locateSchemaPath(project, problem.path),
  }));
}

/** rpgkit-check's static lint over an inline project. */
export function checkProblems(project: Project): StudioProblem[] {
  return lintProject(project).findings.map((finding) => ({
    severity: finding.severity,
    source: "check",
    message: `${finding.message}. ${finding.suggestion}`,
    code: finding.check,
    ...(finding.loc.map === undefined ? {} : { map: finding.loc.map }),
    ...(finding.loc.event === undefined ? {} : { event: finding.loc.event }),
    ...(finding.loc.page === undefined ? {} : { page: finding.loc.page }),
  }));
}
