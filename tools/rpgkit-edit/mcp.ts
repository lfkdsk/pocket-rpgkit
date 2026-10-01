#!/usr/bin/env bun
// Zero-dependency MCP stdio server for the RPG Kit editing operation registry.

import { createInterface } from "node:readline";
import { once } from "node:events";
import { validateSchema } from "../../src/engine/schema-validate.ts";
import { runFileEdit, type FileEditRequest } from "../../editor/api/file.ts";
import { EDIT_TOOL_BY_NAME, EDIT_TOOLS, type EditToolDefinition } from "../../editor/api/tools.ts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_SERVER_INFO = { name: "pocket-rpgkit-edit", version: "0.1.0" } as const;
export const MCP_USAGE = `Usage:
  bun run rpgkit-edit:mcp [--root <project-directory>]

Runs an MCP server over newline-delimited JSON-RPC on stdin/stdout. Tool file
paths must resolve inside --root (default: current working directory). stdout
is reserved for protocol messages.`;

type JsonRpcId = string | number | null;
type JsonObject = Record<string, unknown>;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function resultResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function publicTool(definition: EditToolDefinition): Record<string, unknown> {
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: definition.inputSchema,
    annotations: {
      readOnlyHint: !definition.mutates,
      destructiveHint: definition.mutates,
      idempotentHint: !definition.mutates,
      openWorldHint: false,
    },
  };
}

function parseToolRequest(
  params: unknown,
  root: string,
): { definition: EditToolDefinition; request: FileEditRequest } | { error: string; details?: unknown } {
  if (!isRecord(params) || typeof params.name !== "string") {
    return { error: "tools/call params must contain a string name" };
  }
  const definition = EDIT_TOOL_BY_NAME.get(params.name);
  if (!definition) return { error: `unknown tool ${JSON.stringify(params.name)}` };
  const input = params.arguments ?? {};
  const errors = validateSchema(definition.inputSchema, input);
  if (errors.length > 0) return { error: `${errors[0]!.path}: ${errors[0]!.msg}`, details: errors };
  const values = input as Record<string, unknown>;
  const { file, dryRun, ...args } = values;
  return {
    definition,
    request: {
      command: definition.command,
      file: file as string,
      args,
      dryRun: dryRun === true,
      root,
    },
  };
}

/** Pure single-message dispatcher. Notifications return null and emit no
 * protocol response. File tool calls are synchronous and serialized by the
 * line reader, preventing two writes from racing inside one server. */
export function dispatchMcpMessage(value: unknown, root = process.cwd()): JsonRpcResponse | null {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") {
    return errorResponse(null, -32600, "Invalid Request: expected a JSON-RPC 2.0 object with method");
  }
  if (Object.prototype.hasOwnProperty.call(value, "id") && value.id !== null && typeof value.id !== "string" && typeof value.id !== "number") {
    return errorResponse(null, -32600, "Invalid Request: id must be a string, number, or null");
  }
  const request = value as unknown as JsonRpcRequest;
  const notification = !Object.prototype.hasOwnProperty.call(value, "id");
  const id = request.id ?? null;

  if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") {
    return notification ? null : errorResponse(id, -32600, `${request.method} must be a notification without id`);
  }
  if (notification) return null;

  if (request.method === "initialize") {
    if (!isRecord(request.params) || typeof request.params.protocolVersion !== "string" ||
      !isRecord(request.params.capabilities) || !isRecord(request.params.clientInfo) ||
      typeof request.params.clientInfo.name !== "string" || typeof request.params.clientInfo.version !== "string") {
      return errorResponse(id, -32602, "Invalid params: initialize requires protocolVersion, capabilities, and clientInfo{name,version}");
    }
    return resultResponse(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: MCP_SERVER_INFO,
      instructions: "Use list tools before editing. Mutations save atomically unless dryRun is true; keep the returned patch to undo with rpgkit_project_save direction=reverse.",
    });
  }
  if (request.method === "ping") return resultResponse(id, {});
  if (request.method === "tools/list") {
    if (request.params !== undefined && !isRecord(request.params)) return errorResponse(id, -32602, "Invalid params: tools/list params must be an object");
    return resultResponse(id, { tools: EDIT_TOOLS.map(publicTool) });
  }
  if (request.method === "tools/call") {
    const parsed = parseToolRequest(request.params, root);
    if ("error" in parsed) return errorResponse(id, -32602, `Invalid params: ${parsed.error}`, parsed.details);
    try {
      const response = runFileEdit(parsed.request);
      const text = JSON.stringify(response);
      return resultResponse(id, {
        content: [{ type: "text", text }],
        structuredContent: response,
        isError: !response.ok,
      });
    } catch (error) {
      return errorResponse(id, -32603, "Internal error", error instanceof Error ? error.message : String(error));
    }
  }
  return errorResponse(id, -32601, `Method not found: ${request.method}`);
}

export function dispatchMcpLine(line: string, root = process.cwd()): JsonRpcResponse | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    return errorResponse(null, -32700, "Parse error", error instanceof Error ? error.message : String(error));
  }
  return dispatchMcpMessage(value, root);
}

async function writeResponse(response: JsonRpcResponse): Promise<boolean> {
  try {
    if (!process.stdout.write(`${JSON.stringify(response)}\n`)) await once(process.stdout, "drain");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPIPE") return false;
    throw error;
  }
}

export async function runMcpServer(root = process.cwd()): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    const response = line.length > 4 * 1024 * 1024
      ? errorResponse(null, -32600, "Invalid Request: message exceeds 4 MiB")
      : dispatchMcpLine(line, root);
    if (response && !(await writeResponse(response))) break;
  }
}

if (import.meta.main) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(`${MCP_USAGE}\n`);
  } else {
    const argv = process.argv.slice(2);
    let root = process.cwd();
    for (let index = 0; index < argv.length; index++) {
      const argument = argv[index]!;
      if (argument === "--root") {
        const value = argv[++index];
        if (!value) throw new Error("--root requires a directory");
        root = value;
      } else if (argument.startsWith("--root=")) {
        root = argument.slice("--root=".length);
      } else {
        throw new Error(`unknown option ${argument}`);
      }
    }
    await runMcpServer(root);
  }
}
