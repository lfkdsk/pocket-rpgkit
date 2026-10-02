// tools/lib/text-inventory.ts — the strings an app can display, decoded.
//
// A font subset has to hold the characters the running app draws, not the
// characters its source files happen to spell out: `"\u{20BB7}"` in a
// module and `"你"` in a JSON document draw 𠮷 and 你, while their
// source bytes are plain ASCII. This module reads files the way the build
// and the runtime do:
//
// - JavaScript/TypeScript modules: every string literal, template literal
//   chunk (cooked) and JSX text, parsed with the same Babel parser the
//   PocketJS build uses for its own glyph scan (pass 1 of
//   vendor/pocketjs/tools/build.ts), so escapes come out decoded.
// - JSON (a project document, a string table): every key and string value
//   after JSON.parse.
// - Anything else (.txt, .po, .md): the text as is, plus the same text with
//   JavaScript-style `\uXXXX` / `\u{X}` escapes decoded.
//
// A decoded string that is itself a JSON object or array (a serialized
// document inside a module) is parsed again and contributes its strings too.
//
// `appModules` follows an entry's static imports through the app, the kit
// and the framework, like the build's pass 1, so the kit's fixed UI strings
// and the framework's literals are part of an app's inventory.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");

/** Babel is installed only under the vendored PocketJS (it is the build's parser). */
const babel: any = createRequire(join(REPO_ROOT, "vendor/pocketjs/package.json"))("@babel/core");

const MODULE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

function parseModule(path: string, source: string): any {
  const ext = extname(path);
  const typescript = ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts";
  const jsx = ext === ".tsx" || ext === ".jsx" || ext === ".js";
  const plugins: unknown[] = [];
  if (typescript) plugins.push("typescript");
  if (jsx) plugins.push("jsx");
  return babel.parseSync(source, {
    filename: path,
    babelrc: false,
    configFile: false,
    sourceType: "module",
    parserOpts: { plugins, errorRecovery: false },
  });
}

/** Decoded string literals, template chunks and JSX text of one module. */
export function moduleStrings(path: string, source: string = readFileSync(path, "utf8")): string[] {
  const out: string[] = [];
  const visit = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    switch (node.type) {
      case "StringLiteral":
      case "DirectiveLiteral":
      case "JSXText":
        out.push(node.value);
        break;
      case "TemplateElement":
        out.push(node.value.cooked ?? node.value.raw);
        break;
    }
    for (const key in node) {
      if (key === "loc" || key === "start" || key === "end" || key === "extra" || key === "comments" ||
          key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
      const child = node[key];
      if (child && typeof child === "object") visit(child);
    }
  };
  visit(parseModule(path, source).program);
  return out;
}

/** Every key and string value of a parsed JSON value. */
export function jsonStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) jsonStrings(item, out);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      jsonStrings(item, out);
    }
  }
  return out;
}

/** `\uXXXX`, `\u{X}` and surrogate-pair escapes decoded; other text kept. */
export function decodeEscapes(text: string): string {
  return text.replace(/\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})/g, (match, braced: string | undefined, four: string | undefined) => {
    const cp = parseInt(braced ?? four!, 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
  }).replace(/[\ud800-\udbff][\udc00-\udfff]|[\ud800-\udfff]/g, pair => (pair.length === 2 ? pair : ""));
}

/** Strings nested in a serialized JSON object/array inside a string. */
function nestedJson(text: string): string[] {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") && trimmed.endsWith("}")) && !(trimmed.startsWith("[") && trimmed.endsWith("]"))) return [];
  try {
    return jsonStrings(JSON.parse(trimmed));
  } catch {
    return [];
  }
}

/** The display strings of one file, decoded (see the header). */
export function fileStrings(path: string): string[] {
  const source = readFileSync(path, "utf8");
  const ext = extname(path).toLowerCase();
  let strings: string[];
  if (MODULE_EXTENSIONS.has(ext)) strings = moduleStrings(path, source);
  else if (ext === ".json") strings = jsonStrings(JSON.parse(source));
  else strings = [source, decodeEscapes(source)];
  const nested: string[] = [];
  for (const text of strings) nested.push(...nestedJson(text));
  return nested.length ? [...strings, ...nested] : strings;
}

/** The TypeScript/TSX modules an entry statically imports, transitively
 *  (the entry included): relative imports and package imports that resolve
 *  to `.ts`/`.tsx` source (the kit, the framework). Plain `.js` packages
 *  (solid-js) are left out, as the build's pass 1 does. */
export function appModules(entry: string): string[] {
  const transpilers = new Map<string, Bun.Transpiler>();
  const transpiler = (path: string): Bun.Transpiler => {
    const loader = extname(path) === ".tsx" ? "tsx" : "ts";
    let t = transpilers.get(loader);
    if (!t) transpilers.set(loader, (t = new Bun.Transpiler({ loader })));
    return t;
  };
  const seen = new Set<string>();
  const order: string[] = [];
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    // The compiled-styles module holds class names, not display text.
    if (file.replace(/\\/g, "/").endsWith("/styles.generated.ts")) return;
    order.push(file);
    let imports: { path: string }[];
    try {
      imports = transpiler(file).scanImports(readFileSync(file, "utf8"));
    } catch {
      return;
    }
    for (const { path: spec } of imports) {
      let resolved: string;
      try {
        resolved = Bun.resolveSync(spec, dirname(file));
      } catch {
        continue;
      }
      if (/\.tsx?$/.test(resolved) && !resolved.endsWith(".d.ts")) walk(resolved);
    }
  };
  walk(resolve(entry));
  return order;
}

/** The decoded display strings of an app: its entry's module graph, the
 *  given extra files (project documents, string tables) and loose text. */
export function appTextInventory(opts: { entries?: string[]; files?: string[]; chars?: string }): string[] {
  const out: string[] = [];
  const files = new Set<string>();
  for (const entry of opts.entries ?? []) for (const file of appModules(entry)) files.add(file);
  for (const file of opts.files ?? []) files.add(resolve(file));
  for (const file of files) out.push(...fileStrings(file));
  if (opts.chars) out.push(opts.chars);
  return out;
}
