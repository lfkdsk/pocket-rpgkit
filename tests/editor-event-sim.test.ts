// End-to-end event-editor interaction over the real PocketJS wasm host.
// The tests deliberately drive only public pointer/key service lines: they
// prove that the visible controls, editor reducer, serializer, and runtime
// interpreter agree on the same project data.

import { describe, expect, test } from "bun:test";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { createSession, startSession, stepSession } from "../src/engine/session.ts";
import type { GameEvent, Project } from "../src/engine/types.ts";
import { BUNDLED_PROJECTS } from "../editor/engine/projects.ts";
import { commandInspectorRows } from "../editor/engine/event-fields.ts";
import {
  createEventInspectorLayout,
  type EventInspectorLayout,
  type InspectorControl,
} from "../editor/engine/event-layout.ts";
import { eventToolButtons, fittedView, HEADER_H, TILE } from "../editor/engine/layout.ts";
import { appPreflight, fnv1a } from "./helpers/boot.ts";
import {
  bootEditorWorld,
  installEditorSimIsolation,
  type BoundEditorWorld,
} from "./helpers/editor-session.ts";

const preflight = appPreflight("editor");
if (!preflight.ok) console.warn(`editor event sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

installEditorSimIsolation();

const SUNSTONE = BUNDLED_PROJECTS.find((document) => document.id === "sunstone")!;
type World = BoundEditorWorld;
let live: World | null = null;
const probes = () => live!.probes();

function frame(world: World): void {
  world.frame(0);
  world.tick();
}

async function bootSvc(
  inbox: string[],
  outbox: string[],
  width = 480,
  height = 272,
): Promise<World> {
  const world = await bootEditorWorld(
    60,
    undefined,
    (ops) => {
      ops.svcOpen = () => true;
      ops.svcPoll = () => (inbox.length ? inbox.splice(0).join("\n") : null);
      ops.svcSend = (line: string) => outbox.push(line);
    },
    { width, height },
  );
  live = world;
  for (let i = 0; i < 4; i++) frame(world);
  return world;
}

function line(inbox: string[], world: World, value: object): void {
  inbox.push(JSON.stringify(value));
  frame(world);
}

function click(inbox: string[], world: World, x: number, y: number): void {
  line(inbox, world, { t: "mouse", x, y, d: true });
  line(inbox, world, { t: "mouse", x, y, d: false });
}

function drag(inbox: string[], world: World, from: [number, number], to: [number, number]): void {
  line(inbox, world, { t: "mouse", x: from[0], y: from[1], d: true });
  line(inbox, world, { t: "mouse", x: to[0], y: to[1], d: true });
  line(inbox, world, { t: "mouse", x: to[0], y: to[1], d: false });
}

function typeText(inbox: string[], world: World, text: string): void {
  line(inbox, world, { t: "ch", s: text });
}

function key(inbox: string[], world: World, k: string, cmd = false): void {
  line(inbox, world, { t: "key", k, cmd, sh: false, alt: false, ctl: cmd });
}

function cellPoint(width: number, height: number, tx: number, ty: number): [number, number] {
  const viewport = fittedView(width, height, false);
  return [viewport.frame.x + tx * TILE + 8, viewport.frame.y + ty * TILE + 8];
}

function eventToolPoint(id: "new" | "edit" | "copy" | "delete"): [number, number] {
  const button = eventToolButtons().find((candidate) => candidate.id === id)!;
  return [button.x + Math.floor(button.w / 2), HEADER_H + button.y + Math.floor(button.h / 2)];
}

function selectedEvent(): GameEvent {
  const state = probes().state().editor;
  const map = state.project.maps[state.mapIndex]!;
  return map.events.find((event: GameEvent) => event.id === state.selectedEventId)!;
}

function inspectorLayout(width: number, height: number): EventInspectorLayout {
  const state = probes().state().editor;
  const event = selectedEvent();
  const page = event.pages[state.selectedPageIndex]!;
  return createEventInspectorLayout({
    width,
    height: height - HEADER_H,
    pageCount: event.pages.length,
    activePage: state.selectedPageIndex,
    // The scripted events in this file have no page conditions; condition
    // geometry is covered by the pure event-layout suite.
    conditions: [],
    commands: commandInspectorRows(page.commands),
    scroll: { pagesX: 0, conditionsY: 0, commandsY: 0 },
  });
}

function clickInspectorControl(
  inbox: string[],
  world: World,
  control: InspectorControl,
): void {
  click(
    inbox,
    world,
    control.rect.x + Math.floor(control.rect.w / 2),
    HEADER_H + control.rect.y + Math.floor(control.rect.h / 2),
  );
}

function enterEventMode(inbox: string[], world: World): void {
  click(inbox, world, 26, 10); // ground -> upper
  click(inbox, world, 26, 10); // upper -> events
  expect(probes().state().eventMode).toBe(true);
}

simDescribe("event editor pointer integration", () => {
  test("selects and drags a multi-cell event, then copies/deletes/undoes through visible controls", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    const project = JSON.parse(SUNSTONE.json) as Project;
    const elder = project.maps[0]!.events!.find((event) => event.id === "elder")!;
    elder.w = 2;
    elder.h = 2;
    expect(probes().inject(JSON.stringify(project, null, 2) + "\n")).toEqual({ ok: true });

    enterEventMode(inbox, world);
    const start = cellPoint(480, 272, elder.x + 1, elder.y + 1);
    const end = cellPoint(480, 272, elder.x + 2, elder.y + 2);
    click(inbox, world, ...start);
    expect(probes().state().editor.selectedEventId).toBe("elder");
    drag(inbox, world, start, end);
    expect(selectedEvent()).toMatchObject({ id: "elder", x: 10, y: 6, w: 2, h: 2 });
    expect(probes().state().editor.past).toHaveLength(1);

    const beforeCopy = probes().state().editor.project.maps[0].events.length;
    click(inbox, world, ...eventToolPoint("copy"));
    expect(probes().state().editor.project.maps[0].events).toHaveLength(beforeCopy + 1);
    expect(probes().state().editor.selectedEventId).toBe("elder-copy");
    click(inbox, world, ...eventToolPoint("delete"));
    expect(probes().state().editor.project.maps[0].events).toHaveLength(beforeCopy);
    click(inbox, world, 350, 10); // undo delete
    expect(probes().state().editor.project.maps[0].events).toHaveLength(beforeCopy + 1);
  });

  test("creates a named speaking NPC by clicks and typing, saves it, and the runtime opens its text", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    enterEventMode(inbox, world);

    // The starting player is at (9,9), facing up. Put the new NPC directly
    // ahead at (9,8), where the original project has no event.
    click(inbox, world, ...cellPoint(480, 272, 9, 8));
    click(inbox, world, ...eventToolPoint("new"));
    expect(probes().state().inspectorOpen).toBe(true);

    let layout = inspectorLayout(480, 272);
    clickInspectorControl(inbox, world, layout.eventFields.find((c) => c.action.kind === "event-field" && c.action.field === "name")!);
    for (let i = 0; i < 5; i++) key(inbox, world, "Backspace");
    typeText(inbox, world, "Greeter");
    key(inbox, world, "Enter");

    layout = inspectorLayout(480, 272);
    clickInspectorControl(inbox, world, layout.pageFields.find((c) => c.action.kind === "page-field" && c.action.field === "sprite")!);
    for (let i = 0; i < 4; i++) key(inbox, world, "Backspace");
    typeText(inbox, world, "wiz");
    key(inbox, world, "Enter");
    layout = inspectorLayout(480, 272);
    clickInspectorControl(inbox, world, layout.pageFields.find((c) => c.action.kind === "page-field" && c.action.field === "blocks")!);

    layout = inspectorLayout(480, 272);
    clickInspectorControl(inbox, world, layout.commandActions.find((c) => c.action.kind === "command-action" && c.action.action === "add")!);
    typeText(inbox, world, "text");
    key(inbox, world, "Enter");
    layout = inspectorLayout(480, 272);
    clickInspectorControl(inbox, world, layout.commandRows[0]!.fields[0]!);
    typeText(inbox, world, "Hello from the editor.");
    key(inbox, world, "Enter");

    click(inbox, world, 450, 10); // SAVE remains reachable above inspector
    const saveLines = outbox
      .map((value) => JSON.parse(value) as { t: string; text?: string })
      .filter((value) => value.t === "save");
    expect(saveLines).toHaveLength(1);
    const savedText = saveLines[0]!.text!;
    const saved = JSON.parse(savedText) as Project;
    const npc = saved.maps[0]!.events!.find((event) => event.id === "event")!;
    expect(npc).toMatchObject({
      name: "Greeter",
      x: 9,
      y: 8,
      pages: [{ trigger: "action", sprite: "wiz", blocks: true, commands: [{ op: "text", lines: ["Hello from the editor."] }] }],
    });
    expect(savedText).toContain('"ELDER: The Sunstone that lit our valley"');
    expect(probes().state().editor.dirty).toBe(false);

    const session = createSession(saved, 60);
    let state = startSession(saved, session);
    state = stepSession(session, state, { buttons: BTN.CIRCLE, confirmEdge: true });
    if (state.interp.modal === null) state = stepSession(session, state, { buttons: 0 });
    expect(state.interp.modal).toMatchObject({
      kind: "text",
      lines: ["Hello from the editor."],
    });
  });
});

function pixel(framebuffer: Uint8Array, width: number, x: number, y: number): [number, number, number, number] {
  const offset = (y * width + x) * 4;
  return [
    framebuffer[offset]!,
    framebuffer[offset + 1]!,
    framebuffer[offset + 2]!,
    framebuffer[offset + 3]!,
  ];
}

const screenshotPins: Record<string, string> = {
  "480x272": "1a0c6978",
  "720x480": "12f19931",
};

simDescribe("event inspector responsive rendering", () => {
  for (const [width, height] of [[480, 272], [720, 480]] as const) {
    test(`${width}x${height} renders semantic inspector regions and matches its PNG`, async () => {
      const inbox: string[] = [];
      const outbox: string[] = [];
      const world = await bootSvc(inbox, outbox, width, height);
      enterEventMode(inbox, world);
      click(inbox, world, ...cellPoint(width, height, 9, 5)); // elder
      click(inbox, world, ...eventToolPoint("edit"));
      expect(probes().state().inspectorOpen).toBe(true);
      frame(world);

      const layout = inspectorLayout(width, height);
      const framebuffer = world.render();
      expect(framebuffer).toHaveLength(width * height * 4);
      const name = layout.eventFields[0]!.rect;
      expect(pixel(framebuffer, width, name.x + name.w - 2, HEADER_H + name.y + 2)).toEqual([44, 58, 82, 255]);
      expect(pixel(framebuffer, width, layout.leftWidth, HEADER_H + layout.bodyTop + 50)).toEqual([8, 11, 16, 255]);
      const firstCommand = layout.commandRows[0]!.header.rect;
      expect(pixel(framebuffer, width, firstCommand.x + firstCommand.w - 2, HEADER_H + firstCommand.y + 2)).toEqual([32, 43, 61, 255]);

      const nameKey = `${width}x${height}`;
      const hash = fnv1a(framebuffer);
      if (process.env.EDITOR_EVENT_UPDATE_GOLDENS) {
        await Bun.write(
          new URL(`./goldens/editor-events.${nameKey}.png`, import.meta.url),
          encodePNG(framebuffer, width, height),
        );
        console.log(`editor event golden ${nameKey}: ${hash}`);
      }
      const pin = screenshotPins[nameKey];
      if (pin) expect(hash).toBe(pin);
      const png = new Uint8Array(await Bun.file(new URL(`./goldens/editor-events.${nameKey}.png`, import.meta.url)).arrayBuffer());
      const decoded = decodePng(png);
      expect({ width: decoded.width, height: decoded.height, hash: fnv1a(decoded.rgba) }).toEqual({ width, height, hash });
    });
  }
});
