import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { runFileEdit } from "../editor/api/file.ts";
import { buildAndVerifySunstoneAgentTask } from "../tools/rpgkit-edit/example-sunstone.ts";
import type { FileEditResponse } from "../editor/api/types.ts";

const ROOT = resolve(import.meta.dir, "..");
const TEMP = join(import.meta.dir, `.rpgkit-edit-tmp-${process.pid}`);
const CLI = join(ROOT, "tools/rpgkit-edit/cli.ts");
const SUNSTONE = join(ROOT, "examples/sunstone/data/sunstone.json");

beforeAll(() => mkdirSync(TEMP, { recursive: true }));
afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

function tempFile(name: string, source = readFileSync(SUNSTONE, "utf8")): string {
  const path = join(TEMP, `${name}-${randomUUID()}.json`);
  writeFileSync(path, source);
  return path;
}

describe("rpgkit-edit file and CLI adapter", () => {
  test("dry-run computes a patch without changing one source byte", () => {
    const file = tempFile("dry-run");
    const before = readFileSync(file, "utf8");
    const response = runFileEdit({
      command: "paint-tile",
      file,
      args: { map: "village", x: 0, y: 0, tile: "town.1" },
      dryRun: true,
    });
    expect(response).toMatchObject({ ok: true, changed: true, dryRun: true, written: false });
    expect(response.ok && response.patch?.changes).toHaveLength(1);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("an invalid edit is rejected and the original file stays unchanged", () => {
    const file = tempFile("invalid");
    const before = readFileSync(file, "utf8");
    const response = runFileEdit({
      command: "paint-rect",
      file,
      args: { map: "village", x: 19, y: 12, width: 2, height: 1, tile: "town.1" },
    });
    expect(response).toMatchObject({ ok: false, written: false, error: { code: "OUT_OF_BOUNDS", path: "$" } });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("a successful write is atomic at the adapter boundary", () => {
    const file = tempFile("write");
    const response = runFileEdit({
      command: "paint-tile",
      file,
      args: { map: "village", x: 0, y: 0, tile: "town.1" },
    });
    expect(response).toMatchObject({ ok: true, changed: true, dryRun: false, written: true });
    expect((JSON.parse(readFileSync(file, "utf8")) as any).maps[0].ground[0]).toBe("town.1");
    expect(readdirSync(TEMP).filter((name) => name.includes(".rpgkit-edit-") && name.endsWith(".tmp"))).toEqual([]);
  });

  test("editing through a symlink updates its target without replacing the link", () => {
    const target = tempFile("symlink-target");
    const link = join(TEMP, `symlink-${randomUUID()}.json`);
    symlinkSync(target, link);
    const response = runFileEdit({
      command: "paint-tile",
      file: link,
      args: { map: "village", x: 0, y: 0, tile: "town.1" },
    });
    expect(response).toMatchObject({ ok: true, written: true, file: target });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect((JSON.parse(readFileSync(target, "utf8")) as any).maps[0].ground[0]).toBe("town.1");
  });

  test("an optional project root rejects files reached outside it, including through symlinks", () => {
    const root = join(TEMP, `root-${randomUUID()}`);
    mkdirSync(root);
    const outside = tempFile("outside");
    const link = join(root, "escape.json");
    symlinkSync(outside, link);
    expect(runFileEdit({ command: "open", file: link, root })).toMatchObject({
      ok: false,
      written: false,
      error: { code: "PATH_OUTSIDE_ROOT" },
    });
  });

  test("saving a local event edit preserves an untouched event's exact bytes", () => {
    const keep = `{ "id" : "keep", "name" : "Odd spacing stays", "x" : 0, "y" : 0,
          "pages" : [ { "trigger" : "action", "commands" : [ { "op" : "text", "lines" : ["KEEP  punctuation"] } ] } ] }`;
    const source = `{
 "format":"rpgkit-project/v1", "title":"Preserve", "tileSize":16,
 "start":{"map":"m","x":0,"y":0,"dir":"down"},
 "sheets":[{"id":"s","pak":"chunks","cols":1,"rows":1}], "items":[],
 "maps":[{"id":"m","name":"M","width":2,"height":1,"sheets":["s"],"ground":["s.0","s.0"],
 "events":[${keep},{"id":"edit","name":"Before","x":1,"y":0,"pages":[{"trigger":"action","commands":[]}]}]}]
}`;
    const file = tempFile("preserve", source);
    const response = runFileEdit({ command: "update-event", file, args: { map: "m", event: "edit", changes: { name: "After" } } });
    expect(response).toMatchObject({ ok: true, written: true });
    const saved = readFileSync(file, "utf8");
    expect(saved).toContain(keep);
    expect((JSON.parse(saved) as any).maps[0].events[1].name).toBe("After");
  });

  test("CLI stdout is one JSON document and errors exit nonzero", () => {
    const file = tempFile("cli");
    const good = Bun.spawnSync({
      cmd: [process.execPath, CLI, "list-events", "--file", file, "--json", '{"map":"village"}'],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(good.exitCode).toBe(0);
    expect(good.stderr.toString()).toBe("");
    const response = JSON.parse(good.stdout.toString()) as FileEditResponse;
    expect(response).toMatchObject({ ok: true, command: "list-events", written: false });
    expect(good.stdout.toString().trim().split("\n")).toHaveLength(1);

    const before = readFileSync(file, "utf8");
    const bad = Bun.spawnSync({
      cmd: [process.execPath, CLI, "paint-tile", "--file", file, "--json", '{"map":"missing","x":0,"y":0,"tile":"town.1"}'],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(bad.exitCode).toBe(1);
    expect(JSON.parse(bad.stdout.toString())).toMatchObject({ ok: false, error: { code: "MAP_NOT_FOUND", path: "$.map" } });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("example authors a three-line, ten-gold, self-switch NPC through seven CLI edits", () => {
    const output = join(TEMP, "sunstone-agent-task.json");
    const sourceBefore = readFileSync(SUNSTONE, "utf8");
    const result = buildAndVerifySunstoneAgentTask(output);
    expect(result).toMatchObject({
      output,
      event: "agent-greeter",
      cliEdits: 7,
      initialGold: 5,
      finalGold: 15,
      selfSwitch: "A",
      oneShot: true,
    });
    expect(result.dialogues).toHaveLength(3);
    expect(readFileSync(SUNSTONE, "utf8")).toBe(sourceBefore);
    const edited = JSON.parse(readFileSync(output, "utf8")) as any;
    const villageEvents = edited.maps.find((map: any) => map.id === "village").events;
    expect(villageEvents.find((event: any) => event.id === "agent-greeter")).toMatchObject({ x: 10, y: 1 });
    expect(villageEvents.some((event: any) => event.id === "elder")).toBe(true);
    expect(villageEvents.some((event: any) => event.id === "north-gate")).toBe(true);
  });
});
