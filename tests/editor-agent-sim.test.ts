// End-to-end natural-language editor flow. A fake offline agent consumes the
// prompt, calls the real proposal-only MCP server, and returns the resulting
// proposal through the same SVC messages used by the desktop companion.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createSimFsHost } from "../vendor/pocketjs/hosts/sim/fs.ts";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import type { Project } from "../src/engine/types.ts";
import {
  createProposalPanelLayout,
  proposalActionRects,
} from "../editor/engine/proposal-layout.ts";
import {
  HEADER_H,
  STATUS_H,
  TILE,
  fittedView,
  headerButtons,
  mapOffset,
} from "../editor/engine/layout.ts";
import { BUNDLED_PROJECTS } from "../editor/engine/projects.ts";
import { LOCAL_AGENT_PROTOCOL } from "../editor/agent/types.ts";
import {
  LocalAgentController,
  type LocalAgentFileConfig,
} from "../tools/lib/editor-agent-companion.ts";
import { appPreflight, fnv1a } from "./helpers/boot.ts";
import {
  bootEditorWorld,
  installEditorSimIsolation,
  type BoundEditorWorld,
} from "./helpers/editor-session.ts";

const preflight = appPreflight("editor");
if (!preflight.ok) console.warn(`editor agent sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

installEditorSimIsolation();

const ROOT = resolve(import.meta.dir, "..");
const TEMP = join(import.meta.dir, `.editor-agent-sim-${process.pid}`);
const SOURCE = join(ROOT, "examples", "sunstone", "data", "sunstone.json");
const FAKE = join(import.meta.dir, "fixtures", "fake-local-agent.ts");
const W = 480;
const H = 272;
const PROJECT = JSON.parse(BUNDLED_PROJECTS.find((document) => document.id === "sunstone")!.json) as Project;

function agentLayout() {
  return createProposalPanelLayout(H - HEADER_H - STATUS_H, "compose").agent!;
}

beforeAll(() => mkdirSync(TEMP, { recursive: true }));
afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

function frame(world: BoundEditorWorld): void {
  world.frame(0);
  world.tick();
}

function send(inbox: string[], world: BoundEditorWorld, value: object): void {
  inbox.push(JSON.stringify(value));
  frame(world);
}

function click(inbox: string[], world: BoundEditorWorld, x: number, y: number): void {
  send(inbox, world, { t: "mouse", x, y, d: true });
  send(inbox, world, { t: "mouse", x, y, d: false });
}

async function pumpUntil(world: BoundEditorWorld, predicate: () => boolean, timeoutMs = 7_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for editor local-agent state");
    await Bun.sleep(10);
    frame(world);
  }
}

function rgbPixels(
  framebuffer: Uint8Array,
  rect: { x: number; y: number; w: number; h: number },
  rgb: readonly [number, number, number],
): number {
  let count = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const offset = (y * W + x) * 4;
      if (framebuffer[offset] === rgb[0] && framebuffer[offset + 1] === rgb[1] && framebuffer[offset + 2] === rgb[2]) count++;
    }
  }
  return count;
}

simDescribe("editor local-agent UI", () => {
  test("sends selected context, opens the fake MCP proposal, accepts one hunk, and undoes it", async () => {
    const directory = join(TEMP, randomUUID());
    mkdirSync(directory, { recursive: true });
    const projectFile = join(directory, "sunstone.json");
    copyFileSync(SOURCE, projectFile);
    const configFile = join(directory, "agent.json");
    const config: LocalAgentFileConfig = {
      adapter: "custom",
      name: "offline fake",
      command: [process.execPath, FAKE],
      mcpRegistration: "claude-json",
      workingDirectory: "{{projectDir}}",
      timeoutMs: 5_000,
      env: { FAKE_AGENT_MODE: "success" },
    };
    writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);

    const inbox: string[] = [];
    const guestMessages: any[] = [];
    const controller = new LocalAgentController({
      repoRoot: ROOT,
      projectFile,
      stateDirectory: join(directory, "state"),
      configFile,
      onMessage: (message) => inbox.push(JSON.stringify(message)),
    });
    const fs = createSimFsHost();
    const world = await bootEditorWorld(
      60,
      { fs: fs.ns },
      (ops) => {
        ops.svcOpen = () => true;
        ops.svcPoll = () => (inbox.length ? inbox.splice(0).join("\n") : null);
        ops.svcSend = (line: string) => {
          const message = JSON.parse(line);
          guestMessages.push(message);
          controller.handle(message);
        };
      },
      { width: W, height: H },
    );

    try {
      send(inbox, world, { t: "load", text: readFileSync(projectFile, "utf8") });
      send(inbox, world, controller.ready);
      expect(world.probes().state().agentReady).toMatchObject({ available: true, adapter: "offline fake" });

      // Cycle GROUND -> UPPER -> PASS -> EVENTS, then explicitly select the
      // elder's cell/event. This selection is independent from playtest start.
      const layer = headerButtons(W).find((button) => button.id === "layer")!;
      for (let index = 0; index < 3; index++) click(inbox, world, layer.x + 2, layer.y + 2);
      const map = PROJECT.maps[0]!;
      const elder = map.events!.find((event) => event.id === "elder")!;
      const fit = fittedView(W, H, false);
      const cellX = fit.frame.x + (mapOffset(map.width, fit.cols) + elder.x) * TILE + 4;
      const cellY = fit.frame.y + (mapOffset(map.height, fit.rows) + elder.y) * TILE + 4;
      click(inbox, world, cellX, cellY);
      expect(world.probes().state()).toMatchObject({
        selectedCell: { mapId: map.id, x: elder.x, y: elder.y },
        editor: { selectedEventId: "elder", selectedPageIndex: 0, dirty: false },
      });

      const proposals = headerButtons(W).find((button) => button.id === "proposals")!;
      click(inbox, world, proposals.x + 2, proposals.y + 2);
      const compose = agentLayout();
      click(inbox, world, compose.input.x + 2, HEADER_H + compose.input.y + 2);
      send(inbox, world, { t: "paste", text: "Brighten the selected tile" });

      const composeFrame = world.render().slice();
      expect(JSON.stringify(world.getTree())).toContain("editor-agent-input");
      expect(rgbPixels(composeFrame, {
        x: compose.input.x,
        y: HEADER_H + compose.input.y,
        w: compose.input.w,
        h: compose.input.h,
      }, [255, 210, 74])).toBeGreaterThan(100);
      const composeHash = fnv1a(composeFrame);
      const goldenUrl = new URL("./goldens/editor-agent-box.480x272.png", import.meta.url);
      if (process.env.EDITOR_AGENT_UPDATE_GOLDEN) {
        await Bun.write(goldenUrl, encodePNG(composeFrame, W, H));
        console.log(`editor agent box golden 480x272: ${composeHash}`);
      }
      if (!process.env.EDITOR_AGENT_UPDATE_GOLDEN) expect(composeHash).toBe("09a3827d");
      if (!process.env.EDITOR_AGENT_UPDATE_GOLDEN) {
        const decoded = decodePng(new Uint8Array(await Bun.file(goldenUrl).arrayBuffer()));
        expect({ width: decoded.width, height: decoded.height }).toEqual({ width: W, height: H });
        expect(decoded.rgba).toEqual(composeFrame);
      }

      const beforeTile = map.ground[elder.y * map.width + elder.x];
      send(inbox, world, { t: "key", k: "Enter", cmd: false, sh: false, alt: false, ctl: false });
      const start = guestMessages.find((message) => message.t === "agent-start");
      expect(start).toMatchObject({
        protocol: LOCAL_AGENT_PROTOCOL,
        request: "Brighten the selected tile",
        context: {
          map: { id: map.id, name: map.name, width: map.width, height: map.height },
          selectedCell: { mapId: map.id, x: elder.x, y: elder.y },
          selectedEvent: { id: "elder", x: elder.x, y: elder.y, w: 1, h: 1, page: 0 },
        },
      });

      await pumpUntil(world, () => world.probes().state().agentState?.status === "completed");
      const completed = world.probes().state();
      expect(completed).toMatchObject({ proposalOpen: true, selectedProposal: 0, agentInput: "" });
      expect(completed.proposalPreview.tiles).toEqual([
        expect.objectContaining({ mapId: map.id, x: elder.x, y: elder.y }),
      ]);
      expect(readFileSync(projectFile, "utf8")).toBe(readFileSync(SOURCE, "utf8"));

      const accept = proposalActionRects(H - HEADER_H - STATUS_H)
        .find((item) => item.action.kind === "accept")!.rect;
      click(inbox, world, accept.x + 4, HEADER_H + accept.y + 4);
      expect(world.probes().state().editor.project.maps[0]!.ground[elder.y * map.width + elder.x]).not.toBe(beforeTile);
      expect(world.probes().state().editor.past).toHaveLength(1);

      send(inbox, world, { t: "key", k: "z", cmd: true, sh: false, alt: false, ctl: false });
      expect(world.probes().state().editor.project.maps[0]!.ground[elder.y * map.width + elder.x]).toBe(beforeTile);
      expect(world.probes().state().editor.past).toHaveLength(0);
    } finally {
      await controller.close();
    }
  });

  test("surfaces unavailable, cancel, and timeout states without launching a network agent", async () => {
    const inbox: string[] = [];
    const outbox: any[] = [];
    const fs = createSimFsHost();
    const world = await bootEditorWorld(
      60,
      { fs: fs.ns },
      (ops) => {
        ops.svcOpen = () => true;
        ops.svcPoll = () => (inbox.length ? inbox.splice(0).join("\n") : null);
        ops.svcSend = (line: string) => outbox.push(JSON.parse(line));
      },
      { width: W, height: H },
    );
    send(inbox, world, { t: "load", text: BUNDLED_PROJECTS.find((document) => document.id === "sunstone")!.json });
    send(inbox, world, {
      t: "agent-ready",
      protocol: LOCAL_AGENT_PROTOCOL,
      available: false,
      adapter: "missing agent",
      message: "missing-agent is not installed or executable",
      maxPromptChars: 4096,
    });

    const proposals = headerButtons(W).find((button) => button.id === "proposals")!;
    click(inbox, world, proposals.x + 2, proposals.y + 2);
    send(inbox, world, { t: "paste", text: "Change the selected area" });
    const compose = agentLayout();
    click(inbox, world, compose.action.x + 2, HEADER_H + compose.action.y + 2);
    expect(outbox.filter((message) => message.t === "agent-start")).toEqual([]);
    expect(world.probes().state().notice.text).toContain("NOT INSTALLED");

    send(inbox, world, {
      t: "agent-ready",
      protocol: LOCAL_AGENT_PROTOCOL,
      available: true,
      adapter: "offline fake",
      message: "offline fake ready",
      maxPromptChars: 4096,
    });
    click(inbox, world, compose.action.x + 2, HEADER_H + compose.action.y + 2);
    const start = outbox.find((message) => message.t === "agent-start");
    expect(start).toBeDefined();
    expect(world.probes().state().agentRunning).toBe(true);

    click(inbox, world, compose.action.x + 2, HEADER_H + compose.action.y + 2);
    expect(outbox.at(-1)).toEqual({ t: "agent-cancel", protocol: LOCAL_AGENT_PROTOCOL, id: start.id });
    expect(world.probes().state().agentState.status).toBe("cancelling");
    send(inbox, world, {
      t: "agent-state",
      protocol: LOCAL_AGENT_PROTOCOL,
      id: start.id,
      status: "cancelled",
      message: "Local agent cancelled.",
    });
    expect(world.probes().state().agentRunning).toBe(false);

    click(inbox, world, compose.input.x + 2, HEADER_H + compose.input.y + 2);
    send(inbox, world, { t: "key", k: "Enter", cmd: false, sh: false, alt: false, ctl: false });
    const nextStart = outbox.filter((message) => message.t === "agent-start").at(-1);
    expect(nextStart.id).not.toBe(start.id);
    send(inbox, world, {
      t: "agent-state",
      protocol: LOCAL_AGENT_PROTOCOL,
      id: nextStart.id,
      status: "timed-out",
      message: "Local agent timed out after 20 ms.",
    });
    expect(world.probes().state()).toMatchObject({
      agentRunning: false,
      agentState: { status: "timed-out" },
      notice: { kind: "bad" },
    });
  });
});
