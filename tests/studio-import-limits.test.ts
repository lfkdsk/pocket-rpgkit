// Resource limits on imported documents and art (editor/api/limits.ts): each
// byte and count limit accepts input exactly at the limit and rejects one
// byte / one item over it, in the edit API (EditSession, the pack reader,
// shard loading) and on Studio's in-memory host (file and image picks).

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatBytes,
  MAX_EVENTS_PER_MAP,
  MAX_MAPS,
  MAX_PACK_BYTES,
  MAX_PNG_BYTES,
  MAX_PNG_PIXELS,
  MAX_PNG_SIDE,
  MAX_PROJECT_FILE_BYTES,
  MAX_SHARD_BYTES,
  MAX_SHARDS,
  packFileProblem,
  pngProblem,
  projectFileProblem,
  readPngSize,
  shardProblem,
  utf8Bytes,
} from "../editor/api/limits.ts";
import { parseShardedPack, serializeShardedPack, SHARDED_PACK_KIND } from "../editor/api/pack.ts";
import { EditSession } from "../editor/api/session.ts";
import { loadValidatedMapShard } from "../editor/api/sharded.ts";
import { StudioApp } from "../editor/studio/app.ts";
import { ArtRegistry } from "../editor/studio/art.ts";
import { StudioFiles } from "../editor/studio/files.ts";
import { MemoryDirectory, MemoryHost } from "../editor/studio/host-memory.ts";
import { openProjectDirectory } from "../editor/studio/project-directory.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";
import { mapManifestHash } from "../src/engine/map-repository.ts";
import { canonicalJson } from "../src/engine/save.ts";
import type { MapDef, Project, ProjectShell } from "../src/engine/types.ts";

const ROOT = join(import.meta.dir, "..");
const SUNSTONE = readFileSync(join(ROOT, "examples", "sunstone", "data", "sunstone.json"), "utf8");
const MEADOW = readFileSync(join(ROOT, "examples", "meadow", "data", "meadow.json"), "utf8");
const TILE_PNG = new Uint8Array(readFileSync(join(ROOT, "editor", "assets", "tile-town-48.png")));

/** `text` (JSON) padded with trailing whitespace to exactly `bytes` UTF-8 bytes. */
function padTo(text: string, bytes: number): string {
  const body = text.trimEnd();
  return body + " ".repeat(bytes - utf8Bytes(body));
}

/** Run `open` and return the thrown error's code, or "OK". */
function codeOf(open: () => unknown): string {
  try {
    open();
    return "OK";
  } catch (error) {
    return (error as { code?: string }).code ?? "NO_CODE";
  }
}

function errorOf(open: () => unknown): { code?: string; message: string; path?: string } {
  try {
    open();
  } catch (error) {
    return error as { code?: string; message: string; path?: string };
  }
  throw new Error("expected an error");
}

/** Meadow with `count` copies of its one map (ids m0, m1, …). */
function projectWithMaps(count: number): Project {
  const project = JSON.parse(MEADOW) as Project;
  const map = project.maps[0]!;
  project.maps = Array.from({ length: count }, (_, i) => ({ ...map, id: `m${i}` }));
  project.start = { ...project.start, map: "m0" };
  return project;
}

/** Meadow with `count` 1x1 maps (ids m0, m1, …): the shard-count limit
 * needs many shards, not big ones. With Meadow's full map the fixture alone
 * (validate + SHA-256 of every shard, on a cold JIT) took about 3 s per
 * build and the test ran past the 5 s default when run on its own. */
function projectWithTinyMaps(count: number): Project {
  const project = JSON.parse(MEADOW) as Project;
  const map = project.maps[0]!;
  project.maps = Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    name: map.name,
    width: 1,
    height: 1,
    sheets: map.sheets,
    ground: [map.ground[0]!],
    events: [],
  }));
  project.start = { ...project.start, map: "m0", x: 0, y: 0 };
  return project;
}

/** Meadow whose map has exactly `count` small events. */
function projectWithEvents(count: number): Project {
  const project = JSON.parse(MEADOW) as Project;
  const map = project.maps[0]!;
  map.events = Array.from({ length: count }, (_, i) => ({
    id: `e${i}`,
    x: i % map.width,
    y: Math.floor(i / map.width) % map.height,
    pages: [{ trigger: "action", commands: [] }],
  })) as MapDef["events"];
  return project;
}

function packOf(project: Project): string {
  const split = splitProjectMaps(project);
  return serializeShardedPack(split.shellText, split.shell.mapIndex, new Map(split.entries.map((entry) => [entry.path, entry.text])));
}

/** A PNG header (signature + IHDR) declaring `width`×`height`. */
function pngHeader(width: number, height: number): Uint8Array {
  const header = TILE_PNG.slice(0, 24);
  new DataView(header.buffer).setUint32(16, width);
  new DataView(header.buffer).setUint32(20, height);
  return header;
}

function studioOnMemoryHost(): { host: MemoryHost; app: StudioApp; files: StudioFiles } {
  const host = new MemoryHost();
  const app = new StudioApp();
  const files = new StudioFiles(app, new ArtRegistry(), host);
  return { host, app, files };
}

describe("byte counting and messages", () => {
  test("utf8Bytes counts ASCII, multibyte and surrogate pairs like TextEncoder", () => {
    for (const text of ["", "plain ascii", "café", "€uro", "日本語", "😀 pair", "a\u{10FFFF}b", "lone \ud800 surrogate", "x\udc00"]) {
      expect(utf8Bytes(text)).toBe(new TextEncoder().encode(text).length);
    }
  });

  test("utf8Bytes short-circuits once the UTF-16 length alone is over the limit", () => {
    const text = "é".repeat(10); // 20 bytes
    expect(utf8Bytes(text, 9)).toBe(10); // a lower bound, still over the limit
    expect(utf8Bytes(text, 10)).toBe(20); // counted exactly
  });

  test("size problems: exactly at the limit is fine, one byte over is named", () => {
    expect(projectFileProblem(MAX_PROJECT_FILE_BYTES)).toBeNull();
    expect(projectFileProblem(MAX_PROJECT_FILE_BYTES + 1, "village.json")).toBe(
      "village.json is 33,554,433 bytes; project files can be at most 32 MiB.",
    );
    expect(projectFileProblem(40 * 1024 * 1024, "village.json")).toBe("village.json is 40.0 MiB; project files can be at most 32 MiB.");
    expect(packFileProblem(MAX_PACK_BYTES)).toBeNull();
    expect(packFileProblem(MAX_PACK_BYTES + 1, "pack.json")).toBe("pack.json is 67,108,865 bytes; sharded packs can be at most 64 MiB.");
    expect(shardProblem("maps/town.json", MAX_SHARD_BYTES)).toBeNull();
    expect(shardProblem("maps/town.json", MAX_SHARD_BYTES + 1)).toBe(
      'shard "maps/town.json" is 8,388,609 bytes; one map shard can be at most 8 MiB.',
    );
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
  });
});

describe("EditSession.open limits", () => {
  test("review repro: Sunstone padded to 64.1 MiB is refused before parsing", () => {
    const input = padTo(SUNSTONE, Math.round(64.1 * 1024 * 1024));
    const error = errorOf(() => EditSession.open(input));
    expect(error.code).toBe("TOO_LARGE");
    expect(error.message).toBe("the document is 64.1 MiB; project files can be at most 32 MiB and sharded packs at most 64 MiB.");
  });

  test("an inline project of exactly 32 MiB opens; one byte more is refused", () => {
    const atLimit = padTo(SUNSTONE, MAX_PROJECT_FILE_BYTES);
    const session = EditSession.open(atLimit);
    expect(session.kind).toBe("inline");
    expect(session.maps()).toHaveLength(3);
    const error = errorOf(() => EditSession.open(atLimit + " "));
    expect(error.code).toBe("TOO_LARGE");
    expect(error.message).toBe("the project file is 33,554,433 bytes; project files can be at most 32 MiB.");
  });

  test(`${MAX_MAPS} maps are accepted; ${MAX_MAPS + 1} are refused`, () => {
    expect(EditSession.open(JSON.stringify(projectWithMaps(MAX_MAPS))).maps()).toHaveLength(MAX_MAPS);
    const error = errorOf(() => EditSession.open(JSON.stringify(projectWithMaps(MAX_MAPS + 1))));
    expect(error.code).toBe("TOO_LARGE");
    expect(error.path).toBe("$.maps");
    expect(error.message).toBe("the project has 1,025 maps; a project can have at most 1,024.");
  });

  test(`${MAX_EVENTS_PER_MAP} events on a map are accepted; ${MAX_EVENTS_PER_MAP + 1} are refused`, () => {
    expect(EditSession.open(JSON.stringify(projectWithEvents(MAX_EVENTS_PER_MAP))).maps()[0]?.eventCount).toBe(MAX_EVENTS_PER_MAP);
    const error = errorOf(() => EditSession.open(JSON.stringify(projectWithEvents(MAX_EVENTS_PER_MAP + 1))));
    expect(error.code).toBe("TOO_LARGE");
    expect(error.path).toBe("$.maps[0].events");
    expect(error.message).toBe('map "meadow" has 4,097 events; a map can have at most 4,096.');
  });

  test("map cells stay bounded by the schema: width 257 is rejected", () => {
    const project = JSON.parse(SUNSTONE) as Project;
    expect(() => EditSession.open(JSON.stringify(project))).not.toThrow();
    project.maps[0]!.width = 257;
    const error = errorOf(() => EditSession.open(JSON.stringify(project))) as { code?: string; details?: { path: string; msg: string }[] };
    expect(error.code).not.toBe("TOO_LARGE");
    expect(error.details?.some((detail) => detail.path.includes("width"))).toBe(true);
  });
});

describe("sharded pack limits", () => {
  const SUNSTONE_PACK = packOf(JSON.parse(SUNSTONE) as Project);

  test("a pack of exactly 64 MiB opens; one byte more is refused", () => {
    const atLimit = `${padTo(SUNSTONE_PACK, MAX_PACK_BYTES - 1)}\n`;
    expect(utf8Bytes(atLimit)).toBe(MAX_PACK_BYTES);
    expect(parseShardedPack(atLimit).shards.size).toBe(3);
    expect(EditSession.open(atLimit).kind).toBe("pack");
    const over = `${atLimit} `;
    for (const open of [() => parseShardedPack(over), () => EditSession.open(over)]) {
      const error = errorOf(open);
      expect(error.code).toBe("TOO_LARGE");
      expect(error.message).toContain("67,108,865 bytes");
    }
  });

  test(`${MAX_SHARDS} shards are accepted; ${MAX_SHARDS + 1} are refused before the shell is validated`, () => {
    const atLimit = packOf(projectWithMaps(MAX_SHARDS));
    expect(parseShardedPack(atLimit).shards.size).toBe(MAX_SHARDS);
    expect(EditSession.open(atLimit).maps()).toHaveLength(MAX_SHARDS);
    const over = packOf(projectWithMaps(MAX_SHARDS + 1));
    const error = errorOf(() => EditSession.open(over));
    expect(error.code).toBe("TOO_LARGE");
    expect(error.message).toBe("the pack has 1,025 map shards; a pack can have at most 1,024.");
    // The count is checked on the envelope, so even an invalid shell gets it.
    const shards = Object.fromEntries(Array.from({ length: MAX_SHARDS + 1 }, (_, i) => [`maps/m${i}.json`, "{}"]));
    expect(codeOf(() => parseShardedPack(JSON.stringify({ kind: SHARDED_PACK_KIND, shell: "{}", shards })))).toBe("TOO_LARGE");
  });

  test("a shard of exactly 8 MiB is accepted by the pack reader; one byte more is refused", () => {
    const pack = JSON.parse(SUNSTONE_PACK) as { kind: string; shell: string; shards: Record<string, string> };
    const entry = "maps/forest.json";
    pack.shards[entry] = padTo(pack.shards[entry]!, MAX_SHARD_BYTES);
    expect(parseShardedPack(JSON.stringify(pack)).shards.get(entry)).toHaveLength(MAX_SHARD_BYTES);
    pack.shards[entry] += " ";
    const error = errorOf(() => parseShardedPack(JSON.stringify(pack)));
    expect(error.code).toBe("TOO_LARGE");
    expect(error.path).toBe('$.shards["maps/forest.json"]');
    expect(error.message).toBe('shard "maps/forest.json" is 8,388,609 bytes; one map shard can be at most 8 MiB.');
  });

  test("shard loading checks the shard's size before its checksum", () => {
    const split = splitProjectMaps(JSON.parse(SUNSTONE) as Project);
    const entry = split.entries.find((item) => item.path === "maps/forest.json")!;
    const atLimit = padTo(entry.text, MAX_SHARD_BYTES);
    // At the limit it fails only for the (deliberately) stale checksum.
    expect(codeOf(() => loadValidatedMapShard(split.shell, entry.path, atLimit))).toBe("INVALID_DOCUMENT");
    expect(codeOf(() => loadValidatedMapShard(split.shell, entry.path, `${atLimit} `))).toBe("TOO_LARGE");
  });

  test("a pack's shell of exactly 32 MiB passes the size check; one byte more is refused", () => {
    const pack = JSON.parse(SUNSTONE_PACK) as { kind: string; shell: string; shards: Record<string, string> };
    pack.shell = padTo(pack.shell, MAX_PROJECT_FILE_BYTES);
    expect(parseShardedPack(JSON.stringify(pack)).shards.size).toBe(3);
    pack.shell += " ";
    const error = errorOf(() => parseShardedPack(JSON.stringify(pack)));
    expect(error.code).toBe("TOO_LARGE");
    expect(error.path).toBe("$.shell");
  });

  test(`a shard with ${MAX_EVENTS_PER_MAP} events loads; ${MAX_EVENTS_PER_MAP + 1} are refused`, () => {
    for (const [count, expected] of [[MAX_EVENTS_PER_MAP, "OK"], [MAX_EVENTS_PER_MAP + 1, "TOO_LARGE"]] as const) {
      const split = splitProjectMaps(projectWithEvents(count));
      const entry = split.entries[0]!;
      expect(codeOf(() => loadValidatedMapShard(split.shell, entry.path, entry.text))).toBe(expected);
    }
    const pack = packOf(projectWithEvents(MAX_EVENTS_PER_MAP + 1));
    const session = EditSession.open(pack);
    const error = errorOf(() => session.map("meadow"));
    expect(error.code).toBe("TOO_LARGE");
    expect(error.message).toBe('map "meadow" has 4,097 events; a map can have at most 4,096.');
  });
});

describe("PNG limits", () => {
  test("readPngSize reads a real PNG's IHDR and rejects other bytes", () => {
    expect(readPngSize(TILE_PNG)).toEqual({ width: 16, height: 16 });
    expect(pngProblem("tile.png", TILE_PNG.length, TILE_PNG.subarray(0, 24))).toBeNull();
    const bad = TILE_PNG.slice(0, 24);
    bad[1] = 0x51;
    expect(readPngSize(bad)).toBeNull();
    expect(pngProblem("fake.png", 24, bad)).toBe("fake.png is not a PNG image.");
    expect(pngProblem("short.png", 10, TILE_PNG.subarray(0, 10))).toBe("short.png is not a PNG image.");
    expect(pngProblem("empty.png", 24, pngHeader(0, 16))).toBe("empty.png is not a PNG image.");
  });

  test(`a side of ${MAX_PNG_SIDE} px is accepted; ${MAX_PNG_SIDE + 1} is refused`, () => {
    expect(pngProblem("wide.png", 100, pngHeader(MAX_PNG_SIDE, 16))).toBeNull();
    expect(pngProblem("tall.png", 100, pngHeader(16, MAX_PNG_SIDE))).toBeNull();
    expect(pngProblem("wide.png", 100, pngHeader(MAX_PNG_SIDE + 1, 16))).toBe(
      "wide.png is 8,193×16 px; local PNGs can be at most 8,192 px on a side.",
    );
    expect(pngProblem("tall.png", 100, pngHeader(16, MAX_PNG_SIDE + 1))).not.toBeNull();
  });

  test(`${MAX_PNG_PIXELS} pixels are accepted; the next possible area is refused`, () => {
    expect(pngProblem("square.png", 100, pngHeader(4096, 4096))).toBeNull();
    expect(pngProblem("strip.png", 100, pngHeader(8192, 2048))).toBeNull();
    // 2^24 + 1 = 97 × 172,961 has no factorization with both sides ≤ 8192;
    // the smallest area over the limit that does is 2113 × 7940 (limit + 4).
    expect(2113 * 7940).toBe(MAX_PNG_PIXELS + 4);
    expect(pngProblem("big.png", 100, pngHeader(2113, 7940))).toBe(
      "big.png is 2,113×7,940 px (16,777,220 pixels); local PNGs can have at most 16,777,216 pixels.",
    );
    expect(pngProblem("big.png", 100, pngHeader(4097, 4096))).not.toBeNull();
  });

  test(`a file of ${MAX_PNG_BYTES} bytes passes the size check; one byte more is refused`, () => {
    expect(pngProblem("art.png", MAX_PNG_BYTES)).toBeNull();
    expect(pngProblem("art.png", MAX_PNG_BYTES + 1)).toBe("art.png is 16,777,217 bytes; local PNGs can be at most 16 MiB.");
  });
});

describe("MemoryHost picks", () => {
  test("a file over 64 MiB is refused unread with a visible error; one at the limit opens", async () => {
    const { host, app } = studioOnMemoryHost();
    host.filePicks.push({ name: "huge.json", text: SUNSTONE, size: MAX_PACK_BYTES + 1 });
    host.pickProjectFile();
    await Bun.sleep(0);
    expect(app.session).toBeNull();
    expect(app.notices.at(-1)).toMatchObject({
      level: "error",
      text: "huge.json is 67,108,865 bytes; project files can be at most 32 MiB and sharded packs at most 64 MiB.",
    });
    host.filePicks.push({ name: "sunstone.json", text: SUNSTONE, size: MAX_PACK_BYTES });
    host.pickProjectFile();
    await Bun.sleep(0);
    expect(app.session?.kind).toBe("inline");
  });

  test("an inline file between 32 and 64 MiB is read, then refused by EditSession with a clear notice", async () => {
    const { host, app } = studioOnMemoryHost();
    host.filePicks.push({ name: "village.json", text: padTo(SUNSTONE, 40 * 1024 * 1024) });
    host.pickProjectFile();
    await Bun.sleep(0);
    expect(app.session).toBeNull();
    expect(app.notices.at(-1)?.text).toBe("Could not open village.json: the project file is 40.0 MiB; project files can be at most 32 MiB.");
  });

  test("image picks: a real PNG is usable; oversized files and dimensions yield errors", async () => {
    const host = new MemoryHost();
    host.imagePicks.push(
      { name: "tile.png", bytes: TILE_PNG },
      { name: "huge.png", bytes: TILE_PNG, size: MAX_PNG_BYTES + 1 },
      { name: "wide.png", bytes: pngHeader(MAX_PNG_SIDE + 1, 1) },
      { name: "notes.txt", bytes: new TextEncoder().encode("not an image at all, really") },
    );
    const ok = await host.pickImage();
    expect(ok && "url" in ok ? ok.name : null).toBe("tile.png");
    expect(await host.pickImage()).toEqual({ error: "huge.png is 16,777,217 bytes; local PNGs can be at most 16 MiB." });
    expect(await host.pickImage()).toEqual({ error: "wide.png is 8,193×1 px; local PNGs can be at most 8,192 px on a side." });
    expect(await host.pickImage()).toEqual({ error: "notes.txt is not a PNG image." });
    expect(await host.pickImage()).toBeNull();
  });
});

/** `project` as a loose folder: a shell plus one file per map, under
 * `maps/` or (root: true) next to the shell at the top level. */
function looseFolder(project: Project, options: { root?: boolean; shell?: string } = {}): MemoryDirectory {
  const split = splitProjectMaps(project, options.root ? { mapEntry: (id) => `${id}.json` } : {});
  const files = new Map<string, string>([[options.shell ?? "project.json", split.shellText]]);
  for (const entry of split.entries) files.set(entry.path, entry.text);
  return new MemoryDirectory("game/", files);
}

/** A real loose folder of nine maps (no faked sizes) whose map files are
 * padded with trailing whitespace, their hashes declared to match, so that
 * the pack Studio builds from the folder is exactly `packBytes`. */
function folderPackingTo(packBytes: number, options: { root?: boolean } = {}): MemoryDirectory {
  const split = splitProjectMaps(projectWithMaps(9), options.root ? { mapEntry: (id) => `${id}.json` } : {});
  const packOf = (texts: string[]) =>
    utf8Bytes(serializeShardedPack(split.shellText, split.shell.mapIndex, new Map(split.entries.map((entry, i) => [entry.path, texts[i]!]))));
  // Spaces after a shard's JSON reach the pack unescaped, one byte each.
  let missing = packBytes - packOf(split.entries.map((entry) => entry.text));
  const texts = split.entries.map((entry) => {
    const add = Math.min(missing, MAX_SHARD_BYTES - utf8Bytes(entry.text));
    missing -= add;
    return entry.text + " ".repeat(add);
  });
  expect(missing).toBe(0);
  const { mapManifestHash: _declared, ...rest } = split.shell;
  const unhashed: ProjectShell = { ...rest, mapIndex: split.shell.mapIndex.map((meta, i) => ({ ...meta, sha256: createHash("sha256").update(texts[i]!).digest("hex") })) };
  const shellText = canonicalJson({ ...unhashed, mapManifestHash: mapManifestHash(unhashed) });
  expect(utf8Bytes(shellText)).toBe(utf8Bytes(split.shellText));
  const files = new Map<string, string>([["project.json", shellText]]);
  split.entries.forEach((entry, i) => files.set(entry.path, texts[i]!));
  return new MemoryDirectory("game/", files);
}

/** Open `dir` through Studio on the memory host, as a folder pick. */
async function studioOpensFolder(dir: MemoryDirectory): Promise<{ app: StudioApp }> {
  const { host, app } = studioOnMemoryHost();
  host.directoryPicks.push(dir);
  await host.pickProjectDirectory();
  await Bun.sleep(0);
  return { app };
}

/** The exact-limit and one-byte-over checks for a folder's pack. */
async function expectFolderPackLimit(root: boolean): Promise<void> {
  const exact = folderPackingTo(MAX_PACK_BYTES, { root });
  // Real texts only: every reported size is the file's own UTF-8 size.
  expect(exact.sizes.size).toBe(0);
  const fileBytes = [...exact.files.values()].map((text) => utf8Bytes(text));
  expect(fileBytes.every((bytes) => bytes > 0)).toBe(true);
  const shardBytes = [...exact.files.entries()].filter(([path]) => path !== "project.json").map(([, text]) => utf8Bytes(text));
  expect(shardBytes).toHaveLength(9);
  expect(Math.max(...shardBytes)).toBe(MAX_SHARD_BYTES);
  // The files alone are under 64 MiB; packing adds keys, indentation and escapes.
  expect(fileBytes.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThan(MAX_PACK_BYTES);
  const opened = await openProjectDirectory(exact);
  expect(utf8Bytes(opened.packText)).toBe(MAX_PACK_BYTES);
  // Seven map files are padded to 8 MiB, the eighth holds the rest and the
  // ninth is unpadded. One of each passes the full shard check, checksum
  // included (the engine's hash is slow in tests, so not all nine).
  expect(shardBytes.filter((bytes) => bytes === MAX_SHARD_BYTES)).toHaveLength(7);
  const shell = JSON.parse(opened.baseline.shellText) as ProjectShell;
  const entries = [...opened.baseline.shards.keys()];
  for (const entry of [entries[0]!, entries[7]!, entries[8]!]) {
    expect(loadValidatedMapShard(shell, entry, opened.baseline.shards.get(entry)!).id).toMatch(/^m\d$/);
  }
  const { app } = await studioOpensFolder(exact);
  expect(app.session?.kind).toBe("pack");
  expect(app.session?.isDirty()).toBe(false);
  expect(app.notices.at(-1)).toMatchObject({ level: "info", text: "Opened sharded pack game/. Save writes back into game/." });

  const over = folderPackingTo(MAX_PACK_BYTES + 1, { root });
  expect([...over.files.values()].reduce((sum, text) => sum + utf8Bytes(text), 0)).toBeLessThan(MAX_PACK_BYTES);
  const message = "game/: the project (project.json and 9 map files) as one sharded pack is 67,108,865 bytes; sharded packs can be at most 64 MiB.";
  await expect(openProjectDirectory(over)).rejects.toThrow(message);
  const refused = await studioOpensFolder(over);
  expect(refused.app.session).toBeNull();
  expect(refused.app.notices.at(-1)?.level).toBe("error");
  expect(refused.app.notices.at(-1)?.text).toStartWith("Could not open game/:");
  expect(refused.app.notices.at(-1)?.text).toEndWith(message);
}

describe("loose folder limits (checked from file sizes before reading)", () => {
  test("a map file of exactly 8 MiB is read; one byte more is refused unread", async () => {
    const dir = looseFolder(JSON.parse(SUNSTONE) as Project);
    dir.sizes.set("maps/forest.json", MAX_SHARD_BYTES);
    expect((await openProjectDirectory(dir)).shardCount).toBe(3);
    dir.reads = [];
    dir.sizes.set("maps/forest.json", MAX_SHARD_BYTES + 1);
    await expect(openProjectDirectory(dir)).rejects.toThrow(
      'game/: shard "maps/forest.json" is 8,388,609 bytes; one map shard can be at most 8 MiB.',
    );
    expect(dir.reads).toEqual(["project.json"]);
  });

  test("a real folder whose pack is exactly 64 MiB opens in Studio; one byte more is refused", async () => {
    await expectFolderPackLimit(false);
  }, 60_000);

  test("map files that alone total 64 MiB + 1 byte are refused before any is read", async () => {
    const dir = looseFolder(projectWithMaps(9));
    const shell = utf8Bytes(dir.files.get("project.json")!);
    const shards = [...dir.files.keys()].filter((path) => path.startsWith("maps/"));
    expect(shards).toHaveLength(9);
    // Seven full-size shards, one holding the rest of the budget, one byte more.
    const sizes = [...Array(7).fill(MAX_SHARD_BYTES), MAX_SHARD_BYTES - shell, 1];
    expect(sizes.every((bytes) => bytes > 0)).toBe(true);
    shards.forEach((path, i) => dir.sizes.set(path, sizes[i]!));
    expect(shell + sizes.reduce((sum, bytes) => sum + bytes, 0)).toBe(MAX_PACK_BYTES + 1);
    await expect(openProjectDirectory(dir)).rejects.toThrow(
      "game/: the project (project.json and 9 map files) is 67,108,865 bytes; sharded packs can be at most 64 MiB.",
    );
    expect(dir.reads).toEqual(["project.json"]);
  });

  test(`${MAX_SHARDS} map files are read; ${MAX_SHARDS + 1} are refused before any is read`, async () => {
    expect((await openProjectDirectory(looseFolder(projectWithTinyMaps(MAX_SHARDS)))).shardCount).toBe(MAX_SHARDS);
    const dir = looseFolder(projectWithTinyMaps(MAX_SHARDS + 1));
    await expect(openProjectDirectory(dir)).rejects.toThrow("game/: the pack has 1,025 map shards; a pack can have at most 1,024.");
    expect(dir.reads).toEqual(["project.json"]);
  });

  test("only the shell is read while looking for it; other top-level JSON is not", async () => {
    const dir = looseFolder(JSON.parse(SUNSTONE) as Project);
    dir.files.set("big.json", "{}");
    dir.sizes.set("big.json", MAX_PROJECT_FILE_BYTES + 1);
    dir.files.set("notes.json", "{}");
    expect((await openProjectDirectory(dir)).shardCount).toBe(3);
    expect(dir.reads).toEqual(["project.json", "maps/cave.json", "maps/forest.json", "maps/village.json"]);
    // When the oversized file is the only candidate, it is refused unread.
    dir.files.delete("project.json");
    dir.files.delete("notes.json");
    dir.reads = [];
    await expect(openProjectDirectory(dir)).rejects.toThrow(
      "game/: big.json is 33,554,433 bytes; project files can be at most 32 MiB.",
    );
    expect(dir.reads).toEqual([]);
  });

  test("a project shell of exactly 32 MiB is read; one byte more is refused unread", async () => {
    const dir = looseFolder(JSON.parse(SUNSTONE) as Project);
    dir.sizes.set("project.json", MAX_PROJECT_FILE_BYTES);
    expect((await openProjectDirectory(dir)).shardCount).toBe(3);
    dir.reads = [];
    dir.sizes.set("project.json", MAX_PROJECT_FILE_BYTES + 1);
    await expect(openProjectDirectory(dir)).rejects.toThrow("game/: project.json is 33,554,433 bytes; project files can be at most 32 MiB.");
    expect(dir.reads).toEqual([]);
  });

  test("the shell's file size counts toward the 64 MiB folder total", async () => {
    const dir = looseFolder(projectWithMaps(5));
    const shards = [...dir.files.keys()].filter((path) => path.startsWith("maps/"));
    for (const path of shards.slice(0, 4)) dir.sizes.set(path, MAX_SHARD_BYTES);
    dir.sizes.set(shards[4]!, 1);
    dir.sizes.set("project.json", MAX_PROJECT_FILE_BYTES - 1);
    expect((await openProjectDirectory(dir)).shardCount).toBe(5);
    dir.reads = [];
    dir.sizes.set("project.json", MAX_PROJECT_FILE_BYTES);
    await expect(openProjectDirectory(dir)).rejects.toThrow(
      "game/: the project (project.json and 5 map files) is 67,108,865 bytes; sharded packs can be at most 64 MiB.",
    );
    expect(dir.reads).toEqual(["project.json"]);
  });
});

describe("loose folder limits with map files next to the shell (top-level entries)", () => {
  const ROOT_SHARDS = ["cave.json", "forest.json", "village.json"];

  test("the folder opens and reads the shell, then each map file once", async () => {
    const dir = looseFolder(JSON.parse(SUNSTONE) as Project, { root: true });
    expect([...dir.files.keys()].sort()).toEqual([...ROOT_SHARDS, "project.json"].sort());
    const opened = await openProjectDirectory(dir);
    expect(opened.shardCount).toBe(3);
    expect([...opened.baseline.shards.keys()]).toEqual(ROOT_SHARDS);
    expect(dir.reads).toEqual(["project.json", ...ROOT_SHARDS]);
  });

  for (const target of ROOT_SHARDS) {
    test(`${target} at 8 MiB + 1 byte is refused and never read; neither is any other map file`, async () => {
      const dir = looseFolder(JSON.parse(SUNSTONE) as Project, { root: true });
      dir.sizes.set(target, MAX_SHARD_BYTES);
      expect((await openProjectDirectory(dir)).shardCount).toBe(3);
      dir.reads = [];
      dir.sizes.set(target, MAX_SHARD_BYTES + 1);
      await expect(openProjectDirectory(dir)).rejects.toThrow(
        `game/: shard "${target}" is 8,388,609 bytes; one map shard can be at most 8 MiB.`,
      );
      expect(dir.reads).not.toContain(target);
      expect(dir.reads).toEqual(["project.json"]);
    });
  }

  test("a real top-level folder whose pack is exactly 64 MiB opens in Studio; one byte more is refused", async () => {
    await expectFolderPackLimit(true);
  }, 60_000);

  test("shell plus top-level map files one byte over 64 MiB are refused before any map file is read", async () => {
    const dir = looseFolder(projectWithMaps(9), { root: true });
    const shell = utf8Bytes(dir.files.get("project.json")!);
    const shards = [...dir.files.keys()].filter((path) => path !== "project.json").sort();
    expect(shards).toHaveLength(9);
    expect(shards.every((path) => !path.includes("/"))).toBe(true);
    const sizes = [...Array(7).fill(MAX_SHARD_BYTES), MAX_SHARD_BYTES - shell, 1];
    expect(sizes.every((bytes) => bytes > 0)).toBe(true);
    shards.forEach((path, i) => dir.sizes.set(path, sizes[i]!));
    expect(shell + sizes.reduce((sum, bytes) => sum + bytes, 0)).toBe(MAX_PACK_BYTES + 1);
    await expect(openProjectDirectory(dir)).rejects.toThrow(
      "game/: the project (project.json and 9 map files) is 67,108,865 bytes; sharded packs can be at most 64 MiB.",
    );
    expect(dir.reads).toEqual(["project.json"]);
  });

  test("with no project.json or game.json among several top-level files, nothing is read", async () => {
    const dir = looseFolder(JSON.parse(SUNSTONE) as Project, { root: true, shell: "world.json" });
    dir.sizes.set("cave.json", MAX_SHARD_BYTES + 1);
    await expect(openProjectDirectory(dir)).rejects.toThrow(
      "game/ has 4 JSON files at its top level (cave.json, forest.json, village.json, world.json) and none is named project.json or game.json, so Studio cannot tell which is the project shell; name the shell project.json.",
    );
    expect(dir.reads).toEqual([]);
  });

  test("the memory host's folder pick shows the refusal as a visible error", async () => {
    const { host, app } = studioOnMemoryHost();
    const dir = looseFolder(JSON.parse(SUNSTONE) as Project);
    dir.sizes.set("maps/cave.json", MAX_SHARD_BYTES + 1);
    host.directoryPicks.push(dir);
    await host.pickProjectDirectory();
    await Bun.sleep(0);
    expect(app.session).toBeNull();
    expect(app.notices.at(-1)).toMatchObject({ level: "error" });
    expect(app.notices.at(-1)?.text).toContain('shard "maps/cave.json" is 8,388,609 bytes');
  });
});
