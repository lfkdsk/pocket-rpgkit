// editor/engine/document.ts — project document gate: parse, validate
// against src/data/schema.json, and canonical serialize. Pure TS (no
// host imports), so the same gate runs in bun unit tests and the guest.

import { validateSchema, type VError } from "../../src/engine/schema-validate.ts";
import type { Project } from "../../src/engine/types.ts";
import { PROJECT_SCHEMA } from "./projects.ts";

export interface LoadedProject {
  project: Project;
  errors: VError[];
}

/** Parse + validate a rpgkit-project/v1 document. A JSON syntax failure is
 *  one error at "$"; schema failures keep the parsed value so the caller
 *  can show the errors and refuse the export. */
export function loadProject(text: string): LoadedProject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { project: null as unknown as Project, errors: [{ path: "$", msg: `invalid JSON: ${(e as Error).message}` }] };
  }
  return { project: parsed as Project, errors: validateSchema(PROJECT_SCHEMA, parsed) };
}

/** Validate an in-memory project before export. */
export function validateProject(project: Project): VError[] {
  return validateSchema(PROJECT_SCHEMA, project);
}

/** Canonical wire form: 2-space indent + trailing LF, the exact spelling
 *  the example cookers emit data/*.json with. An untouched document
 *  re-serializes byte-for-byte (the round-trip test pins this). */
export function serializeProject(project: Project): string {
  return JSON.stringify(project, null, 2) + "\n";
}

interface JsonNode {
  start: number;
  end: number;
  kind: "array" | "object" | "scalar";
  items?: JsonNode[];
  properties?: Map<string, JsonNode>;
}

/** Serialize an edited project while retaining every unchanged source byte.
 *
 * The editor normally opens the cookers' canonical JSON, but a host file may
 * use a different indentation or property order. Re-stringifying the whole
 * document after changing one event would turn that local edit into a noisy
 * full-file rewrite. This small JSON span parser lets us replace only changed
 * values. Existing array elements are patched recursively; when an events
 * array changes length, unchanged events are reused by id byte-for-byte.
 * Invalid source is impossible here (loadProject is the gate), and callers
 * can fall back to serializeProject if a stale source/project pair is passed.
 */
export function serializeProjectPreservingSource(
  source: string,
  original: Project,
  edited: Project,
): string {
  if (semanticEqual(original, edited)) return source;
  try {
    const root = parseJsonSpans(source);
    const parsed = JSON.parse(source) as unknown;
    if (!semanticEqual(parsed, original)) return serializeProject(edited);
    const patched = patchNode(source, root, original, edited, []);
    return source.slice(0, root.start) + patched + source.slice(root.end);
  } catch {
    return serializeProject(edited);
  }
}

function patchNode(source: string, node: JsonNode, before: unknown, after: unknown, path: string[]): string {
  if (semanticEqual(before, after)) return source.slice(node.start, node.end);

  if (node.kind === "object" && isRecord(before) && isRecord(after)) {
    const beforeKeys = Object.keys(before);
    const afterKeys = Object.keys(after);
    if (sameStrings(beforeKeys, afterKeys) && node.properties) {
      const replacements: { start: number; end: number; text: string }[] = [];
      for (const key of beforeKeys) {
        if (semanticEqual(before[key], after[key])) continue;
        const child = node.properties.get(key);
        if (!child) return stringifyAt(after, source, node.start);
        replacements.push({
          start: child.start,
          end: child.end,
          text: patchNode(source, child, before[key], after[key], [...path, key]),
        });
      }
      return applyLocalReplacements(source, node, replacements);
    }
  }

  if (node.kind === "array" && Array.isArray(before) && Array.isArray(after) && node.items) {
    if (before.length === after.length && node.items.length === before.length) {
      const replacements: { start: number; end: number; text: string }[] = [];
      for (let i = 0; i < before.length; i++) {
        if (semanticEqual(before[i], after[i])) continue;
        const child = node.items[i]!;
        replacements.push({
          start: child.start,
          end: child.end,
          text: patchNode(source, child, before[i], after[i], [...path, String(i)]),
        });
      }
      return applyLocalReplacements(source, node, replacements);
    }
    if (path.at(-1) === "events") {
      const keyed = patchEventArray(source, node, before, after, path);
      if (keyed !== null) return keyed;
    }
  }

  return stringifyAt(after, source, node.start);
}

function patchEventArray(
  source: string,
  node: JsonNode,
  before: unknown[],
  after: unknown[],
  path: string[],
): string | null {
  if (!node.items || !before.every(hasStringId) || !after.every(hasStringId)) return null;
  const old = new Map<string, { value: Record<string, unknown>; node: JsonNode }>();
  for (let i = 0; i < before.length; i++) {
    const value = before[i] as Record<string, unknown>;
    if (old.has(value.id as string) || !node.items[i]) return null;
    old.set(value.id as string, { value, node: node.items[i]! });
  }
  if (new Set(after.map((v) => (v as Record<string, unknown>).id)).size !== after.length) return null;

  const base = lineIndent(source, node.start);
  const childIndent = base + 2;
  const prefix = " ".repeat(childIndent);
  const parts = after.map((value) => {
    const record = value as Record<string, unknown>;
    const prior = old.get(record.id as string);
    return prior
      ? patchNode(source, prior.node, prior.value, record, [...path, record.id as string])
      : stringifyWithIndent(record, childIndent);
  });
  return parts.length === 0 ? "[]" : `[\n${prefix}${parts.join(`,\n${prefix}`)}\n${" ".repeat(base)}]`;
}

function applyLocalReplacements(
  source: string,
  node: JsonNode,
  replacements: { start: number; end: number; text: string }[],
): string {
  let out = source.slice(node.start, node.end);
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    const start = replacement.start - node.start;
    const end = replacement.end - node.start;
    out = out.slice(0, start) + replacement.text + out.slice(end);
  }
  return out;
}

function stringifyAt(value: unknown, source: string, start: number): string {
  return stringifyWithIndent(value, lineIndent(source, start));
}

function stringifyWithIndent(value: unknown, indent: number): string {
  const lines = JSON.stringify(value, null, 2).split("\n");
  return lines.map((line, i) => (i === 0 ? line : " ".repeat(indent) + line)).join("\n");
}

function lineIndent(source: string, at: number): number {
  const line = source.lastIndexOf("\n", at - 1) + 1;
  let i = line;
  while (source[i] === " " || source[i] === "\t") i++;
  return i - line;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasStringId(value: unknown): value is Record<string, unknown> & { id: string } {
  return isRecord(value) && typeof value.id === "string";
}

function sameStrings(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** Parse just enough JSON syntax to associate each value with its exact byte
 * range. JSON.parse remains the semantic parser and validator. */
function parseJsonSpans(source: string): JsonNode {
  let at = 0;
  const ws = (): void => {
    while (at < source.length && /\s/.test(source[at]!)) at++;
  };
  const stringToken = (): { start: number; end: number; value: string } => {
    const start = at;
    if (source[at] !== '"') throw new Error("expected string");
    at++;
    while (at < source.length) {
      const c = source[at++]!;
      if (c === "\\") at++;
      else if (c === '"') break;
    }
    const end = at;
    return { start, end, value: JSON.parse(source.slice(start, end)) as string };
  };
  const value = (): JsonNode => {
    ws();
    const start = at;
    if (source[at] === "{") {
      at++;
      const properties = new Map<string, JsonNode>();
      ws();
      if (source[at] !== "}") {
        while (true) {
          ws();
          const key = stringToken().value;
          ws();
          if (source[at++] !== ":") throw new Error("expected colon");
          const child = value();
          properties.set(key, child);
          ws();
          if (source[at] === "}") break;
          if (source[at++] !== ",") throw new Error("expected comma");
        }
      }
      at++;
      return { start, end: at, kind: "object", properties };
    }
    if (source[at] === "[") {
      at++;
      const items: JsonNode[] = [];
      ws();
      if (source[at] !== "]") {
        while (true) {
          items.push(value());
          ws();
          if (source[at] === "]") break;
          if (source[at++] !== ",") throw new Error("expected comma");
        }
      }
      at++;
      return { start, end: at, kind: "array", items };
    }
    if (source[at] === '"') {
      stringToken();
      return { start, end: at, kind: "scalar" };
    }
    while (at < source.length && !/[\s,\]}]/.test(source[at]!)) at++;
    if (at === start) throw new Error("expected value");
    return { start, end: at, kind: "scalar" };
  };
  const root = value();
  ws();
  if (at !== source.length) throw new Error("trailing JSON input");
  return root;
}

/** Field-level semantic equality (JSON values): true when the two
 *  documents differ in nothing but formatting. */
export function semanticEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => semanticEqual(v, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as Record<string, unknown>).sort();
    const kb = Object.keys(b as Record<string, unknown>).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) =>
      semanticEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}
