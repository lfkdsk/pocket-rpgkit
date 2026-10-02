// src/host/attract-tape.ts — where attract mode gets its tape.
//
// The game passes its built-in winning playthrough (a frozen RLE tape).
// On a host that mounted data.fs (linux-app/macos-app) a file named
// attract-tape.json at the app's own data root REPLACES it, so a different
// recorded run can drive the demo without rebuilding: drop the file in,
// relaunch. The document is the devtools tape shape tools/tape.ts writes;
// any read or shape failure falls back to the built-in tape. On targets
// without fs (web-app, sim) the built-in tape is always used.

import { file, fsHost } from "@pocketjs/framework/fs";
import type { WorldTraversalMode } from "../engine/types.ts";
import { expandTapeRuns, parseTapeDocumentWithIdentity } from "../engine/tape.ts";

/** The tape attract mode plays: the fs override when present and valid,
 *  otherwise the built-in runs. */
export function loadAttractTape(
  builtin: readonly (readonly [number, number])[],
  overrideName = "attract-tape.json",
  builtinWorldTraversal: WorldTraversalMode = "legacy-transfer",
): { masks: number[]; external: boolean; worldTraversal: WorldTraversalMode } {
  if (fsHost()) {
    try {
      const f = file(overrideName);
      if (f.exists()) {
        const external = parseTapeDocumentWithIdentity(f.text());
        if (external) return { ...external, external: true };
      }
    } catch {
      // Host error (missing file etc.): built-in tape.
    }
  }
  return {
    masks: expandTapeRuns(builtin),
    external: false,
    worldTraversal: builtinWorldTraversal,
  };
}
