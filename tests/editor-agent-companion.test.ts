import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { proposalSemanticHash } from "../editor/proposals/model.ts";
import { loadPendingProposals } from "../editor/api/proposals.ts";
import {
  LOCAL_AGENT_PROTOCOL,
  type LocalAgentHostMessage,
  type LocalAgentStart,
} from "../editor/agent/types.ts";
import {
  LocalAgentController,
  loadLocalAgentConfig,
  startEditorAgentCompanion,
} from "../tools/lib/editor-agent-companion.ts";

const ROOT = resolve(import.meta.dir, "..");
const TEMP = join(import.meta.dir, `.editor-agent-${process.pid}`);
const SOURCE = join(ROOT, "examples", "sunstone", "data", "sunstone.json");
const FAKE = join(import.meta.dir, "fixtures", "fake-local-agent.ts");

beforeAll(() => mkdirSync(TEMP, { recursive: true }));
afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

function projectCopy(): string {
  const path = join(TEMP, `${randomUUID()}.json`);
  copyFileSync(SOURCE, path);
  return path;
}

function request(projectFile: string, id = "1".repeat(64)): LocalAgentStart {
  const project = JSON.parse(readFileSync(projectFile, "utf8"));
  return {
    t: "agent-start",
    protocol: LOCAL_AGENT_PROTOCOL,
    id,
    request: "Brighten the selected tile",
    projectHash: proposalSemanticHash(project),
    context: {
      map: { id: "village", name: "Bramble Hollow", width: 20, height: 13 },
      selectedCell: { mapId: "village", x: 8, y: 5 },
      selectedEvent: { id: "elder", name: "Village Elder", x: 9, y: 5, w: 1, h: 1, page: 0 },
    },
  };
}

function configFile(
  directory: string,
  mode: "success" | "hang" | "fail" | "env-probe" | "tree",
  timeoutMs = 5_000,
  extraEnv: Record<string, string> = {},
): string {
  const path = join(directory, "agent.json");
  writeFileSync(path, `${JSON.stringify({
    adapter: "custom",
    name: "offline fake",
    command: [process.execPath, FAKE],
    mcpRegistration: "claude-json",
    workingDirectory: "{{projectDir}}",
    timeoutMs,
    env: { FAKE_AGENT_MODE: mode, ...extraEnv },
  }, null, 2)}\n`);
  return path;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForFile(path: string, timeoutMs = 7_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await Bun.sleep(10);
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid)) {
    if (Date.now() >= deadline) throw new Error(`process ${pid} survived local-agent cleanup`);
    await Bun.sleep(10);
  }
}

function wireHello(app: string): Buffer {
  const name = Buffer.from(app);
  const hello = Buffer.alloc(7 + name.length);
  hello.writeUInt32LE(0x544e4b50, 0);
  hello[4] = 1;
  hello[6] = name.length;
  name.copy(hello, 7);
  return hello;
}

function openSocket(address: string): Promise<Socket> {
  const [host, portText] = address.split(":");
  return new Promise<Socket>((resolveSocket, reject) => {
    const socket = createConnection({ host, port: Number(portText) }, () => resolveSocket(socket));
    socket.once("error", reject);
  });
}

async function closesPromptly(socket: Socket): Promise<boolean> {
  return await Promise.race([
    new Promise<boolean>((resolveClose) => socket.once("close", () => resolveClose(true))),
    Bun.sleep(500).then(() => false),
  ]);
}

async function waitFor(
  messages: (LocalAgentHostMessage | { t: "proposals"; proposals: unknown[] })[],
  predicate: (message: LocalAgentHostMessage | { t: "proposals"; proposals: unknown[] }) => boolean,
  timeoutMs = 7_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!messages.some(predicate)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for local-agent message: ${JSON.stringify(messages)}`);
    await Bun.sleep(10);
  }
}

function createController(
  projectFile: string,
  configFilePath: string,
  messages: (LocalAgentHostMessage | { t: "proposals"; proposals: unknown[] })[],
  onProposalsChanged?: () => void,
): LocalAgentController {
  return new LocalAgentController({
    repoRoot: ROOT,
    projectFile,
    stateDirectory: join(TEMP, `state-${randomUUID()}`),
    configFile: configFilePath,
    onMessage: (message) => messages.push(message),
    onProposalsChanged,
  });
}

describe("editor local-agent companion", () => {
  test("builds isolated Claude and TraeCLI adapter templates without invoking either agent", () => {
    const projectFile = projectCopy();
    const trae = loadLocalAgentConfig(ROOT, projectFile, { adapter: "traecli" });
    expect(trae).toMatchObject({ adapter: "traecli", mcpRegistration: "traecli-config" });
    expect(trae.command.slice(0, 2)).toEqual(["traecli", "exec"]);
    expect(trae.command).toContain("read-only");
    expect(trae.command).toContain("{{mcpRegistration}}");

    const claude = loadLocalAgentConfig(ROOT, projectFile, { adapter: "claude" });
    expect(claude).toMatchObject({ adapter: "claude", mcpRegistration: "claude-json" });
    expect(claude.command.slice(0, 2)).toEqual(["claude", "-p"]);
    expect(claude.command).toContain("--strict-mcp-config");
    expect(claude.command).toContain("{{mcpConfig}}");
  });

  test("fake agent reads the contextual prompt and creates only a proposal through real MCP", async () => {
    const directory = join(TEMP, randomUUID());
    mkdirSync(directory, { recursive: true });
    const projectFile = projectCopy();
    const before = readFileSync(projectFile, "utf8");
    const messages: (LocalAgentHostMessage | { t: "proposals"; proposals: unknown[] })[] = [];
    let synced = 0;
    const controller = createController(projectFile, configFile(directory, "success"), messages, () => { synced++; });
    expect(controller.ready).toMatchObject({ available: true, adapter: "offline fake" });
    try {
      controller.handle(request(projectFile));
      await waitFor(messages, (message) => message.t === "agent-state" && message.status === "completed");
      expect(readFileSync(projectFile, "utf8")).toBe(before);
      expect(loadPendingProposals(projectFile).map((proposal) => proposal.id)).toEqual([`fake-${"1".repeat(16)}`]);
      expect(synced).toBe(1);
      expect(messages.map((message) => message.t)).toEqual([
        "agent-state", "agent-state", "proposals", "agent-state",
      ]);
      expect(messages.at(-1)).toMatchObject({ status: "completed", proposalIds: [`fake-${"1".repeat(16)}`] });
    } finally {
      await controller.close();
    }
  });

  test("rechecks the on-disk semantic hash immediately before launch", async () => {
    const directory = join(TEMP, randomUUID());
    mkdirSync(directory, { recursive: true });
    const projectFile = projectCopy();
    const staleRequest = request(projectFile, "8".repeat(64));
    const changed = JSON.parse(readFileSync(projectFile, "utf8")) as Record<string, unknown>;
    changed.title = `${String(changed.title)} (changed on disk)`;
    writeFileSync(projectFile, `${JSON.stringify(changed, null, 2)}\n`);
    const messages: (LocalAgentHostMessage | { t: "proposals"; proposals: unknown[] })[] = [];
    const controller = createController(projectFile, configFile(directory, "hang"), messages);
    try {
      controller.handle(staleRequest);
      await Bun.sleep(20);
      expect(messages).toEqual([
        expect.objectContaining({
          t: "agent-state",
          id: staleRequest.id,
          status: "failed",
          message: expect.stringContaining("unsaved or stale"),
        }),
      ]);
      expect(controller.activeRequestId).toBeNull();
      expect(loadPendingProposals(projectFile)).toEqual([]);
    } finally {
      await controller.close();
    }
  });

  test("passes only the documented host environment plus explicitly configured values", async () => {
    const directory = join(TEMP, randomUUID());
    mkdirSync(directory, { recursive: true });
    const report = join(directory, "environment.json");
    const secretName = `RPGKIT_UNRELATED_SECRET_${process.pid}`;
    const previousSecret = process.env[secretName];
    process.env[secretName] = "must-not-leak";
    const projectFile = projectCopy();
    const messages: (LocalAgentHostMessage | { t: "proposals"; proposals: unknown[] })[] = [];
    const controller = createController(projectFile, configFile(directory, "env-probe", 5_000, {
      FAKE_AGENT_ENV_REPORT: report,
      FAKE_AGENT_EXPLICIT_VALUE: "configured",
    }), messages);
    try {
      controller.handle(request(projectFile, "6".repeat(64)));
      await waitFor(messages, (message) => message.t === "agent-state" && message.status === "failed");
      await waitForFile(report);
      const childEnv = JSON.parse(readFileSync(report, "utf8")) as Record<string, string>;
      expect(childEnv[secretName]).toBeUndefined();
      for (const key of ["PATH", "HOME", "LANG"]) {
        if (process.env[key] !== undefined) expect(childEnv[key]).toBe(process.env[key]);
      }
      expect(childEnv).toMatchObject({
        FAKE_AGENT_ENV_REPORT: report,
        FAKE_AGENT_EXPLICIT_VALUE: "configured",
        RPGKIT_AGENT_PROJECT_FILE: projectFile,
        RPGKIT_AGENT_REQUEST_ID: "6".repeat(64),
      });
      expect(childEnv.RPGKIT_AGENT_MCP_CONFIG).toEndWith("mcp.json");
    } finally {
      if (previousSecret === undefined) delete process.env[secretName];
      else process.env[secretName] = previousSecret;
      await controller.close();
    }
  });

  test("times out and reaps an unresponsive agent", async () => {
    const directory = join(TEMP, randomUUID());
    mkdirSync(directory, { recursive: true });
    const projectFile = projectCopy();
    const messages: (LocalAgentHostMessage | { t: "proposals"; proposals: unknown[] })[] = [];
    const controller = createController(projectFile, configFile(directory, "hang", 40), messages);
    try {
      controller.handle(request(projectFile, "2".repeat(64)));
      await waitFor(messages, (message) => message.t === "agent-state" && message.status === "timed-out");
      expect(controller.activeRequestId).toBeNull();
      expect(loadPendingProposals(projectFile)).toEqual([]);
    } finally {
      await controller.close();
    }
  });

  test("cancels the active process and refuses concurrent starts", async () => {
    const directory = join(TEMP, randomUUID());
    mkdirSync(directory, { recursive: true });
    const projectFile = projectCopy();
    const messages: (LocalAgentHostMessage | { t: "proposals"; proposals: unknown[] })[] = [];
    const controller = createController(projectFile, configFile(directory, "hang"), messages);
    const first = request(projectFile, "3".repeat(64));
    const second = request(projectFile, "4".repeat(64));
    try {
      controller.handle(first);
      controller.handle(second);
      await waitFor(messages, (message) => message.t === "agent-state" && message.id === second.id && message.status === "failed");
      expect(controller.activeRequestId).toBe(first.id);
      controller.handle({ t: "agent-cancel", protocol: LOCAL_AGENT_PROTOCOL, id: first.id });
      await waitFor(messages, (message) => message.t === "agent-state" && message.id === first.id && message.status === "cancelled");
      expect(controller.activeRequestId).toBeNull();
    } finally {
      await controller.close();
    }
  });

  test.skipIf(process.platform === "win32")("cancellation reaps a TERM-resistant grandchild process", async () => {
    const directory = join(TEMP, randomUUID());
    mkdirSync(directory, { recursive: true });
    const pidFile = join(directory, "grandchild.pid");
    const termFile = join(directory, "grandchild.term");
    const projectFile = projectCopy();
    const messages: (LocalAgentHostMessage | { t: "proposals"; proposals: unknown[] })[] = [];
    const controller = createController(projectFile, configFile(directory, "tree", 5_000, {
      FAKE_AGENT_CHILD_PID_FILE: pidFile,
      FAKE_AGENT_CHILD_TERM_FILE: termFile,
    }), messages);
    let grandchildPid: number | null = null;
    try {
      const start = request(projectFile, "7".repeat(64));
      controller.handle(start);
      await waitForFile(pidFile);
      grandchildPid = Number(readFileSync(pidFile, "utf8"));
      expect(processExists(grandchildPid)).toBe(true);
      controller.handle({ t: "agent-cancel", protocol: LOCAL_AGENT_PROTOCOL, id: start.id });
      await waitFor(messages, (message) => message.t === "agent-state" && message.id === start.id && message.status === "cancelled");
      await waitForProcessExit(grandchildPid);
      expect(readFileSync(termFile, "utf8")).toBe("SIGTERM\n");
      expect(controller.activeRequestId).toBeNull();
    } finally {
      if (grandchildPid !== null && processExists(grandchildPid)) {
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch {
          // The process exited between the liveness check and cleanup.
        }
      }
      await controller.close();
    }
  });

  test("reports an unavailable configured executable before launch", async () => {
    const directory = join(TEMP, randomUUID());
    mkdirSync(directory, { recursive: true });
    const projectFile = projectCopy();
    const path = join(directory, "missing.json");
    writeFileSync(path, `${JSON.stringify({
      adapter: "custom",
      name: "missing agent",
      command: [join(directory, "definitely-not-installed")],
      mcpRegistration: "claude-json",
    })}\n`);
    const messages: (LocalAgentHostMessage | { t: "proposals"; proposals: unknown[] })[] = [];
    const controller = createController(projectFile, path, messages);
    expect(controller.ready).toMatchObject({ available: false, adapter: "missing agent" });
    controller.handle(request(projectFile, "5".repeat(64)));
    expect(messages.at(-1)).toMatchObject({ status: "failed", message: expect.stringContaining("not installed") });
    await controller.close();
  });

  test("requires a per-launch token in the PocketJS SVC WIRE handshake", async () => {
    const projectFile = projectCopy();
    const companion = await startEditorAgentCompanion({
      repoRoot: ROOT,
      projectFile,
      stateDirectory: join(TEMP, `wire-${randomUUID()}`),
      adapter: "off",
      app: "editor",
    });
    expect(companion.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rejected = await openSocket(companion.address);
    rejected.write(wireHello("editor"));
    expect(await closesPromptly(rejected)).toBe(true);

    const socket = await openSocket(companion.address);
    let received = Buffer.alloc(0);
    const ready = new Promise<any>((resolveReady, reject) => {
      socket.on("error", reject);
      socket.on("data", (chunk) => {
        received = Buffer.concat([received, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
        if (received.length < 16) return;
        expect(received.readUInt32LE(0)).toBe(0x544e4b50);
        const length = received.readUInt32LE(12);
        if (received.length >= 16 + length) resolveReady(JSON.parse(received.subarray(16, 16 + length).toString("utf8")));
      });
    });
    socket.write(wireHello(companion.authToken));
    try {
      expect(await ready).toMatchObject({ t: "agent-ready", protocol: LOCAL_AGENT_PROTOCOL, available: false });
    } finally {
      socket.destroy();
      await companion.close();
    }
  });

  test("uses a fresh SVC authentication token for every companion launch", async () => {
    const projectFile = projectCopy();
    const first = await startEditorAgentCompanion({
      repoRoot: ROOT,
      projectFile,
      stateDirectory: join(TEMP, `wire-${randomUUID()}`),
      adapter: "off",
      app: "editor",
    });
    const second = await startEditorAgentCompanion({
      repoRoot: ROOT,
      projectFile,
      stateDirectory: join(TEMP, `wire-${randomUUID()}`),
      adapter: "off",
      app: "editor",
    });
    try {
      expect(first.authToken).not.toBe(second.authToken);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });
});

