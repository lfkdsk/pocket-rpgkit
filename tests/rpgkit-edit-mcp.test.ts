import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { EDIT_COMMANDS, type EditPatch } from "../editor/api/types.ts";
import { EDIT_TOOLS } from "../editor/api/tools.ts";
import { runFileEdit } from "../editor/api/file.ts";
import {
  MCP_PROTOCOL_VERSION,
  dispatchMcpLine,
  dispatchMcpMessage,
} from "../tools/rpgkit-edit/mcp.ts";

const ROOT = resolve(import.meta.dir, "..");
const TEMP = join(import.meta.dir, `.rpgkit-edit-mcp-${process.pid}`);
const SUNSTONE = join(ROOT, "examples/sunstone/data/sunstone.json");
const SERVER = join(ROOT, "tools/rpgkit-edit/mcp.ts");

beforeAll(() => mkdirSync(TEMP, { recursive: true }));
afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

function copy(): string {
  const path = join(TEMP, `${randomUUID()}.json`);
  copyFileSync(SUNSTONE, path);
  return path;
}

function call(name: string, args: Record<string, unknown>): any {
  return dispatchMcpMessage({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

const initializeParams = {
  protocolVersion: MCP_PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: "rpgkit-edit-test", version: "1.0.0" },
};

describe("rpgkit-edit MCP protocol", () => {
  test("initializes, pings, lists tools, and emits nothing for notifications", () => {
    expect(dispatchMcpMessage({ jsonrpc: "2.0", id: "init", method: "initialize", params: initializeParams }))
      .toMatchObject({ id: "init", result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} } } });
    expect(dispatchMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(dispatchMcpMessage({ jsonrpc: "2.0", id: 1, method: "ping" })).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    const listed = dispatchMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }) as any;
    expect(listed.result.tools.map((tool: any) => tool.name)).toEqual(EDIT_TOOLS.map((tool) => tool.name));
    expect(listed.result.tools.every((tool: any) => tool.description.length > 20 && tool.inputSchema.type === "object")).toBe(true);
  });

  test("returns standard JSON-RPC errors for malformed messages, methods and params", () => {
    expect(dispatchMcpLine("{bad")).toMatchObject({ error: { code: -32700 } });
    expect(dispatchMcpMessage([])).toMatchObject({ error: { code: -32600 } });
    expect(dispatchMcpMessage({ jsonrpc: "2.0", id: 1, method: "missing" })).toMatchObject({ error: { code: -32601 } });
    expect(dispatchMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "missing", arguments: {} } }))
      .toMatchObject({ error: { code: -32602 } });
    expect(dispatchMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "rpgkit_events_list", arguments: {} } }))
      .toMatchObject({ error: { code: -32602, data: expect.any(Array) } });
    expect(dispatchMcpMessage({ jsonrpc: "2.0", id: { bad: true }, method: "ping" }))
      .toMatchObject({ id: null, error: { code: -32600 } });
    expect(dispatchMcpMessage({ jsonrpc: "2.0", id: 4, method: "notifications/initialized" }))
      .toMatchObject({ id: 4, error: { code: -32600 } });
  });

  const cases: { name: string; args: (file: string) => Record<string, unknown> }[] = [
    { name: "rpgkit_project_open", args: (file) => ({ file }) },
    { name: "rpgkit_maps_list", args: (file) => ({ file }) },
    { name: "rpgkit_events_list", args: (file) => ({ file, map: "village" }) },
    { name: "rpgkit_pages_list", args: (file) => ({ file, map: "village", event: "elder" }) },
    { name: "rpgkit_commands_list", args: (file) => ({ file, map: "village", event: "elder", page: 0 }) },
    { name: "rpgkit_tile_paint", args: (file) => ({ file, dryRun: true, map: "village", x: 0, y: 0, tile: "town.1" }) },
    { name: "rpgkit_tile_rect", args: (file) => ({ file, dryRun: true, map: "village", x: 0, y: 0, width: 2, height: 1, tile: "town.1" }) },
    { name: "rpgkit_tile_fill", args: (file) => ({ file, dryRun: true, map: "village", x: 0, y: 0, tile: "town.1" }) },
    { name: "rpgkit_event_add", args: (file) => ({ file, dryRun: true, map: "village", event: { id: "mcp-event", x: 9, y: 8, pages: [{ trigger: "action", commands: [] }] } }) },
    { name: "rpgkit_event_update", args: (file) => ({ file, dryRun: true, map: "village", event: "elder", changes: { name: "MCP Elder" } }) },
    { name: "rpgkit_event_delete", args: (file) => ({ file, dryRun: true, map: "village", event: "elder" }) },
    { name: "rpgkit_page_add", args: (file) => ({ file, dryRun: true, map: "village", event: "elder", page: { trigger: "action", commands: [] } }) },
    { name: "rpgkit_page_update", args: (file) => ({ file, dryRun: true, map: "village", event: "elder", page: 0, value: { trigger: "action", commands: [] } }) },
    { name: "rpgkit_page_delete", args: (file) => ({ file, dryRun: true, map: "village", event: "village-chest", page: 1 }) },
    { name: "rpgkit_command_insert", args: (file) => ({ file, dryRun: true, map: "village", event: "elder", page: 0, address: { path: [], index: 0 }, command: { op: "text", lines: ["MCP"] } }) },
    { name: "rpgkit_command_delete", args: (file) => ({ file, dryRun: true, map: "village", event: "elder", page: 0, address: { path: [], index: 0 } }) },
    { name: "rpgkit_command_update", args: (file) => ({ file, dryRun: true, map: "village", event: "elder", page: 0, address: { path: [], index: 0 }, field: "cps", value: "30" }) },
    { name: "rpgkit_project_validate", args: (file) => ({ file }) },
    {
      name: "rpgkit_project_save",
      args: (file) => {
        const preview = runFileEdit({ command: "paint-tile", file, dryRun: true, args: { map: "village", x: 0, y: 0, tile: "town.1" } });
        if (!preview.ok) throw new Error(JSON.stringify(preview));
        return { file, dryRun: true, patch: preview.patch as EditPatch };
      },
    },
  ];

  for (const entry of cases) {
    test(`${entry.name} is registered and callable`, () => {
      const file = copy();
      const before = readFileSync(file, "utf8");
      const args = entry.args(file);
      const response = call(entry.name, args);
      expect(response).toMatchObject({ jsonrpc: "2.0", id: 7, result: { isError: false } });
      const body = JSON.parse(response.result.content[0].text);
      expect(body.ok).toBe(true);
      if (args.dryRun === true) expect(readFileSync(file, "utf8")).toBe(before);
    });
  }

  test("registry has exactly one MCP tool for every operation", () => {
    expect(new Set(EDIT_TOOLS.map((tool) => tool.name)).size).toBe(EDIT_TOOLS.length);
    expect(EDIT_TOOLS.map((tool) => tool.command).sort()).toEqual([...EDIT_COMMANDS].sort());
  });

  test("a non-dry-run MCP mutation persists and a domain failure is a tool error", () => {
    const file = copy();
    const changed = call("rpgkit_tile_paint", { file, map: "village", x: 0, y: 0, tile: "town.1" });
    expect(changed).toMatchObject({ result: { isError: false, structuredContent: { ok: true, written: true } } });
    expect((JSON.parse(readFileSync(file, "utf8")) as any).maps[0].ground[0]).toBe("town.1");

    const failed = call("rpgkit_tile_paint", { file, map: "missing", x: 0, y: 0, tile: "town.1" });
    expect(failed).toMatchObject({ result: { isError: true, structuredContent: { ok: false, error: { code: "MAP_NOT_FOUND" } } } });
  });

  test("stdio server keeps stdout as one JSON-RPC object per line and survives parse errors", async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, SERVER],
      cwd: ROOT,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: initializeParams }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "rpgkit_project_open", arguments: { file: SUNSTONE } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "rpgkit_events_list", arguments: { file: SUNSTONE, map: "missing" } } }),
      "{bad",
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
      JSON.stringify({ jsonrpc: "2.0", id: 5, method: "ping" }),
      "",
    ].join("\n"));
    child.stdin.end();
    const timeout = setTimeout(() => child.kill(), 3_000);
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    clearTimeout(timeout);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const messages = stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(messages.map((message) => message.id)).toEqual([1, 2, 3, null, 4, 5]);
    expect(messages[1]).toMatchObject({ result: { isError: false } });
    expect(messages[2]).toMatchObject({ result: { isError: true } });
    expect(messages[3]).toMatchObject({ error: { code: -32700 } });
    expect(messages[4].result.tools).toHaveLength(EDIT_TOOLS.length);
  });
});
