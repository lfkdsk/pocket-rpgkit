// tests/helpers/guest-globals.ts — find uses of globals and built-in members
// that the PocketJS guest realm does not provide.
//
// The desktop host runs bundles on QuickJS; Bun (where the tests run) has
// many more globals (structuredClone, TextEncoder, setTimeout, crypto, ...).
// A call to one of them passes every sim test and throws a ReferenceError
// on the desktop host. This scanner type-checks the guest code and resolves
// every value identifier and property access to its declaration:
//
// - an identifier declared only by the TypeScript/Bun libraries is a host
//   global and must be one of the names the guest actually has;
// - `X.member` / `x.member` declared on a built-in library interface
//   (ArrayConstructor, Array, String, Map, ...) must exist on that global or
//   its prototype in the guest;
// - a guest module may import only relative files and the allowed packages.
//
// The allowlist is measured, not written by hand:
// tests/fixtures/quickjs-guest-globals.json is the inventory printed by the
// real desktop host's QuickJS realm (tools/editor-sharded-quickjs-check.sh
// --write-globals). `typeof X` is always allowed (feature detection).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

export interface GuestInventory {
  globals: string[];
  members: Record<string, string[]>;
}

export interface GuestViolation {
  file: string;
  line: number;
  name: string;
  kind: "global" | "member" | "import";
}

const ROOT = resolve(import.meta.dir, "..", "..");
const SOURCE = /\.(?:ts|tsx)$/;

/** Packages a guest bundle may import: PocketJS's framework and Solid. */
const GUEST_PACKAGES = [/^solid-js(?:\/|$)/, /^@pocketjs\/framework(?:\/|$)/];

export function loadGuestInventory(): GuestInventory {
  const text = readFileSync(join(ROOT, "tests", "fixtures", "quickjs-guest-globals.json"), "utf8");
  return JSON.parse(text) as GuestInventory;
}

function resolveSource(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (SOURCE.test(candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every repo source file a guest bundle built from `entries` contains:
 * the bundler's relative-import walk, without type-only imports. */
export function guestModuleGraph(entries: readonly string[]): {
  files: string[];
  violations: GuestViolation[];
} {
  const transpilers = {
    ts: new Bun.Transpiler({ loader: "ts" }),
    tsx: new Bun.Transpiler({ loader: "tsx" }),
  };
  const seen = new Set<string>();
  const violations: GuestViolation[] = [];
  const queue = entries.map((entry) => resolve(entry));
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    const transpiler = file.endsWith(".tsx") ? transpilers.tsx : transpilers.ts;
    for (const { kind, path } of transpiler.scanImports(source)) {
      // Bun's JSX transform reports React runtime require-calls; the guest
      // build compiles JSX with Solid. A real require() is caught as the
      // `require` global, which the guest does not have.
      if (kind !== "import-statement" && kind !== "dynamic-import") continue;
      if (path.startsWith(".")) {
        const target = resolveSource(file, path);
        if (target && !relative(ROOT, target).startsWith("vendor")) queue.push(target);
        continue;
      }
      if (!GUEST_PACKAGES.some((pattern) => pattern.test(path))) {
        violations.push({ file: relative(ROOT, file), line: lineOf(source, path), name: path, kind: "import" });
      }
    }
  }
  return { files: [...seen].sort(), violations };
}

function lineOf(source: string, needle: string): number {
  const at = source.indexOf(`"${needle}"`);
  return at < 0 ? 0 : source.slice(0, at).split("\n").length;
}

function compilerOptions(): ts.CompilerOptions {
  const configPath = join(ROOT, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT, { noEmit: true }, configPath);
  return parsed.options;
}

/** A declaration from the TypeScript lib or an ambient @types/bun-types file. */
function isLibraryFile(program: ts.Program, file: ts.SourceFile): boolean {
  return program.isSourceFileDefaultLibrary(file) || file.fileName.includes("/node_modules/");
}

/** Inventory keys for a library interface's members, or null when the
 * interface is not a guest built-in this check knows how to read. */
function inventoryKeysFor(owner: string, inventory: GuestInventory): string[] | null {
  const aliases: Record<string, string> = {
    ReadonlyArray: "Array.prototype",
    ReadonlyMap: "Map.prototype",
    ReadonlySet: "Set.prototype",
    CallableFunction: "Function.prototype",
    NewableFunction: "Function.prototype",
    Console: "console",
    // The iterator helpers (map, filter, toArray, ...). `Iterator` itself is
    // the protocol (next/return/throw), which every iterator implements on
    // its own prototype, not on the global Iterator.prototype.
    IteratorObject: "Iterator.prototype",
  };
  if (owner === "Iterator" || owner === "AsyncIterator" || owner.endsWith("Iterator")) return null;
  const alias = aliases[owner];
  if (alias) return inventory.members[alias] ? [alias] : null;
  if (owner.endsWith("Constructor")) {
    const base = owner.slice(0, -"Constructor".length);
    return inventory.members[base] ? [base] : null;
  }
  if (inventory.members[`${owner}.prototype`]) return [`${owner}.prototype`];
  if (inventory.members[owner]) return [owner];
  return null;
}

/** The interface or namespace a library member is declared in. */
function ownerName(declaration: ts.Declaration): string | null {
  const parent = declaration.parent;
  if (parent && (ts.isInterfaceDeclaration(parent) || ts.isClassDeclaration(parent)) && parent.name) {
    return parent.name.text;
  }
  if (parent && ts.isModuleBlock(parent) && ts.isModuleDeclaration(parent.parent) && ts.isIdentifier(parent.parent.name)) {
    return parent.parent.name.text;
  }
  // `declare var Math: Math` style members live in a type literal.
  return null;
}

/** Scan `files` (absolute paths) for guest-unavailable globals and members.
 * `program` may be passed when the caller already built one. */
export function scanGuestSources(
  files: readonly string[],
  inventory: GuestInventory,
  program: ts.Program = ts.createProgram([...files], compilerOptions()),
): GuestViolation[] {
  const checker = program.getTypeChecker();
  const globals = new Set(inventory.globals);
  const members = new Map(Object.entries(inventory.members).map(([key, names]) => [key, new Set(names)]));
  const violations: GuestViolation[] = [];

  const libraryDeclarations = (symbol: ts.Symbol | undefined): ts.Declaration[] | null => {
    if (!symbol) return null;
    const declarations = symbol.declarations ?? [];
    if (declarations.length === 0) return null;
    return declarations.every((declaration) => isLibraryFile(program, declaration.getSourceFile()))
      ? declarations
      : null;
  };

  for (const path of files) {
    const sourceFile = program.getSourceFile(path);
    if (!sourceFile) throw new Error(`guest scan: ${path} is not in the program`);
    const report = (node: ts.Node, name: string, kind: GuestViolation["kind"]): void => {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      violations.push({ file: relative(ROOT, path), line, name, kind });
    };

    const checkMember = (access: ts.PropertyAccessExpression): void => {
      const declarations = libraryDeclarations(checker.getSymbolAtLocation(access.name));
      if (!declarations) return;
      const name = access.name.text;
      // globalThis.X is a global read.
      if (ts.isIdentifier(access.expression) && access.expression.text === "globalThis") {
        if (!globals.has(name)) report(access.name, name, "global");
        return;
      }
      for (const declaration of declarations) {
        const owner = ownerName(declaration);
        if (!owner) continue;
        const keys = inventoryKeysFor(owner, inventory);
        if (!keys) continue;
        if (!keys.some((key) => members.get(key)!.has(name))) report(access.name, `${owner}.${name}`, "member");
        return;
      }
    };

    const visit = (node: ts.Node): void => {
      // Types, ambient declarations and type-only syntax never run.
      if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
      if (ts.isModuleDeclaration(node) && (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Ambient)) return;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
      if (ts.isTypeOfExpression(node) && ts.isIdentifier(node.expression)) return;
      if (ts.isPropertyAccessExpression(node)) {
        checkMember(node);
        visit(node.expression);
        return;
      }
      if (ts.isIdentifier(node)) {
        const parent = node.parent;
        // Names of declarations, properties and labels are not reads.
        const isName = (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) ||
          ts.isMethodDeclaration(parent) || ts.isVariableDeclaration(parent) ||
          ts.isFunctionDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent) ||
          ts.isClassDeclaration(parent) || ts.isEnumMember(parent) || ts.isGetAccessor(parent) ||
          ts.isSetAccessor(parent) || ts.isJsxAttribute(parent) || ts.isLabeledStatement(parent)) &&
          (parent as { name?: ts.Node }).name === node;
        if (!isName && !ts.isJsxAttribute(parent)) {
          const symbol = ts.isShorthandPropertyAssignment(parent)
            ? checker.getShorthandAssignmentValueSymbol(parent)
            : checker.getSymbolAtLocation(node);
          if (libraryDeclarations(symbol) && (symbol!.flags & ts.SymbolFlags.Value) && !globals.has(node.text)) {
            report(node, node.text, "global");
          }
        }
        return;
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
  }
  return violations;
}

export function formatViolations(violations: readonly GuestViolation[]): string {
  return violations.map((v) => `${v.file}:${v.line} ${v.kind} ${v.name}`).join("\n");
}

export function createGuestProgram(files: readonly string[]): ts.Program {
  return ts.createProgram([...files], compilerOptions());
}
