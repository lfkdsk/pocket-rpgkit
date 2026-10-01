// tools/studio-build.ts — build Studio, the browser-native map and event
// editor (editor/studio), into <site>/studio/ as plain static files. Studio
// is not a PocketJS game: no wasm, no pak, no player page.
//
//   bun tools/studio-build.ts                 # into dist/web/studio
//   bun tools/studio-build.ts --outdir /srv/x # into /srv/x/studio
//
// tools/web.ts calls buildStudio when web.json has a "studio" entry.
//
// Output, every URL relative to studio/ (GitHub Pages serves the site under
// a sub-path):
//
//   index.html               editor/studio/index.html with the browser
//                            host's boot snippet (editor/studio/
//                            host-browser-boot.ts) in place of its
//                            HOST_BOOT_PLACEHOLDER
//   studio.css               editor/studio/studio.css + inspector.css
//   studio.js                editor/studio/main.ts bundled for the browser
//   examples.json            the bundled examples (shape: StudioExamples)
//   examples/<id>.json       each editor/sources.ts document, verbatim
//                            (with each example's demo chapters as save
//                            codes, for the play-test's start menu)
//   examples/sunstone-pack.json
//                            Sunstone as an rpgkit-edit/sharded-pack-v1
//   art/sheets/<sheet>.png   tile sheets, keyed by sheet id
//   art/sprites/<id>.png     static sprites, keyed by sprite id, and each
//                            example's player frame as player-<example>.png
//
// Sheet and sprite ids are global: an id shared by several examples must
// come from byte-identical files (editor/sources.ts promises this for
// sheets; editor/gen-assets.ts enforces it for sprites). The build checks
// both and fails otherwise.
//
// The page template calls no browser APIs; the host's boot script replaces
// the HOST_BOOT_PLACEHOLDER comment. The placeholder may appear at most once
// in any template, and the default template must carry it. A custom template
// (options.template) without it is written verbatim.
//
// Deterministic: the bytes depend only on the committed inputs.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Project } from "../src/engine/types.ts";
import { serializeShardedPack } from "../editor/api/pack.ts";
import { browserBootScript } from "../editor/studio/host-browser-boot.ts";
import { EDITOR_SOURCES, type EditorSource } from "../editor/sources.ts";
import { splitProjectMaps } from "./lib/map-project.ts";

export interface StudioBuildOptions {
  /** The site root (e.g. dist/web); Studio goes to <outdir>/studio. */
  outdir: string;
  /** This kit's checkout; defaults to the directory above tools/. */
  kitRoot?: string;
  /** Bundle entry; defaults to <kitRoot>/editor/studio/main.ts. */
  entry?: string;
  /** Page template; defaults to <kitRoot>/editor/studio/index.html. Its
   *  HOST_BOOT_PLACEHOLDER (at most one; the default must have it) becomes
   *  the browser host's boot script. */
  template?: string;
  /** Stylesheets concatenated in order into studio.css; a missing file is
   *  skipped. Defaults to editor/studio/studio.css then inspector.css. */
  styles?: readonly string[];
}

export interface StudioExample {
  id: string;
  title: string;
  /** "inline" is a whole rpgkit-project/v1 document; "pack" is an
   *  rpgkit-edit/sharded-pack-v1 container. */
  kind: "inline" | "pack";
  document: string;
  sheets: Record<string, string>;
  sprites: Record<string, string>;
  player?: string;
  /** Demo chapters a play-test can start from (save codes, no tapes). */
  chapters?: StudioChapter[];
}

export interface StudioChapter {
  id: string;
  title: string;
  snapshot: string;
}

export interface StudioExamples {
  examples: StudioExample[];
}

export const STUDIO_DIR = "studio";
/** Marks where a host's boot snippet goes in the page template. */
export const HOST_BOOT_PLACEHOLDER = "<!-- studio:host-boot -->";
export const STUDIO_PACK_SOURCE = "sunstone";
export const STUDIO_PACK_ID = "sunstone-pack";
export const STUDIO_PACK_TITLE = "Sunstone (sharded pack)";

const ID = /^[a-z0-9][a-z0-9._-]*$/i;

/** Write <studio>/<path> once; a second write of the same path must carry
 *  identical bytes. */
class Output {
  private written = new Map<string, Uint8Array>();
  constructor(private readonly root: string) {}

  write(path: string, bytes: Uint8Array | string, what: string): string {
    const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
    const seen = this.written.get(path);
    if (seen) {
      if (!Buffer.from(seen).equals(Buffer.from(data))) {
        throw new Error(`studio: ${what} differs from an earlier file written to ${path}`);
      }
      return path;
    }
    const target = join(this.root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    this.written.set(path, data);
    return path;
  }

  files(): string[] {
    return [...this.written.keys()].sort();
  }
}

function usableId(id: string, what: string): string {
  if (!ID.test(id)) throw new Error(`studio: ${what} "${id}" is not usable as a file name`);
  return id;
}

function readSource(kitRoot: string, path: string, what: string): Buffer {
  const full = join(kitRoot, path);
  if (!existsSync(full)) throw new Error(`studio: ${what} not found: ${path}`);
  return readFileSync(full);
}

interface ExampleArt {
  sheets: Record<string, string>;
  sprites: Record<string, string>;
  player?: string;
}

function copyExample(kitRoot: string, out: Output, source: EditorSource, project: Project): ExampleArt {
  const exampleDir = dirname(dirname(source.document));
  const sheets: Record<string, string> = {};
  for (const sheet of project.sheets ?? []) {
    if (!source.sheets[sheet.id]) throw new Error(`studio: ${source.id} declares sheet "${sheet.id}" with no source PNG in editor/sources.ts`);
  }
  for (const [sheetId, png] of Object.entries(source.sheets)) {
    sheets[sheetId] = out.write(
      `art/sheets/${usableId(sheetId, "sheet id")}.png`,
      readSource(kitRoot, png, `sheet "${sheetId}" of ${source.id}`),
      `sheet "${sheetId}" of ${source.id}`,
    );
  }
  const sprites: Record<string, string> = {};
  for (const [spriteId, sprite] of Object.entries(project.sprites ?? {})) {
    if (sprite.kind !== "image") continue;
    sprites[spriteId] = out.write(
      `art/sprites/${usableId(spriteId, "sprite id")}.png`,
      readSource(kitRoot, join(exampleDir, sprite.src), `sprite "${spriteId}" of ${source.id}`),
      `sprite "${spriteId}" of ${source.id}`,
    );
  }
  // Documents carry no player sprite of their own; the runtime draws each
  // example's built-in walker, whose first frame stands in for it here.
  const playerFrame = join(exampleDir, "assets", "player-dir0.png");
  const player = existsSync(join(kitRoot, playerFrame))
    ? out.write(
        `art/sprites/player-${source.id}.png`,
        readFileSync(join(kitRoot, playerFrame)),
        `player frame of ${source.id}`,
      )
    : undefined;
  return { sheets, sprites, ...(player ? { player } : {}) };
}

/** An example's demo chapters as save codes (editor/sources.ts names the
 *  module). Tapes stay behind: a play-test restores the save point and plays
 *  live. */
async function exampleChapters(kitRoot: string, source: EditorSource): Promise<StudioChapter[] | undefined> {
  if (!source.chapters) return undefined;
  const module = (await import(join(kitRoot, source.chapters.module))) as Record<string, unknown>;
  const demo = module[source.chapters.export] as { chapters?: readonly { id: unknown; title: unknown; snapshot: unknown }[] } | undefined;
  if (!demo || !Array.isArray(demo.chapters)) {
    throw new Error(`studio: ${source.chapters.module} exports no ${source.chapters.export}.chapters for ${source.id}`);
  }
  return demo.chapters.map((chapter, index) => {
    if (typeof chapter.id !== "string" || typeof chapter.title !== "string" || typeof chapter.snapshot !== "string") {
      throw new Error(`studio: chapter ${index} of ${source.id} needs a string id, title and save code`);
    }
    return { id: chapter.id, title: chapter.title, snapshot: chapter.snapshot };
  });
}

/** The Sunstone document as a sharded pack, in the splitter's default JSON
 *  entry encoding. */
export function studioPackText(project: Project): string {
  const split = splitProjectMaps(project);
  const shards = new Map(split.entries.map((entry) => [entry.path, entry.text] as const));
  return serializeShardedPack(split.shellText, split.shell.mapIndex, shards);
}

/** The page: the template with the browser host's boot script in place of
 *  the placeholder. `required` (the default template) makes a missing
 *  placeholder an error; more than one is always an error. */
export function studioPage(template: string, required: boolean, path = "page template"): string {
  const parts = template.split(HOST_BOOT_PLACEHOLDER);
  if (parts.length > 2) {
    throw new Error(`studio: ${path} has ${parts.length - 1} host boot placeholders (${HOST_BOOT_PLACEHOLDER}); expected one`);
  }
  if (parts.length === 1) {
    if (required) throw new Error(`studio: ${path} lacks the host boot placeholder ${HOST_BOOT_PLACEHOLDER}`);
    return template;
  }
  return parts.join(browserBootScript());
}

async function bundle(entry: string): Promise<Uint8Array> {
  if (!existsSync(entry)) throw new Error(`studio: bundle entry not found: ${entry}`);
  const result = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm", minify: true, throw: false });
  if (!result.success || result.outputs.length !== 1) {
    for (const log of result.logs) console.error(log);
    throw new Error(
      `studio: bundling ${entry} failed` +
        (result.success ? ` (expected one output, got ${result.outputs.length})` : ""),
    );
  }
  return new Uint8Array(await result.outputs[0]!.arrayBuffer());
}

function concatStyles(paths: readonly string[]): string {
  return paths
    .filter((path) => existsSync(path))
    .map((path) => {
      const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
      return text.endsWith("\n") || text.length === 0 ? text : `${text}\n`;
    })
    .join("");
}

/** Build <outdir>/studio from scratch. Returns the written files, relative
 *  to outdir, sorted. */
export async function buildStudio(options: StudioBuildOptions): Promise<{ files: string[] }> {
  const kitRoot = resolve(options.kitRoot ?? join(import.meta.dir, ".."));
  const studioSrc = join(kitRoot, "editor", "studio");
  const entry = resolve(options.entry ?? join(studioSrc, "main.ts"));
  const template = resolve(options.template ?? join(studioSrc, "index.html"));
  const styles = (options.styles ?? [join(studioSrc, "studio.css"), join(studioSrc, "inspector.css")]).map((p) => resolve(p));
  const root = join(resolve(options.outdir), STUDIO_DIR);

  // Bundle and check the page before touching the output, so a failed build
  // leaves it alone.
  const script = await bundle(entry);
  if (!existsSync(template)) throw new Error(`studio: page template not found: ${template}`);
  const page = studioPage(readFileSync(template, "utf8"), options.template === undefined, template);

  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const out = new Output(root);
  out.write("index.html", page, "index.html");
  out.write("studio.css", concatStyles(styles), "studio.css");
  out.write("studio.js", script, "studio.js");

  const examples: StudioExample[] = [];
  let packArt: ExampleArt | undefined;
  let packProject: Project | undefined;
  for (const source of EDITOR_SOURCES) {
    usableId(source.id, "example id");
    const text = readSource(kitRoot, source.document, `document of ${source.id}`);
    const project = JSON.parse(text.toString("utf8")) as Project;
    const document = out.write(`examples/${source.id}.json`, text, `document of ${source.id}`);
    const art = copyExample(kitRoot, out, source, project);
    const chapters = await exampleChapters(kitRoot, source);
    examples.push({ id: source.id, title: project.title, kind: "inline", document, ...art, ...(chapters ? { chapters } : {}) });
    if (source.id === STUDIO_PACK_SOURCE) {
      packArt = art;
      packProject = project;
    }
  }
  if (!packArt || !packProject) throw new Error(`studio: editor/sources.ts has no "${STUDIO_PACK_SOURCE}" example to pack`);
  examples.push({
    id: STUDIO_PACK_ID,
    title: STUDIO_PACK_TITLE,
    kind: "pack",
    document: out.write(`examples/${STUDIO_PACK_ID}.json`, studioPackText(packProject), "sharded pack"),
    ...packArt,
  });
  const ids = new Set<string>();
  for (const example of examples) {
    if (ids.has(example.id)) throw new Error(`studio: example id "${example.id}" repeats`);
    ids.add(example.id);
  }

  const manifest: StudioExamples = {
    examples: examples.map(({ id, title, kind, document, sheets, sprites, player, chapters }) => ({
      id,
      title,
      kind,
      document,
      sheets,
      sprites,
      ...(player ? { player } : {}),
      ...(chapters ? { chapters } : {}),
    })),
  };
  out.write("examples.json", `${JSON.stringify(manifest, null, 2)}\n`, "examples.json");
  return { files: out.files().map((path) => `${STUDIO_DIR}/${path}`) };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    let outdir = join(import.meta.dir, "..", "dist", "web");
    for (let i = 0; i < args.length; i++) {
      const flag = /^--outdir(?:=(.*))?$/.exec(args[i]!);
      if (!flag) throw new Error(`studio: unknown argument ${args[i]} (usage: bun tools/studio-build.ts [--outdir <site>])`);
      const value = flag[1] ?? args[++i];
      if (!value) throw new Error("studio: --outdir needs a value");
      outdir = value;
    }
    const { files } = await buildStudio({ outdir });
    console.log(`studio: ${files.length} file(s) in ${join(resolve(outdir), STUDIO_DIR)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
