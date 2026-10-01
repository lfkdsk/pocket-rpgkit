import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect, type Socket } from "node:net";
import { dirname, join } from "node:path";
import {
  canonicalMapJson,
  mapManifestHash,
  sha256Text,
} from "../src/engine/map-repository.ts";
import { canonicalJson } from "../src/engine/save.ts";
import type { MapDef, Project, ProjectShell } from "../src/engine/types.ts";
import {
  EditorFiles,
  EditorFilesError,
  startEditorFilesServer,
  type ProjectSaveMessage,
} from "../tools/editor-files.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function map(id: string): MapDef {
  return {
    id,
    name: id,
    width: 2,
    height: 2,
    sheets: ["tiles"],
    ground: ["tiles.0", "tiles.0", "tiles.0", "tiles.0"],
    events: [],
  };
}

function project(): Project {
  return {
    format: "rpgkit-project/v1",
    title: "editor files fixture",
    tileSize: 16,
    start: { map: "a", x: 0, y: 0, dir: "down" },
    sheets: [{ id: "tiles", pak: "tiles", cols: 2, rows: 1, defaultPassage: "pass" }],
    items: [],
    maps: [map("a"), map("b")],
  };
}

function fixture(writeShards = true) {
  const root = mkdtempSync(join(import.meta.dir, ".rpgkit-editor-files-"));
  temporary.push(root);
  const split = splitProjectMaps(project());
  const shellFile = join(root, "project.json");
  writeFileSync(shellFile, split.shellText);
  if (writeShards) {
    for (const entry of split.entries) {
      const path = join(root, entry.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, entry.text);
    }
  }
  return { root, shellFile, split };
}

function changedSave(
  split: ReturnType<typeof splitProjectMaps>,
  request = 7,
): { message: ProjectSaveMessage; entry: string; text: string; shellText: string } {
  const original = split.entries[0]!;
  const changed = structuredClone(JSON.parse(original.text) as MapDef);
  changed.ground[0] = "tiles.1";
  const text = canonicalMapJson(changed);
  const unhashed: ProjectShell = {
    ...split.shell,
    mapIndex: split.shell.mapIndex.map((meta) => meta.entry === original.path
      ? { ...meta, sha256: sha256Text(text) }
      : meta),
  };
  delete unhashed.mapManifestHash;
  const shell: ProjectShell = { ...unhashed, mapManifestHash: mapManifestHash(unhashed) };
  const shellText = canonicalJson(shell);
  return {
    entry: original.path,
    text,
    shellText,
    message: {
      t: "project-save",
      request,
      baseManifestHash: split.shell.mapManifestHash!,
      shell: shellText,
      shards: [{ entry: original.path, text, expectedSha256: original.meta.sha256 }],
    },
  };
}

describe("desktop editor file companion", () => {
  test("opens only the shell/catalog and lazily returns a verified shard", () => {
    const { root, shellFile, split } = fixture(false);
    const files = new EditorFiles(shellFile, { root });
    expect(files.project()).toEqual({ t: "project", shell: split.shellText });

    const entry = split.entries[0]!;
    expect(files.handle({ t: "map-read", request: 1, entry: entry.path })).toMatchObject({
      t: "map-error",
      request: 1,
      entry: entry.path,
      error: expect.stringContaining("READ_FAILED"),
    });

    const path = join(root, entry.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, entry.text);
    expect(files.handle({ t: "map-read", request: 2, entry: entry.path })).toEqual({
      t: "map-data",
      request: 2,
      entry: entry.path,
      text: entry.text,
    });
    expect(files.handle({ t: "map-read", request: 3, entry: "maps/nope.json" })).toMatchObject({
      t: "map-error",
      error: expect.stringContaining("ENTRY_NOT_FOUND"),
    });
  });

  test("commits only targeted shards, in catalog order, with the shell last", () => {
    const { root, shellFile, split } = fixture();
    const untouched = split.entries[1]!;
    const untouchedBefore = readFileSync(join(root, untouched.path), "utf8");
    const order: string[] = [];
    const files = new EditorFiles(shellFile, {
      root,
      hooks: {
        beforeRename(path, kind, phase) {
          if (phase === "commit") order.push(`${kind}:${path}`);
        },
      },
    });
    const changed = changedSave(split);

    expect(files.handle(changed.message)).toEqual({ t: "project-saved", request: 7, ok: true });
    expect(order.map((value) => value.slice(0, value.indexOf(":")))).toEqual(["shard", "shell"]);
    expect(readFileSync(join(root, changed.entry), "utf8")).toBe(changed.text);
    expect(readFileSync(shellFile, "utf8")).toBe(changed.shellText);
    expect(readFileSync(join(root, untouched.path), "utf8")).toBe(untouchedBefore);
    expect(files.project().shell).toBe(changed.shellText);
    expect(files.handle({ t: "map-read", request: 8, entry: changed.entry })).toMatchObject({
      t: "map-data",
      text: changed.text,
    });
  });

  test("rejects stale shell and shard bases before replacing any project file", () => {
    const shellCase = fixture();
    const shellSave = changedSave(shellCase.split);
    const driftedShell = `${shellCase.split.shellText}\n`;
    writeFileSync(shellCase.shellFile, driftedShell);
    const shellFiles = new EditorFiles(shellCase.shellFile, { root: shellCase.root });
    // Opened bytes include the harmless newline; the guest's older manifest is
    // still valid, but an external byte edit after open must lose the race.
    writeFileSync(shellCase.shellFile, `${driftedShell} `);
    expect(shellFiles.handle(shellSave.message)).toMatchObject({
      t: "project-saved",
      ok: false,
      error: expect.stringContaining("WRITE_CONFLICT"),
    });
    expect(readFileSync(join(shellCase.root, shellSave.entry), "utf8")).toBe(shellCase.split.entries[0]!.text);

    const shardCase = fixture();
    const shardSave = changedSave(shardCase.split);
    const stale = `${shardCase.split.entries[0]!.text}\n`;
    writeFileSync(join(shardCase.root, shardSave.entry), stale);
    const shardFiles = new EditorFiles(shardCase.shellFile, { root: shardCase.root });
    expect(shardFiles.handle(shardSave.message)).toMatchObject({
      t: "project-saved",
      ok: false,
      error: expect.stringContaining("WRITE_CONFLICT"),
    });
    expect(readFileSync(shardCase.shellFile, "utf8")).toBe(shardCase.split.shellText);
    expect(readFileSync(join(shardCase.root, shardSave.entry), "utf8")).toBe(stale);
  });

  test("rolls back a committed shard when the shell rename fails", () => {
    const { root, shellFile, split } = fixture();
    const changed = changedSave(split);
    const phases: string[] = [];
    const files = new EditorFiles(shellFile, {
      root,
      hooks: {
        beforeRename(_path, kind, phase) {
          phases.push(`${phase}:${kind}`);
          if (phase === "commit" && kind === "shell") throw new Error("injected shell rename failure");
        },
      },
    });

    expect(files.handle(changed.message)).toMatchObject({
      t: "project-saved",
      request: 7,
      ok: false,
      error: expect.stringContaining("WRITE_FAILED"),
    });
    expect(phases).toEqual(["commit:shard", "commit:shell", "rollback:shard"]);
    expect(readFileSync(join(root, changed.entry), "utf8")).toBe(split.entries[0]!.text);
    expect(readFileSync(shellFile, "utf8")).toBe(split.shellText);
  });

  test("rejects lexical and symlink escapes from the configured root", () => {
    const base = mkdtempSync(join(import.meta.dir, ".rpgkit-editor-root-"));
    temporary.push(base);
    const root = join(base, "project");
    mkdirSync(root);
    const escaped = splitProjectMaps(project(), { mapEntry: (id) => `../${id}.json` });
    const shellFile = join(root, "project.json");
    writeFileSync(shellFile, escaped.shellText);
    expect(() => new EditorFiles(shellFile, { root })).toThrow(EditorFilesError);
    try {
      new EditorFiles(shellFile, { root });
    } catch (error) {
      expect(error).toMatchObject({ code: "PATH_OUTSIDE_ROOT" });
    }

    const linked = fixture(false);
    const target = join(base, "outside.json");
    writeFileSync(target, linked.split.entries[0]!.text);
    const link = join(linked.root, linked.split.entries[0]!.path);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link);
    const files = new EditorFiles(linked.shellFile, { root: linked.root });
    expect(files.handle({ t: "map-read", request: 9, entry: linked.split.entries[0]!.path })).toMatchObject({
      t: "map-error",
      request: 9,
      error: expect.stringContaining("PATH_OUTSIDE_ROOT"),
    });
  });

  test("speaks the desktop host PKNT handshake and framed control route", async () => {
    const { root, shellFile, split } = fixture();
    const server = await startEditorFilesServer(shellFile, { root, app: "editor" });
    const socket = await new Promise<Socket>((accept, reject) => {
      const client = connect(server.port, server.host, () => accept(client));
      client.once("error", reject);
    });
    const reader = new ByteReader(socket);
    try {
      const hello = pkntHello("editor");
      socket.write(hello.subarray(0, 3));
      socket.write(hello.subarray(3));
      const ack = await reader.take(8);
      expect(ack.readUInt32LE(0)).toBe(0x544e4b50);
      expect(ack[4]).toBe(1);
      expect(await reader.control()).toEqual({ t: "project", shell: split.shellText });

      socket.write(pkntControl({ t: "map-read", request: 41, entry: split.entries[1]!.path }));
      expect(await reader.control()).toEqual({
        t: "map-data",
        request: 41,
        entry: split.entries[1]!.path,
        text: split.entries[1]!.text,
      });
    } finally {
      socket.destroy();
      await server.close();
    }
  });

  test("chunks oversized map reads and project saves through actual PKNT ctrl frames", async () => {
    const root = mkdtempSync(join(import.meta.dir, ".rpgkit-editor-large-"));
    temporary.push(root);
    const large = project();
    large.maps = [
      {
        ...map("a"),
        width: 256,
        height: 256,
        ground: new Array(256 * 256).fill("tiles.0"),
      },
      // Make the initial shell/catalog itself cross the ctrl-line limit too.
      ...Array.from({ length: 96 }, (_, index) => map(`m${String(index).padStart(3, "0")}`)),
    ];
    const split = splitProjectMaps(large);
    const shellFile = join(root, "project.json");
    writeFileSync(shellFile, split.shellText);
    for (const entry of split.entries) {
      const path = join(root, entry.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, entry.text);
    }
    expect(split.entries[0]!.text.length).toBeGreaterThan(285_698);

    const server = await startEditorFilesServer(shellFile, { root, app: "editor" });
    const socket = await new Promise<Socket>((accept, reject) => {
      const client = connect(server.port, server.host, () => accept(client));
      client.once("error", reject);
    });
    const reader = new ByteReader(socket);
    try {
      socket.write(pkntHello("editor"));
      await reader.take(8);
      expect(await reader.control()).toEqual({ t: "project", shell: split.shellText });
      expect(reader.controlPayloadSizes.length).toBeGreaterThan(2);

      const entry = split.entries[0]!;
      socket.write(pkntControl({ t: "map-read", request: 50, entry: entry.path }));
      expect(await reader.control()).toEqual({
        t: "map-data",
        request: 50,
        entry: entry.path,
        text: entry.text,
      });
      expect(reader.controlPayloadSizes.length).toBeGreaterThan(2);
      expect(reader.controlPayloadSizes.every((length) => length <= 8192)).toBe(true);

      // A duplicate/out-of-order chunk invalidates only that transfer. The
      // next direct logical message must be accepted from a clean state.
      socket.write(pkntControl({ t: "chunk-start", transfer: 8, chunks: 2 }));
      socket.write(pkntControl({ t: "chunk", transfer: 8, index: 0, text: "{" }));
      socket.write(pkntControl({ t: "chunk", transfer: 8, index: 0, text: "}" }));
      socket.write(pkntControl({ t: "map-read", request: 51, entry: entry.path }));
      expect(await reader.control()).toMatchObject({ t: "map-data", request: 51, text: entry.text });

      const changed = changedSave(split, 52);
      const saveFrames = pkntControls(changed.message, 9);
      expect(saveFrames.length).toBeGreaterThan(2);
      expect(saveFrames.every((frame) => frame.readUInt32LE(4) <= 8192)).toBe(true);
      for (const frame of saveFrames) socket.write(frame);
      expect(await reader.control()).toEqual({ t: "project-saved", request: 52, ok: true });
      expect(readFileSync(join(root, changed.entry), "utf8")).toBe(changed.text);
      expect(readFileSync(shellFile, "utf8")).toBe(changed.shellText);
      expect(reader.controlPayloadSizes.every((length) => length <= 8192)).toBe(true);
    } finally {
      socket.destroy();
      await server.close();
    }
  }, 20_000);
});

function pkntHello(app: string): Buffer {
  const name = Buffer.from(app, "utf8");
  const hello = Buffer.alloc(7 + name.length);
  hello.writeUInt32LE(0x544e4b50, 0);
  hello[4] = 1;
  hello[6] = name.length;
  name.copy(hello, 7);
  return hello;
}

function pkntControl(value: unknown): Buffer {
  return pkntControlText(JSON.stringify(value));
}

function pkntControlText(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const frame = Buffer.alloc(8 + payload.length);
  frame[0] = 0x10;
  frame.writeUInt32LE(payload.length, 4);
  payload.copy(frame, 8);
  return frame;
}

function pkntControls(value: unknown, transfer: number): Buffer[] {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") <= 8192) return [pkntControlText(text)];
  const chunks = Math.ceil(text.length / 1024);
  const frames = [pkntControl({ t: "chunk-start", transfer, chunks })];
  for (let index = 0; index < chunks; index++) {
    frames.push(pkntControl({
      t: "chunk",
      transfer,
      index,
      text: text.slice(index * 1024, (index + 1) * 1024),
    }));
  }
  return frames;
}

class ByteReader {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private wake: (() => void) | undefined;
  readonly controlPayloadSizes: number[] = [];

  constructor(socket: Socket) {
    socket.on("data", (chunk) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      this.buffer = Buffer.concat([this.buffer, bytes]);
      this.wake?.();
      this.wake = undefined;
    });
  }

  async take(length: number): Promise<Buffer<ArrayBufferLike>> {
    while (this.buffer.length < length) {
      await new Promise<void>((accept) => {
        this.wake = accept;
      });
    }
    const result = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return result;
  }

  async control(): Promise<unknown> {
    const first = await this.controlEnvelope();
    if (!isTestRecord(first) || first.t !== "chunk-start") return first;
    const transfer = first.transfer;
    const chunks = first.chunks;
    expect(Number.isSafeInteger(transfer)).toBe(true);
    expect(Number.isSafeInteger(chunks)).toBe(true);
    const parts: string[] = [];
    for (let index = 0; index < (chunks as number); index++) {
      const envelope = await this.controlEnvelope();
      expect(envelope).toMatchObject({ t: "chunk", transfer, index });
      if (!isTestRecord(envelope) || typeof envelope.text !== "string") {
        throw new Error("test peer received a malformed chunk");
      }
      expect(envelope.text.length).toBeLessThanOrEqual(1024);
      parts.push(envelope.text);
    }
    return JSON.parse(parts.join(""));
  }

  private async controlEnvelope(): Promise<unknown> {
    const header = await this.take(8);
    expect(header[0]).toBe(0x10);
    const length = header.readUInt32LE(4);
    this.controlPayloadSizes.push(length);
    const payload = await this.take(length);
    return JSON.parse(payload.toString("utf8"));
  }
}

function isTestRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
