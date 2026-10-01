import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { fnv1a } from "../vendor/pocketjs/hosts/sim/sim.ts";
import {
  makeShowcaseContactSheet,
  SHOWCASE_SCREENSHOTS,
} from "../tools/showcase-screenshots.ts";
import { SHOWCASE_HALLS } from "../examples/showcase/showcase-data.ts";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "docs", "screenshots");

describe("showcase screenshot catalogue", () => {
  test("contains one 480x272 image for the lobby and every authored hall", () => {
    expect(SHOWCASE_SCREENSHOTS.map(({ id }) => id)).toEqual([
      "lobby",
      ...SHOWCASE_HALLS.map(({ id }) => id),
    ]);
    const hashes = new Set<string>();
    for (const shot of SHOWCASE_SCREENSHOTS) {
      const image = decodePng(new Uint8Array(readFileSync(join(OUT, shot.file))));
      expect([image.width, image.height], shot.file).toEqual([480, 272]);
      hashes.add(fnv1a(image.rgba));
    }
    expect(hashes.size).toBe(SHOWCASE_SCREENSHOTS.length);
  });

  test("overview is the exact row-major half-scale contact sheet", () => {
    const frames = SHOWCASE_SCREENSHOTS.map(({ file }) =>
      decodePng(new Uint8Array(readFileSync(join(OUT, file)))).rgba);
    const expected = makeShowcaseContactSheet(frames);
    const actual = decodePng(new Uint8Array(readFileSync(join(OUT, "showcase-overview.png"))));
    expect([actual.width, actual.height]).toEqual([expected.width, expected.height]);
    expect(actual.rgba).toEqual(expected.rgba);
  });
});
