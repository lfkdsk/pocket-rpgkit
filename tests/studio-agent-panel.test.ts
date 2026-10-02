// Studio's Agent panel without a DOM: AgentReview (editor/studio/agent-model.ts)
// builds the request a local agent receives, lists the EditProposal values it
// answers with, and accepts one as a single undo step through
// EditSession.replaceInline. Runs on the in-memory host with a scripted agent.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_AGENT_MAX_PROMPT } from "../editor/agent/types.ts";
import { createProposalFromOperations } from "../editor/api/proposals.ts";
import { serializeShardedPack } from "../editor/api/pack.ts";
import { EditSession } from "../editor/api/session.ts";
import { serializeProjectPreservingSource } from "../editor/engine/document.ts";
import { applyProposalHunks } from "../editor/proposals/model.ts";
import type { EditProposal } from "../editor/proposals/types.ts";
import { AGENT_PACK_MESSAGE, AgentReview, compactSide } from "../editor/studio/agent-model.ts";
import { StudioApp } from "../editor/studio/app.ts";
import { NEEDS_DESKTOP, type AgentOutcome, type AgentRequest } from "../editor/studio/host.ts";
import { MemoryHost } from "../editor/studio/host-memory.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";
import type { Project } from "../src/engine/types.ts";

const ROOT = join(import.meta.dir, "..");
const SUNSTONE = readFileSync(join(ROOT, "examples", "sunstone", "data", "sunstone.json"), "utf8");

function sunstonePack(): string {
  const split = splitProjectMaps(JSON.parse(SUNSTONE) as Project);
  return serializeShardedPack(split.shellText, split.shell.mapIndex, new Map(split.entries.map((entry) => [entry.path, entry.text])));
}

/** Two independent hunks on the village: paint two tiles, move the elder. */
function villageProposal(source = SUNSTONE, id = "brighter-village"): EditProposal {
  return createProposalFromOperations(source, {
    id,
    title: "Brighter village entrance",
    rationale: "Mark the entrance and give the elder room.",
    author: "test-agent",
    createdAt: "2026-09-30T12:00:00.000Z",
    hunks: [
      {
        id: "entrance-tiles",
        summary: "Paint two entrance tiles",
        operations: [{ command: "paint-rect", args: { map: "village", layer: "ground", x: 0, y: 0, width: 2, height: 1, tile: "town.1" } }],
      },
      {
        id: "move-elder",
        summary: "Move the elder one step right",
        operations: [{ command: "update-event", args: { map: "village", event: "elder", changes: { x: 10 } } }],
      },
    ],
  });
}

function studio(options: { text?: string; reply?: (request: AgentRequest) => Promise<AgentOutcome> } = {}) {
  const host = new MemoryHost();
  if (options.reply) host.agentReply = options.reply;
  const app = new StudioApp();
  const review = new AgentReview(app, host);
  app.load(EditSession.open(options.text ?? SUNSTONE), { label: "sunstone.json", savesTo: "storage" });
  return { host, app, review, session: () => app.session! };
}

const answer = (...proposals: EditProposal[]) => async (): Promise<AgentOutcome> => ({ ok: true, proposals: proposals.map((proposal) => JSON.stringify(proposal)) });

describe("the agent request", () => {
  test("carries the prompt, the export bytes and the open map's selection", async () => {
    const { host, app, review } = studio({ reply: answer() });
    expect(review.availability().available).toBe(true);
    app.select({ kind: "cell", x: 3, y: 4 });
    review.draft = "  Put a well here  ";
    expect(await review.send()).toBe(true);
    expect(host.agentRequests).toEqual([{
      prompt: "Put a well here",
      projectText: SUNSTONE,
      context: {
        map: { id: "village", name: expect.any(String), width: 20, height: 13 },
        selectedCell: { mapId: "village", x: 3, y: 4 },
        selectedEvent: null,
      },
    }]);
    expect(review.status).toBe("done");
    expect(review.message).toBe("The agent finished without proposing a change.");

    app.select({ kind: "event", eventId: "elder", page: 0 });
    await review.send("Make the elder friendlier");
    expect(host.agentRequests[1]!.context).toMatchObject({
      selectedCell: null,
      selectedEvent: { id: "elder", name: "Village Elder", x: 9, y: 5, w: 1, h: 1, page: 0 },
    });
  });

  test("an empty or over-long request is refused before reaching the host", async () => {
    const { host, review } = studio({ reply: answer() });
    expect(await review.send("   ")).toBe(false);
    expect(review.status).toBe("error");
    expect(review.message).toBe("Describe what the agent should change.");
    expect(await review.send("x".repeat(LOCAL_AGENT_MAX_PROMPT + 1))).toBe(false);
    expect(review.message).toMatch(/limit is 4096/);
    expect(host.agentRequests).toEqual([]);
  });

  test("NEEDS_DESKTOP and FAILED outcomes show their message", async () => {
    const browserLike = studio();
    expect(browserLike.review.availability()).toEqual({ available: false, reason: NEEDS_DESKTOP });
    expect(await browserLike.review.send("Add a shop")).toBe(false);
    expect(browserLike.review.message).toBe(NEEDS_DESKTOP);
    expect(browserLike.host.agentRequests).toEqual([]);

    const needs = studio({ reply: async () => ({ ok: false, code: "NEEDS_DESKTOP", message: NEEDS_DESKTOP }) });
    expect(await needs.review.send("Add a shop")).toBe(false);
    expect(needs.review).toMatchObject({ status: "error", message: NEEDS_DESKTOP });

    const failed = studio({ reply: async () => ({ ok: false, code: "FAILED", message: "The agent exited with code 1." }) });
    expect(await failed.review.send("Add a shop")).toBe(false);
    expect(failed.review).toMatchObject({ status: "error", message: "The agent exited with code 1." });

    const threw = studio({ reply: async () => { throw new Error("bridge closed"); } });
    expect(await threw.review.send("Add a shop")).toBe(false);
    expect(threw.review.message).toBe("The agent run failed: bridge closed");
  });

  test("cancel stops waiting, tells the host and drops the late answer", async () => {
    let release!: (outcome: AgentOutcome) => void;
    const { host, review } = studio({ reply: () => new Promise<AgentOutcome>((resolve) => { release = resolve; }) });
    const sent = review.send("Add a shop");
    expect(review.status).toBe("running");
    expect(await review.send("again")).toBe(false);
    review.cancel();
    expect(review.status).toBe("cancelled");
    expect(host.agentCancels).toBe(1);
    release({ ok: true, proposals: [JSON.stringify(villageProposal())] });
    expect(await sent).toBe(false);
    expect(review.reviews()).toEqual([]);
    expect(review.status).toBe("cancelled");
  });

  test("unreadable proposals are reported, readable ones listed", async () => {
    const { review } = studio({ reply: async () => ({ ok: true, proposals: ["{not json", JSON.stringify(villageProposal())] }) });
    expect(await review.send("Brighten the village")).toBe(true);
    expect(review.reviews().map((item) => item.id)).toEqual(["brighter-village"]);
    expect(review.message).toMatch(/^1 proposal to review\. Proposal 1 could not be read: /);
  });
});

describe("reviewing proposals", () => {
  test("a proposal on the Sunstone example is listed with clean hunks", async () => {
    const { review } = studio({ reply: answer(villageProposal()) });
    await review.send("Brighten the village");
    expect(review.message).toBe("1 proposal to review.");
    const [item] = review.reviews();
    expect(item).toMatchObject({
      id: "brighter-village",
      title: "Brighter village entrance",
      author: "test-agent",
      status: "pending",
      baseMatches: true,
      acceptable: 2,
      blocked: null,
      problem: null,
    });
    expect(item!.hunks.map((hunk) => [hunk.id, hunk.state, hunk.decision])).toEqual([
      ["entrance-tiles", "clean", null],
      ["move-elder", "clean", null],
    ]);
    expect(item!.hunks[0]!.changes).toEqual([
      { path: "/maps/0/ground/0", before: "\"town.0\"", after: "\"town.1\"" },
      { path: "/maps/0/ground/1", before: "\"town.0\"", after: "\"town.1\"" },
    ]);
    expect(item!.hunks[1]!.changes).toEqual([{ path: "/maps/0/events/1/x", before: "9", after: "10" }]);
    expect(compactSide({ exists: false })).toBe("(none)");
    expect(compactSide({ exists: true, value: "x".repeat(100) }, 10)).toBe("\"xxxxxxxx…");
  });

  test("accept changes the document exactly as proposed, as one undo step", async () => {
    const proposal = villageProposal();
    const { app, review, session } = studio({ reply: answer(proposal) });
    await review.send("Brighten the village");
    const before = JSON.parse(SUNSTONE) as Project;
    const expected = applyProposalHunks(before, proposal, ["entrance-tiles", "move-elder"]);
    const edits: string[] = [];
    app.on((reason) => edits.push(reason));

    expect(review.accept("brighter-village")).toEqual({ ok: true, message: "Accepted \"Brighter village entrance\"." });
    const accepted = session().exportText();
    expect(accepted).toBe(serializeProjectPreservingSource(SUNSTONE, before, expected));
    expect(JSON.parse(accepted)).toEqual(JSON.parse(serializeProjectPreservingSource(SUNSTONE, before, expected)));
    expect(edits).toContain("edit");
    expect(session().isDirty()).toBe(true);
    expect(session().history().map((entry) => entry.label)).toEqual(["Accept proposal: Brighter village entrance"]);
    expect(session().history()[0]!.patch.changes.map((change) => change.path)).toEqual(["/maps/0/events/1/x", "/maps/0/ground/0", "/maps/0/ground/1"]);
    expect(app.currentMap()!.events!.find((event) => event.id === "elder")!.x).toBe(10);

    const item = review.review("brighter-village")!;
    expect(item.status).toBe("accepted");
    expect(item.hunks.map((hunk) => hunk.decision)).toEqual(["accepted", "accepted"]);
    expect(item.acceptable).toBe(0);
    expect(review.accept("brighter-village").ok).toBe(false);
    expect(session().history().length).toBe(1);

    app.undo();
    expect(session().exportText()).toBe(SUNSTONE);
    expect(session().isDirty()).toBe(false);
    app.redo();
    expect(session().exportText()).toBe(accepted);
  });

  test("a stale proposal cannot be accepted and says why", async () => {
    const proposal = villageProposal();
    const { app, review, session } = studio({ reply: answer(proposal) });
    await review.send("Brighten the village");
    // The user paints one of the proposal's cells and moves the elder elsewhere.
    app.run("paint-rect", { map: "village", layer: "ground", x: 0, y: 0, width: 1, height: 1, tile: "town.2" }, "Paint");
    app.run("update-event", { map: "village", event: "elder", changes: { x: 8 } }, "Move elder");
    const edited = session().exportText();
    const item = review.review("brighter-village")!;
    expect(item.baseMatches).toBe(false);
    expect(item.hunks.map((hunk) => [hunk.state, hunk.conflicts])).toEqual([
      ["conflict", ["/maps/0/ground/0"]],
      ["conflict", ["/maps/0/events/1/x"]],
    ]);
    expect(item.acceptable).toBe(0);
    expect(item.blocked).toBe("\"Paint two entrance tiles\" conflicts at /maps/0/ground/0: the document changed there since the agent proposed it. Ask the agent again.");

    const result = review.accept("brighter-village");
    expect(result).toEqual({ ok: false, message: item.blocked! });
    expect(review.message).toBe(item.blocked!);
    expect(review.review("brighter-village")!.problem).toBe(item.blocked);
    expect(session().exportText()).toBe(edited);
    expect(session().history().map((entry) => entry.label)).toEqual(["Paint", "Move elder"]);
  });

  test("clean hunks are accepted while conflicting ones stay undecided", async () => {
    const { app, review, session } = studio({ reply: answer(villageProposal()) });
    await review.send("Brighten the village");
    app.run("update-event", { map: "village", event: "elder", changes: { x: 8 } }, "Move elder");
    const result = review.accept("brighter-village");
    expect(result).toEqual({ ok: true, message: "Accepted \"Brighter village entrance\". 1 change left undecided: it conflicts with the document." });
    const item = review.review("brighter-village")!;
    expect(item.status).toBe("partly-accepted");
    expect(item.hunks.map((hunk) => [hunk.decision, hunk.state])).toEqual([["accepted", "already-applied"], [null, "conflict"]]);
    expect(app.currentMap()!.ground.slice(0, 2)).toEqual(["town.1", "town.1"]);
    expect(app.currentMap()!.events!.find((event) => event.id === "elder")!.x).toBe(8);
    expect(session().history().map((entry) => entry.label)).toEqual(["Move elder", "Accept proposal: Brighter village entrance"]);
  });

  test("a hunk already in the document is marked accepted without a history step", async () => {
    const { app, review, session } = studio({ reply: answer(villageProposal()) });
    await review.send("Brighten the village");
    app.run("update-event", { map: "village", event: "elder", changes: { x: 10 } }, "Move elder");
    app.run("paint-rect", { map: "village", layer: "ground", x: 0, y: 0, width: 2, height: 1, tile: "town.1" }, "Paint");
    expect(review.review("brighter-village")!.hunks.map((hunk) => hunk.state)).toEqual(["already-applied", "already-applied"]);
    expect(review.accept("brighter-village").ok).toBe(true);
    expect(review.review("brighter-village")!.status).toBe("accepted");
    expect(session().history().length).toBe(2);
  });

  test("reject drops the proposal and leaves the document alone", async () => {
    const { review, session } = studio({ reply: answer(villageProposal(), villageProposal(SUNSTONE, "second")) });
    await review.send("Brighten the village");
    expect(review.reviews().map((item) => item.id)).toEqual(["brighter-village", "second"]);
    expect(review.reject("brighter-village")).toBe(true);
    expect(review.message).toBe("Rejected \"Brighter village entrance\".");
    expect(review.reviews().map((item) => item.id)).toEqual(["second"]);
    expect(review.reject("brighter-village")).toBe(false);
    expect(session().exportText()).toBe(SUNSTONE);
    expect(session().history()).toEqual([]);
  });

  test("a proposal arriving again with the same id replaces the listed one", () => {
    const { review } = studio({ reply: answer() });
    expect(review.receive([JSON.stringify(villageProposal())])).toEqual({ added: 1, invalid: [] });
    expect(review.receive([JSON.stringify({ ...villageProposal(), title: "Renamed" })])).toEqual({ added: 1, invalid: [] });
    expect(review.reviews().map((item) => item.title)).toEqual(["Renamed"]);
  });

  test("opening another document clears the list", async () => {
    const { app, review } = studio({ reply: answer(villageProposal()) });
    await review.send("Brighten the village");
    expect(review.reviews().length).toBe(1);
    app.load(EditSession.open(SUNSTONE), { label: "again.json", savesTo: "storage" });
    expect(review.reviews()).toEqual([]);
    expect(review.status).toBe("idle");
  });
});

describe("sharded packs", () => {
  test("agents are refused on pack documents", async () => {
    const { host, review, session } = studio({ text: sunstonePack(), reply: answer(villageProposal()) });
    expect(session().kind).toBe("pack");
    expect(review.availability()).toEqual({ available: false, reason: AGENT_PACK_MESSAGE });
    expect(await review.send("Brighten the village")).toBe(false);
    expect(review.message).toBe(AGENT_PACK_MESSAGE);
    expect(host.agentRequests).toEqual([]);

    // A proposal that reaches the list anyway cannot be accepted.
    review.receive([JSON.stringify(villageProposal())]);
    expect(review.review("brighter-village")).toMatchObject({ blocked: AGENT_PACK_MESSAGE, acceptable: 0 });
    expect(review.accept("brighter-village")).toEqual({ ok: false, message: AGENT_PACK_MESSAGE });
    expect(session().history()).toEqual([]);
  });
});

describe("EditSession.replaceInline", () => {
  test("one validated history step; identical is a no-op; packs and invalid projects are refused", () => {
    const session = EditSession.open(SUNSTONE);
    const same = session.replaceInline("Same", JSON.parse(SUNSTONE) as Project);
    expect(same).toMatchObject({ ok: true, changed: false });
    expect(session.history()).toEqual([]);

    const invalid = structuredClone(JSON.parse(SUNSTONE)) as Project;
    invalid.start.map = "nowhere";
    const refused = session.replaceInline("Broken", invalid);
    expect(refused.ok).toBe(false);
    expect(session.history()).toEqual([]);
    expect(session.exportText()).toBe(SUNSTONE);

    const next = structuredClone(JSON.parse(SUNSTONE)) as Project;
    next.title = "Sunstone, retold";
    next.maps[0]!.ground[0] = "town.1";
    const response = session.replaceInline("Retitle", next);
    expect(response).toMatchObject({ ok: true, changed: true });
    expect(JSON.parse(session.exportText())).toEqual(next);
    expect(session.exportText()).toBe(serializeProjectPreservingSource(SUNSTONE, JSON.parse(SUNSTONE) as Project, next));
    expect(session.history().map((entry) => [entry.label, entry.patch.changes.length])).toEqual([["Retitle", 2]]);
    session.undo();
    expect(session.exportText()).toBe(SUNSTONE);
    session.redo();
    expect(JSON.parse(session.exportText())).toEqual(next);

    const pack = EditSession.open(sunstonePack());
    const packed = pack.replaceInline("Nope", next);
    expect(packed).toMatchObject({ ok: false, error: { code: "INLINE_ONLY" } });
  });
});
