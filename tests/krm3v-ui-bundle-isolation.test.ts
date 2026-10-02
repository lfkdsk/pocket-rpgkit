// Concrete KRM3V presentation stays behind explicit package entries. The
// pass-1 input list is stronger than minified-text needles: it records every
// source module admitted to the application's dependency graph.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const inputs = (app: string): string => join(ROOT, "dist", `${app}.inputs.json`);
const ready = ["meadow", "sunstone", "rmi-play"].every((app) => existsSync(inputs(app)));
if (!ready) console.warn("KRM3V UI bundle isolation test skipped: build meadow, sunstone and rmi-play first");
const builtTest = ready ? test : test.skip;

const modules = (app: string): string[] =>
  (JSON.parse(readFileSync(inputs(app), "utf8")) as string[]).map((path) => path.replaceAll("\\", "/"));

describe("KRM3V presentation remains opt-in", () => {
  test("exports dedicated parallax and item-icon entries", async () => {
    const pkg = await Bun.file(join(ROOT, "package.json")).json() as { exports: Record<string, string> };
    expect(pkg.exports["./ui/parallax"]).toBe("./src/ui/ParallaxLayer.tsx");
    expect(pkg.exports["./ui/item-icons"]).toBe("./src/ui/ItemIconRow.tsx");
  });

  builtTest("ordinary GameView apps reach neither concrete component", () => {
    for (const app of ["meadow", "sunstone"]) {
      const source = modules(app);
      expect(source.some((path) => path.endsWith("/src/ui/ParallaxLayer.tsx")), app).toBe(false);
      expect(source.some((path) => path.endsWith("/src/ui/ItemIconRow.tsx")), app).toBe(false);
    }
  });

  builtTest("the imported-game fixture explicitly reaches both components", () => {
    const source = modules("rmi-play");
    expect(source.some((path) => path.endsWith("/src/ui/ParallaxLayer.tsx"))).toBe(true);
    expect(source.some((path) => path.endsWith("/src/ui/ItemIconRow.tsx"))).toBe(true);
  });
});
