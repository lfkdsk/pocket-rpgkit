// editor/api/pack-format.ts — the one definition of the
// `rpgkit-edit/sharded-pack-v1` container format: the kind tag, the portable
// shard-entry key rule, the JSON envelope check, the exact serialization and
// the base64 codec for the optional embedded image assets.
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

/** One image a pack carries in its optional `assets` record, keyed by the
 * relative path the project names it by (see editor/studio/project-art.ts).
 * `data` is the file's bytes in standard padded base64. */
export interface PackAsset {
  type: "image/png";
  data: string;
}

/** The outer pack object, or why `text` is not one. `problem` tells callers
 * which failure it was ("json": unparseable text, "kind": parsed but not a
 * pack envelope) so each can attach its own error details. Shard and asset
 * values are left unchecked; the shell text is not parsed here. `assets` is
 * undefined when the pack has none (every pack written before assets
 * existed); readers that do not use art can ignore it. */
export type PackEnvelope =
  | { problem: null; shell: string; shards: Record<string, unknown>; assets: Record<string, unknown> | undefined }
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
  if (value.assets !== undefined && !isRecord(value.assets)) {
    return { problem: "kind", message: `a ${SHARDED_PACK_KIND} document's "assets" must be an object` };
  }
  return { problem: null, shell: value.shell, shards: value.shards, assets: value.assets };
}

/** Serialize in the canonical spelling: two-space JSON, shards in the order
 * given (callers pass catalog order), then the assets in the order given,
 * trailing newline. `assets` is written only when there is at least one, so
 * a pack without art keeps the exact bytes it had before assets existed. A
 * null-prototype record keeps keys such as "__proto__" ordinary own
 * properties. */
export function packText(
  shellText: string,
  entries: Iterable<readonly [string, string]>,
  assets?: Iterable<readonly [string, PackAsset]>,
): string {
  const shards = Object.create(null) as Record<string, string>;
  for (const [entry, text] of entries) shards[entry] = text;
  const pack: Record<string, unknown> = { kind: SHARDED_PACK_KIND, shell: shellText, shards };
  const art = Object.create(null) as Record<string, PackAsset>;
  let any = false;
  for (const [path, asset] of assets ?? []) {
    art[path] = { type: asset.type, data: asset.data };
    any = true;
  }
  if (any) pack.assets = art;
  return `${JSON.stringify(pack, null, 2)}\n`;
}

// ---- base64 ---------------------------------------------------------------
// Hand-rolled so the codec is the same in browsers, Bun and Node without
// Buffer, and strict: atob accepts whitespace and missing padding.

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUES = (() => {
  const values = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i++) values[BASE64_ALPHABET.charCodeAt(i)] = i;
  return values;
})();

/** Bytes a well-formed base64 text of `length` characters decodes to, at
 * most (padding not subtracted); lets callers refuse oversized data before
 * decoding it. */
export function base64DecodedBound(length: number): number {
  return Math.ceil(length / 4) * 3;
}

/** Standard padded base64 of `bytes`. */
export function encodeBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const codes: number[] = [];
  const flush = () => {
    chunks.push(String.fromCharCode(...codes));
    codes.length = 0;
  };
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    codes.push(
      BASE64_ALPHABET.charCodeAt(a >> 2),
      BASE64_ALPHABET.charCodeAt(((a & 3) << 4) | (b >> 4)),
      i + 1 < bytes.length ? BASE64_ALPHABET.charCodeAt(((b & 15) << 2) | (c >> 6)) : 61,
      i + 2 < bytes.length ? BASE64_ALPHABET.charCodeAt(c & 63) : 61,
    );
    if (codes.length >= 8192) flush();
  }
  flush();
  return chunks.join("");
}

/** The bytes of a standard padded base64 text, or null when it is not one:
 * a length that is not a multiple of four, a character outside the
 * alphabet, padding anywhere but the last one or two places, or nonzero
 * unused bits before the padding (so every byte string has one spelling). */
export function decodeBase64(text: string): Uint8Array | null {
  if (text.length % 4 !== 0) return null;
  const pad = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array((text.length / 4) * 3 - pad);
  let at = 0;
  for (let i = 0; i < text.length; i += 4) {
    const last = i + 4 === text.length;
    const quad = [0, 0, 0, 0];
    for (let j = 0; j < 4; j++) {
      const code = text.charCodeAt(i + j);
      if (last && j >= 4 - pad) continue;
      const value = code < 128 ? BASE64_VALUES[code]! : -1;
      if (value < 0) return null;
      quad[j] = value;
    }
    const [a, b, c, d] = quad as [number, number, number, number];
    bytes[at++] = (a << 2) | (b >> 4);
    if (last && pad === 2) {
      if ((b & 15) !== 0) return null;
      break;
    }
    bytes[at++] = ((b & 15) << 4) | (c >> 2);
    if (last && pad === 1) {
      if ((c & 3) !== 0) return null;
      break;
    }
    bytes[at++] = ((c & 3) << 6) | d;
  }
  return bytes;
}
