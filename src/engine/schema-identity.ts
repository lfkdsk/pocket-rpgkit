// src/engine/schema-identity.ts — which project-schema generations a sharded
// shell or save may name.
//
// A sharded shell and every save taken from it record the schema identity
// they were produced under (`mapSchemaHash`, `content.schema`). The identity
// is SHA-256 over canonical src/data/schema.json, so every schema edit,
// however small, yields a new one. Most v1 edits only add optional fields,
// commands or conditions: a document written for the older schema is still
// valid under the new one and means the same thing, and the runtime keeps
// accepting it. Those predecessors are listed here.
//
// Rules for changing this file when schema.json changes:
// - A purely additive change (every older document still validates and
//   behaves identically: a new optional property, a new command/condition
//   variant, a new enum value, a loosened limit) moves the outgoing
//   MAP_SCHEMA_HASH to the top of MAP_SCHEMA_COMPATIBLE_HASHES with a note.
// - Anything else (a new required field, a removed or tightened value, an
//   existing field that now behaves differently) is a new generation: clear
//   the list. Older shells and saves are then refused until a migration
//   exists. Note the break in src/data/CHANGELOG.md.
// tests/schema-compat.test.ts enforces that each schema edit takes one of
// these two paths.

/** SHA-256 of canonical src/data/schema.json. A test derives it from the file
 * so schema edits cannot leave it stale; keeping the literal avoids hashing
 * the schema at startup. */
export const MAP_SCHEMA_HASH = "c0588207c28d2ffcec9e2ac981f9859ca55576fb7dc53f221466c249d07bfa06";

/** Earlier schema identities whose shells and saves remain loadable, newest
 * first. Each entry names the change that superseded it.
 *
 * History of cleared lists (each break refuses every identity before it):
 * - `0b9fff5b…` → current only added an optional field, so it is listed.
 * - `47cf3d8f…` → `0b9fff5b…` added the `scene` command, but the same change
 *   made a parallel page's queued battle drop when the page stops being
 *   active before the battle starts; older documents that relied on the
 *   battle still starting behave differently.
 * - `462299c3…` → `c27e2e51…` clamps numeric variable writes to safe
 *   integers, and saves holding larger numbers are refused.
 * - `c8ca2ce7…` → `462299c3…` turns a transfer to an unknown map from a
 *   thrown host error into the frozen content-error state.
 * - `9570c570…` → `c8ca2ce7…` made `blocks: false` events stop blocking
 *   character movement.
 * tests/fixtures/schema-compat keeps a refused fixture and a recorded
 * counterexample for each of these. */
export const MAP_SCHEMA_COMPATIBLE_HASHES: readonly string[] = Object.freeze([
  // superseded by: optional `icon` on choices options
  "0b9fff5b478b87e0dcae1f37044a444043c735339ca45245bdbbb9e2e36e7ab5",
]);

/** True when the current runtime accepts shells and saves that name `hash`. */
export function isCompatibleMapSchemaHash(hash: string): boolean {
  return hash === MAP_SCHEMA_HASH || MAP_SCHEMA_COMPATIBLE_HASHES.includes(hash);
}

/** Explains why `hash` is refused by this runtime, for shell and save errors. */
export function describeMapSchemaRefusal(hash: string): string {
  const short = (h: string) => `${h.slice(0, 8)}…`;
  const accepted = [MAP_SCHEMA_HASH, ...MAP_SCHEMA_COMPATIBLE_HASHES].map(short).join(", ");
  return `schema ${short(hash)} is not one this runtime reads (it reads ${accepted}); ` +
    "it comes from before a breaking format change or from a different RPG Kit build, " +
    "see Schema identities in the rpgkit-project CHANGELOG";
}
