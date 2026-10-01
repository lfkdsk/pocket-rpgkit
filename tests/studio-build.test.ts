// tests/studio-build.test.ts — tools/studio-build.ts writes Studio's static
// files: the page (with the browser host's boot script injected), the bundle,
// and the bundled examples with their art, all addressed by URLs relative to
// studio/. Stub page sources stand in for any
// editor/studio file that does not exist yet.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseShardedPack } from "../editor/api/pack.ts";
import { EDITOR_SOURCES } from "../editor/sources.ts";
import type { Project } from "../src/engine/types.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";
import { browserBootScript } from "../editor/studio/host-browser-boot.ts";
import { buildStudio, HOST_BOOT_PLACEHOLDER, type StudioBuildOptions, type StudioExamples } from "../tools/studio-build.ts";
import { KIT_ROOT } from "../tools/web.ts";

const STUDIO_SRC = join(KIT_ROOT, "editor", "studio");

let temp: string;
let options: (outdir: string) => StudioBuildOptions;

beforeAll(() => {
  temp = mkdtempSync(join(tmpdir(), "rpgkit-studio-build-"));
  const stubs = join(temp, "stubs");
  mkdirSync(stubs, { recursive: true });
  const stub = (name: string, text: string): string | undefined => {
    if (existsSync(join(STUDIO_SRC, name))) return undefined;
    writeFileSync(join(stubs, name), text);
    return join(stubs, name);
  };
  const entry = stub("main.ts", 'document.body.textContent = "studio";\n');
  const template = stub("index.html", '<!doctype html>\n<link rel="stylesheet" href="studio.css">\n<script type="module" src="studio.js"></script>\n');
  options = (outdir) => ({ outdir, ...(entry ? { entry } : {}), ...(template ? { template } : {}) });
});

afterAll(() => rmSync(temp, { recursive: true, force: true }));

function snapshot(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.set(path.slice(root.length + 1), readFileSync(path));
    }
  };
  walk(root);
  return files;
}

describe("buildStudio", () => {
  test("writes the page, the bundle and every example it lists", async () => {
    const outdir = join(temp, "site");
    const { files } = await buildStudio(options(outdir));
    const studio = join(outdir, "studio");
    for (const name of ["index.html", "studio.css", "studio.js", "examples.json"]) {
      expect(files).toContain(`studio/${name}`);
      expect(existsSync(join(studio, name))).toBe(true);
    }
    expect(files).toEqual([...snapshot(outdir).keys()].sort());

    const template = readFileSync(options(outdir).template ?? join(STUDIO_SRC, "index.html"), "utf8");
    const page = readFileSync(join(studio, "index.html"), "utf8");
    if (template.includes(HOST_BOOT_PLACEHOLDER)) {
      expect(page).toBe(template.replace(HOST_BOOT_PLACEHOLDER, () => browserBootScript()));
      expect(page).not.toContain(HOST_BOOT_PLACEHOLDER);
    } else {
      expect(page).toBe(template);
    }

    const manifest = JSON.parse(readFileSync(join(studio, "examples.json"), "utf8")) as StudioExamples;
    expect(manifest.examples.map((example) => example.id)).toEqual(["sunstone", "meadow", "sunstone-pack"]);
    expect(manifest.examples.map((example) => example.kind)).toEqual(["inline", "inline", "pack"]);
    for (const example of manifest.examples) {
      const urls = [example.document, ...Object.values(example.sheets), ...Object.values(example.sprites), ...(example.player ? [example.player] : [])];
      for (const url of urls) {
        expect(url.startsWith("/") || url.includes("..") || /^[a-z]+:/i.test(url)).toBe(false);
        expect(existsSync(join(studio, url))).toBe(true);
      }
    }

    for (const source of EDITOR_SOURCES) {
      const example = manifest.examples.find((candidate) => candidate.id === source.id)!;
      const original = readFileSync(join(KIT_ROOT, source.document));
      expect(readFileSync(join(studio, example.document))).toEqual(original);
      const project = JSON.parse(original.toString("utf8")) as Project;
      expect(example.title).toBe(project.title);
      expect(Object.keys(example.sheets).sort()).toEqual(Object.keys(source.sheets).sort());
      for (const [sheet, png] of Object.entries(source.sheets)) {
        expect(readFileSync(join(studio, example.sheets[sheet]!))).toEqual(readFileSync(join(KIT_ROOT, png)));
      }
      const images = Object.entries(project.sprites ?? {}).filter(([, sprite]) => sprite.kind === "image");
      expect(Object.keys(example.sprites).sort()).toEqual(images.map(([id]) => id).sort());
      for (const [id, sprite] of images) {
        if (sprite.kind !== "image") continue;
        expect(readFileSync(join(studio, example.sprites[id]!)))
          .toEqual(readFileSync(join(KIT_ROOT, dirname(dirname(source.document)), sprite.src)));
      }
      expect(example.player).toBe(`art/sprites/player-${source.id}.png`);
    }

    const sunstone = manifest.examples.find((example) => example.id === "sunstone")!;
    const pack = manifest.examples.find((example) => example.id === "sunstone-pack")!;
    expect(pack).toMatchObject({ title: "Sunstone (sharded pack)", document: "examples/sunstone-pack.json" });
    expect(pack.sheets).toEqual(sunstone.sheets);
    expect(pack.sprites).toEqual(sunstone.sprites);
    expect(pack.player).toBe(sunstone.player);
  });

  test("the sharded pack holds exactly the splitter's shell and shards", () => {
    const studio = join(temp, "site", "studio");
    const parsed = parseShardedPack(readFileSync(join(studio, "examples", "sunstone-pack.json"), "utf8"));
    const source = EDITOR_SOURCES.find((candidate) => candidate.id === "sunstone")!;
    const split = splitProjectMaps(JSON.parse(readFileSync(join(KIT_ROOT, source.document), "utf8")) as Project);
    expect(parsed.shellText).toBe(split.shellText);
    expect([...parsed.shards.keys()]).toEqual(split.entries.map((entry) => entry.path));
    for (const entry of split.entries) expect(parsed.shards.get(entry.path)).toBe(entry.text);
  });

  test("two builds are byte-identical, and a rebuild clears stale files", async () => {
    const first = snapshot(join(temp, "site"));
    const again = join(temp, "again");
    mkdirSync(join(again, "studio"), { recursive: true });
    writeFileSync(join(again, "studio", "stale.txt"), "old");
    await buildStudio(options(again));
    expect(snapshot(again)).toEqual(first);
  });

  test("the real page gets the host boot script; a custom template without the slot is copied verbatim", async () => {
    const real = readFileSync(join(STUDIO_SRC, "index.html"), "utf8");
    expect(real.split(HOST_BOOT_PLACEHOLDER).length).toBe(2);
    const plain = join(temp, "plain.html");
    const plainText = '<!doctype html>\n<script type="module" src="studio.js"></script>\n';
    writeFileSync(plain, plainText);
    const outdir = join(temp, "plain-site");
    await buildStudio({ ...options(outdir), template: plain });
    expect(readFileSync(join(outdir, "studio", "index.html"), "utf8")).toBe(plainText);

    const slotted = join(temp, "slotted.html");
    writeFileSync(slotted, `<!doctype html>\n${HOST_BOOT_PLACEHOLDER}\n<p>$& $1</p>\n`);
    await buildStudio({ ...options(outdir), template: slotted });
    expect(readFileSync(join(outdir, "studio", "index.html"), "utf8")).toBe(`<!doctype html>\n${browserBootScript()}\n<p>$& $1</p>\n`);
  });

  test("a template with two host boot placeholders fails and leaves earlier output alone", async () => {
    const twice = join(temp, "twice.html");
    writeFileSync(twice, `<!doctype html>\n${HOST_BOOT_PLACEHOLDER}\n${HOST_BOOT_PLACEHOLDER}\n`);
    const outdir = join(temp, "site");
    const before = snapshot(outdir);
    await expect(buildStudio({ ...options(outdir), template: twice })).rejects.toThrow(/2 host boot placeholders/);
    expect(snapshot(outdir)).toEqual(before);
  });

  test("a failed bundle fails loudly and leaves earlier output alone", async () => {
    const broken = join(temp, "broken.ts");
    writeFileSync(broken, 'import "./does-not-exist.ts";\n');
    const outdir = join(temp, "site");
    const before = snapshot(outdir);
    const quiet = console.error;
    console.error = () => {};
    try {
      await expect(buildStudio({ ...options(outdir), entry: broken })).rejects.toThrow(/bundling .* failed/);
    } finally {
      console.error = quiet;
    }
    expect(snapshot(outdir)).toEqual(before);
  });
});
