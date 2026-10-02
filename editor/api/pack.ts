// editor/api/pack.ts — the self-contained `rpgkit-edit/sharded-pack-v1`
// container: one JSON file carrying a ProjectShell text and the exact text of
// every shard it indexes. Browsers cannot open a directory of shard files, so
// browser front-ends exchange this file instead; the logical edits inside it
// are still ordinary sharded patch-v1 operations (see sharded.ts).
//
// Shard texts stay opaque strings here. Unchanged shards are written back
// byte-for-byte, so a replacement pack differs from its source only in the
// shell and the shards an edit actually touched.
//
// A pack may also carry the project's art: an optional `assets` record of
// PNG images keyed by the relative paths the project names them by. Assets
// are opaque here too (checked, never re-encoded) and written back exactly.
//
// The format itself (kind tag, entry-key rule, envelope check, byte spelling)
// lives in pack-format.ts, shared with the browser player; this file adds the
// strict ProjectShell gate, the asset checks and EditApiError reporting.

import type { MapIndexEntry, ProjectShell } from "../../src/engine/types.ts";
import {
  MAX_PACK_BYTES,
  MAX_PROJECT_FILE_BYTES,
  MAX_SHARD_BYTES,
  PNG_HEADER_BYTES,
  packAssetBytesProblem,
  packAssetCountProblem,
  packFileProblem,
  pngProblem,
  projectFileProblem,
  readPngSize,
  shardCountProblem,
  shardProblem,
  utf8Bytes,
} from "./limits.ts";
import { EditApiError } from "./operations.ts";
import {
  base64DecodedBound,
  decodeBase64,
  packEntryProblem,
  packText,
  readPackEnvelope,
  SHARDED_PACK_KIND,
  type PackAsset,
} from "./pack-format.ts";
import { loadValidatedProjectShell } from "./sharded.ts";

export { SHARDED_PACK_KIND, type PackAsset };

export interface ShardedPack {
  shellText: string;
  shell: ProjectShell;
  /** Entry -> shard text, in the shell's mapIndex order. */
  shards: Map<string, string>;
  /** Relative path -> embedded image, in the pack's order; empty when the
   * pack carries no art. */
  assets: Map<string, PackAsset>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A map-index entry is an opaque POSIX-relative key, never an OS path. */
export function assertPackEntry(value: unknown): string {
  const problem = packEntryProblem(value);
  if (problem !== null) throw new EditApiError("INVALID_PACK", problem, "$.shards", "relative key", value);
  return value as string;
}

/** True when `text` looks like a sharded pack (cheap sniff, no validation). */
export function sourceDeclaresShardedPack(text: string): boolean {
  try {
    const value = JSON.parse(text) as unknown;
    return isRecord(value) && value.kind === SHARDED_PACK_KIND;
  } catch {
    return false;
  }
}

function tooLarge(problem: string | null, path: string): void {
  if (problem !== null) throw new EditApiError("TOO_LARGE", problem, path);
}

/** Parse a pack. The shell passes the same strict gate as file-backed shells;
 * shard texts are only checked for presence and size here and are validated
 * lazily by loadValidatedMapShard when a map is first opened. Resource limits
 * (limits.ts) are checked first: the whole text before it is parsed, the
 * shard count and the shell's size before the shell is validated. Embedded
 * assets are checked last (parsePackAssets). */
export function parseShardedPack(text: string): ShardedPack {
  tooLarge(packFileProblem(utf8Bytes(text, MAX_PACK_BYTES)), "$");
  const envelope = readPackEnvelope(text);
  if (envelope.problem === "json") throw new EditApiError("INVALID_PACK", envelope.message, "$");
  if (envelope.problem === "kind") throw new EditApiError("INVALID_PACK", envelope.message, "$", SHARDED_PACK_KIND);
  const supplied = envelope.shards;
  const entries = Object.keys(supplied);
  tooLarge(shardCountProblem(entries.length), "$.shards");
  tooLarge(projectFileProblem(utf8Bytes(envelope.shell, MAX_PROJECT_FILE_BYTES), "the pack's shell"), "$.shell");
  for (const entry of entries) {
    const shard = supplied[entry];
    if (typeof shard === "string") tooLarge(shardProblem(entry, utf8Bytes(shard, MAX_SHARD_BYTES)), `$.shards[${JSON.stringify(entry)}]`);
  }
  const shell = loadValidatedProjectShell(envelope.shell);
  tooLarge(shardCountProblem(shell.mapIndex.length), "$.shell");
  for (const entry of entries) {
    assertPackEntry(entry);
    if (!shell.mapIndex.some((meta) => meta.entry === entry)) {
      throw new EditApiError("INVALID_PACK", `pack contains unindexed shard ${JSON.stringify(entry)}`, "$.shards");
    }
  }
  const shards = new Map<string, string>();
  for (const meta of shell.mapIndex) {
    assertPackEntry(meta.entry);
    const shard = supplied[meta.entry];
    if (typeof shard !== "string") {
      throw new EditApiError("INVALID_PACK", `pack is missing shard text for ${JSON.stringify(meta.entry)}`, "$.shards");
    }
    shards.set(meta.entry, shard);
  }
  return { shellText: envelope.shell, shell, shards, assets: parsePackAssets(envelope.assets) };
}

/** Check a pack's `assets` record. Each key is a portable relative path
 * (the shard-entry rule); each value is `{ type: "image/png", data }` whose
 * base64 data decodes to a PNG within the local-PNG limits. The count and
 * the decoded total are limited per pack; an image's size is checked from
 * its base64 length before it is decoded. */
function parsePackAssets(supplied: Record<string, unknown> | undefined): Map<string, PackAsset> {
  const assets = new Map<string, PackAsset>();
  if (supplied === undefined) return assets;
  const paths = Object.keys(supplied);
  tooLarge(packAssetCountProblem(paths.length), "$.assets");
  let total = 0;
  for (const path of paths) {
    const at = `$.assets[${JSON.stringify(path)}]`;
    if (packEntryProblem(path) !== null) {
      throw new EditApiError("INVALID_PACK", `unsafe asset path ${JSON.stringify(path)}; asset keys must be portable relative paths`, "$.assets", "relative key", path);
    }
    const value = supplied[path];
    if (!isRecord(value) || typeof value.data !== "string" || Object.keys(value).some((key) => key !== "type" && key !== "data")) {
      throw new EditApiError("INVALID_PACK", `asset ${JSON.stringify(path)} must be an object with only "type" and "data"`, at);
    }
    if (value.type !== "image/png") {
      throw new EditApiError("INVALID_PACK", `asset ${JSON.stringify(path)} has type ${JSON.stringify(value.type)}; only "image/png" is supported`, `${at}.type`, "image/png", value.type);
    }
    const data = value.data;
    // Refuse an oversized image from its base64 length, before decoding.
    tooLarge(pngProblem(`asset ${JSON.stringify(path)}`, base64DecodedBound(data.length) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0)), `${at}.data`);
    const bytes = decodeBase64(data);
    if (bytes === null) throw new EditApiError("INVALID_PACK", `asset ${JSON.stringify(path)} is not valid base64`, `${at}.data`);
    total += bytes.length;
    tooLarge(packAssetBytesProblem(total), "$.assets");
    const header = bytes.subarray(0, PNG_HEADER_BYTES);
    const size = readPngSize(header);
    const problem = pngProblem(`asset ${JSON.stringify(path)}`, bytes.length, header);
    if (problem !== null) throw new EditApiError(size === null || size.width === 0 || size.height === 0 ? "INVALID_PACK" : "TOO_LARGE", problem, `${at}.data`);
    assets.set(path, { type: "image/png", data });
  }
  return assets;
}

/** Serialize in the browser host's spelling: two-space JSON, shards in
 * catalog order, then any assets in the order given, trailing newline. */
export function serializeShardedPack(
  shellText: string,
  catalog: readonly MapIndexEntry[],
  shards: ReadonlyMap<string, string>,
  assets?: ReadonlyMap<string, PackAsset>,
): string {
  const ordered: [string, string][] = [];
  for (const meta of catalog) {
    const text = shards.get(meta.entry);
    if (text === undefined) throw new EditApiError("INVALID_PACK", `pack is missing shard text for ${JSON.stringify(meta.entry)}`, "$.shards");
    ordered.push([meta.entry, text]);
  }
  return packText(shellText, ordered, assets);
}
