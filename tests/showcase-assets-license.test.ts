import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  TUXEMON_ASSETS,
  type TuxemonAssetLicense,
} from "../examples/showcase/tuxemon-assets.ts";

const REPO = resolve(import.meta.dir, "..");
const ASSET_ROOT = join(REPO, "examples", "showcase", "assets", "tuxemon");
const ATTRIBUTION = join(REPO, "examples", "showcase", "ATTRIBUTION.md");

function repoFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...repoFiles(path));
    else if (entry.isFile()) files.push(relative(REPO, path).replaceAll("\\", "/"));
  }
  return files.sort();
}

describe("showcase Tuxemon asset licences", () => {
  test("the manifest covers every vendored Tuxemon asset exactly once", () => {
    const listed = TUXEMON_ASSETS.map(({ repoPath }) => repoPath);
    expect(new Set(listed).size).toBe(listed.length);
    expect(repoFiles(ASSET_ROOT)).toEqual([...listed].sort());
  });

  test("every manifest entry exists", () => {
    for (const entry of TUXEMON_ASSETS) {
      expect(existsSync(join(REPO, entry.repoPath)), entry.repoPath).toBe(true);
    }
  });

  test("every licence is an allowed open asset licence", () => {
    const allowed = new Set<TuxemonAssetLicense>([
      "CC0",
      "Public Domain / CC0",
      "CC BY 3.0",
      "CC BY 4.0",
      "CC BY-SA 4.0",
    ]);
    for (const entry of TUXEMON_ASSETS) {
      expect(allowed.has(entry.license), `${entry.repoPath}: ${entry.license}`).toBe(true);
    }
  });

  test("ATTRIBUTION.md names every asset and author", () => {
    const attribution = readFileSync(ATTRIBUTION, "utf8");
    for (const entry of TUXEMON_ASSETS) {
      expect(attribution, `${entry.repoPath} is missing from ATTRIBUTION.md`).toContain(entry.repoPath);
      expect(attribution, `${entry.author} is missing from ATTRIBUTION.md`).toContain(entry.author);
    }
  });
});
