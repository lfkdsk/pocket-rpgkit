// Studio's play-test (editor/studio/preview.ts) on the memory host: what the
// panel's controller sends to the game — the document, the start cell or
// chapter, reloads and restarts — and what it refuses to send. The browser
// side (iframe, postMessage, forged replies, Esc) is tools/studio-verify.ts.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StudioApp } from "../editor/studio/app.ts";
import { ArtRegistry } from "../editor/studio/art.ts";
import { StudioFiles } from "../editor/studio/files.ts";
import { MemoryHost } from "../editor/studio/host-memory.ts";
import { chaptersFor, PlayTest, previewDocument, PREVIEW_LIMITS } from "../editor/studio/preview.ts";
import { PREVIEW_PROTOCOL, previewMessageBytes } from "../tools/preview/protocol.ts";
import { studioPackText } from "../tools/studio-build.ts";
import type { Project } from "../src/engine/types.ts";

const ROOT = join(import.meta.dir, "..");
const SUNSTONE = readFileSync(join(ROOT, "examples", "sunstone", "data", "sunstone.json"), "utf8");
const SLOT = "playtest-screen";

function studio(text = SUNSTONE, host = new MemoryHost()) {
  const app = new StudioApp();
  const files = new StudioFiles(app, new ArtRegistry(), host);
  expect(files.openText(text, "doc.json", "doc.json")).toBe(true);
  const play = new PlayTest(app, host, () => files.examples);
  return { host, app, files, play, game: host.playTest! };
}

/** Sunstone plus seven full 256×256 maps: just over the 4 MiB message limit. */
function oversized(): string {
  const project = JSON.parse(SUNSTONE) as Project;
  for (let i = 1; i <= 7; i++) {
    project.maps.push({ id: `big-${i}`, name: `Big ${i}`, width: 256, height: 256, sheets: ["town"], ground: new Array(256 * 256).fill("town.37"), events: [] } as unknown as Project["maps"][number]);
  }
  return `${JSON.stringify(project)}\n`;
}

describe("Studio play-test controller", () => {
  test("Play loads the export bytes and starts at the selected cell and facing", async () => {
    const { app, play, game } = studio();
    app.select({ kind: "cell", x: 9, y: 7 });
    play.dir = "up";
    await play.openIn(SLOT);
    expect(game.calls).toEqual([`connect:${SLOT}`, "load", "start:village:9:7:up", "state", "focus"]);
    expect(game.loaded).toEqual([app.session!.exportText()]);
    expect(play.status).toBe("running");
    expect(play.state).toMatchObject({ map: "village", x: 9, y: 7, dir: "up", frame: 15 });
    await play.poll();
    expect(play.state?.frame).toBe(30);
    expect(play.readings).toBe(2);
  });

  test("with no cell selected, the game starts at the project start", async () => {
    const { play, game } = studio();
    await play.openIn(SLOT);
    expect(game.calls).toContain("start:village:9:9:up");
    play.choice = { kind: "project" };
    expect(play.nextTarget()).toEqual({ kind: "tile", map: "village", x: 9, y: 9, dir: "up" });
  });

  test("an edit marks the game stale; Reload sends the latest document to the same place", async () => {
    const { app, play, game } = studio();
    app.select({ kind: "cell", x: 9, y: 7 });
    await play.openIn(SLOT);
    expect(play.stale).toBe(false);
    app.run("update-command", { map: "village", event: "elder", page: 0, address: { path: [], index: 0 }, field: "lines", value: "ELDER: Edited." });
    expect(play.stale).toBe(true);
    app.select({ kind: "none" });
    game.calls = [];
    expect(await play.play(play.target)).toBe(true);
    expect(game.calls).toEqual(["load", "start:village:9:7:down", "state", "focus"]);
    expect(JSON.parse(game.loaded.at(-1)!).maps[0].events.find((e: { id: string }) => e.id === "elder").pages[0].commands[0].lines).toEqual(["ELDER: Edited."]);
    expect(play.stale).toBe(false);
  });

  test("Restart loads the same document afresh, without later edits; after Stop it loads the latest", async () => {
    const { app, play, game } = studio();
    app.select({ kind: "cell", x: 9, y: 7 });
    await play.openIn(SLOT);
    const first = game.loaded[0]!;
    app.run("update-command", { map: "village", event: "elder", page: 0, address: { path: [], index: 0 }, field: "lines", value: "ELDER: Later." });
    game.calls = [];
    await play.restart();
    expect(game.calls).toEqual(["load", "start:village:9:7:down", "state", "focus"]);
    expect(game.loaded.at(-1)).toBe(first);
    expect(play.stale).toBe(true);
    await play.stop();
    expect(play.status).toBe("stopped");
    game.calls = [];
    await play.restart();
    expect(game.calls).toEqual(["load", "start:village:9:7:down", "state", "focus"]);
    expect(game.loaded.at(-1)).toBe(app.session!.exportText());
  });

  test("a refused start is shown, with the cell it tried", async () => {
    const { app, play, game } = studio();
    app.select({ kind: "cell", x: 9, y: 5 });
    game.failNext = { type: "start", code: "bad-start", message: "village (9, 5) holds an event" };
    await play.openIn(SLOT);
    expect(play.status).toBe("error");
    expect(play.error).toBe("Could not start at village (9, 5): village (9, 5) holds an event");
  });

  test("a failed connection is shown and the next Play connects again", async () => {
    const { play, game } = studio();
    game.failNext = { type: "connect", code: "timeout", message: "The game page did not start within 20 s." };
    await play.openIn(SLOT);
    expect(play.status).toBe("error");
    expect(play.error).toBe("The game page did not start within 20 s.");
    await play.play();
    expect(play.status).toBe("running");
    expect(game.calls.filter((call) => call.startsWith("connect"))).toHaveLength(2);
  });

  test("a document over the protocol's message limit is refused with a reason and never sent", async () => {
    const { play, game } = studio(oversized());
    await play.openIn(SLOT);
    expect(play.blocked).toMatch(/^Too large to play-test: the document is 4\.\d MiB and the preview protocol carries at most 4\.0 MiB per message\.$/);
    expect(game.calls).toEqual([]);
    expect(await play.play()).toBe(false);
    expect(game.calls).toEqual([]);
  });

  test("the size check counts the load message the way the game page does", () => {
    const { app } = studio();
    const document = previewDocument(app.session!);
    if (!document.ok) throw new Error(document.reason);
    const message = { protocol: PREVIEW_PROTOCOL, type: "load", requestId: "studio-load-000000", document: document.text };
    expect(document.bytes).toBe(previewMessageBytes(message));
    expect(document.bytes).toBeLessThan(PREVIEW_LIMITS.maxMessageBytes);
    expect(document.expanded).toBe(false);
  });

  test("a sharded pack is put together into one inline document", async () => {
    const project = JSON.parse(SUNSTONE) as Project;
    const { app, play, game } = studio(studioPackText(project));
    expect(app.session!.kind).toBe("pack");
    await play.openIn(SLOT);
    expect(play.status).toBe("running");
    expect(play.expanded).toBe(true);
    const sent = JSON.parse(game.loaded[0]!) as Project & { mapIndex?: unknown };
    expect(sent.mapIndex).toBeUndefined();
    // The pack's map index order (by id) replaces the authored order; the
    // maps themselves are unchanged.
    const byId = (maps: Project["maps"]) => [...maps].sort((a, b) => a.id.localeCompare(b.id));
    expect(byId(sent.maps)).toEqual(byId(project.maps));
    expect(sent.start).toEqual(project.start);
  });

  test("chapters come from the bundled example with the same title", async () => {
    const host = new MemoryHost();
    const chapters = [{ id: "forest", title: "Whispering Wood", snapshot: "code-forest" }];
    host.examples = [
      { id: "meadow", title: "Mini Meadow", document: "m.json", sheets: {}, sprites: {}, chapters: [{ id: "x", title: "X", snapshot: "x" }] },
      { id: "sunstone", title: (JSON.parse(SUNSTONE) as Project).title, document: "s.json", sheets: {}, sprites: {}, chapters },
    ];
    const { files, play, game } = studio(SUNSTONE, host);
    await files.loadExamples();
    expect(play.chapters()).toEqual(chapters);
    expect(chaptersFor(host.examples, "Something else")).toEqual([]);
    play.choice = { kind: "chapter", chapter: "forest" };
    await play.openIn(SLOT);
    expect(game.calls).toContain("start:chapter:forest");
    expect(game.chapters[0]).toEqual(chapters);
  });

  test("a host without play-testing says why", async () => {
    const host = new MemoryHost();
    host.playTest = null;
    const { play } = studio(SUNSTONE, host);
    expect(play.availability()).toEqual({ available: false, reason: "This host has no game to play-test in." });
    await play.openIn(SLOT);
    expect(play.status).toBe("error");
    expect(play.error).toBe("This host has no game to play-test in.");
  });

  test("a failed Stop is shown and the next Play connects again", async () => {
    const { play, game } = studio();
    await play.openIn(SLOT);
    game.failNext = { type: "stop", code: "disconnected", message: "The game was closed." };
    await play.stop();
    expect(play.status).toBe("error");
    expect(play.error).toBe("The game was closed.");
    game.calls = [];
    await play.play();
    expect(game.calls[0]).toBe(`connect:${SLOT}`);
  });

  test("Esc in the game reaches the panel; Close disconnects", async () => {
    const { play, game } = studio();
    let released = 0;
    play.onRelease(() => released++);
    await play.openIn(SLOT);
    game.release();
    expect(released).toBe(1);
    play.close();
    expect(play.status).toBe("closed");
    expect(game.calls.at(-1)).toBe("disconnect");
    expect(game.connected).toBe(false);
  });
});
