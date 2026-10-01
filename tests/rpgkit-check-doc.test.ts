// tests/rpgkit-check-doc.test.ts — the project loader: the example
// documents must load schema-clean, and malformed input must become
// findings instead of crashes.

import { describe, expect, test } from "bun:test";
import { loadProjectFile, structuralFindings } from "../tools/rpgkit-check/src/doc.ts";

const EXAMPLES = [
  "examples/sunstone/data/sunstone.json",
  "examples/meadow/data/meadow.json",
  "examples/grow/data/grow-settlement.json",
];

describe("rpgkit-check doc loading", () => {
  for (const path of EXAMPLES) {
    test(`${path} loads schema-clean`, () => {
      const loaded = loadProjectFile(path);
      expect(loaded.project).not.toBeNull();
      expect(loaded.shell).toBe(false);
      expect(loaded.schemaErrors).toEqual([]);
      expect(structuralFindings(loaded.project!)).toEqual([]);
    });
  }

  test("a missing file is a finding, not a throw", () => {
    const loaded = loadProjectFile("examples/sunstone/data/does-not-exist.json");
    expect(loaded.project).toBeNull();
    expect(loaded.schemaErrors).toHaveLength(1);
    expect(loaded.schemaErrors[0]!.check).toBe("doc/unreadable");
  });

  test("syntax-broken JSON is a finding", () => {
    const loaded = loadProjectFile("package.json"); // valid JSON, wrong shape
    expect(loaded.project).not.toBeNull();
    expect(loaded.schemaErrors.length).toBeGreaterThan(0);
    expect(loaded.schemaErrors.every((f) => f.check === "doc/schema")).toBe(true);
  });
});
