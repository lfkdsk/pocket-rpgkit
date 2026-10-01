// Desktop-only local-agent companion for rpgkit-editor.
//
// The PocketJS guest sends small JSON control messages over SVC WIRE. This
// process owns the OS child, so the browser/QuickJS bundle never gains process
// or host-filesystem access. The child sees a proposal-only rpgkit-edit MCP
// server: its sole write capability is creating an AI3 review sidecar.

import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { loadProject } from "../../editor/engine/document.ts";
import { loadPendingProposals } from "../../editor/api/proposals.ts";
import { proposalSemanticHash } from "../../editor/proposals/model.ts";
import { createSvcWireAuthToken } from "./svc-wire-auth.ts";
import {
  LOCAL_AGENT_MAX_PROMPT,
  LOCAL_AGENT_PROTOCOL,
  parseLocalAgentGuestMessage,
  type LocalAgentGuestMessage,
  type LocalAgentHostMessage,
  type LocalAgentReady,
  type LocalAgentStart,
  type LocalAgentState,
} from "../../editor/agent/types.ts";

const WIRE_MAGIC = 0x544e4b50;
const WIRE_VERSION = 1;
const WIRE_HEADER_SIZE = 8;
const WIRE_MAX_PAYLOAD = 256 * 1024;
const WIRE_MSG_PING = 0x01;
const WIRE_MSG_PONG = 0x02;
const WIRE_MSG_CTRL = 0x10;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 800;
const PROCESS_GROUP_GRACE_MS = 1_000;

/** Host values that command-line agents need for executable lookup, user
 * configuration, locale/terminal behavior, temporary files, and TLS roots.
 * Credentials, proxies, loader hooks, and runtime injection flags are
 * intentionally absent; a custom config can opt into extra values via env. */
export const LOCAL_AGENT_ENV_ALLOWLIST = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL",
  "TMPDIR", "TMP", "TEMP",
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE",
  "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR", "TZ",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  "TRAE_HOME", "CLAUDE_CONFIG_DIR",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
] as const;

const MANAGED_AGENT_ENV = new Set([
  "RPGKIT_AGENT_PROJECT_FILE",
  "RPGKIT_AGENT_MCP_CONFIG",
  "RPGKIT_AGENT_REQUEST_ID",
]);

export type LocalAgentAdapter = "traecli" | "claude" | "custom" | "off";
export type McpRegistration = "traecli-config" | "claude-json";

export interface LocalAgentFileConfig {
  adapter?: LocalAgentAdapter;
  name?: string;
  command?: string[];
  mcpRegistration?: McpRegistration;
  workingDirectory?: string;
  timeoutMs?: number;
  promptTemplate?: string;
  env?: Record<string, string>;
}

export interface ResolvedLocalAgentConfig {
  adapter: LocalAgentAdapter;
  name: string;
  command: string[];
  mcpRegistration: McpRegistration;
  workingDirectory: string;
  timeoutMs: number;
  promptTemplate: string;
  env: Record<string, string>;
  configDirectory: string;
}

export interface LocalAgentControllerOptions {
  repoRoot: string;
  projectFile: string;
  stateDirectory: string;
  adapter?: LocalAgentAdapter;
  configFile?: string;
  onMessage(message: LocalAgentHostMessage | { t: "proposals"; proposals: unknown[] }): void;
  onProposalsChanged?(): void | Promise<void>;
}

export interface EditorAgentCompanionOptions extends Omit<LocalAgentControllerOptions, "onMessage"> {
  app: string;
}

export interface EditorAgentCompanion {
  address: string;
  /** Per-launch PKNT hello identity passed only to the desktop host. */
  authToken: string;
  controller: LocalAgentController;
  close(): Promise<void>;
}

const DEFAULT_PROMPT_TEMPLATE = `User request:
{{request}}

Current editor context:
{{contextJson}}`;

const POLICY_PROMPT = `You are the local editing agent for Pocket RPG Kit.
Work only through the rpgkit-edit MCP server provided to this process. Inspect
the project and run useful read-only rpgkit-check tools, then call
rpgkit_proposal_create exactly once. Never directly edit the project, never
write other files, and do not merely describe a change. The editor will show
your proposal to the user for review. The target project is {{projectFile}}.

`;

const BUILTIN_COMMANDS: Record<"traecli" | "claude", string[]> = {
  traecli: [
    "traecli", "exec", "--ephemeral", "--sandbox", "read-only",
    "--ask-for-approval", "never", "--ignore-user-config", "--ignore-rules",
    "-c", "{{mcpRegistration}}", "-",
  ],
  claude: [
    "claude", "-p", "--output-format", "text", "--permission-mode", "dontAsk",
    "--no-session-persistence", "--disable-slash-commands", "--strict-mcp-config",
    "--mcp-config", "{{mcpConfig}}", "--tools", "", "--allowedTools",
    "mcp__rpgkit-edit__*",
  ],
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  return value;
}

function parseFileConfig(value: unknown): LocalAgentFileConfig {
  const raw = object(value, "agent config");
  const allowed = new Set(["adapter", "name", "command", "mcpRegistration", "workingDirectory", "timeoutMs", "promptTemplate", "env"]);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`agent config has unknown field(s): ${unknown.join(", ")}`);
  const adapter = raw.adapter ?? "traecli";
  if (!["traecli", "claude", "custom", "off"].includes(String(adapter))) {
    throw new Error("agent config adapter must be traecli, claude, custom, or off");
  }
  const registration = raw.mcpRegistration;
  if (registration !== undefined && registration !== "traecli-config" && registration !== "claude-json") {
    throw new Error("agent config mcpRegistration must be traecli-config or claude-json");
  }
  const timeoutMs = raw.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || Number(timeoutMs) < 20 || Number(timeoutMs) > 30 * 60_000) {
    throw new Error("agent config timeoutMs must be an integer from 20 to 1800000");
  }
  let env: Record<string, string> | undefined;
  if (raw.env !== undefined) {
    const entries = object(raw.env, "agent config env");
    if (Object.values(entries).some((item) => typeof item !== "string")) {
      throw new Error("agent config env values must be strings");
    }
    const invalid = Object.keys(entries).find((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
    if (invalid !== undefined) throw new Error(`agent config env has invalid variable name: ${invalid}`);
    const managed = Object.keys(entries).find((key) => MANAGED_AGENT_ENV.has(key.toUpperCase()));
    if (managed !== undefined) throw new Error(`agent config env cannot override launcher-owned variable: ${managed}`);
    env = entries as Record<string, string>;
  }
  for (const [key, value] of Object.entries({ name: raw.name, workingDirectory: raw.workingDirectory, promptTemplate: raw.promptTemplate })) {
    if (value !== undefined && typeof value !== "string") throw new Error(`agent config ${key} must be a string`);
  }
  return {
    adapter: adapter as LocalAgentAdapter,
    ...(raw.name === undefined ? {} : { name: raw.name as string }),
    ...(raw.command === undefined ? {} : { command: strings(raw.command, "agent config command") }),
    ...(registration === undefined ? {} : { mcpRegistration: registration }),
    ...(raw.workingDirectory === undefined ? {} : { workingDirectory: raw.workingDirectory as string }),
    timeoutMs: Number(timeoutMs),
    ...(raw.promptTemplate === undefined ? {} : { promptTemplate: raw.promptTemplate as string }),
    ...(env === undefined ? {} : { env }),
  };
}

export function loadLocalAgentConfig(
  repoRoot: string,
  projectFile: string,
  options: { adapter?: LocalAgentAdapter; configFile?: string } = {},
): ResolvedLocalAgentConfig {
  const configPath = options.configFile ? resolve(options.configFile) : null;
  const fromFile = configPath ? parseFileConfig(JSON.parse(readFileSync(configPath, "utf8"))) : {};
  const adapter = options.adapter ?? fromFile.adapter ?? "traecli";
  const configDirectory = configPath ? dirname(configPath) : repoRoot;
  const command = fromFile.command ?? (adapter === "traecli" || adapter === "claude" ? BUILTIN_COMMANDS[adapter] : []);
  if (adapter === "custom" && command.length === 0) throw new Error("custom agent config requires command");
  const mcpRegistration = fromFile.mcpRegistration ?? (adapter === "traecli" ? "traecli-config" : "claude-json");
  const rawWorkingDirectory = fromFile.workingDirectory ?? "{{projectDir}}";
  const projectDir = dirname(realpathSync(resolve(projectFile)));
  const workingValue = rawWorkingDirectory.replaceAll("{{projectDir}}", projectDir).replaceAll("{{repoRoot}}", repoRoot);
  const workingDirectory = isAbsolute(workingValue) ? resolve(workingValue) : resolve(configDirectory, workingValue);
  if (!existsSync(workingDirectory)) throw new Error(`agent working directory does not exist: ${workingDirectory}`);
  return {
    adapter,
    name: fromFile.name ?? adapter,
    command,
    mcpRegistration,
    workingDirectory,
    timeoutMs: fromFile.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    promptTemplate: fromFile.promptTemplate ?? DEFAULT_PROMPT_TEMPLATE,
    env: fromFile.env ?? {},
    configDirectory,
  };
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function executable(command: string, cwd: string): string | null {
  const candidate = command.includes("/") || command.includes("\\")
    ? (isAbsolute(command) ? command : resolve(cwd, command))
    : Bun.which(command);
  if (!candidate) return null;
  try {
    accessSync(candidate, constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

function replaceTemplate(template: string, values: Record<string, string>, label: string): string {
  const output = template.replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g, (whole, key: string) => values[key] ?? whole);
  const unknown = [...output.matchAll(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g)].map((match) => match[1]);
  if (unknown.length > 0) throw new Error(`${label} has unknown placeholder(s): ${[...new Set(unknown)].join(", ")}`);
  return output;
}

function compactOutput(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_OUTPUT_CHARS);
}

function inheritedAgentEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of LOCAL_AGENT_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function processGroupExists(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function signalAgentGroup(child: AgentChild, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    try {
      child.kill(signal);
    } catch {
      // The child raced with cleanup.
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    try {
      child.kill(signal);
    } catch {
      // The child raced with cleanup.
    }
  }
}

/** Stop every process still in the detached agent group. Waiting here makes
 * cancelled/timed-out terminal states, and close(), process-tree barriers. */
async function stopAgentGroup(child: AgentChild): Promise<void> {
  if (process.platform === "win32") {
    signalAgentGroup(child, "SIGTERM");
    await Promise.race([child.exited, Bun.sleep(PROCESS_GROUP_GRACE_MS)]);
    signalAgentGroup(child, "SIGKILL");
    return;
  }
  if (!processGroupExists(child.pid)) return;
  signalAgentGroup(child, "SIGTERM");
  const deadline = Date.now() + PROCESS_GROUP_GRACE_MS;
  while (processGroupExists(child.pid) && Date.now() < deadline) await Bun.sleep(10);
  if (processGroupExists(child.pid)) signalAgentGroup(child, "SIGKILL");
}

function state(id: string, status: LocalAgentState["status"], message: string, proposalIds?: string[]): LocalAgentState {
  return {
    t: "agent-state",
    protocol: LOCAL_AGENT_PROTOCOL,
    id,
    status,
    message,
    ...(proposalIds === undefined ? {} : { proposalIds }),
  };
}

type AgentChild = Bun.Subprocess<"pipe", "pipe", "pipe">;

interface ActiveRun {
  request: LocalAgentStart;
  child: AgentChild;
  stdout: Promise<string>;
  stderr: Promise<string>;
  timeout: ReturnType<typeof setTimeout>;
  cleanup: Promise<void> | null;
  stopReason: "cancelled" | "timed-out" | null;
  beforeIds: Set<string>;
  promptFile: string;
  done: Promise<void>;
}

export class LocalAgentController {
  readonly config: ResolvedLocalAgentConfig | null;
  readonly ready: LocalAgentReady;
  private readonly options: LocalAgentControllerOptions;
  private readonly mcpConfigFile: string | null;
  private readonly mcpRegistration: string | null;
  private active: ActiveRun | null = null;

  constructor(options: LocalAgentControllerOptions) {
    this.options = options;
    let config: ResolvedLocalAgentConfig | null = null;
    let ready: LocalAgentReady;
    let mcpConfigFile: string | null = null;
    let mcpRegistration: string | null = null;
    try {
      config = loadLocalAgentConfig(options.repoRoot, options.projectFile, options);
      if (config.adapter === "off") {
        ready = this.readyMessage(false, "off", "Local agent is disabled; pass --agent traecli or --agent claude.");
      } else {
        const projectDir = dirname(realpathSync(resolve(options.projectFile)));
        const server = join(options.repoRoot, "tools", "rpgkit-edit", "mcp.ts");
        const mcp = {
          mcpServers: {
            "rpgkit-edit": {
              command: process.execPath,
              args: [server, "--root", projectDir, "--proposal-only"],
            },
          },
        };
        mcpConfigFile = join(options.stateDirectory, "mcp.json");
        atomicWrite(mcpConfigFile, `${JSON.stringify(mcp, null, 2)}\n`);
        mcpRegistration = `mcp_servers.rpgkit-edit={ command = ${tomlString(process.execPath)}, args = [` +
          mcp.mcpServers["rpgkit-edit"].args.map(tomlString).join(", ") + "] }";
        const values = this.templateValues(config, "", mcpConfigFile, mcpRegistration, "");
        const command = config.command.map((part) => replaceTemplate(part, values, "agent command"));
        const found = command.length > 0 ? executable(command[0]!, config.workingDirectory) : null;
        ready = found
          ? this.readyMessage(true, config.name, `${config.name} ready`)
          : this.readyMessage(false, config.name, `${command[0] || config.name} is not installed or executable`);
      }
    } catch (error) {
      ready = this.readyMessage(false, options.adapter ?? "configured agent", error instanceof Error ? error.message : String(error));
    }
    this.config = config;
    this.ready = ready;
    this.mcpConfigFile = mcpConfigFile;
    this.mcpRegistration = mcpRegistration;
  }

  get activeRequestId(): string | null {
    return this.active?.request.id ?? null;
  }

  private readyMessage(available: boolean, adapter: string, message: string): LocalAgentReady {
    return { t: "agent-ready", protocol: LOCAL_AGENT_PROTOCOL, available, adapter, message, maxPromptChars: LOCAL_AGENT_MAX_PROMPT };
  }

  private emit(message: LocalAgentHostMessage | { t: "proposals"; proposals: unknown[] }): void {
    this.options.onMessage(message);
  }

  private templateValues(
    config: ResolvedLocalAgentConfig,
    prompt: string,
    mcpConfig: string,
    mcpRegistration: string,
    promptFile: string,
  ): Record<string, string> {
    const projectFile = realpathSync(resolve(this.options.projectFile));
    return {
      prompt,
      promptFile,
      mcpConfig,
      mcpRegistration,
      projectFile,
      projectDir: dirname(projectFile),
      repoRoot: this.options.repoRoot,
      request: "",
      contextJson: "",
    };
  }

  /** Malformed/foreign SVC messages are ignored; valid task messages always
   * receive a state transition, including unavailable and busy failures. */
  handle(value: unknown): void {
    const message = parseLocalAgentGuestMessage(value);
    if (!message) return;
    if (message.t === "agent-cancel") {
      this.cancel(message.id);
      return;
    }
    void this.start(message);
  }

  private async start(request: LocalAgentStart): Promise<void> {
    if (this.active) {
      this.emit(state(request.id, "failed", `Another local-agent request is already running (${this.active.request.id.slice(0, 8)}).`));
      return;
    }
    if (!this.config || !this.ready.available || !this.mcpConfigFile || !this.mcpRegistration) {
      this.emit(state(request.id, "failed", this.ready.message));
      return;
    }
    let source: string;
    try {
      source = readFileSync(this.options.projectFile, "utf8");
      const loaded = loadProject(source);
      if (loaded.errors.length > 0) throw new Error(`project is invalid: ${loaded.errors[0]!.path} ${loaded.errors[0]!.msg}`);
      const currentHash = proposalSemanticHash(loaded.project);
      if (currentHash !== request.projectHash) {
        throw new Error("The editor has unsaved or stale content; save or reload before asking the agent.");
      }
    } catch (error) {
      this.emit(state(request.id, "failed", error instanceof Error ? error.message : String(error)));
      return;
    }

    const contextJson = JSON.stringify(request.context, null, 2);
    const projectFile = realpathSync(resolve(this.options.projectFile));
    const promptBody = replaceTemplate(this.config.promptTemplate, {
      request: request.request,
      contextJson,
      projectFile,
      projectDir: dirname(projectFile),
      repoRoot: this.options.repoRoot,
    }, "promptTemplate");
    const prompt = replaceTemplate(POLICY_PROMPT, { projectFile }, "policy prompt") + promptBody;
    mkdirSync(this.options.stateDirectory, { recursive: true });
    const promptFile = join(this.options.stateDirectory, `prompt-${request.id}.txt`);
    atomicWrite(promptFile, prompt);
    const values = {
      ...this.templateValues(this.config, prompt, this.mcpConfigFile, this.mcpRegistration, promptFile),
      request: request.request,
      contextJson,
    };
    let beforeIds: Set<string>;
    let command: string[];
    let cwd: string;
    let env: Record<string, string>;
    try {
      command = this.config.command.map((part) => replaceTemplate(part, values, "agent command"));
      cwd = replaceTemplate(this.config.workingDirectory, values, "workingDirectory");
      env = Object.fromEntries(Object.entries(this.config.env).map(([key, value]) => [key, replaceTemplate(value, values, `env.${key}`)]));
      beforeIds = new Set(loadPendingProposals(this.options.projectFile).map((proposal) => proposal.id));
    } catch (error) {
      rmSync(promptFile, { force: true });
      this.emit(state(request.id, "failed", error instanceof Error ? error.message : String(error)));
      return;
    }

    let child: AgentChild;
    try {
      child = Bun.spawn({
        cmd: command,
        cwd,
        env: {
          ...inheritedAgentEnvironment(),
          ...env,
          RPGKIT_AGENT_PROJECT_FILE: projectFile,
          RPGKIT_AGENT_MCP_CONFIG: this.mcpConfigFile,
          RPGKIT_AGENT_REQUEST_ID: request.id,
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      });
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (error) {
      rmSync(promptFile, { force: true });
      this.emit(state(request.id, "failed", `Could not start ${this.config.name}: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }

    let finish!: () => void;
    const done = new Promise<void>((resolveDone) => { finish = resolveDone; });
    const run: ActiveRun = {
      request,
      child,
      stdout: new Response(child.stdout).text(),
      stderr: new Response(child.stderr).text(),
      timeout: setTimeout(() => this.terminate(request.id, "timed-out"), this.config.timeoutMs),
      cleanup: null,
      stopReason: null,
      beforeIds,
      promptFile,
      done,
    };
    this.active = run;
    this.emit(state(request.id, "starting", `Starting ${this.config.name}…`));
    this.emit(state(request.id, "running", `${this.config.name} is preparing a proposal…`));
    void this.finish(run).finally(finish);
  }

  private terminate(id: string, reason: "cancelled" | "timed-out"): void {
    const run = this.active;
    if (!run || run.request.id !== id || run.stopReason) return;
    run.stopReason = reason;
    if (reason === "cancelled") this.emit(state(id, "cancelling", "Cancelling local agent…"));
    run.cleanup = stopAgentGroup(run.child);
  }

  cancel(id: string): void {
    if (!this.active || this.active.request.id !== id) {
      this.emit(state(id, "failed", "No matching local-agent request is running."));
      return;
    }
    this.terminate(id, "cancelled");
  }

  private async finish(run: ActiveRun): Promise<void> {
    const exitCode = await run.child.exited;
    run.cleanup ??= stopAgentGroup(run.child);
    await run.cleanup;
    const [stdout, stderr] = await Promise.all([run.stdout, run.stderr]);
    clearTimeout(run.timeout);
    rmSync(run.promptFile, { force: true });
    if (this.active !== run) return;
    this.active = null;
    if (run.stopReason) {
      this.emit(state(
        run.request.id,
        run.stopReason,
        run.stopReason === "cancelled" ? "Local agent cancelled." : `Local agent timed out after ${this.config!.timeoutMs} ms.`,
      ));
      return;
    }
    if (exitCode !== 0) {
      const detail = compactOutput(stderr) || compactOutput(stdout) || `exit ${exitCode}`;
      this.emit(state(run.request.id, "failed", `${this.config!.name} failed: ${detail}`));
      return;
    }
    try {
      await this.options.onProposalsChanged?.();
      const proposals = loadPendingProposals(this.options.projectFile);
      const proposalIds = proposals.filter((proposal) => !run.beforeIds.has(proposal.id)).map((proposal) => proposal.id);
      if (proposalIds.length === 0) {
        this.emit(state(run.request.id, "failed", `${this.config!.name} finished without creating a proposal.`));
        return;
      }
      this.emit({ t: "proposals", proposals });
      this.emit(state(run.request.id, "completed", `Created ${proposalIds.length} proposal(s).`, proposalIds));
    } catch (error) {
      this.emit(state(run.request.id, "failed", `Could not load the agent proposal: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  async close(): Promise<void> {
    const run = this.active;
    if (run) {
      this.terminate(run.request.id, "cancelled");
      await run.done;
    }
  }
}

interface WirePeer {
  socket: Socket;
  buffer: Buffer;
  handshaken: boolean;
}

function frame(kind: number, payload: Uint8Array): Buffer {
  if (payload.byteLength > WIRE_MAX_PAYLOAD) throw new Error("SVC WIRE payload exceeds 256 KiB");
  const output = Buffer.alloc(WIRE_HEADER_SIZE + payload.byteLength);
  output[0] = kind;
  output.writeUInt32LE(payload.byteLength, 4);
  Buffer.from(payload).copy(output, WIRE_HEADER_SIZE);
  return output;
}

function ctrl(value: unknown): Buffer {
  return frame(WIRE_MSG_CTRL, new TextEncoder().encode(JSON.stringify(value)));
}

/** Start the loopback SVC WIRE endpoint before launching PocketJS, then pass
 * `--svc-connect companion.address` to the desktop host. */
export async function startEditorAgentCompanion(options: EditorAgentCompanionOptions): Promise<EditorAgentCompanion> {
  const peers = new Set<WirePeer>();
  let live: WirePeer | null = null;
  const authToken = createSvcWireAuthToken();
  const broadcast = (message: LocalAgentHostMessage | { t: "proposals"; proposals: unknown[] }): void => {
    if (live?.handshaken && !live.socket.destroyed) live.socket.write(ctrl(message));
  };
  const controller = new LocalAgentController({ ...options, onMessage: broadcast });
  const server: Server = createServer((socket) => {
    const peer: WirePeer = { socket, buffer: Buffer.alloc(0), handshaken: false };
    peers.add(peer);
    socket.on("close", () => {
      peers.delete(peer);
      if (live === peer) live = null;
    });
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk) => {
      peer.buffer = Buffer.concat([peer.buffer, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      if (!peer.handshaken) {
        if (peer.buffer.length < 7) return;
        const appLength = peer.buffer[6]!;
        const helloLength = 7 + appLength;
        if (peer.buffer.length < helloLength) return;
        const magic = peer.buffer.readUInt32LE(0);
        const version = peer.buffer[4];
        const app = peer.buffer.subarray(7, helloLength).toString("utf8");
        if (magic !== WIRE_MAGIC || version !== WIRE_VERSION || app !== authToken) {
          socket.destroy();
          return;
        }
        peer.buffer = peer.buffer.subarray(helloLength);
        peer.handshaken = true;
        if (live && live !== peer) live.socket.destroy();
        live = peer;
        const ack = Buffer.alloc(8);
        ack.writeUInt32LE(WIRE_MAGIC, 0);
        ack[4] = WIRE_VERSION;
        socket.write(ack);
        socket.write(ctrl(controller.ready));
      }
      while (peer.handshaken && peer.buffer.length >= WIRE_HEADER_SIZE) {
        const kind = peer.buffer[0]!;
        const length = peer.buffer.readUInt32LE(4);
        if (length > WIRE_MAX_PAYLOAD) {
          socket.destroy();
          return;
        }
        if (peer.buffer.length < WIRE_HEADER_SIZE + length) return;
        const payload = peer.buffer.subarray(WIRE_HEADER_SIZE, WIRE_HEADER_SIZE + length);
        peer.buffer = peer.buffer.subarray(WIRE_HEADER_SIZE + length);
        if (kind === WIRE_MSG_PING) socket.write(frame(WIRE_MSG_PONG, payload));
        else if (kind === WIRE_MSG_CTRL) {
          try {
            controller.handle(JSON.parse(payload.toString("utf8")) as LocalAgentGuestMessage);
          } catch {
            // Malformed guest control data is ignored without killing input.
          }
        }
      }
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    const fail = (error: Error) => reject(error);
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", fail);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("local-agent companion failed to bind loopback TCP");
  return {
    address: `127.0.0.1:${address.port}`,
    authToken,
    controller,
    async close() {
      await controller.close();
      for (const peer of peers) peer.socket.destroy();
      if (server.listening) await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}
