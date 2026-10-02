// src/engine/schema-validate.ts — minimal JSON Schema (draft
// 2020-12 subset) validator covering the constructs data/schema.json uses:
// type, const, enum, properties/required/additionalProperties, items,
// minItems/maxItems, oneOf/anyOf/allOf/not, if/then/else, $ref + $defs, pattern,
// minLength/maxLength, minimum/maximum, exclusiveMinimum, minProperties,
// uniqueItems, prefixItems. Not a general-purpose validator — a zero-dependency checker
// for THIS schema, so the runtime data keeps an acceptance gate without
// adding a dependency.

export type Schema = Record<string, any>;

export interface VError {
  path: string;
  msg: string;
}

/** Values already known to satisfy a schema node: objects/arrays by
 * identity, and scalar array items by value (a map's ground cells repeat a
 * few tile ids thousands of times). Only callers that never mutate a
 * validated value in place may pass one (the editor's protocol keeps every
 * document revision immutable); a value is skipped only where a previous
 * walk proved it valid, so the error list is unchanged. */
export interface SchemaMemo {
  objects: WeakMap<Schema, WeakSet<object>>;
  items: WeakMap<Schema, Set<unknown>>;
  /** Arrays known to equal `base` except at `changed` indexes (ascending,
   *  distinct; a diff's output). When `base` was proven valid under the same
   *  schema, only those items are walked. */
  deltas?: WeakMap<object, { base: unknown[]; changed: readonly number[] }>;
}

export function createSchemaMemo(): SchemaMemo {
  return { objects: new WeakMap(), items: new WeakMap() };
}

export function validateSchema(
  root: Schema,
  instance: unknown,
  schema: Schema = root,
  memo?: SchemaMemo,
): VError[] {
  const errs: VError[] = [];
  const path: (string | number)[] = [];
  const patterns = new Map<string, RegExp>();
  const allowedKeys = new Map<Schema, Set<string>>();
  let recording = true;

  const pathText = (): string => "$" + path.map((part) =>
    typeof part === "number" ? `[${part}]` : `.${part}`).join("");
  const typeIs = (ty: string, v: unknown): boolean => {
    switch (ty) {
      case "object": return v !== null && typeof v === "object" && !Array.isArray(v);
      case "array": return Array.isArray(v);
      case "string": return typeof v === "string";
      case "integer": return typeof v === "number" && Number.isInteger(v);
      case "number": return typeof v === "number";
      case "boolean": return typeof v === "boolean";
      case "null": return v === null;
      default: return false;
    }
  };
  const typeMatches = (type: string | readonly string[], v: unknown): boolean =>
    Array.isArray(type) ? type.some((ty: string) => typeIs(ty, v)) : typeIs(type as string, v);

  const walk = (sch: Schema, v: unknown): boolean => {
    if (sch.$ref) {
      const name = sch.$ref.split("/").pop()!;
      return walk(root.$defs[name], v);
    }
    if (memo !== undefined && v !== null && typeof v === "object") {
      if (memo.objects.get(sch)?.has(v)) return true;
      const valid = check(sch, v);
      if (valid) {
        let known = memo.objects.get(sch);
        if (!known) memo.objects.set(sch, known = new WeakSet());
        known.add(v);
      }
      return valid;
    }
    return check(sch, v);
  };

  const check = (sch: Schema, v: unknown): boolean => {
    let valid = true;
    const fail = (msg: string): void => {
      valid = false;
      if (recording) errs.push({ path: pathText(), msg });
    };

    if (sch.const !== undefined && v !== sch.const) fail(`must equal ${JSON.stringify(sch.const)}`);
    if (sch.enum && !sch.enum.includes(v)) fail(`must be one of ${JSON.stringify(sch.enum)}`);
    if (sch.type && !typeMatches(sch.type, v)) {
      fail(`expected ${JSON.stringify(sch.type)}`);
      return false;
    }
    if (typeof v === "string") {
      if (sch.pattern) {
        let pattern = patterns.get(sch.pattern);
        if (!pattern) {
          pattern = new RegExp(sch.pattern);
          patterns.set(sch.pattern, pattern);
        }
        if (!pattern.test(v)) fail(`must match ${sch.pattern}`);
      }
      if (sch.minLength !== undefined && v.length < sch.minLength) fail(`minLength ${sch.minLength}`);
      if (sch.maxLength !== undefined && v.length > sch.maxLength) fail(`maxLength ${sch.maxLength}`);
    }
    if (typeof v === "number") {
      if (sch.minimum !== undefined && v < sch.minimum) fail(`minimum ${sch.minimum}`);
      if (sch.maximum !== undefined && v > sch.maximum) fail(`maximum ${sch.maximum}`);
      if (sch.exclusiveMinimum !== undefined && v <= sch.exclusiveMinimum) fail(`exclusiveMinimum ${sch.exclusiveMinimum}`);
    }
    if (Array.isArray(v)) {
      if (sch.minItems !== undefined && v.length < sch.minItems) fail(`minItems ${sch.minItems}`);
      if (sch.maxItems !== undefined && v.length > sch.maxItems) fail(`maxItems ${sch.maxItems}`);
      if (sch.uniqueItems) {
        const seen = new Set(v.map((x) => JSON.stringify(x)));
        if (seen.size !== v.length) fail("items must be unique");
      }
      if (sch.items) {
        let known: Set<unknown> | undefined;
        if (memo !== undefined) {
          known = memo.items.get(sch.items);
          if (!known) memo.items.set(sch.items, known = new Set());
        }
        const delta = memo?.deltas?.get(v);
        const only = delta !== undefined && delta.base.length === v.length && memo!.objects.get(sch)?.has(delta.base)
          ? delta.changed
          : undefined;
        const count = only ? only.length : v.length;
        for (let at = 0; at < count; at++) {
          const index = only ? only[at]! : at;
          const item = v[index];
          if (item === undefined && !(index in v)) continue; // a hole, as forEach skips
          const scalar = item === null || typeof item !== "object";
          if (scalar && known?.has(item)) continue;
          path.push(index);
          if (!walk(sch.items, item)) valid = false;
          else if (scalar) known?.add(item);
          path.pop();
        }
      }
      if (sch.prefixItems) sch.prefixItems.forEach((itemSchema: Schema, index: number) => {
        if (index >= v.length) return;
        path.push(index);
        if (!walk(itemSchema, v[index])) valid = false;
        path.pop();
      });
    }
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const object = v as Record<string, unknown>;
      const properties = sch.properties ?? {};
      if (sch.minProperties && Object.keys(object).length < sch.minProperties) {
        fail(`minProperties ${sch.minProperties}`);
      }
      for (const required of sch.required ?? []) {
        if (!Object.hasOwn(object, required)) fail(`missing required '${required}'`);
      }
      if (sch.additionalProperties === false) {
        let allowed = allowedKeys.get(sch);
        if (!allowed) {
          allowed = new Set([...Object.keys(properties), ...(sch.required ?? [])]);
          allowedKeys.set(sch, allowed);
        }
        for (const key of Object.keys(object)) if (!allowed.has(key)) {
          path.push(key);
          fail("additional property");
          path.pop();
        }
      }
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (Object.hasOwn(object, key)) {
          path.push(key);
          if (!walk(propertySchema as Schema, object[key])) valid = false;
          path.pop();
        }
      }
      if (sch.additionalProperties !== null && typeof sch.additionalProperties === "object") {
        for (const key of Object.keys(object)) {
          if (Object.hasOwn(properties, key)) continue;
          path.push(key);
          if (!walk(sch.additionalProperties as Schema, object[key])) valid = false;
          path.pop();
        }
      }
    }
    if (sch.oneOf) {
      let candidates = sch.oneOf as Schema[];
      const typed = candidates.filter((branch) => branch.type === undefined || typeMatches(branch.type, v));
      if (typed.length > 0) candidates = typed;
      if (v !== null && typeof v === "object" && !Array.isArray(v) && candidates.length > 1) {
        const object = v as Record<string, unknown>;
        for (const key of ["op", "kind"]) {
          const declaring = candidates.filter((branch) => {
            const discriminator = branch.properties?.[key];
            return discriminator?.const !== undefined || discriminator?.enum !== undefined;
          });
          if (declaring.length !== candidates.length) continue;
          const matching = declaring.filter((branch) => {
            const discriminator = branch.properties[key];
            return discriminator.const !== undefined
              ? object[key] === discriminator.const
              : discriminator.enum.includes(object[key]);
          });
          if (matching.length === 1) candidates = matching;
          break;
        }
      }
      const wasRecording = recording;
      recording = false;
      const matches = candidates.filter((branch) => walk(branch, v)).length;
      recording = wasRecording;
      if (matches !== 1) fail(`oneOf: matched ${matches} branches (need exactly 1)`);
    }
    if (sch.anyOf) {
      const wasRecording = recording;
      recording = false;
      const matches = (sch.anyOf as Schema[]).filter((branch) => walk(branch, v)).length;
      recording = wasRecording;
      if (matches === 0) fail("anyOf: matched no branches");
    }
    if (sch.allOf) {
      for (const branch of sch.allOf as Schema[]) if (!walk(branch, v)) valid = false;
    }
    if (sch.not) {
      const wasRecording = recording;
      recording = false;
      const matches = walk(sch.not as Schema, v);
      recording = wasRecording;
      if (matches) fail("not: matched a forbidden schema");
    }
    if (sch.if) {
      const wasRecording = recording;
      recording = false;
      const matches = walk(sch.if as Schema, v);
      recording = wasRecording;
      const branch = matches ? sch.then : sch.else;
      if (branch && !walk(branch as Schema, v)) valid = false;
    }
    return valid;
  };

  walk(schema, instance);
  return errs;
}
