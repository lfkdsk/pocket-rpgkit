// tools/lib/map-project.ts — deterministic large-project sharding.
//
// The result is deliberately filesystem/package agnostic. A game importer
// can write `files` verbatim as independent files or add the same byte arrays
// as addressable DATA entries in its pak.

import { canonicalJson, utf8Encode } from "../../src/engine/save.ts";
import {
  MAP_SCHEMA_HASH,
  assertShellManifestFresh,
  canonicalMapJson,
  mapManifestHash,
  sha256Text,
  validateMapDef,
} from "../../src/engine/map-repository.ts";
import type {
  MapIndexEntry,
  Project,
  ProjectShell,
} from "../../src/engine/types.ts";

export interface SplitMapEntry {
  path: string;
  text: string;
  bytes: Uint8Array;
  meta: MapIndexEntry;
}

export interface SplitProjectMaps {
  shell: ProjectShell;
  shellText: string;
  entries: readonly SplitMapEntry[];
  /** Shell first, followed by map entries in id order. */
  files: readonly { path: string; bytes: Uint8Array }[];
}

export interface SplitProjectOptions {
  shellEntry?: string;
  mapEntry?: (id: string) => string;
}

const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** Split an inline project into canonical, byte-stable shell/map payloads. */
export function splitProjectMaps(
  project: Project,
  options: SplitProjectOptions = {},
): SplitProjectMaps {
  const shellEntry = options.shellEntry ?? "project.json";
  const mapEntry = options.mapEntry ?? ((id: string) => `maps/${id}.json`);
  for (const map of project.maps) validateMapDef(map);
  const maps = [...project.maps].sort((a, b) => compareText(a.id, b.id));
  const ids = new Set<string>();
  const paths = new Set<string>([shellEntry]);
  const entries: SplitMapEntry[] = maps.map((map) => {
    if (ids.has(map.id)) throw new Error(`splitProjectMaps: duplicate map id ${map.id}`);
    ids.add(map.id);
    const path = mapEntry(map.id);
    if (!path) throw new Error(`splitProjectMaps: empty entry for ${map.id}`);
    if (paths.has(path)) throw new Error(`splitProjectMaps: duplicate output path ${path}`);
    paths.add(path);
    const text = canonicalMapJson(map);
    const meta: MapIndexEntry = {
      id: map.id,
      width: map.width,
      height: map.height,
      entry: path,
      sha256: sha256Text(text),
    };
    return { path, text, bytes: utf8Encode(text), meta };
  });
  const { maps: _maps, ...globals } = project;
  const unhashed: ProjectShell = {
    ...globals,
    mapIndex: entries.map((entry) => entry.meta),
    mapSchemaHash: MAP_SCHEMA_HASH,
  };
  const shell: ProjectShell = {
    ...unhashed,
    mapManifestHash: mapManifestHash(unhashed),
  };
  // Build-time self-check: the declared identity must match what the exported
  // freshness check computes, so a packaged shell read back from disk and
  // passed to assertShellManifestFresh cannot drift from the splitter.
  assertShellManifestFresh(shell);
  const shellText = canonicalJson(shell);
  return {
    shell,
    shellText,
    entries,
    files: [
      { path: shellEntry, bytes: utf8Encode(shellText) },
      ...entries.map((entry) => ({ path: entry.path, bytes: entry.bytes })),
    ],
  };
}
