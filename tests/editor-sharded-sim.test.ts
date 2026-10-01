import { describe, expect, test } from "bun:test";
import type { MapDef, Project, ProjectShell } from "../src/engine/types.ts";
import { canonicalMapJson, createJsonMapRepository } from "../src/engine/map-repository.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";
import { ServiceMessageAssembler } from "../editor/engine/service-chunks.ts";
import { BUNDLED_PROJECTS } from "../editor/engine/projects.ts";
import { fittedView, headerButtons, HEADER_H, STATUS_H, TILE, type HeaderActionId } from "../editor/engine/layout.ts";
import { mapListWindow } from "../editor/engine/map-list.ts";
import { appPreflight } from "./helpers/boot.ts";
import { bootEditorWorld, installEditorSimIsolation, type BoundEditorWorld } from "./helpers/editor-session.ts";

const preflight = appPreflight("editor");
if (!preflight.ok) console.warn(`editor sharded sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

installEditorSimIsolation();

const W = 480;
const H = 272;

function fixture(): ReturnType<typeof splitProjectMaps> {
  const example = JSON.parse(BUNDLED_PROJECTS[0]!.json) as Project;
  const sheet = example.sheets[0]!.id;
  const maps: MapDef[] = Array.from({ length: 263 }, (_, index) => {
    const last = index === 262;
    const width = last ? 100 : 2;
    const height = last ? 100 : 2;
    return {
      id: `map_${String(index).padStart(3, "0")}`,
      name: `Map ${index}`,
      width,
      height,
      sheets: [sheet],
      ground: new Array(width * height).fill(`${sheet}.0`),
      events: [],
    };
  });
  return splitProjectMaps({
    ...example,
    title: "Sharded editor integration",
    start: { map: maps[0]!.id, x: 0, y: 0, dir: "down" },
    maps,
  });
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
  for (let index = 0; index < 4; index++) frame(world);
  return world;
}

function frame(world: BoundEditorWorld): void {
  world.frame(0);
  world.tick();
}

async function settle(world: BoundEditorWorld, done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await Promise.resolve();
    frame(world);
    if (done()) return;
  }
  throw new Error("editor did not settle");
}

function send(inbox: string[], world: BoundEditorWorld, message: unknown): void {
  inbox.push(JSON.stringify(message));
  frame(world);
}

function click(inbox: string[], world: BoundEditorWorld, x: number, y: number): void {
  send(inbox, world, { t: "mouse", x, y, d: true, b: 0 });
  send(inbox, world, { t: "mouse", x, y, d: false, b: 0 });
}

function clickHeader(inbox: string[], world: BoundEditorWorld, id: HeaderActionId, width = W): void {
  let button = headerButtons(width).find((candidate) => candidate.id === id);
  if (!button) {
    const more = headerButtons(width).find((candidate) => candidate.id === "more")!;
    click(inbox, world, more.x + Math.floor(more.w / 2), more.y + Math.floor(more.h / 2));
    button = headerButtons(width, true).find((candidate) => candidate.id === id);
  }
  expect(button).toBeDefined();
  click(inbox, world, button!.x + Math.floor(button!.w / 2), button!.y + Math.floor(button!.h / 2));
}

function logicalMessages(outbox: string[]): Record<string, unknown>[] {
  const assembler = new ServiceMessageAssembler();
  const messages: Record<string, unknown>[] = [];
  for (const line of outbox.splice(0)) {
    const value = assembler.push(JSON.parse(line));
    if (value && typeof value === "object" && !Array.isArray(value)) {
      messages.push(value as Record<string, unknown>);
    }
  }
  return messages;
}

simDescribe("sharded visual editor", () => {
  test("opens 263 maps lazily, edits the 100x100 tail map, and clears dirty only after save ack", async () => {
    const split = fixture();
    const sourceByEntry = new Map(split.entries.map((entry) => [entry.path, entry.text]));
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);

    send(inbox, world, { t: "project", shell: split.shellText, request: 70 });
    let outgoing = logicalMessages(outbox);
    expect(outgoing.find((message) => message.t === "loaded")).toMatchObject({ request: 70, ok: true });
    const firstRead = outgoing.find((message) => message.t === "map-read")!;
    expect(firstRead).toMatchObject({ entry: split.entries[0]!.path });
    expect(outgoing.filter((message) => message.t === "map-read")).toHaveLength(1);
    expect(world.probes().state()).toMatchObject({
      sharded: true,
      catalogCount: 263,
      loadedMapIds: [],
    });

    send(inbox, world, {
      t: "map-data",
      request: firstRead.request,
      entry: firstRead.entry,
      text: sourceByEntry.get(firstRead.entry as string),
    });
    await settle(world, () => world.probes().state().loadingMapIndex === null);
    expect(world.probes().state()).toMatchObject({ catalogIndex: 0, loadedMapIds: ["map_000"] });

    // AI proposal hunks use inline /maps/... paths and the proposal bridge
    // writes one inline file. A sharded session must reject both an injected
    // queue and the header action without assessing, applying, or emitting a
    // review message for the resident one-map reducer view.
    const residentBefore = canonicalMapJson(world.probes().state().editor.project.maps[0]);
    send(inbox, world, {
      t: "proposals",
      proposals: [{
        id: "stale-inline-proposal",
        title: "Must not alias the resident shard",
        rationale: "The /maps/0 path belongs to an inline project.",
        author: "test",
        createdAt: "2026-10-01T00:00:00.000Z",
        baseHash: "0".repeat(64),
        hunks: [{
          id: "tile",
          summary: "Paint inline map zero",
          changes: [{
            path: "/maps/0/ground/0",
            before: { exists: true, value: `${split.shell.sheets[0]!.id}.0` },
            after: { exists: true, value: `${split.shell.sheets[0]!.id}.1` },
          }],
        }],
      }],
    });
    expect(world.probes().state()).toMatchObject({
      sharded: true,
      proposalOpen: false,
      pendingProposals: [],
      mapListOpen: false,
      notice: { kind: "bad", text: "PROPOSALS ARE UNAVAILABLE FOR SHARDED PROJECTS" },
    });
    clickHeader(inbox, world, "proposals");
    expect(world.probes().state()).toMatchObject({
      proposalOpen: false,
      pendingProposals: [],
      mapListOpen: false,
      dirtyMapIds: [],
      notice: { kind: "bad", text: expect.stringContaining("INLINE PROJECT") },
    });
    expect(canonicalMapJson(world.probes().state().editor.project.maps[0])).toBe(residentBefore);
    expect(logicalMessages(outbox).filter((message) => message.t === "proposal-review")).toEqual([]);

    // MAP opens the virtualized catalog. End + Enter requests only map 262.
    clickHeader(inbox, world, "map");
    expect(world.probes().state().mapListOpen).toBe(true);
    expect(world.probes().state().visibleMapRows).toBeLessThanOrEqual(14);
    send(inbox, world, { t: "key", k: "End", cmd: false, sh: false, alt: false, ctl: false });
    expect(world.probes().state().mapListCursor).toBe(262);
    world.resizeViewport(720, 480);
    frame(world);
    frame(world);
    expect(world.probes().state().mapListScroll).toBe(
      mapListWindow(263, 480 - HEADER_H - STATUS_H, Infinity).maxScroll,
    );
    world.resizeViewport(W, H);
    frame(world);
    frame(world);
    expect(world.probes().state().mapListCursor).toBe(262);
    send(inbox, world, { t: "key", k: "Enter", cmd: false, sh: false, alt: false, ctl: false });
    outgoing = logicalMessages(outbox);
    const lastRead = outgoing.find((message) => message.t === "map-read")!;
    expect(lastRead).toMatchObject({ entry: split.entries[262]!.path });
    send(inbox, world, {
      t: "map-data",
      request: lastRead.request,
      entry: lastRead.entry,
      text: sourceByEntry.get(lastRead.entry as string),
    });
    await settle(world, () => world.probes().state().catalogIndex === 262);
    expect(world.probes().state().editor.project.maps[0]).toMatchObject({ id: "map_262", width: 100, height: 100 });
    expect(world.probes().state().loadedMapIds).toEqual(["map_000", "map_262"]);

    // Pick the second tile and paint the top-left cell of the large map.
    click(inbox, world, 3 + 2 * 13 + 6, HEADER_H + 33 + 6);
    const canvas = fittedView(W, H, false).frame;
    click(inbox, world, canvas.x + TILE / 2, canvas.y + TILE / 2);
    expect(world.probes().state().editor.project.maps[0].ground[0]).toBe(`${split.shell.sheets[0]!.id}.1`);

    send(inbox, world, { t: "key", k: "s", cmd: true, sh: false, alt: false, ctl: true, request: 80 });
    outgoing = logicalMessages(outbox);
    const failedSave = outgoing.find((message) => message.t === "project-save")!;
    expect(failedSave.shards).toHaveLength(1);
    expect((failedSave.shards as { entry: string }[])[0]!.entry).toBe(split.entries[262]!.path);
    expect(world.probes().state().savePending).toBe(true);
    send(inbox, world, { t: "project-saved", request: 80, ok: false, error: "injected conflict" });
    expect(world.probes().state().dirtyMapIds).toEqual(["map_262"]);
    expect(world.probes().state().editor.dirty).toBe(true);

    send(inbox, world, { t: "key", k: "s", cmd: true, sh: false, alt: false, ctl: true, request: 81 });
    outgoing = logicalMessages(outbox);
    const saved = outgoing.find((message) => message.t === "project-save")!;
    send(inbox, world, { t: "project-saved", request: 81, ok: true });
    expect(world.probes().state().savePending).toBe(false);
    expect(world.probes().state().dirtyMapIds).toEqual([]);
    expect(world.probes().state().editor.dirty).toBe(false);

    // A fresh runtime repository sees the editor's emitted shard and shell.
    const savedShell = JSON.parse(saved.shell as string) as ProjectShell;
    const changed = (saved.shards as { entry: string; text: string }[])[0]!;
    const repository = createJsonMapRepository(savedShell.mapIndex, {
      read: (entry) => entry === changed.entry ? changed.text : sourceByEntry.get(entry)!,
    }, { verify: true, validate: "full" });
    expect(repository.acquire("map_262").ground[0]).toBe(`${split.shell.sheets[0]!.id}.1`);
    expect(canonicalMapJson(repository.acquire("map_000"))).toBe(sourceByEntry.get(split.entries[0]!.path)!);
  }, 20_000);
});
