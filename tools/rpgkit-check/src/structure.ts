// tools/rpgkit-check/src/structure.ts — document-structure findings that
// need no file system, shared by the CLI (via doc.ts) and browser editors.

import type { Project } from "../../../src/engine/types.ts";
import { makeFinding, type Finding } from "./finding.ts";

/** Structural sanity that is cheaper to assert once than in every check:
 *  duplicate map ids and duplicate event ids. Returns findings (empty when
 *  the document is clean). */
export function structuralFindings(project: Project): Finding[] {
  const findings: Finding[] = [];
  const mapIds = new Set<string>();
  for (const map of project.maps) {
    if (mapIds.has(map.id)) {
      findings.push(
        makeFinding(
          "lint/map-id-duplicate",
          "error",
          `duplicate map id ${JSON.stringify(map.id)}`,
          "map ids must be unique; the engine keys worlds and transfers by them",
          { map: map.id },
        ),
      );
    }
    mapIds.add(map.id);
    const eventIds = new Set<string>();
    for (const event of map.events ?? []) {
      if (eventIds.has(event.id)) {
        findings.push(
          makeFinding(
            "lint/event-id-duplicate",
            "error",
            `event ${JSON.stringify(event.id)} appears twice on map ${JSON.stringify(map.id)}`,
            "event ids must be unique within a map; the engine keys characters and self-switches by them",
            { map: map.id, event: event.id },
          ),
        );
      }
      eventIds.add(event.id);
    }
  }
  return findings;
}
