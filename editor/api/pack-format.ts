// editor/api/pack-format.ts — the one definition of the
// `rpgkit-edit/sharded-pack-v1` container format: the kind tag, the portable
// shard-entry key rule, the JSON envelope check and the exact serialization.
//
// Two front-ends read and write packs: the TypeScript edit API (pack.ts,
// which reports EditApiError) and the no-build browser player
// (tools/web/player.js, which reports plain Error). Both wrap these helpers in
// their own error type, so the rules, messages and bytes cannot drift apart.
// This module has NO imports so the browser bundle pulls in nothing else.

export const SHARDED_PACK_KIND = "rpgkit-edit/sharded-pack-v1" as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A map-index entry is an opaque POSIX-relative key, never a browser or OS
 * path. Returns the rejection message, or null for an acceptable key.
 * Rejecting traversal and alternate separators keeps packs portable. */
export function packEntryProblem(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || /[\x00-\x1f\x7f]/.test(value)) {
    return "shard entries must be non-empty portable path keys";
  }
  const parts = value.split("/");
  if (value.startsWith("/") || /^[a-zA-Z]:/.test(value) || parts.some((part) => part === "" || part === "." || part === "..")) {
    return `unsafe shard entry ${JSON.stringify(value)}`;
  }
  return null;
}

/** The outer pack object, or why `text` is not one. `problem` tells callers
 * which failure it was ("json": unparseable text, "kind": parsed but not a
 * pack envelope) so each can attach its own error details. Shard values are
 * left unchecked; the shell text is not parsed here. */
export type PackEnvelope =
  | { problem: null; shell: string; shards: Record<string, unknown> }
  | { problem: "json"; message: string }
  | { problem: "kind"; message: string };

export function readPackEnvelope(text: string): PackEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { problem: "json", message: `pack is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isRecord(value) || value.kind !== SHARDED_PACK_KIND || typeof value.shell !== "string" || !isRecord(value.shards)) {
    return { problem: "kind", message: `not a ${SHARDED_PACK_KIND} document` };
  }
  return { problem: null, shell: value.shell, shards: value.shards };
}

/** Serialize in the canonical spelling: two-space JSON, shards in the order
 * given (callers pass catalog order), trailing newline. A null-prototype
 * record keeps keys such as "__proto__" ordinary own properties. */
export function packText(shellText: string, entries: Iterable<readonly [string, string]>): string {
  const shards = Object.create(null) as Record<string, string>;
  for (const [entry, text] of entries) shards[entry] = text;
  return `${JSON.stringify({ kind: SHARDED_PACK_KIND, shell: shellText, shards }, null, 2)}\n`;
}
