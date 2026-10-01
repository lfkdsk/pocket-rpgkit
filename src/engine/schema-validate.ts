// src/engine/schema-validate.ts — minimal JSON Schema (draft
// 2020-12 subset) validator covering the constructs data/schema.json uses:
// type, const, enum, properties/required/additionalProperties, items,
// minItems/maxItems, oneOf/anyOf/allOf, if/then/else, $ref + $defs, pattern,
// minLength/maxLength, minimum/maximum, exclusiveMinimum, minProperties,
// uniqueItems, prefixItems. Not a general-purpose validator — a zero-dependency checker
// for THIS schema, so the runtime data keeps an acceptance gate without
// adding a dependency.

export type Schema = Record<string, any>;

export interface VError {
  path: string;
  msg: string;
}

export function validateSchema(
  root: Schema,
  instance: unknown,
  schema: Schema = root,
): VError[] {
  const errs: VError[] = [];
  const path: (string | number)[] = [];
  const patterns = new Map<string, RegExp>();
  const allowedKeys = new Map<Schema, Set<string>>();
  let recording = true;

  const pathText = (): string => "$" + path.map((part) =>
    typeof part === "number" ? `[${part}]` : `.${part}`).join("");
  const typeMatches = (type: string | readonly string[], v: unknown): boolean => {
    const types = Array.isArray(type) ? type : [type];
    return types.some((ty: string) => ({
      object: v !== null && typeof v === "object" && !Array.isArray(v),
      array: Array.isArray(v),
      string: typeof v === "string",
      integer: typeof v === "number" && Number.isInteger(v),
      number: typeof v === "number",
      boolean: typeof v === "boolean",
      null: v === null,
    })[ty]);
  };

  const walk = (sch: Schema, v: unknown): boolean => {
    if (sch.$ref) {
      const name = sch.$ref.split("/").pop()!;
      return walk(root.$defs[name], v);
    }
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
      if (sch.items) v.forEach((item, index) => {
        path.push(index);
        if (!walk(sch.items, item)) valid = false;
        path.pop();
      });
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
