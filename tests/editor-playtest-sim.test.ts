// The editor's PLAY surface over the real wasm sim host. These tests cross
// the whole boundary that the pure playtest helpers cannot: svc pointer
// input -> unsaved editor state -> production GameView/session -> STOP back
// to the same editor/undo history.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { BUNDLED_PROJECTS } from "../editor/engine/projects.ts";
import { fittedView, headerButtons, HEADER_H, TILE } from "../editor/engine/layout.ts";
import {
  playtestDebugRows,
} from "../editor/engine/playtest.ts";
import {
  playtestPanelRect,
  playtestRowRect,
} from "../editor/engine/playtest-layout.ts";
import type { Project } from "../src/engine/types.ts";
import { appPreflight, fnv1a } from "./helpers/boot.ts";
import {
  bootEditorWorld,
  installEditorSimIsolation,
  type BoundEditorWorld,
} from "./helpers/editor-session.ts";

const preflight = appPreflight("editor");
if (!preflight.ok) console.warn(`editor playtest sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

installEditorSimIsolation();

const W = 480;
const H = 272;
const SLOT2: [number, number] = [3 + 2 * 13 + 6, HEADER_H + 33 + 6];
const SUNSTONE = BUNDLED_PROJECTS.find((document) => document.id === "sunstone")!;
const MEADOW = BUNDLED_PROJECTS.find((document) => document.id === "meadow")!;
const PLAY_BUTTON = headerButtons(W).find((button) => button.id === "play")!;
const PLAY_POINT: [number, number] = [
  PLAY_BUTTON.x + Math.floor(PLAY_BUTTON.w / 2),
  PLAY_BUTTON.y + Math.floor(PLAY_BUTTON.h / 2),
];

function frame(world: BoundEditorWorld, mask = 0): void {
  world.frame(mask);
  world.tick();
}

async function bootSvc(inbox: string[], outbox: string[]): Promise<BoundEditorWorld> {
  const world = await bootEditorWorld(
    60,
    undefined,
    (ops) => {
      ops.svcOpen = () => true;
      ops.svcPoll = () => (inbox.length ? inbox.splice(0).join("\n") : null);
      ops.svcSend = (line: string) => outbox.push(line);
    },
    { width: W, height: H },
  );
  for (let i = 0; i < 4; i++) frame(world);
  return world;
}

function svcLine(inbox: string[], world: BoundEditorWorld, line: object): void {
  inbox.push(JSON.stringify(line));
  frame(world);
}

function click(inbox: string[], world: BoundEditorWorld, x: number, y: number, extra: object = {}): void {
  svcLine(inbox, world, { t: "mouse", x, y, d: true, ...extra });
  svcLine(inbox, world, { t: "mouse", x, y, d: false, ...extra });
}

function pixel(framebuffer: Uint8Array, x: number, y: number): [number, number, number, number] {
  const offset = (y * W + x) * 4;
  return [
    framebuffer[offset]!,
    framebuffer[offset + 1]!,
    framebuffer[offset + 2]!,
    framebuffer[offset + 3]!,
  ];
}

function treeHas(tree: unknown, text: string): boolean {
  return JSON.stringify(tree).includes(text);
}

function debugProject(): Project {
  const project = JSON.parse(SUNSTONE.json) as Project;
  const map = project.maps[0]!;
  map.events = [
    ...(map.events ?? []),
    {
      id: "debug-page",
      name: "Debug page",
      x: 1,
      y: 1,
      pages: [
        { trigger: "action", sprite: "boy", blocks: false, commands: [] },
        {
          condition: { switch: "debug-page-active" },
          trigger: "action",
          sprite: "wiz",
          blocks: false,
          commands: [],
        },
      ],
    },
  ];
  return project;
}

function fallbackProject(): Project {
  const project = JSON.parse(SUNSTONE.json) as Project;
  const map = project.maps[0]!;
  map.events = [
    ...(map.events ?? []),
    {
      id: "preview-fallback",
      name: "Preview fallback",
      x: 1,
      y: 1,
      pages: [
        {
          trigger: "autorun",
          commands: [
            { op: "ext", call: "preview.missing", args: null },
            { op: "screenBackdrop", layer: "cutscene", variant: "arrival" },
            {
              op: "battle",
              setup: { foe: "slime" },
              onWin: [{ op: "switch", id: "fallback.done", value: true }],
              onEscape: [{ op: "switch", id: "fallback.done", value: true }],
            },
          ],
        },
        {
          condition: { switch: "fallback.done" },
          trigger: "action",
          commands: [],
        },
      ],
    },
  ];
  return project;
}

async function golden(name: string, framebuffer: Uint8Array): Promise<string> {
  const url = new URL(`./goldens/editor-playtest.${name}.png`, import.meta.url);
  if (process.env.EDITOR_PLAYTEST_UPDATE_GOLDENS) {
    await Bun.write(url, encodePNG(framebuffer, W, H));
  }
  const png = new Uint8Array(await Bun.file(url).arrayBuffer());
  const decoded = decodePng(png);
  expect({ width: decoded.width, height: decoded.height }).toEqual({ width: W, height: H });
  expect(framebuffer).toEqual(decoded.rgba);
  return fnv1a(framebuffer);
}

simDescribe("editor in-memory playtest", () => {
  test("PLAY uses the unsaved map and selected cell; STOP preserves undo and redo", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    const probes = world.probes();
    const editorFrame = fittedView(W, H, false).frame;
    const at = (tx: number, ty: number): [number, number] => [
      editorFrame.x + tx * TILE + 3,
      editorFrame.y + ty * TILE + 3,
    ];

    click(inbox, world, ...SLOT2); // town.1
    const [startX, startY] = at(4, 8);
    const [changedX, changedY] = at(5, 8);
    // One drag chooses (4,8) as the start and paints two unsaved cells.
    svcLine(inbox, world, { t: "mouse", x: startX, y: startY, d: true });
    svcLine(inbox, world, { t: "mouse", x: changedX, y: changedY, d: true });
    svcLine(inbox, world, { t: "mouse", x: changedX, y: changedY, d: false });

    const before = probes.state();
    expect(before.editor.past).toHaveLength(1);
    expect(before.editor.dirty).toBe(true);
    expect(before.editor.project.maps[0].ground[8 * 20 + 5]).toBe("town.1");
    expect(before.playStartCell).toEqual({ mapId: "village", x: 4, y: 8 });

    click(inbox, world, ...PLAY_POINT); // PLAY
    for (let i = 0; i < 3; i++) frame(world);

    const playing = probes.state();
    expect(playing.playtest).toBe(true);
    expect(playing.playProject).not.toBe(before.editor.project);
    expect(playing.playProject.maps[0].ground[8 * 20 + 5]).toBe("town.1");
    expect(playing.playState.mapId).toBe("village");
    expect({ tx: playing.playState.move.tx, ty: playing.playState.move.ty }).toEqual({ tx: 4, ty: 8 });
    // The disposable preview did not replace or clear the editor reducer.
    expect(playing.editor).toBe(before.editor);
    expect(playing.editor.past).toHaveLength(1);

    // World/bar clicks are owned by the playtest overlay, never routed back
    // into the hidden palette/canvas/header.
    click(inbox, world, 350, 10);
    click(inbox, world, 200, 150);
    expect(probes.state().editor).toBe(before.editor);
    expect(probes.state().editor.past).toHaveLength(1);

    // The second edited cell is visible through GameView's streamed layer.
    // town.1 differs from the original flat-grass town.0 at local (3,3).
    const tile = decodePng(new Uint8Array(readFileSync(new URL("../editor/assets/tile-town-1.png", import.meta.url))));
    const sourceOffset = (3 * TILE + 3) * 4;
    const sourcePixel: [number, number, number, number] = [
      tile.rgba[sourceOffset]!,
      tile.rgba[sourceOffset + 1]!,
      tile.rgba[sourceOffset + 2]!,
      tile.rgba[sourceOffset + 3]!,
    ];
    const mapX = Math.floor((W - 20 * TILE) / 2);
    const mapY = Math.floor((H - 13 * TILE) / 2);
    expect(pixel(world.render(), mapX + 5 * TILE + 3, mapY + 8 * TILE + 3)).toEqual(sourcePixel);

    click(inbox, world, 28, 11); // STOP
    const stopped = probes.state();
    expect(stopped.playtest).toBe(false);
    expect(stopped.editor).toBe(before.editor);
    expect(stopped.editor.past).toHaveLength(1);
    expect(stopped.notice.text).toContain("UNDO HISTORY PRESERVED");

    click(inbox, world, 350, 10); // UNDO
    expect(probes.state().editor.past).toHaveLength(0);
    expect(probes.state().editor.project.maps[0].ground[8 * 20 + 5]).toBe("town.0");
    click(inbox, world, 398, 10); // REDO
    expect(probes.state().editor.past).toHaveLength(1);
    expect(probes.state().editor.project.maps[0].ground[8 * 20 + 5]).toBe("town.1");
  });

  test("the live switch editor changes the active page and LAST/FRESH controls the next run", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    const probes = world.probes();
    expect(probes.inject(JSON.stringify(debugProject()))).toEqual({ ok: true });
    frame(world);

    click(inbox, world, ...PLAY_POINT); // PLAY
    for (let i = 0; i < 3; i++) frame(world);
    expect(probes.state().playState.chars.chars["debug-page"].pageIndex).toBe(0);

    click(inbox, world, 83, 11); // DEBUG
    expect(probes.state().playDebug).toBe(true);
    const state = probes.state();
    const rows = playtestDebugRows(state.playProject, state.playState, "switch");
    const rowIndex = rows.findIndex((row) => row.kind === "switch" && row.id === "debug-page-active");
    expect(rowIndex).toBeGreaterThanOrEqual(0);
    const panel = playtestPanelRect(W, H, false);
    const row = playtestRowRect(panel, rowIndex);
    click(inbox, world, row.x + row.w - 7, row.y + Math.floor(row.h / 2));
    for (let i = 0; i < 2; i++) frame(world);
    expect(probes.state().playState.sw.switches["debug-page-active"]).toBe(true);
    expect(probes.state().playState.chars.chars["debug-page"].pageIndex).toBe(1);
    expect(probes.state().playState.sw).toBe(probes.state().playState.interp.sw);
    expect(treeHas(world.getTree(), "ON")).toBe(true);

    click(inbox, world, 28, 11); // STOP captures the switch/variable banks
    expect(probes.state().hasLastPlayState).toBe(true);
    click(inbox, world, 310, 10); // STATE -> LAST
    expect(probes.state().carryPrevious).toBe(true);
    click(inbox, world, ...PLAY_POINT);
    for (let i = 0; i < 3; i++) frame(world);
    expect(probes.state().playState.sw.switches["debug-page-active"]).toBe(true);
    expect(probes.state().playState.chars.chars["debug-page"].pageIndex).toBe(1);

    click(inbox, world, 28, 11);
    click(inbox, world, 310, 10); // STATE -> FRESH
    expect(probes.state().carryPrevious).toBe(false);
    click(inbox, world, ...PLAY_POINT);
    for (let i = 0; i < 3; i++) frame(world);
    expect(probes.state().playState.sw.switches["debug-page-active"]).toBeUndefined();
    expect(probes.state().playState.chars.chars["debug-page"].pageIndex).toBe(0);
    svcLine(inbox, world, { t: "key", k: "Escape" });
    expect(probes.state().playtest).toBe(false);
    expect(probes.state().editor.project.maps[0].events.at(-1)?.id).toBe("debug-page");
  });

  test("browser file save and load requests remain live during PLAY", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    const probes = world.probes();

    click(inbox, world, ...PLAY_POINT); // PLAY
    expect(probes.state().playtest).toBe(true);
    svcLine(inbox, world, { t: "key", k: "s", cmd: true, sh: false, alt: false, ctl: true, request: 71 });
    expect(outbox.map((line) => JSON.parse(line)).at(-1)).toMatchObject({ t: "save", request: 71 });
    expect(probes.state().playtest).toBe(true);

    svcLine(inbox, world, { t: "load", text: MEADOW.json, request: 72 });
    expect(probes.state().playtest).toBe(false);
    expect(probes.state().editor.project.title).toBe("Pocket RPG Kit — Mini Meadow");
    expect(outbox.map((line) => JSON.parse(line)).at(-1)).toEqual({ t: "loaded", ok: true, request: 72 });
  });

  test("unregistered extensions, screen backdrops and battles show fallbacks without crashing", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    const probes = world.probes();
    expect(probes.inject(JSON.stringify(fallbackProject()))).toEqual({ ok: true });
    frame(world);

    click(inbox, world, ...PLAY_POINT);
    for (let i = 0; i < 5; i++) frame(world);
    const playing = probes.state();
    expect(playing.playIssues.map((issue: { kind: string }) => issue.kind)).toEqual([
      "extension",
      "battle",
      "backdrop",
    ]);
    expect(playing.playIssues[0].message).toContain("unregistered extension command preview.missing");
    expect(playing.playState.interp.error).toBeUndefined();
    expect(treeHas(world.getTree(), "editor-playtest-warning")).toBe(true);
    expect(treeHas(world.getTree(), "unregistered extension command preview.missing")).toBe(true);
    expect(treeHas(world.getTree(), "editor-playtest-battle-placeholder")).toBe(true);
    const warning = pixel(world.render(), 2, 23);
    expect(warning[0]).toBeGreaterThan(warning[1]);
    expect(warning[1]).toBeGreaterThan(warning[2]);

    frame(world, BTN.CIRCLE); // deterministic editor battle result: win
    frame(world, 0);
    for (let i = 0; i < 5; i++) frame(world);
    expect(probes.state().playState.sw.switches["fallback.done"]).toBe(true);
    expect(probes.state().playState.interp.error).toBeUndefined();
  });

  test("play view and live debugger match reviewed PNG goldens", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    const probes = world.probes();
    expect(probes.inject(JSON.stringify(debugProject()))).toEqual({ ok: true });
    frame(world);

    click(inbox, world, ...PLAY_POINT);
    for (let i = 0; i < 3; i++) frame(world);
    const game = world.render().slice();
    expect(treeHas(world.getTree(), "editor-playtest-root")).toBe(true);
    expect(treeHas(world.getTree(), "rpgkit-world")).toBe(true);
    const stopFill = pixel(game, 5, 4);
    expect(stopFill[0]).toBeGreaterThan(stopFill[1] + 30);
    // A world cell below the chrome is real green-dominant tile art.
    const ground = pixel(game, 80 + 4 * TILE + 8, 32 + 8 * TILE + 8);
    expect(ground[1]).toBeGreaterThan(ground[0]);
    expect(await golden("game", game)).toBe("30601139");

    click(inbox, world, 83, 11);
    frame(world);
    const debug = world.render().slice();
    expect(treeHas(world.getTree(), "editor-playtest-debug-panel")).toBe(true);
    expect(treeHas(world.getTree(), "editor-playtest-row-switch-debug-page-active")).toBe(true);
    const panel = playtestPanelRect(W, H, false);
    const border = pixel(debug, panel.x, panel.y);
    expect(border[0]).toBeGreaterThan(border[2]);
    const inside = pixel(debug, panel.x + 8, panel.y + 8);
    expect(inside[0]).toBeLessThan(60);
    expect(inside[1]).toBeLessThan(70);
    expect(await golden("debug", debug)).toBe("cf3bcabe");
  });
});
