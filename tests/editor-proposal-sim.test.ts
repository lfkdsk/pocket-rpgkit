// End-to-end proposal review over the real PocketJS wasm sim host. The test
// drives only the companion wire and visible controls, then pins one ghost
// preview frame with both a tile overlay and a moved-event box.

import { describe, expect, test } from "bun:test";
import { createSimFsHost } from "../vendor/pocketjs/hosts/sim/fs.ts";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import type { Project } from "../src/engine/types.ts";
import { sha256Text } from "../src/engine/map-repository.ts";
import { BUNDLED_PROJECTS } from "../editor/engine/projects.ts";
import { serializeProjectPreservingSource } from "../editor/engine/document.ts";
import { HEADER_H, STATUS_H, TILE, fittedView, headerButtons, mapOffset, type HeaderActionId } from "../editor/engine/layout.ts";
import { proposalActionRects, proposalRowRect } from "../editor/engine/proposal-layout.ts";
import { createProposalFromOperations } from "../editor/api/proposals.ts";
import { applyProposalHunks, proposalSemanticHash } from "../editor/proposals/model.ts";
import {
  EDITOR_SAVE_CAPABILITY_PATH,
  EDITOR_SAVE_PROTOCOL,
  EDITOR_SAVE_REQUEST_PATH,
  EDITOR_SAVE_RESULT_PATH,
  PROPOSAL_HOST_STATE_PATH,
  PROPOSAL_SESSION_PATH,
} from "../editor/proposals/types.ts";
import { FS_WRITE_TRUNCATE } from "../vendor/pocketjs/contracts/spec/fs.ts";
import { appPreflight, fnv1a } from "./helpers/boot.ts";
import {
  bootEditorWorld,
  installEditorSimIsolation,
  type BoundEditorWorld,
} from "./helpers/editor-session.ts";

const preflight = appPreflight("editor");
if (!preflight.ok) console.warn(`editor proposal sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

installEditorSimIsolation();

const W = 480;
const H = 272;
const SUNSTONE = BUNDLED_PROJECTS.find((document) => document.id === "sunstone")!;
const PROJECT = JSON.parse(SUNSTONE.json) as Project;
const REQUEST = {
  id: "agent-village-review",
  title: "Polish village welcome",
  rationale: "Make the path clearer and move the elder beside it.",
  author: "local-agent",
  createdAt: "2026-09-30T12:00:00.000Z",
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
};

type World = BoundEditorWorld;
let live: World | null = null;
const probes = () => live!.probes();

function frame(world: World): void {
  world.frame(0);
  world.tick();
}

async function boot(
  inbox: string[],
  outbox: string[],
  fs: ReturnType<typeof createSimFsHost>,
): Promise<World> {
  const world = await bootEditorWorld(
    60,
    { fs: fs.ns },
    (ops) => {
      ops.svcOpen = () => true;
      ops.svcPoll = () => (inbox.length ? inbox.splice(0).join("\n") : null);
      ops.svcSend = (line: string) => outbox.push(line);
    },
    { width: W, height: H },
  );
  live = world;
  for (let index = 0; index < 4; index++) frame(world);
  return world;
}

function send(inbox: string[], world: World, value: object): void {
  inbox.push(JSON.stringify(value));
  frame(world);
}

function click(inbox: string[], world: World, x: number, y: number): void {
  send(inbox, world, { t: "mouse", x, y, d: true });
  send(inbox, world, { t: "mouse", x, y, d: false });
}

function clickHeader(inbox: string[], world: World, id: HeaderActionId): void {
  const button = headerButtons(W).find((candidate) => candidate.id === id);
  expect(button).toBeDefined();
  click(inbox, world, button!.x + Math.floor(button!.w / 2), button!.y + Math.floor(button!.h / 2));
}

function clickFirstProposal(inbox: string[], world: World): void {
  const row = proposalRowRect(0, false, true);
  click(inbox, world, row.x + Math.floor(row.w / 2), HEADER_H + row.y + Math.floor(row.h / 2));
}

function changedPixels(before: Uint8Array, after: Uint8Array, x0: number, y0: number): number {
  let changed = 0;
  for (let y = y0; y < y0 + TILE; y++) {
    for (let x = x0; x < x0 + TILE; x++) {
      const offset = (y * W + x) * 4;
      if (before[offset] !== after[offset] || before[offset + 1] !== after[offset + 1] || before[offset + 2] !== after[offset + 2]) changed++;
    }
  }
  return changed;
}

function bluePixels(framebuffer: Uint8Array, x0: number, y0: number): number {
  let blue = 0;
  for (let y = y0; y < y0 + TILE; y++) {
    for (let x = x0; x < x0 + TILE; x++) {
      const offset = (y * W + x) * 4;
      const r = framebuffer[offset]!;
      const g = framebuffer[offset + 1]!;
      const b = framebuffer[offset + 2]!;
      if (b > 100 && b - r > 35 && g > 70) blue++;
    }
  }
  return blue;
}

function writeFsText(fs: ReturnType<typeof createSimFsHost>, path: string, text: string): void {
  const write = fs.ns.write as (path: string, data: string, mode: number) => number;
  expect(write(path, JSON.stringify(text), FS_WRITE_TRUNCATE)).toBe(0);
}

function readFsText(fs: ReturnType<typeof createSimFsHost>, path: string): string {
  return (fs.ns.readText as (path: string) => string)(path);
}

simDescribe("editor proposal review", () => {
  test("previews without edits, reviews per hunk, undoes acceptance once, and persists partial state", async () => {
    const proposal = createProposalFromOperations(SUNSTONE.json, REQUEST);
    const fs = createSimFsHost();
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await boot(inbox, outbox, fs);
    const before = world.render().slice();

    send(inbox, world, { t: "proposals", proposals: [proposal] });
    clickHeader(inbox, world, "proposals");
    clickFirstProposal(inbox, world);

    const previewState = probes().state();
    expect(previewState.proposalOpen).toBe(true);
    expect(previewState.selectedProposal).toBe(0);
    expect(previewState.proposalPreview).toMatchObject({
      tiles: [{ mapId: "village", layer: "ground", x: 8, y: 5, tile: "town.1" }],
      events: [{ mapId: "village", kind: "moved", id: "elder", x: 10, y: 5, fromX: 9, fromY: 5 }],
    });
    expect(previewState.editor.dirty).toBe(false);
    expect(previewState.editor.past).toHaveLength(0);
    expect(JSON.parse(probes().export().text)).toEqual(PROJECT);

    const previewFrame = world.render().slice();
    const fit = fittedView(W, H, false);
    const map = PROJECT.maps[0]!;
    const originX = fit.frame.x + mapOffset(map.width, fit.cols) * TILE;
    const originY = fit.frame.y + mapOffset(map.height, fit.rows) * TILE;
    expect(changedPixels(before, previewFrame, originX + 8 * TILE, originY + 5 * TILE)).toBeGreaterThan(80);
    expect(bluePixels(previewFrame, originX + 10 * TILE, originY + 5 * TILE)).toBeGreaterThan(150);
    const tree = JSON.stringify(world.getTree());
    expect(tree).toContain("editor-proposal-tile-ground");
    expect(tree).toContain("editor-proposal-event-moved-elder");

    const hash = fnv1a(previewFrame);
    const goldenUrl = new URL("./goldens/editor-proposals.480x272.png", import.meta.url);
    if (process.env.EDITOR_PROPOSAL_UPDATE_GOLDEN) {
      await Bun.write(goldenUrl, encodePNG(previewFrame, W, H));
      console.log(`editor proposal golden 480x272: ${hash}`);
    }
    if (!process.env.EDITOR_PROPOSAL_UPDATE_GOLDEN) expect(hash).toBe("e9b62066");
    const png = new Uint8Array(await Bun.file(goldenUrl).arrayBuffer());
    const decoded = decodePng(png);
    expect({ width: decoded.width, height: decoded.height }).toEqual({ width: W, height: H });
    expect(decoded.rgba).toEqual(previewFrame);

    const actions = proposalActionRects(H - HEADER_H - STATUS_H);
    const accept = actions.find((item) => item.action.kind === "accept")!.rect;
    click(inbox, world, accept.x + 4, HEADER_H + accept.y + 4);
    const accepted = probes().state();
    expect(accepted.editor.project.maps[0]!.ground[5 * 20 + 8]).toBe("town.1");
    expect(accepted.editor.project.maps[0]!.events!.find((event: { id: string }) => event.id === "elder")!.x).toBe(9);
    expect(accepted.editor.past).toHaveLength(1);
    expect(accepted.proposals[0]!.hunks.map((hunk: { decision?: { status: string } }) => hunk.decision?.status))
      .toEqual(["accepted", undefined]);
    const messages = outbox.map((line) => JSON.parse(line));
    expect(messages.map((message) => message.t)).toEqual(["proposal-review"]);
    const saved = probes().export().text;

    send(inbox, world, { t: "key", k: "z", cmd: true, sh: false, alt: false, ctl: false });
    expect(probes().state().editor.project.maps[0]!.ground[5 * 20 + 8]).toBe("town.43");
    expect(probes().state().editor.past).toHaveLength(0);

    // A fresh editor over the same data.fs sees the partial review. Feed it
    // the host file saved above, matching the real desktop launch order.
    const inbox2: string[] = [];
    const outbox2: string[] = [];
    const world2 = await boot(inbox2, outbox2, fs);
    send(inbox2, world2, { t: "load", text: saved });
    expect(probes().state().proposals[0]!.hunks.map((hunk: { decision?: { status: string } }) => hunk.decision?.status))
      .toEqual(["accepted", undefined]);

    clickHeader(inbox2, world2, "proposals");
    clickFirstProposal(inbox2, world2);
    expect(probes().state().selectedProposalHunk).toBe(1);
    const beforeReject = probes().export().text;
    const reject = actions.find((item) => item.action.kind === "reject")!.rect;
    click(inbox2, world2, reject.x + 4, HEADER_H + reject.y + 4);
    expect(probes().export().text).toBe(beforeReject);
    expect(probes().state().proposals[0]!.hunks.map((hunk: { decision?: { status: string } }) => hunk.decision?.status))
      .toEqual(["accepted", "rejected"]);
    expect(probes().state().pendingProposals).toEqual([]);
  });

  test("pans into an expanded map and renders a ghost in the proposed column", async () => {
    const map = PROJECT.maps[0]!;
    expect(map.width).toBe(20);
    const proposal = createProposalFromOperations(SUNSTONE.json, {
      id: "expand-village",
      title: "Extend the village edge",
      rationale: "Preview one authored tile beyond the live map boundary.",
      author: "local-agent",
      createdAt: "2026-09-30T12:10:00.000Z",
      hunks: [{
        id: "east-column",
        summary: "Add and paint the east column",
        operations: [
          { command: "update-map", args: { map: map.id, changes: { width: map.width + 1 } } },
          { command: "paint-tile", args: { map: map.id, layer: "ground", x: map.width, y: 0, tile: "town.1" } },
        ],
      }, {
        id: "keep-reviewing",
        summary: "Move an event inside the live map",
        operations: [
          { command: "update-event", args: { map: map.id, event: "elder", changes: { x: 10 } } },
        ],
      }],
    });
    const fs = createSimFsHost();
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await boot(inbox, outbox, fs);
    send(inbox, world, { t: "proposals", proposals: [proposal] });
    clickHeader(inbox, world, "proposals");
    const before = world.render().slice();
    clickFirstProposal(inbox, world);

    const state = probes().state();
    expect(state.cam).toEqual({ x: 1, y: 0 });
    expect(state.proposalPreview).toMatchObject({
      maps: [{ mapId: map.id, width: 21, height: map.height }],
      tiles: [{ mapId: map.id, layer: "ground", x: 20, y: 0, tile: "town.1" }],
    });
    const tree = JSON.stringify(world.getTree());
    expect(tree).toContain("editor-proposal-tile-ground");
    const frame = world.render().slice();
    const fit = fittedView(W, H, false);
    // Camera x=1 puts proposed world x=20 in the last visible column.
    expect(changedPixels(before, frame, fit.frame.x + 19 * TILE, fit.frame.y)).toBeGreaterThan(80);

    const actions = proposalActionRects(H - HEADER_H - STATUS_H);
    const reject = actions.find((item) => item.action.kind === "reject")!.rect;
    click(inbox, world, reject.x + 4, HEADER_H + reject.y + 4);
    expect(probes().state().proposals[0]!.hunks.map((hunk: { decision?: { status: string } }) => hunk.decision?.status))
      .toEqual(["rejected", undefined]);
    expect(probes().state()).toMatchObject({ cam: { x: 0, y: 0 }, proposalPreview: { maps: [] } });

    clickHeader(inbox, world, "proposals");
    expect(probes().state()).toMatchObject({ cam: { x: 0, y: 0 }, proposalOpen: false });
  });

  test("keeps the legacy svc save path for a companion without the managed marker", async () => {
    const fs = createSimFsHost();
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await boot(inbox, outbox, fs);
    send(inbox, world, { t: "load", text: SUNSTONE.json });

    clickHeader(inbox, world, "save");
    expect(outbox.map((line) => JSON.parse(line)).filter((line) => line.t === "save")).toHaveLength(1);
    expect(readFsText(fs, EDITOR_SAVE_REQUEST_PATH)).toBe("");
  });

  test("fails closed when the explicit managed save bridge is not ready", async () => {
    const fs = createSimFsHost();
    writeFsText(fs, EDITOR_SAVE_CAPABILITY_PATH, `${JSON.stringify({ protocol: EDITOR_SAVE_PROTOCOL })}\n`);
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await boot(inbox, outbox, fs);
    send(inbox, world, { t: "load", text: SUNSTONE.json });

    clickHeader(inbox, world, "save");
    expect(outbox.map((line) => JSON.parse(line)).filter((line) => line.t === "save")).toEqual([]);
    expect(readFsText(fs, EDITOR_SAVE_REQUEST_PATH)).toBe("");
    expect(probes().state().notice.text).toContain("HOST SAVE BRIDGE IS NOT READY");
  });

  test("refuses SAVE until a host apply is confirmed and after external drift", async () => {
    const proposal = createProposalFromOperations(SUNSTONE.json, REQUEST);
    const fs = createSimFsHost();
    const baseHash = proposalSemanticHash(PROJECT);
    writeFsText(fs, PROPOSAL_SESSION_PATH, `${JSON.stringify({ projectHash: baseHash, proposals: [proposal] }, null, 2)}\n`);
    writeFsText(fs, EDITOR_SAVE_CAPABILITY_PATH, `${JSON.stringify({ protocol: EDITOR_SAVE_PROTOCOL })}\n`);
    writeFsText(fs, PROPOSAL_HOST_STATE_PATH, `${JSON.stringify({ projectHash: baseHash }, null, 2)}\n`);
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await boot(inbox, outbox, fs);
    send(inbox, world, { t: "load", text: SUNSTONE.json });
    clickHeader(inbox, world, "proposals");
    clickFirstProposal(inbox, world);
    const actions = proposalActionRects(H - HEADER_H - STATUS_H);
    const accept = actions.find((item) => item.action.kind === "accept")!.rect;
    click(inbox, world, accept.x + 4, HEADER_H + accept.y + 4);

    clickHeader(inbox, world, "save");
    expect(outbox.map((line) => JSON.parse(line)).filter((line) => line.t === "save")).toHaveLength(0);
    expect(probes().state().notice.text).toContain("WAITING FOR HOST PROPOSAL APPLY");

    const acceptedProject = applyProposalHunks(PROJECT, proposal, ["path-tile"]);
    writeFsText(fs, PROPOSAL_HOST_STATE_PATH, `${JSON.stringify({
      projectHash: proposalSemanticHash(acceptedProject),
    }, null, 2)}\n`);
    clickHeader(inbox, world, "save");

    const request = JSON.parse(readFsText(fs, EDITOR_SAVE_REQUEST_PATH));
    expect(request).toMatchObject({
      expectedSourceHash: sha256Text(serializeProjectPreservingSource(SUNSTONE.json, PROJECT, acceptedProject)),
      projectHash: proposalSemanticHash(acceptedProject),
    });
    expect(outbox.map((line) => JSON.parse(line)).filter((line) => line.t === "save")).toHaveLength(0);
    writeFsText(fs, EDITOR_SAVE_RESULT_PATH, `${JSON.stringify({
      id: request.id,
      status: "saved",
      projectHash: request.projectHash,
    })}\n`);
    frame(world);
    expect(probes().state().pendingHostSave).toBeNull();
    expect(probes().state().notice.text).toContain("SAVED");

    const externallyEdited = structuredClone(acceptedProject);
    externallyEdited.title = "Externally edited title";
    writeFsText(fs, PROPOSAL_HOST_STATE_PATH, `${JSON.stringify({
      projectHash: proposalSemanticHash(externallyEdited),
    }, null, 2)}\n`);
    clickHeader(inbox, world, "save");
    expect(outbox.map((line) => JSON.parse(line)).filter((line) => line.t === "save")).toHaveLength(0);
    expect(JSON.parse(readFsText(fs, EDITOR_SAVE_REQUEST_PATH)).id).toBe(request.id);
    expect(probes().state().notice.text).toContain("HOST FILE CHANGED SINCE IT WAS LOADED");
  });

  test("does not overwrite an unrelated edit preserved by host proposal merge", async () => {
    const proposal = createProposalFromOperations(SUNSTONE.json, REQUEST);
    const fs = createSimFsHost();
    const baseHash = proposalSemanticHash(PROJECT);
    writeFsText(fs, PROPOSAL_SESSION_PATH, `${JSON.stringify({ projectHash: baseHash, proposals: [proposal] }, null, 2)}\n`);
    writeFsText(fs, EDITOR_SAVE_CAPABILITY_PATH, `${JSON.stringify({ protocol: EDITOR_SAVE_PROTOCOL })}\n`);
    writeFsText(fs, PROPOSAL_HOST_STATE_PATH, `${JSON.stringify({ projectHash: baseHash }, null, 2)}\n`);
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await boot(inbox, outbox, fs);
    send(inbox, world, { t: "load", text: SUNSTONE.json });
    clickHeader(inbox, world, "proposals");
    clickFirstProposal(inbox, world);
    const actions = proposalActionRects(H - HEADER_H - STATUS_H);
    const accept = actions.find((item) => item.action.kind === "accept")!.rect;
    click(inbox, world, accept.x + 4, HEADER_H + accept.y + 4);

    const external = structuredClone(PROJECT);
    external.title = "Host-only title retained";
    const hostMerged = applyProposalHunks(external, proposal, ["path-tile"]);
    writeFsText(fs, PROPOSAL_HOST_STATE_PATH, `${JSON.stringify({
      projectHash: proposalSemanticHash(hostMerged),
    }, null, 2)}\n`);
    clickHeader(inbox, world, "save");

    expect(outbox.map((line) => JSON.parse(line)).filter((line) => line.t === "save")).toHaveLength(0);
    expect(probes().state().notice.text).toContain("HOST FILE CHANGED DURING PROPOSAL REVIEW");
    expect(probes().state().hostSaveGuard).not.toBeNull();
  });
});
