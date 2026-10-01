// tools/rpgkit-check/src/dynamic/reach-static.ts — deterministic structural
// checks about transfers. Unlike the search, these are proofs: they hold for
// every story state, not just the states the search explored.
//
//   reach/transfer-target-missing  (error)   a literal transfer names a map
//                                             that is not in the document
//   reach/transfer-landing-blocked (warning) a literal transfer lands on a
//                                             non-standable terrain tile
//   reach/map-orphan               (info)    no literal transfer anywhere
//                                             points at the map (start map
//                                             excepted)
//   reach/dynamic-transfer         (info)    a transfer whose target map is
//                                             a variable reference — the
//                                             search cannot follow it

import { isStandable } from "../../../../src/engine/passability.ts";
import type { Session } from "../../../../src/engine/session.ts";
import type { Command, Project } from "../../../../src/engine/types.ts";
import { makeFinding, type Finding, type FindingLocation } from "../finding.ts";
import { walkProjectCommands, type CommandPath } from "../walk.ts";

interface TransferRef {
  loc: FindingLocation;
  target: string | { variable: string };
  x: number | { variable: string };
  y: number | { variable: string };
}

function collectTransfers(project: Project): TransferRef[] {
  const refs: TransferRef[] = [];
  const walk = (commands: readonly Command[], loc: FindingLocation): void => {
    walkProjectCommands(project, commands, (command: Command, path: CommandPath) => {
      if (command.op !== "transfer") return;
      refs.push({
        loc: { ...loc, commandPath: [...path] },
        target: command.map,
        x: command.x,
        y: command.y,
      });
    });
  };
  for (const map of project.maps) {
    for (const ev of map.events ?? []) {
      ev.pages.forEach((page, pageIndex) => {
        walk(page.commands, { map: map.id, event: ev.id, page: pageIndex });
      });
    }
  }
  for (const common of project.commonEvents ?? []) {
    walk(common.commands, { common: common.id });
  }
  return refs;
}

/** The structural transfer findings. `session` supplies the authored
 *  passage tables (runtime tileProperty overrides are story-state-dependent
 *  and out of scope for a static proof). */
export function staticTransferChecks(project: Project, session: Session): Finding[] {
  const findings: Finding[] = [];
  const mapsById = new Map(project.maps.map((m) => [m.id, m]));
  const refs = collectTransfers(project);

  // Literal targets: missing map, blocked landing, and the inbound set.
  const inbound = new Set<string>();
  for (const ref of refs) {
    if (typeof ref.target !== "string") continue;
    inbound.add(ref.target);
    if (!mapsById.has(ref.target)) {
      findings.push(makeFinding(
        "reach/transfer-target-missing",
        "error",
        `transfer targets map ${JSON.stringify(ref.target)}, which is not in the document`,
        "fix the transfer's map id, or add the map to the document",
        ref.loc,
      ));
      continue;
    }
    if (typeof ref.x === "number" && typeof ref.y === "number") {
      const table = session.tables.get(ref.target);
      if (table && !isStandable(table, ref.x, ref.y)) {
        findings.push(makeFinding(
          "reach/transfer-landing-blocked",
          "warning",
          `transfer to ${JSON.stringify(ref.target)} lands on (${ref.x}, ${ref.y}), which is not standable terrain`,
          "move the landing to a standable tile; the engine still places the player there, but the tile may trap them",
          ref.loc,
        ));
      }
    }
  }

  // Dynamic-target transfers: the search cannot follow a variable target.
  for (const ref of refs) {
    if (typeof ref.target === "string") continue;
    findings.push(makeFinding(
      "reach/dynamic-transfer",
      "info",
      `transfer target is the variable ${JSON.stringify(ref.target.variable)}, resolved at runtime`,
      "the reach search follows only literal map targets; this transfer is listed, not followed",
      ref.loc,
    ));
  }

  // Orphan maps: no literal transfer points at them.
  for (const map of project.maps) {
    if (map.id === project.start.map) continue;
    if (inbound.has(map.id)) continue;
    findings.push(makeFinding(
      "reach/map-orphan",
      "info",
      `map ${JSON.stringify(map.id)} has no literal transfer pointing at it`,
      "it may still be reachable via a dynamic (variable-target) transfer, a battle completion, or extension logic; the search report says whether a witness was found",
      { map: map.id },
    ));
  }

  return findings;
}
