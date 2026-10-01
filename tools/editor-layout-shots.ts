// Capture the editor's responsive panels through the same wasm sim host used
// by interaction tests. The resulting PNGs are review artifacts, not mocked
// component snapshots: pointer routing and responsive viewport state are live.

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { bootWorld, type SimWorld } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { BUNDLED_PROJECTS } from "../editor/engine/projects.ts";
import {
  compactHeader,
  eventToolButtons,
  fittedView,
  headerButtons,
  HEADER_H,
  mapOffset,
  STATUS_H,
  TILE,
  type HeaderActionId,
} from "../editor/engine/layout.ts";
import { createMapInspectorLayout } from "../editor/engine/map-layout.ts";
import { proposalRowRect } from "../editor/engine/proposal-layout.ts";
import { playtestDebugRect, playtestStopRect } from "../editor/engine/playtest-layout.ts";
import { createProposalFromOperations } from "../editor/api/proposals.ts";
import { LOCAL_AGENT_PROTOCOL } from "../editor/agent/types.ts";
import type { Project } from "../src/engine/types.ts";

const ROOT = resolve(import.meta.dir, "..");
const OUT = resolve(ROOT, "findings", "ED-UI1-shots", "after");
const PROFILES = [
  [400, 240, "web-min-400x240"],
  [480, 272, "handheld-480x272"],
  [720, 480, "desktop-720x480"],
  [960, 544, "desktop-960x544"],
  [1280, 720, "web-1280x720"],
] as const;
const SUNSTONE = BUNDLED_PROJECTS.find((document) => document.id === "sunstone")!;
const MODERN_PROJECT = (() => {
  const project = JSON.parse(SUNSTONE.json) as Project;
  const elder = project.maps[0]!.events!.find((event) => event.id === "elder")!;
  elder.pages[0]!.commands = [
    {
      op: "screenTint",
      layer: "world",
      color: { r: 196, g: 176, b: 255, a: 92 },
      duration: 1.25,
      wait: true,
    },
    {
      op: "scene",
      id: "rpgkit.nameInput",
      args: { prompt: "Choose the hero name", maxLength: 12 },
      onDone: [{ op: "text", lines: ["The chosen name is ready."] }],
      onCancel: [{ op: "wait", seconds: 0.25 }],
    },
  ];
  return JSON.stringify(project);
})();
const SCENE_PREVIEW_PROJECT = (() => {
  const project = JSON.parse(SUNSTONE.json) as Project;
  project.maps[0]!.events = [
    {
      id: "responsive-scene-preview",
      name: "Responsive scene preview",
      x: 0,
      y: 0,
      pages: [{
        trigger: "autorun",
        commands: [{
          op: "scene",
          id: "demo.character.profile.name.entry.with.long.namespace",
          args: { prompt: "Choose a long display name without overflowing the handheld preview", maxLength: 24 },
        }],
      }],
    },
  ];
  return JSON.stringify(project);
})();
const PROPOSAL = createProposalFromOperations(SUNSTONE.json, {
  id: "responsive-layout-review",
  title: "Polish village welcome",
  rationale: "Make the path clearer and move the elder beside it.",
  author: "local-agent",
  createdAt: "2026-10-01T12:00:00.000Z",
  hunks: [
    {
      id: "path-tile",
      summary: "Brighten the welcome path",
      operations: [{
        command: "paint-tile",
        args: { map: "village", layer: "ground", x: 8, y: 5, tile: "town.1" },
      }],
    },
    {
      id: "move-elder",
      summary: "Move the village elder",
      operations: [{
        command: "update-event",
        args: { map: "village", event: "elder", changes: { x: 10 } },
      }],
    },
  ],
});

interface EditorGlobals {
  __rpgkitEditorState?: () => any;
  __rpgkitEditorInject?: (json: string) => { ok: boolean; errors?: unknown[] };
}

function frame(world: SimWorld): void {
  world.frame(0);
  world.tick();
}

function send(inbox: string[], world: SimWorld, value: object): void {
  inbox.push(JSON.stringify(value));
  frame(world);
}

function click(inbox: string[], world: SimWorld, x: number, y: number): void {
  send(inbox, world, { t: "mouse", x, y, d: true });
  send(inbox, world, { t: "mouse", x, y, d: false });
}

function clickHeader(inbox: string[], world: SimWorld, width: number, id: HeaderActionId): void {
  let button = headerButtons(width).find((candidate) => candidate.id === id);
  if (!button) {
    const more = headerButtons(width).find((candidate) => candidate.id === "more")!;
    click(inbox, world, more.x + Math.floor(more.w / 2), more.y + Math.floor(more.h / 2));
    button = headerButtons(width, true).find((candidate) => candidate.id === id);
  }
  if (!button) throw new Error(`header action ${id} is unavailable at ${width}px`);
  click(inbox, world, button.x + Math.floor(button.w / 2), button.y + Math.floor(button.h / 2));
}

async function capture(world: SimWorld, width: number, height: number, profile: string, name: string): Promise<void> {
  const path = resolve(OUT, profile, `${name}.png`);
  mkdirSync(resolve(OUT, profile), { recursive: true });
  await Bun.write(path, encodePNG(world.render().slice(), width, height));
  console.log(path.slice(ROOT.length + 1));
}

function injectProject(world: SimWorld, json: string): void {
  const result = (globalThis as EditorGlobals).__rpgkitEditorInject?.(json);
  if (!result?.ok) throw new Error(`editor project injection failed: ${JSON.stringify(result?.errors ?? result)}`);
  frame(world);
}

function openElderInspector(inbox: string[], world: SimWorld, width: number, height: number): void {
  clickHeader(inbox, world, width, "layer");
  clickHeader(inbox, world, width, "layer");
  clickHeader(inbox, world, width, "layer");
  const editor = (globalThis as EditorGlobals).__rpgkitEditorState?.();
  if (!editor) throw new Error("editor state probe is unavailable");
  const map = editor.editor.project.maps[editor.editor.mapIndex]!;
  const fit = fittedView(width, height, false);
  const elder = map.events.find((event: { id: string }) => event.id === "elder")!;
  const eventX = fit.frame.x + mapOffset(map.width, fit.cols) * TILE + elder.x * TILE + 8;
  const eventY = fit.frame.y + mapOffset(map.height, fit.rows) * TILE + elder.y * TILE + 8;
  click(inbox, world, eventX, eventY);
  const edit = eventToolButtons().find((button) => button.id === "edit")!;
  click(inbox, world, edit.x + Math.floor(edit.w / 2), HEADER_H + edit.y + Math.floor(edit.h / 2));
}

for (const [width, height, profile] of PROFILES) {
  const inbox: string[] = [];
  const world = await bootWorld(
    resolve(ROOT, "dist", "editor"),
    60,
    undefined,
    (ops) => {
      ops.svcOpen = () => true;
      ops.svcPoll = () => inbox.length > 0 ? inbox.splice(0).join("\n") : null;
      ops.svcSend = () => undefined;
    },
    { width, height },
  );
  for (let index = 0; index < 4; index++) frame(world);

  await capture(world, width, height, profile, "palette-header-status");
  if (compactHeader(width)) {
    const more = headerButtons(width).find((candidate) => candidate.id === "more")!;
    click(inbox, world, more.x + Math.floor(more.w / 2), more.y + Math.floor(more.h / 2));
    await capture(world, width, height, profile, "header-more-menu");
    const back = headerButtons(width, true).find((candidate) => candidate.id === "more")!;
    click(inbox, world, back.x + Math.floor(back.w / 2), back.y + Math.floor(back.h / 2));
  }

  clickHeader(inbox, world, width, "layer");
  clickHeader(inbox, world, width, "layer");
  clickHeader(inbox, world, width, "layer");
  await capture(world, width, height, profile, "event-panel");

  const editor = (globalThis as EditorGlobals).__rpgkitEditorState?.();
  if (!editor) throw new Error("editor state probe is unavailable");
  const map = editor.editor.project.maps[editor.editor.mapIndex]!;
  const fit = fittedView(width, height, false);
  const elder = map.events.find((event: { id: string }) => event.id === "elder")!;
  const eventX = fit.frame.x + mapOffset(map.width, fit.cols) * TILE + elder.x * TILE + 8;
  const eventY = fit.frame.y + mapOffset(map.height, fit.rows) * TILE + elder.y * TILE + 8;
  click(inbox, world, eventX, eventY);
  const edit = eventToolButtons().find((button) => button.id === "edit")!;
  click(inbox, world, edit.x + Math.floor(edit.w / 2), HEADER_H + edit.y + Math.floor(edit.h / 2));
  await capture(world, width, height, profile, "event-inspector");

  injectProject(world, MODERN_PROJECT);
  openElderInspector(inbox, world, width, height);
  await capture(world, width, height, profile, "event-modern-fields");
  send(inbox, world, { t: "mouse", x: width - 20, y: height - 40, d: false });
  for (let index = 0; index < 4; index++) send(inbox, world, { t: "scroll", dy: 1 });
  await capture(world, width, height, profile, "event-scene-branches");

  injectProject(world, SUNSTONE.json);

  clickHeader(inbox, world, width, "map");
  await capture(world, width, height, profile, "map-inspector");
  const mapClose = createMapInspectorLayout({
    width,
    height: height - HEADER_H - STATUS_H,
  }).close.rect;
  click(
    inbox,
    world,
    mapClose.x + Math.floor(mapClose.w / 2),
    HEADER_H + mapClose.y + Math.floor(mapClose.h / 2),
  );

  send(inbox, world, { t: "proposals", proposals: [PROPOSAL] });
  clickHeader(inbox, world, width, "proposals");
  send(inbox, world, {
    t: "agent-ready",
    protocol: LOCAL_AGENT_PROTOCOL,
    available: true,
    adapter: "responsive offline agent adapter",
    message: "Responsive offline agent is ready for measured proposal layout",
    maxPromptChars: 4096,
  });
  send(inbox, world, {
    t: "paste",
    text: "Brighten the selected village path and move the elder beside it",
  });
  await capture(world, width, height, profile, "agent-compose");
  const proposalRow = proposalRowRect(0, false, true);
  click(
    inbox,
    world,
    proposalRow.x + Math.floor(proposalRow.w / 2),
    HEADER_H + proposalRow.y + Math.floor(proposalRow.h / 2),
  );
  await capture(world, width, height, profile, "proposal-panel");

  clickHeader(inbox, world, width, "proposals");
  clickHeader(inbox, world, width, "play");
  for (let index = 0; index < 3; index++) frame(world);
  await capture(world, width, height, profile, "playtest");
  const debug = playtestDebugRect();
  click(inbox, world, debug.x + Math.floor(debug.w / 2), debug.y + Math.floor(debug.h / 2));
  frame(world);
  await capture(world, width, height, profile, "playtest-debug");

  const stop = playtestStopRect();
  click(inbox, world, stop.x + Math.floor(stop.w / 2), stop.y + Math.floor(stop.h / 2));
  injectProject(world, SCENE_PREVIEW_PROJECT);
  clickHeader(inbox, world, width, "play");
  for (let index = 0; index < 5; index++) frame(world);
  if (!JSON.stringify(world.getTree()).includes("editor-playtest-scene-placeholder")) {
    throw new Error(`scene placeholder did not open at ${width}x${height}`);
  }
  await capture(world, width, height, profile, "playtest-scene-placeholder");
}
