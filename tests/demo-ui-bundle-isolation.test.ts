// The opt-in UI entry must remain outside bundles that only use GameView.
// tools/build-example.ts records PocketJS pass-1 inputs, which is stronger
// evidence than searching minified output: every module considered for the
// final bundle is listed even when its exports are later tree-shaken.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const MEADOW_INPUTS = join(ROOT, "dist", "meadow.inputs.json");
const SUNSTONE_INPUTS = join(ROOT, "dist", "sunstone.inputs.json");
const preflight = existsSync(MEADOW_INPUTS) && existsSync(SUNSTONE_INPUTS);
if (!preflight) console.warn("demo UI bundle isolation test skipped: run `bun run build:example meadow sunstone`");
const bundleTest = preflight ? test : test.skip;

function paths(file: string): string[] {
  return JSON.parse(readFileSync(file, "utf8")) as string[];
}

function demoModules(file: string): string[] {
  return paths(file)
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => path.includes("/src/ui/demo/"));
}

describe("ui/demo bundle isolation", () => {
  test("the package exposes one explicit opt-in entry", async () => {
    const pkg = await Bun.file(join(ROOT, "package.json")).json() as { exports: Record<string, string> };
    expect(pkg.exports["./ui/demo"]).toBe("./src/ui/demo/index.ts");
    expect(Bun.resolveSync("pocket-rpgkit/ui/demo", ROOT).replaceAll("\\", "/")).toEndWith("/src/ui/demo/index.ts");
  });

  bundleTest("a non-demo GameView app reaches no ui/demo implementation", () => {
    expect(demoModules(MEADOW_INPUTS)).toEqual([]);
    expect(readFileSync(join(ROOT, "dist", "meadow.js"), "utf8")).not.toContain("DEMO CONTROLS");
  });

  bundleTest("the opted-in Sunstone app reaches the complete demo entry", () => {
    expect(demoModules(SUNSTONE_INPUTS).map((path) => path.slice(path.lastIndexOf("/") + 1)).sort()).toEqual([
      "demo.tsx",
      "index.ts",
      "runtime.ts",
      "text.ts",
      "types.ts",
    ]);
    expect(readFileSync(join(ROOT, "dist", "sunstone.js"), "utf8")).toContain("DEMO CONTROLS");
  });
});
