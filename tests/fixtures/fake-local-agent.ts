#!/usr/bin/env bun
// Offline test agent: consumes the real prompt, starts the configured MCP
// stdio server, verifies its proposal-only surface, and creates one proposal.

import { readFileSync, writeFileSync } from "node:fs";

const prompt = await Bun.stdin.text();
if (!prompt.includes("Work only through the rpgkit-edit MCP server") ||
    !prompt.includes("Current editor context:") ||
    !prompt.includes("Brighten the selected tile")) {
  process.stderr.write("fake agent received an incomplete prompt\n");
  process.exit(4);
}

const mode = process.env.FAKE_AGENT_MODE ?? "success";
if (mode === "hang") await new Promise<never>(() => {});
if (mode === "env-probe") {
  const report = process.env.FAKE_AGENT_ENV_REPORT;
  if (!report) throw new Error("fake agent env report path is missing");
  writeFileSync(report, `${JSON.stringify(process.env, null, 2)}\n`);
  process.exit(7);
}
if (mode === "tree") {
  const pidFile = process.env.FAKE_AGENT_CHILD_PID_FILE;
  const termFile = process.env.FAKE_AGENT_CHILD_TERM_FILE;
  if (!pidFile || !termFile) throw new Error("fake agent process-tree paths are missing");
  const grandchild = Bun.spawn({
    cmd: [process.execPath, "-e", `
      import { writeFileSync } from "node:fs";
      writeFileSync(process.env.FAKE_AGENT_CHILD_PID_FILE, String(process.pid));
      process.on("SIGTERM", () => writeFileSync(process.env.FAKE_AGENT_CHILD_TERM_FILE, "SIGTERM\\n"));
      await new Promise(() => {});
    `],
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await grandchild.exited;
  process.exit(8);
}
if (mode === "fail") {
  process.stderr.write("fake agent requested failure\n");
  process.exit(7);
}

const configPath = process.env.RPGKIT_AGENT_MCP_CONFIG;
const projectFile = process.env.RPGKIT_AGENT_PROJECT_FILE;
const requestId = process.env.RPGKIT_AGENT_REQUEST_ID;
if (!configPath || !projectFile || !requestId) throw new Error("fake agent environment is incomplete");
const config = JSON.parse(readFileSync(configPath, "utf8")) as {
  mcpServers: Record<string, { command: string; args: string[] }>;
};
const server = config.mcpServers["rpgkit-edit"];
if (!server) throw new Error("fake agent did not receive rpgkit-edit MCP registration");

const project = JSON.parse(readFileSync(projectFile, "utf8")) as {
  maps: { id: string; width: number; ground: (string | null)[]; sheets?: string[] }[];
};
const marker = "Current editor context:\n";
const context = JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length)) as {
  map: { id: string };
  selectedCell: { mapId: string; x: number; y: number } | null;
};
const map = project.maps.find((candidate) => candidate.id === context.map.id) ?? project.maps[0]!;
const selected = context.selectedCell?.mapId === map.id ? context.selectedCell : { x: 0, y: 0 };
const current = map.ground[selected.y * map.width + selected.x];
const sheet = map.sheets?.[0] ?? (typeof current === "string" ? current.split(".")[0] : "town");
const tile = current === `${sheet}.1` ? `${sheet}.0` : `${sheet}.1`;

const child = Bun.spawn({
  cmd: [server.command, ...server.args],
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});
const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-local-agent", version: "1" } },
};
const proposal = {
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: {
    name: "rpgkit_proposal_create",
    arguments: {
      file: projectFile,
      id: `fake-${requestId.slice(0, 16)}`,
      title: "Brighten selected tile",
      rationale: "Exercise the natural-language proposal path without a network agent.",
      author: "fake-local-agent",
      createdAt: "2026-10-01T12:00:00.000Z",
      hunks: [{
        id: "selected-tile",
        summary: "Brighten the selected tile",
        operations: [{ command: "paint-tile", args: { map: map.id, x: selected.x, y: selected.y, tile } }],
      }],
    },
  },
};
child.stdin.write([
  JSON.stringify(initialize),
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  JSON.stringify(proposal),
  "",
].join("\n"));
child.stdin.end();
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
  child.exited,
]);
if (exitCode !== 0) throw new Error(`MCP server failed (${exitCode}): ${stderr}`);
const responses = stdout.trim().split("\n").map((line) => JSON.parse(line));
const tools = responses.find((response) => response.id === 2)?.result?.tools as { name: string }[] | undefined;
if (!tools || !tools.some((tool) => tool.name === "rpgkit_proposal_create") ||
    tools.some((tool) => tool.name === "rpgkit_tile_paint" || tool.name === "rpgkit_project_save" || tool.name === "rpgkit-shot")) {
  throw new Error("fake agent MCP was not proposal-only");
}
const result = responses.find((response) => response.id === 3)?.result;
if (!result || result.isError || result.structuredContent?.written !== true) {
  throw new Error(`fake agent proposal failed: ${JSON.stringify(result)}`);
}
process.stdout.write("fake agent created a proposal through MCP\n");
