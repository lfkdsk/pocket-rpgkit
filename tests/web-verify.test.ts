import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { previewProtocolCheck } from "../tools/web-verify.ts";

const sites: string[] = [];

function site(): string {
  const path = mkdtempSync(join(tmpdir(), "web-verify-"));
  sites.push(path);
  return path;
}

function page(root: string, relative: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "<!doctype html>\n");
}

afterEach(() => {
  for (const path of sites.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("web verifier preview protocol selection", () => {
  test("a single-game site without the preview app is explicitly skipped", () => {
    const root = site();
    page(root, "index.html");
    page(root, "meadow/index.html");
    const output: string[] = [];

    const run = previewProtocolCheck(root, ["meadow"], (line) => output.push(line));

    expect(run).toBe(false);
    expect(output).toHaveLength(1);
    expect(output[0]).toStartWith("  SKIP preview protocol:");
    expect(output[0]).toContain("the preview app is not listed in games.json");
    expect(output[0]).toContain("preview/index.html is absent");
    expect(output[0]).toContain("preview-demo.html is absent");
  });

  test("a listed preview app without its demo page is skipped", () => {
    const root = site();
    page(root, "preview/index.html");
    const output: string[] = [];

    const run = previewProtocolCheck(root, ["preview"], (line) => output.push(line));

    expect(run).toBe(false);
    expect(output).toEqual(["  SKIP preview protocol: preview-demo.html is absent"]);
  });

  test("the checks run only when the preview app and demo page are present", () => {
    const root = site();
    page(root, "preview/index.html");
    page(root, "preview-demo.html");
    const output: string[] = [];

    expect(previewProtocolCheck(root, ["preview"], (line) => output.push(line))).toBe(true);
    expect(output).toEqual([]);
    expect(previewProtocolCheck(root, ["meadow"], () => {})).toBe(false);
  });
});
