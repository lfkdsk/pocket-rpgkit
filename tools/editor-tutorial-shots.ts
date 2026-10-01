#!/usr/bin/env bun
// tools/editor-tutorial-shots.ts — regenerate the figures in
// docs/editor-tutorial.md by driving the built editor bundle (dist/editor.js)
// on the wasm sim host through the same steps the tutorial describes.
//
// Each figure is captured in its OWN child process. The wasm sim host swaps
// consecutive `world.render()` results across boots in the same process (the
// eval'd bundle leaves global render state behind that the next boot reads),
// so a script that boots and renders eight times in one process writes figure
// N with the pixels of figure N+1. Spawning one `bun --shot <name>` child per
// figure gives every capture a fresh process: each child boots, replays the
// tutorial steps up to that figure, and renders exactly once.
//
// Prereqs: bun run build:editor && bun run build:wasm
// Usage:    bun tools/editor-tutorial-shots.ts            (all figures)
//           bun tools/editor-tutorial-shots.ts --shot 01-overview   (one figure)

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bootWorld, type SimWorld } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { appBundle } from "../tests/helpers/boot.ts";
import {
  eventToolButtons,
  fittedView,
  headerButtons,
  HEADER_H,
  paletteSlotOrigin,
  passToolButtons,
  TILE,
} from "../editor/engine/layout.ts";
import {
  createEventInspectorLayout,
  type EventInspectorLayout,
  type InspectorControl,
} from "../editor/engine/event-layout.ts";
import { createMapInspectorLayout } from "../editor/engine/map-layout.ts";
import { commandInspectorRows, conditionFields } from "../editor/engine/event-fields.ts";
import type { InspectorConditionRow } from "../editor/engine/event-layout.ts";
import type { Page } from "../src/engine/types.ts";

// Mirrors flattenInspectorConditions (editor/ui/event-inspector.tsx) for the
// `all` clauses the editor's condition-add prompt produces. Kept here so the
// script imports engine modules only (the UI module pulls a JSX runtime the
// editor build aliases but a plain script does not).
function flattenConditions(page: Page | undefined): InspectorConditionRow[] {
  const all = page?.condition?.all;
  if (!all) return [];
  return all.map((clause, index) => ({
    key: `all:${index}`,
    kind: clause.kind,
    summary: "",
    source: { kind: "all" as const, index },
    fields: conditionFields(clause),
  }));
}

const W = 720;
const H = 480;
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT_DIR = join(ROOT, "docs", "screenshots", "editor-tutorial");

// --- per-boot context ------------------------------------------------------

interface Ctx {
  world: SimWorld;
  state(): any;
  frame(mask?: number): void;
  svcLine(line: object): void;
  click(x: number, y: number, extra?: object): void;
  drag(from: [number, number], to: [number, number]): void;
  typeText(text: string): void;
  key(k: string, cmd?: boolean): void;
  press(mask: number): void;
  idle(frames: number): void;
  headerCenter(id: string): [number, number];
  cellPoint(tx: number, ty: number): [number, number];
  paletteSlot(slot: number): [number, number];
  eventToolPoint(id: "new" | "edit" | "copy" | "delete"): [number, number];
  passToolPoint(id: string): [number, number];
  clickControl(control: { rect: { x: number; y: number; w: number; h: number } }): void;
  cmdScroll: number;
  inspectorLayout(): EventInspectorLayout;
  allControls(layout: EventInspectorLayout): InspectorControl[];
  findField(pred: (c: InspectorControl) => boolean): InspectorControl;
  clickField(pred: (c: InspectorControl) => boolean): InspectorControl;
  setTextField(pred: (c: InspectorControl) => boolean, text: string): void;
  addCommand(op: string): void;
  addCondition(kind: string): void;
  addPage(): void;
  selectCommandRow(pred: (cmd: any) => boolean): void;
  fieldKey(key: string): (c: InspectorControl) => boolean;
}

/** Assert a precondition, mirroring the original script's check(). */
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function bootFresh(): Promise<Ctx> {
  const inbox: string[] = [];
  const outbox: string[] = [];
  const world = await bootWorld(
    appBundle("editor"),
    60,
    undefined,
    (ops) => {
      ops.svcOpen = () => true;
      ops.svcPoll = () => (inbox.length ? inbox.splice(0).join("\n") : null);
      ops.svcSend = (line: string) => outbox.push(line);
    },
    { width: W, height: H },
  );
  const g = globalThis as Record<string, unknown>;
  const ctx: Ctx = {
    world,
    cmdScroll: 0,
    state() {
      return (g.__rpgkitEditorState as () => any)();
    },
    frame(mask = 0) {
      world.frame(mask);
      world.tick();
    },
    svcLine(line: object) {
      inbox.push(JSON.stringify(line));
      this.frame();
    },
    click(x: number, y: number, extra: object = {}) {
      this.svcLine({ t: "mouse", x, y, d: true, ...extra });
      this.svcLine({ t: "mouse", x, y, d: false, ...extra });
    },
    drag(from: [number, number], to: [number, number]) {
      this.svcLine({ t: "mouse", x: from[0], y: from[1], d: true });
      this.svcLine({ t: "mouse", x: to[0], y: to[1], d: true });
      this.svcLine({ t: "mouse", x: to[0], y: to[1], d: false });
    },
    typeText(text: string) {
      this.svcLine({ t: "ch", s: text });
    },
    key(k: string, cmd = false) {
      this.svcLine({ t: "key", k, cmd, sh: false, alt: false, ctl: cmd });
    },
    press(mask: number) {
      this.frame(mask);
      this.frame(0);
    },
    idle(frames: number) {
      for (let i = 0; i < frames; i++) this.frame();
    },
    headerCenter(id: string): [number, number] {
      const b = headerButtons(W).find((b) => b.id === id)!;
      return [b.x + Math.floor(b.w / 2), b.y + Math.floor(b.h / 2)];
    },
    cellPoint(tx: number, ty: number): [number, number] {
      const f = fittedView(W, H, false).frame;
      return [f.x + tx * TILE + 8, f.y + ty * TILE + 8];
    },
    paletteSlot(slot: number): [number, number] {
      const o = paletteSlotOrigin(slot);
      return [o.x + 6, HEADER_H + o.y + 6];
    },
    eventToolPoint(id: "new" | "edit" | "copy" | "delete"): [number, number] {
      const b = eventToolButtons().find((c) => c.id === id)!;
      return [b.x + Math.floor(b.w / 2), HEADER_H + b.y + Math.floor(b.h / 2)];
    },
    passToolPoint(id: string): [number, number] {
      const b = passToolButtons().find((c) => c.id === id)!;
      return [b.x + Math.floor(b.w / 2), HEADER_H + b.y + Math.floor(b.h / 2)];
    },
    clickControl(control: { rect: { x: number; y: number; w: number; h: number } }): void {
      this.click(
        control.rect.x + Math.floor(control.rect.w / 2),
        HEADER_H + control.rect.y + Math.floor(control.rect.h / 2),
      );
    },
    inspectorLayout(): EventInspectorLayout {
      const s = this.state().editor;
      const map = s.project.maps[s.mapIndex]!;
      const event = map.events.find((e: any) => e.id === s.selectedEventId);
      check(event, "no selected event");
      const page = event.pages[s.selectedPageIndex]!;
      return createEventInspectorLayout({
        width: W,
        height: H - HEADER_H,
        pageCount: event.pages.length,
        activePage: s.selectedPageIndex,
        conditions: flattenConditions(page),
        commands: commandInspectorRows(page.commands),
        scroll: { pagesX: 0, conditionsY: 0, commandsY: this.cmdScroll },
      });
    },
    allControls(layout: EventInspectorLayout): InspectorControl[] {
      return [
        ...layout.eventFields,
        ...layout.pageFields,
        ...layout.conditionRows.flatMap((r) => r.fields),
        ...layout.commandRows.flatMap((r) => r.fields),
      ];
    },
    findField(pred: (c: InspectorControl) => boolean): InspectorControl {
      const layout = this.inspectorLayout();
      const found = this.allControls(layout).find(pred);
      check(found, `field not found`);
      return found!;
    },
    clickField(pred: (c: InspectorControl) => boolean): InspectorControl {
      let layout = this.inspectorLayout();
      let control = this.allControls(layout).find(pred);
      check(control, "field not found in layout");
      let guard = 0;
      while (control!.rect.y + control!.rect.h > layout.commandClip.y + layout.commandClip.h && guard++ < 12) {
        this.svcLine({ t: "scroll", dy: 1 });
        this.cmdScroll += 36;
        layout = this.inspectorLayout();
        control = this.allControls(layout).find(pred);
        check(control, "field vanished after scroll");
      }
      this.clickControl(control!);
      return control!;
    },
    setTextField(pred: (c: InspectorControl) => boolean, text: string): void {
      this.clickField(pred);
      for (let i = 0; i < 24; i++) this.key("Backspace");
      this.typeText(text);
      this.key("Enter");
    },
    addCommand(op: string): void {
      const layout = this.inspectorLayout();
      const add = layout.commandActions.find(
        (a) => a.action.kind === "command-action" && a.action.action === "add",
      )!;
      this.clickControl(add);
      this.typeText(op);
      this.key("Enter");
    },
    addCondition(kind: string): void {
      const layout = this.inspectorLayout();
      const add = layout.conditionActions.find(
        (a) => a.action.kind === "condition-action" && a.action.action === "add",
      )!;
      this.clickControl(add);
      this.typeText(kind);
      this.key("Enter");
    },
    addPage(): void {
      const layout = this.inspectorLayout();
      const add = layout.pageActions.find(
        (a) => a.action.kind === "page-action" && a.action.action === "add",
      )!;
      this.clickControl(add);
      this.cmdScroll = 0; // opening/adding a page resets inspector scroll
    },
    selectCommandRow(pred: (cmd: any) => boolean): void {
      const s = this.state().editor;
      const map = s.project.maps[s.mapIndex]!;
      const event = map.events.find((e: any) => e.id === s.selectedEventId)!;
      const page = event.pages[s.selectedPageIndex]!;
      const index = commandInspectorRows(page.commands).findIndex((r) => pred(r));
      check(index >= 0, "command row not found");
      const layout = this.inspectorLayout();
      const geo = layout.commandRows.find((r) => r.row === index)!;
      check(geo, "command row has no geometry");
      this.clickControl(geo.header);
    },
    fieldKey(key: string): (c: InspectorControl) => boolean {
      return (c: InspectorControl) =>
        (c.action as { kind: string; field?: string }).kind.endsWith("-field") &&
        (c.action as { field?: string }).field === key;
    },
  };
  for (let i = 0; i < 4; i++) ctx.frame();
  return ctx;
}

// --- tutorial steps (each replays from a fresh boot) -----------------------

/** Step 2: paint the path, the upper tile, undo/redo, then the passage. */
function paintPathAndUpper(ctx: Ctx): void {
  ctx.click(...ctx.paletteSlot(2)); // town.1 path tile
  ctx.drag(ctx.cellPoint(4, 8), ctx.cellPoint(6, 8));
  ctx.click(...ctx.headerCenter("layer")); // GROUND -> UPPER
  ctx.click(...ctx.paletteSlot(2));
  ctx.click(...ctx.cellPoint(4, 7));
  ctx.click(...ctx.headerCenter("undo"));
  ctx.click(...ctx.headerCenter("redo"));
}

function paintPassage(ctx: Ctx): void {
  ctx.click(...ctx.headerCenter("layer")); // UPPER -> PASS
  ctx.click(...ctx.passToolPoint("block"));
  ctx.click(...ctx.cellPoint(7, 8));
  ctx.click(...ctx.passToolPoint("in-left"));
  ctx.click(...ctx.cellPoint(4, 8));
}

/** Step 3: the Greeter NPC, page 1 (greeting, choices, switch). */
function greeterPage1(ctx: Ctx): void {
  ctx.click(...ctx.headerCenter("layer")); // PASS -> EVENT
  ctx.click(...ctx.cellPoint(9, 8));
  ctx.click(...ctx.eventToolPoint("new"));
  check(ctx.state().inspectorOpen === true, "inspector did not open on NEW");

  ctx.setTextField(ctx.fieldKey("name"), "Greeter");
  ctx.setTextField(ctx.fieldKey("sprite"), "villager");
  ctx.clickField(ctx.fieldKey("blocks")); // boolean: one click toggles on

  ctx.addCommand("text");
  ctx.setTextField(
    (c) => ctx.fieldKey("lines")(c) && (c.action as any).row === 0,
    "VILLAGER: Welcome to Bramble Hollow!",
  );

  ctx.addCommand("choices");
  ctx.setTextField((c) => ctx.fieldKey("prompt")(c) && (c.action as any).row === 1, "VILLAGER: Want a tip?");
  ctx.setTextField((c) => ctx.fieldKey("option:0")(c), "Yes, please!");
  ctx.setTextField((c) => ctx.fieldKey("option:1")(c), "No, thanks.");

  ctx.selectCommandRow((r) => r.command.op === "choices");
  ctx.addCommand("text@option1");
  ctx.setTextField(
    (c) => ctx.fieldKey("lines")(c) && (c.action as any).row === 2,
    "VILLAGER: The forest road is east. Watch for slimes.",
  );

  ctx.selectCommandRow((r) => r.command?.op === "choices");
  ctx.addCommand("text@option2");
  ctx.setTextField(
    (c) => ctx.fieldKey("lines")(c) && (c.action as any).row === 3,
    "VILLAGER: Safe travels!",
  );

  // Select the choices row itself so the switch inserts after it at the root,
  // not after the still-selected nested branch row.
  ctx.selectCommandRow((r) => r.command?.op === "choices");
  ctx.addCommand("switch");
  ctx.setTextField((c) => ctx.fieldKey("id")(c) && (c.action as any).row === 4, "met-villager");

  // Reopen the inspector so the figure shows page 1 from the top.
  ctx.key("Escape");
  ctx.click(...ctx.cellPoint(9, 8));
  ctx.click(...ctx.eventToolPoint("edit"));
}

/** Step 3: pages 2 and 3 (the one-time reward and the after line). */
function greeterPages23(ctx: Ctx): void {
  ctx.addPage();
  ctx.addCondition("switch");
  ctx.setTextField((c) => ctx.fieldKey("id")(c) && (c.action as any).row === 0, "met-villager");
  ctx.addCondition("selfSwitch");
  ctx.clickField((c) => ctx.fieldKey("value")(c) && (c.action as any).row === 1); // toggle off

  ctx.addCommand("text");
  ctx.setTextField(
    (c) => ctx.fieldKey("lines")(c) && (c.action as any).row === 0,
    "VILLAGER: Welcome back! Take these 10 gold.",
  );
  ctx.addCommand("gold");
  ctx.setTextField((c) => ctx.fieldKey("amount")(c) && (c.action as any).row === 1, "10");
  ctx.addCommand("selfSwitch");

  ctx.addPage();
  ctx.addCondition("selfSwitch");
  ctx.addCommand("text");
  ctx.setTextField(
    (c) => ctx.fieldKey("lines")(c) && (c.action as any).row === 0,
    "VILLAGER: I already gave you the reward. Go on!",
  );
}

/** Step 4: create the grove map. Leaves the map inspector open. */
function createGrove(ctx: Ctx): void {
  ctx.key("Escape"); // close the event inspector
  ctx.click(...ctx.headerCenter("map"));
  check(ctx.state().mapInspectorOpen === true, "map inspector did not open");
  const layout = createMapInspectorLayout({ width: W, height: H - HEADER_H });
  const newAction = layout.actions.find((a) => a.action.kind === "action" && a.action.action === "new")!;
  ctx.click(newAction.rect.x + 30, HEADER_H + newAction.rect.y + 10);
  check(ctx.state().editor.project.maps.length === 4, "NEW did not create a map");
  const idField = layout.fields.find((f) => f.action.kind === "field" && f.action.field === "id")!;
  ctx.clickControl(idField);
  for (let i = 0; i < 10; i++) ctx.key("Backspace");
  ctx.typeText("grove");
  ctx.key("Enter");
  check(ctx.state().editor.project.maps[1].id === "grove", "rename failed");
}

function closeMapInspector(ctx: Ctx): void {
  const layout = createMapInspectorLayout({ width: W, height: H - HEADER_H });
  ctx.click(layout.close.rect.x + 24, HEADER_H + layout.close.rect.y + 9);
  check(ctx.state().mapInspectorOpen === false, "map inspector did not close");
}

/** Step 4: the village portal at (11,9) -> grove (3,4), PICK armed. */
function villagePortal(ctx: Ctx): void {
  ctx.click(...ctx.headerCenter("mapprev")); // back to the village
  ctx.click(...ctx.cellPoint(11, 9));
  ctx.click(...ctx.eventToolPoint("new"));
  ctx.clickField(ctx.fieldKey("trigger")); // action -> playerTouch
  ctx.addCommand("transfer");
  const layout = ctx.inspectorLayout();
  const row = layout.commandRows.find((r) => r.pick)!;
  ctx.clickControl(row.pick!);
  check(ctx.state().pendingPick !== null, "PICK did not arm");
}

/** Step 4: pick the grove target, then build the return portal. */
function pickAndReturnPortal(ctx: Ctx): void {
  ctx.click(...ctx.headerCenter("mapnext")); // to the grove
  ctx.click(...ctx.cellPoint(3, 4));
  check(ctx.state().inspectorOpen === true, "inspector did not reopen after pick");

  ctx.key("Escape"); // close the inspector the pick reopened
  ctx.click(...ctx.headerCenter("mapnext")); // to the grove
  ctx.click(...ctx.cellPoint(3, 5));
  ctx.click(...ctx.eventToolPoint("new"));
  check(ctx.state().inspectorOpen === true, "return portal inspector did not open");
  ctx.clickField(ctx.fieldKey("trigger"));
  ctx.addCommand("transfer");
  const layout = ctx.inspectorLayout();
  const row = layout.commandRows.find((r) => r.pick)!;
  ctx.clickControl(row.pick!);
  ctx.click(...ctx.headerCenter("mapprev")); // to the village
  ctx.click(...ctx.cellPoint(10, 9));
}

/** Step 5: play-test from the cell next to the Greeter. */
function playtest(ctx: Ctx): void {
  ctx.key("Escape");
  ctx.click(...ctx.headerCenter("mapprev")); // the second pick left us on the grove
  ctx.click(...ctx.cellPoint(8, 8)); // play-test start cell, next to the Greeter
  check(ctx.state().playStartCell, "play start cell not set");
  ctx.click(...ctx.headerCenter("play"));
  ctx.idle(3);
  check(ctx.state().playtest === true, "PLAY did not start");
  check(ctx.state().playState.mapId === "village", "playtest on wrong map");
}

/** Step 5: talk to the Greeter, then open the live debugger. */
function talkAndDebug(ctx: Ctx): void {
  ctx.press(BTN.RIGHT);
  ctx.idle(3);
  ctx.press(BTN.CIRCLE);
  ctx.idle(3);
  for (let i = 0; i < 10 && ctx.state().playState.interp.modal; i++) {
    ctx.press(BTN.CIRCLE);
    ctx.idle(3);
  }
  check(ctx.state().playState.interp.modal === null, "dialog did not finish");
  check(
    ctx.state().playState.sw.switches["met-villager"] === true,
    "first talk did not set met-villager",
  );

  ctx.click(83, 11); // DEBUG
  ctx.idle(2);
  check(ctx.state().playDebug === true, "debug panel did not open");
}

// --- figures ----------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });

/** Boot fresh, replay the steps up to this figure, render exactly once. */
async function capture(name: string, steps: ((ctx: Ctx) => void)[]): Promise<void> {
  const ctx = await bootFresh();
  for (const step of steps) step(ctx);
  const path = join(OUT_DIR, `${name}.png`);
  await Bun.write(path, encodePNG(ctx.world.render(), W, H));
  console.log(`wrote ${path}`);
}

// Each figure maps to the tutorial steps that precede it.
const SHOTS: Record<string, ((ctx: Ctx) => void)[]> = {
  "01-overview": [],
  "02-painting": [paintPathAndUpper],
  "03-passage": [paintPathAndUpper, paintPassage],
  "04-event-inspector": [paintPathAndUpper, paintPassage, greeterPage1],
  "05-map-inspector": [paintPathAndUpper, paintPassage, greeterPage1, greeterPages23, createGrove],
  "06-transfer-pick": [
    paintPathAndUpper,
    paintPassage,
    greeterPage1,
    greeterPages23,
    createGrove,
    closeMapInspector,
    villagePortal,
  ],
  "07-playtest": [
    paintPathAndUpper,
    paintPassage,
    greeterPage1,
    greeterPages23,
    createGrove,
    closeMapInspector,
    villagePortal,
    pickAndReturnPortal,
    playtest,
  ],
  "08-debug-panel": [
    paintPathAndUpper,
    paintPassage,
    greeterPage1,
    greeterPages23,
    createGrove,
    closeMapInspector,
    villagePortal,
    pickAndReturnPortal,
    playtest,
    talkAndDebug,
  ],
};

// The wasm sim host swaps consecutive renders across boots in the SAME
// process (the eval'd bundle leaves global render state behind that the next
// boot reads), so each figure is captured in its own child process. One boot,
// one render per process keeps every figure byte-exact.
//
// Spawn with an explicit `env` object: without it Bun's sync spawn takes a
// fork-style path that shares the parent's evaluated module state with the
// child, and the child's first render comes back swapped with a later boot's
// state. A fresh environ forces the exec path and full process isolation.
const shotArg = process.argv[2];
if (shotArg === "--shot") {
  const name = process.argv[3]!;
  const steps = SHOTS[name];
  if (!steps) throw new Error(`unknown shot: ${name}`);
  await capture(name, steps);
} else {
  for (const name of Object.keys(SHOTS)) {
    const r = Bun.spawnSync({
      cmd: ["bun", fileURLToPath(import.meta.url), "--shot", name],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, EDITOR_TUTORIAL_SHOT: name },
    });
    if (r.exitCode !== 0) throw new Error(`shot ${name} exited ${r.exitCode}`);
  }
  console.log("editor tutorial shots complete");
}
