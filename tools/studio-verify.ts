// tools/studio-verify.ts — drive Studio (dist/web/studio) in headless Chrome
// end to end, measure frame times and write the documentation screenshots.
//
//   bun run web && bun tools/studio-verify.ts
//   bun tools/studio-verify.ts --site dist/web --out dist/studio-verify --shots docs/screenshots/studio
//
// Checks (any console error, exception or failed request also fails):
//   load      Studio opens Sunstone and draws its map
//   paint     palette pick + brush drag paints cells through paint-cells;
//             Ctrl+Z / Ctrl+Shift+Z undo and redo it
//   event     the event tool creates an event; the inspector adds a text
//             command and writes a line of dialog
//   save      Ctrl+S stores the document; a reload restores it
//   download  the downloaded JSON passes schema validation and rpgkit-edit
//             (the CLI) reads it and lists the new event
//   pack      a sharded pack opens; editing one map and downloading changes
//             exactly that shard (plus the shell's index entry)
//   host      the page runs on the browser host; capability probing enables
//             Open folder and disables the agent and engine checks with reasons
//   folder    a loose sharded project in the origin-private file system opens
//             through the browser host's directory path; Ctrl+S writes back
//             exactly the edited shard and the shell and leaves no temporary
//             file; with the shell's write failing, Save reports the error,
//             puts the shard back and a retry succeeds; Save pressed twice
//             runs the saves one after the other (Save disabled, "saving…"
//             shown) and leaves one whole version on disk
//   limits    a picked file over the pack limit is refused before it is read;
//             the served page carries the browser host's boot script
//   perf      a 100×100 map: zoom, pan and a 200-cell stroke stay fast
//   shots     dark, light, map editing, command tree, problems, narrow

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { executeEditOperation } from "../editor/api/operations.ts";
import { parseShardedPack } from "../editor/api/pack.ts";
import { loadProject } from "../editor/engine/document.ts";
import type { Project } from "../src/engine/types.ts";
import { Cdp, launchChrome } from "./lib/cdp.ts";
import { splitProjectMaps } from "./lib/map-project.ts";

const ROOT = resolve(import.meta.dir, "..");

function option(name: string, fallback: string): string {
  const argv = process.argv.slice(2);
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1]! : fallback;
}

const SITE = resolve(option("site", join(ROOT, "dist", "web")));
const OUT = resolve(option("out", join(ROOT, "dist", "studio-verify")));
const SHOTS = resolve(option("shots", join(ROOT, "docs", "screenshots", "studio")));
const CHROME = option("chrome", Bun.which("google-chrome") ?? Bun.which("chromium") ?? "/usr/bin/google-chrome");

if (!existsSync(join(SITE, "studio", "index.html"))) {
  console.error(`studio-verify: no Studio at ${SITE}/studio; run \`bun run web\` (or bun tools/studio-build.ts) first`);
  process.exit(2);
}

interface Failure { check: string; message: string }
const failures: Failure[] = [];
const results: Record<string, unknown> = {};
const consoleErrors: string[] = [];
const requests: { url: string; status: number }[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function expect(check: string, ok: boolean, message: string): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${check}: ${message}`);
  if (!ok) failures.push({ check, message });
}

function serve() {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      const rel = decodeURIComponent(url.pathname);
      let path = resolve(SITE, `.${rel}`);
      if (!path.startsWith(SITE)) return new Response("forbidden", { status: 403 });
      if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
      const status = existsSync(path) ? 200 : 404;
      requests.push({ url: url.pathname, status });
      return status === 200 ? new Response(Bun.file(path)) : new Response("not found", { status });
    },
  });
}

/** A 100×100 copy of Sunstone's village for the frame-time measurement. */
function largeProject(): string {
  const project = JSON.parse(readFileSync(join(ROOT, "examples", "sunstone", "data", "sunstone.json"), "utf8")) as Project;
  const village = project.maps.find((map) => map.id === "village")!;
  const W = 100;
  const H = 100;
  const ground: string[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) ground.push(village.ground[(y % village.height) * village.width + (x % village.width)] as string);
  }
  const upper = (village.upper ?? []).flatMap(([index, tile]) => {
    const vx = index % village.width;
    const vy = Math.floor(index / village.width);
    const out: [number, string][] = [];
    for (let oy = 0; oy + vy < H; oy += village.height) for (let ox = 0; ox + vx < W; ox += village.width) out.push([(vy + oy) * W + vx + ox, tile as string]);
    return out;
  }).sort((a, b) => a[0] - b[0]);
  project.maps.push({ id: "large", name: "Large 100×100", width: W, height: H, sheets: village.sheets, ground, upper, events: [] } as unknown as Project["maps"][number]);
  project.start = { ...project.start, map: "large", x: 10, y: 10 };
  return `${JSON.stringify(project, null, 2)}\n`;
}

async function main(): Promise<void> {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  const downloads = join(OUT, "downloads");
  mkdirSync(downloads, { recursive: true });
  const server = serve();
  const base = `http://127.0.0.1:${server.port}/studio/`;
  const profile = mkdtempSync(join(OUT, "chrome-profile-"));
  const chrome = await launchChrome(CHROME, profile, "1440,900");
  const cdp = await Cdp.connect(chrome.ws);
  let phase = "startup";

  cdp.on("Runtime.consoleAPICalled", (p) => {
    if (p.type === "error" || p.type === "assert") consoleErrors.push(`[${phase}] console.${p.type}: ${p.args.map((a: any) => a.value ?? a.description).join(" ")}`);
  });
  cdp.on("Runtime.exceptionThrown", (p) => {
    consoleErrors.push(`[${phase}] exception: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`);
  });
  cdp.on("Log.entryAdded", (p) => {
    if (p.entry.level === "error") consoleErrors.push(`[${phase}] log: ${p.entry.text} ${p.entry.url ?? ""}`);
  });
  cdp.on("Network.loadingFailed", (p) => {
    if (!p.canceled) consoleErrors.push(`[${phase}] request failed: ${p.errorText}`);
  });
  cdp.on("Page.javascriptDialogOpening", () => {
    void cdp.send("Page.handleJavaScriptDialog", { accept: true });
  });
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Network.enable");
  await cdp.send("Page.enable");
  await cdp.send("DOM.enable");
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true });

  const evaluate = async <T = any>(expression: string): Promise<T> => {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`evaluate failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result.value as T;
  };
  const waitFor = async <T>(label: string, expression: string, timeout = 15_000): Promise<T> => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const value = await evaluate<T>(expression).catch(() => undefined);
      if (value) return value;
      await sleep(60);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const navigate = async (url: string) => {
    const loaded = new Promise((r) => cdp.on("Page.loadEventFired", r));
    await cdp.send("Page.navigate", { url });
    await loaded;
    await waitFor("Studio ready", `document.documentElement.dataset.ready === "1"`);
    await sleep(250);
  };
  const viewport = async (width: number, height: number, mobile = false) => {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
    await sleep(300);
  };
  const shot = async (name: string) => {
    // Transient notices would cover the panels in documentation shots.
    await evaluate(`(() => { __studio.app.notices = []; __studio.app.emit("notice"); })()`);
    await sleep(200);
    const data = await cdp.send("Page.captureScreenshot", { format: "png" });
    const path = join(SHOTS, `${name}.png`);
    writeFileSync(path, Buffer.from(data.data, "base64"));
    results[`shot:${name}`] = path.slice(ROOT.length + 1);
  };
  const mouse = async (type: string, x: number, y: number, button: "left" | "right" | "middle" | "none" = "left", extra: Record<string, unknown> = {}) => {
    await cdp.send("Input.dispatchMouseEvent", { type, x, y, button, buttons: type === "mouseReleased" || button === "none" ? 0 : button === "left" ? 1 : button === "right" ? 2 : 4, clickCount: 1, ...extra });
  };
  const click = async (x: number, y: number) => {
    await mouse("mouseMoved", x, y, "none");
    await mouse("mousePressed", x, y);
    await mouse("mouseReleased", x, y);
  };
  const clickSelector = async (selector: string) => {
    const point = await evaluate<{ x: number; y: number } | null>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "nearest" });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!point) throw new Error(`no element ${selector}`);
    await click(point.x, point.y);
    await sleep(80);
  };
  const key = async (keyName: string, code: string, modifiers = 0, text?: string) => {
    const keyCode = keyName.length === 1 ? keyName.toUpperCase().charCodeAt(0) : ({ Delete: 46, Escape: 27, Enter: 13 } as Record<string, number>)[keyName] ?? 0;
    await cdp.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key: keyName, code, modifiers, windowsVirtualKeyCode: keyCode, ...(text ? { text } : {}) });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, modifiers, windowsVirtualKeyCode: keyCode });
    await sleep(60);
  };
  const CTRL = 2;
  const SHIFT = 8;
  const cell = (x: number, y: number) => evaluate<{ x: number; y: number }>(`__studio.cellToClient(${x}, ${y})`);
  const drag = async (cells: [number, number][], button: "left" | "right" = "left") => {
    const points = [];
    for (const [x, y] of cells) points.push(await cell(x, y));
    await mouse("mouseMoved", points[0]!.x, points[0]!.y, "none");
    await mouse("mousePressed", points[0]!.x, points[0]!.y, button);
    for (const point of points.slice(1)) await mouse("mouseMoved", point.x, point.y, button);
    await mouse("mouseReleased", points.at(-1)!.x, points.at(-1)!.y, button);
    await sleep(120);
  };
  const setFile = async (selector: string, path: string) => {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    await cdp.send("DOM.setFileInputFiles", { nodeId, files: [path] });
  };
  const waitDownload = async (before: Set<string>, timeout = 10_000): Promise<string> => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const done = readdirSync(downloads).filter((name) => !before.has(name) && !name.endsWith(".crdownload"));
      if (done.length > 0) return join(downloads, done[0]!);
      await sleep(100);
    }
    throw new Error("download did not finish");
  };
  const download = async (): Promise<string> => {
    const before = new Set(readdirSync(downloads));
    await clickSelector("#studio-download");
    return waitDownload(before);
  };

  try {
    // ---- load ----
    phase = "load";
    await viewport(1440, 900);
    await navigate(`${base}?example=sunstone`);
    const loaded = await evaluate<{ title: string; map: string; maps: number; kind: string }>(`({ title: __studio.app.session.title(), map: __studio.app.mapId, maps: __studio.app.session.maps().length, kind: __studio.app.session.kind })`);
    expect("load: Sunstone opens on its start map", loaded.map === "village" && loaded.maps === 3 && loaded.kind === "inline", JSON.stringify(loaded));
    await waitFor("sheet art", `__studio.art.sheetStatus("town").source === "bundled"`);
    const nonVoid = await evaluate<number>(`(() => {
      const c = document.querySelector(".map-canvas");
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      const seen = new Set();
      for (let i = 0; i < d.length; i += 4 * 97) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      return seen.size;
    })()`);
    expect("load: the canvas shows tile art", nonVoid > 30, `${nonVoid} distinct sampled colors`);
    // Headless Chrome reports a light system theme: pin it for the shots.
    await evaluate(`localStorage.setItem("pocket-rpgkit:studio:theme", "light")`);
    const originalText = await evaluate<string>(`__studio.app.session.exportText()`);

    // ---- paint ----
    phase = "paint";
    const palettePoint = await evaluate<{ x: number; y: number }>(`(() => {
      const c = document.querySelector(".palette-canvas");
      const r = c.getBoundingClientRect();
      const cols = 12, rows = 11, cell = 37;
      return { x: r.left + ((cell % cols) + 0.5) * r.width / cols, y: r.top + (Math.floor(cell / cols) + 0.5) * r.height / rows };
    })()`);
    await click(palettePoint.x, palettePoint.y);
    const brush = await evaluate<string>(`__studio.app.brush`);
    expect("paint: a palette click picks the brush", brush === "town.37", String(brush));
    await key("b", "KeyB", 0, "b");
    const stroke: [number, number][] = [[2, 2], [3, 2], [4, 2], [5, 3], [6, 3]];
    const before = await evaluate<string[]>(`[${stroke.map(([x, y]) => `__studio.tileAt(${x}, ${y})`).join(",")}]`);
    await drag(stroke);
    const after = await evaluate<string[]>(`[${stroke.map(([x, y]) => `__studio.tileAt(${x}, ${y})`).join(",")}]`);
    const history = await evaluate<{ label: string; commands: string[] }[]>(`__studio.app.session.history().map((h) => ({ label: h.label, commands: h.commands }))`);
    expect("paint: a brush drag paints every cell of the stroke", after.every((tile) => tile === "town.37"), `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    expect("paint: the stroke is one paint-cells history step", history.length === 1 && history[0]!.commands[0] === "paint-cells", JSON.stringify(history));
    await key("z", "KeyZ", CTRL);
    const undone = await evaluate<string[]>(`[${stroke.map(([x, y]) => `__studio.tileAt(${x}, ${y})`).join(",")}]`);
    const undoneText = await evaluate<string>(`__studio.app.session.exportText()`);
    expect("paint: Ctrl+Z restores the document byte-for-byte", JSON.stringify(undone) === JSON.stringify(before) && undoneText === originalText, JSON.stringify(undone));
    await key("z", "KeyZ", CTRL | SHIFT);
    const redone = await evaluate<string[]>(`[${stroke.map(([x, y]) => `__studio.tileAt(${x}, ${y})`).join(",")}]`);
    expect("paint: Ctrl+Shift+Z redoes it", redone.every((tile) => tile === "town.37"), JSON.stringify(redone));

    // ---- event ----
    phase = "event";
    await key("n", "KeyN", 0, "n");
    const target = await cell(5, 5);
    await click(target.x, target.y);
    await sleep(150);
    const created = await evaluate<{ id: string; x: number; y: number } | null>(`(() => {
      const s = __studio.app.selection;
      if (s.kind !== "event") return null;
      const e = __studio.app.currentMap().events.find((item) => item.id === s.eventId);
      return e ? { id: e.id, x: e.x, y: e.y } : null;
    })()`);
    expect("event: the event tool creates and selects an event", !!created && created.x === 5 && created.y === 5, JSON.stringify(created));
    await clickSelector('[data-action="add-command"]');
    await waitFor("command picker", `!!document.querySelector('[data-field="command-picker"]')`);
    await evaluate(`(() => { const i = document.querySelector('[data-field="command-picker"]'); i.value = "text"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await sleep(80);
    const pickerHit = await evaluate<string>(`(() => {
      const el = document.querySelector('button[data-op="text"]:not([data-action])');
      el.scrollIntoView({ block: "nearest" });
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return JSON.stringify({ r: [r.left, r.top, r.width, r.height], hit: hit?.outerHTML.slice(0, 120), inside: el.contains(hit) });
    })()`);
    results.pickerHit = pickerHit;
    await clickSelector('button[data-op="text"]:not([data-action])');
    await waitFor("inserted text command", `__studio.app.currentMap().events.find((e) => e.id === ${JSON.stringify(created?.id ?? "")})?.pages[0].commands.length === 1`);
    if (!(await evaluate<boolean>(`!!document.querySelector('[data-field="command.lines"]')`))) await clickSelector('[data-action="select-command"]');
    await waitFor("text field", `!!document.querySelector('[data-field="command.lines"]')`);
    await evaluate(`(() => {
      const f = document.querySelector('[data-field="command.lines"]');
      f.focus();
      f.value = "Hello from Studio!";
      f.dispatchEvent(new Event("input", { bubbles: true }));
      f.dispatchEvent(new Event("change", { bubbles: true }));
      f.blur();
    })()`);
    await sleep(200);
    const written = await evaluate<unknown>(`__studio.app.currentMap().events.find((e) => e.id === ${JSON.stringify(created?.id ?? "")})?.pages[0].commands`);
    expect("event: the inspector writes a line of dialog", JSON.stringify(written) === JSON.stringify([{ op: "text", lines: ["Hello from Studio!"] }]), JSON.stringify(written));

    // ---- save / restore ----
    phase = "save";
    await evaluate(`document.activeElement?.blur()`);
    await key("s", "KeyS", CTRL);
    await sleep(150);
    const stored = await evaluate<string | null>(`localStorage.getItem("pocket-rpgkit:studio:document:v1")`);
    const savedText = await evaluate<string>(`__studio.app.session.exportText()`);
    expect("save: Ctrl+S stores the export bytes in this browser", !!stored && JSON.parse(stored).text === savedText, stored ? `${stored.length} chars` : "nothing stored");
    await navigate(base);
    const restored = await evaluate<{ text: string; dirty: boolean }>(`({ text: __studio.app.session.exportText(), dirty: __studio.app.session.isDirty() })`);
    expect("save: a reload restores the saved document", restored.text === savedText && !restored.dirty, `${restored.text.length} chars, dirty ${restored.dirty}`);

    // ---- download ----
    phase = "download";
    const downloaded = await download();
    const downloadedText = readFileSync(downloaded, "utf8");
    const schema = loadProject(downloadedText);
    expect("download: the file is the export and passes the schema", downloadedText === savedText && schema.errors.length === 0, `${downloaded.split("/").pop()}, ${schema.errors.length} schema errors`);
    const cli = Bun.spawnSync([process.execPath, join(ROOT, "tools", "rpgkit-edit", "cli.ts"), "list-events", "--file", downloaded, "--json", JSON.stringify({ map: "village" })], { cwd: ROOT });
    const listed = JSON.parse(cli.stdout.toString() || "{}") as { ok?: boolean; result?: { id: string }[] };
    expect("download: rpgkit-edit reads it and lists the new event", cli.exitCode === 0 && listed.ok === true && !!listed.result?.some((event) => event.id === created?.id), `exit ${cli.exitCode}, ${listed.result?.length ?? 0} events`);
    results.download = downloaded.slice(OUT.length + 1);

    // ---- screenshots of the edited Sunstone ----
    phase = "shots";
    await shot("studio-light");
    const elder = await cell(9, 5);
    await key("v", "KeyV", 0, "v");
    await click(elder.x, elder.y);
    await sleep(200);
    // Select a command inside a choice branch so the tree shows its nesting
    // and the form shows that command's fields.
    const rows = await evaluate<number>(`document.querySelectorAll('[data-action="select-command"]').length`);
    await clickSelector(`[data-action="select-command"]:nth-of-type(1)`);
    await evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-action="select-command"]')];
      const nested = rows.find((row) => row.dataset.op === "text" && row !== rows[0]) ?? rows[rows.length - 1];
      nested.click();
    })()`);
    await sleep(250);
    await evaluate(`document.querySelector('[data-role="command-tree"]').scrollIntoView({ block: "start" })`);
    expect("shots: the elder's command tree has nested rows", rows >= 4, `${rows} rows`);
    await shot("studio-event-commands");
    await key("Escape", "Escape");

    // ---- pack ----
    phase = "pack";
    const packPath = join(OUT, "sunstone-pack.json");
    const packSource = readFileSync(join(SITE, "studio", "examples", "sunstone-pack.json"), "utf8");
    writeFileSync(packPath, packSource);
    await setFile("#studio-open-input", packPath);
    await waitFor("pack opened", `__studio.app.session?.kind === "pack"`);
    const packInfo = await evaluate<{ loaded: string[]; maps: number }>(`({ loaded: __studio.app.session.loadedEntries(), maps: __studio.app.session.maps().length })`);
    expect("pack: opening parses only the start map's shard", packInfo.maps === 3 && packInfo.loaded.length === 1, JSON.stringify(packInfo));
    await clickSelector('.map-row[data-map="forest"]');
    await sleep(200);
    const forestPalette = await evaluate<{ x: number; y: number }>(`(() => {
      const r = document.querySelector(".palette-canvas").getBoundingClientRect();
      return { x: r.left + (1 + 0.5) * r.width / 12, y: r.top + (3 + 0.5) * r.height / 11 };
    })()`);
    await click(forestPalette.x, forestPalette.y);
    await key("b", "KeyB", 0, "b");
    await drag([[3, 3], [4, 3], [5, 3]]);
    const dirty = await evaluate<string[]>(`__studio.app.session.dirtyEntries()`);
    results.packState = await evaluate<unknown>(`({ map: __studio.app.mapId, tool: __studio.app.tool, brush: __studio.app.brush, notices: __studio.app.notices.map((n) => n.text), history: __studio.app.session.history().map((h) => h.label) })`);
    expect("pack: an edit dirties exactly its shard", JSON.stringify(dirty) === JSON.stringify(["maps/forest.json"]), JSON.stringify(dirty));
    const packDownload = readFileSync(await download(), "utf8");
    const original = parseShardedPack(packSource);
    const replaced = parseShardedPack(packDownload);
    const changedShards = [...original.shards.keys()].filter((entry) => original.shards.get(entry) !== replaced.shards.get(entry));
    expect("pack: the replacement pack changes only that shard and the shell", JSON.stringify(changedShards) === JSON.stringify(["maps/forest.json"]) && replaced.shellText !== original.shellText, JSON.stringify(changedShards));
    const shardValid = executeEditOperation(JSON.stringify({ ...JSON.parse(replaced.shellText), mapIndex: undefined, mapManifestHash: undefined, mapSchemaHash: undefined, maps: [...replaced.shards.values()].map((text) => JSON.parse(text)) }), "validate");
    expect("pack: the replacement validates as a whole project", shardValid.response.ok && (shardValid.response.result as { valid: boolean }).valid, JSON.stringify(shardValid.response.ok ? (shardValid.response.result as { errors: unknown[] }).errors.slice(0, 2) : shardValid.response.error));
    await key("Escape", "Escape");

    // ---- host: capability probing drives the controls ----
    phase = "host";
    const hostState = await evaluate<{ name: string; caps: Record<string, { available: boolean; reason: string }>; agent: { disabled: boolean; title: string } }>(`(() => {
      const agent = document.querySelector("#studio-agent");
      return { name: __studio.host.name, caps: __studio.host.capabilities(), agent: { disabled: agent.disabled, title: agent.title } };
    })()`);
    results.capabilities = hostState.caps;
    expect("host: Studio runs on the browser host", hostState.name === "browser", hostState.name);
    expect("host: the agent button is disabled and says it needs the desktop app", hostState.agent.disabled && /desktop app/.test(hostState.agent.title), JSON.stringify(hostState.agent));
    await clickSelector("#studio-open");
    await sleep(150);
    const folderItem = await evaluate<{ disabled: boolean; title: string } | null>(`(() => {
      const item = document.querySelector('.menu [data-menu="Open folder…"]');
      return item ? { disabled: item.disabled, title: item.title } : null;
    })()`);
    await key("Escape", "Escape");
    expect("host: Chrome's directory picker enables Open folder…", !!folderItem && !folderItem.disabled && hostState.caps.openDirectory?.available === true, JSON.stringify(folderItem));
    await clickSelector("#status-problems");
    await sleep(150);
    const engine = await evaluate<{ disabled: boolean; title: string } | null>(`(() => { const b = document.querySelector("#studio-engine-checks"); return b ? { disabled: b.disabled, title: b.title } : null; })()`);
    await clickSelector("#status-problems");
    expect("host: engine checks are disabled with a reason", !!engine && engine.disabled && engine.title.length > 20, JSON.stringify(engine));

    // ---- folder: a loose sharded project saved in place ----
    phase = "folder";
    const split = splitProjectMaps(JSON.parse(readFileSync(join(ROOT, "examples", "sunstone", "data", "sunstone.json"), "utf8")) as Project);
    const looseFiles: Record<string, string> = { "project.json": split.shellText };
    for (const entry of split.entries) looseFiles[entry.path] = entry.text;
    await evaluate(`(async () => {
      const root = await navigator.storage.getDirectory();
      for await (const name of root.keys()) await root.removeEntry(name, { recursive: true });
      const dir = await root.getDirectoryHandle("sunstone", { create: true });
      for (const [path, text] of Object.entries(${JSON.stringify(looseFiles)})) {
        const parts = path.split("/");
        let parent = dir;
        for (const part of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(part, { create: true });
        const w = await (await parent.getFileHandle(parts.at(-1), { create: true })).createWritable();
        await w.write(text);
        await w.close();
      }
      await __studio.host.openDirectoryHandle(dir);
    })()`);
    await waitFor("folder opened", `__studio.files.target?.name === "sunstone/" && __studio.app.session?.kind === "pack"`);
    await evaluate(`__studio.app.openMap("forest")`);
    await evaluate(`__studio.app.run("paint-cells", { map: "forest", layer: "ground", cells: [[2, 2], [3, 2]], value: "town.37" }, "Paint 2 ground cells")`);
    await evaluate(`document.activeElement?.blur()`);
    await key("s", "KeyS", CTRL);
    await waitFor("folder saved", `__studio.files.lastSavedWhere === "directory"`);
    const onDisk = await evaluate<{ files: Record<string, string>; pack: string; status: string; dirty: boolean }>(`(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("sunstone");
      const files = {};
      for (const path of ${JSON.stringify(Object.keys(looseFiles))}) {
        const parts = path.split("/");
        let parent = dir;
        for (const part of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(part);
        files[path] = await (await (await parent.getFileHandle(parts.at(-1))).getFile()).text();
      }
      return { files, pack: __studio.app.session.exportText(), status: document.querySelector("#status-saved").textContent, dirty: __studio.app.session.isDirty() };
    })()`);
    const savedPack = parseShardedPack(onDisk.pack);
    const rewritten = Object.keys(looseFiles).filter((path) => onDisk.files[path] !== looseFiles[path]).sort();
    const matches = onDisk.files["project.json"] === savedPack.shellText && [...savedPack.shards].every(([entry, text]) => onDisk.files[entry] === text);
    results.folder = { rewritten, status: onDisk.status };
    expect("folder: Ctrl+S writes back exactly the edited shard and the shell", JSON.stringify(rewritten) === JSON.stringify(["maps/forest.json", "project.json"]) && matches && !onDisk.dirty, JSON.stringify({ rewritten, matches, dirty: onDisk.dirty }));
    expect("folder: the status bar names the folder", onDisk.status === "saved to sunstone/", onDisk.status);

    // Every file in the folder, recursively: a save leaves no temporaries.
    const listFolder = `(async () => {
      const out = [];
      const walk = async (dir, prefix) => {
        for await (const [name, handle] of dir.entries()) {
          if (handle.kind === "directory") await walk(handle, prefix + name + "/");
          else out.push(prefix + name);
        }
      };
      await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle("sunstone"), "");
      return out.sort();
    })()`;
    const afterSave = await evaluate<string[]>(listFolder);
    const moveSupported = await evaluate<boolean>(`typeof FileSystemFileHandle !== "undefined" && typeof FileSystemFileHandle.prototype.move === "function"`);
    expect("folder: the save leaves no temporary files", JSON.stringify(afterSave) === JSON.stringify(Object.keys(looseFiles).sort()), JSON.stringify({ files: afterSave, moveSupported }));

    // A failed shell write: the error is shown, the shard is put back, and
    // the baseline stays old so the next save succeeds.
    const readFolder = `(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("sunstone");
      const files = {};
      for (const path of ${JSON.stringify(Object.keys(looseFiles))}) {
        const parts = path.split("/");
        let parent = dir;
        for (const part of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(part);
        files[path] = await (await (await parent.getFileHandle(parts.at(-1))).getFile()).text();
      }
      return files;
    })()`;
    await evaluate(`(() => {
      const ref = __studio.files.target.ref;
      const real = ref.dir;
      const fail = () => Promise.reject(new Error("injected shell failure"));
      ref.realDir = real;
      ref.dir = {
        ...real,
        write: (path, text) => path === "project.json" ? fail() : real.write(path, text),
        ...(real.rename ? { rename: (from, to) => to === "project.json" ? fail() : real.rename(from, to) } : {}),
      };
      __studio.app.run("paint-cells", { map: "forest", layer: "ground", cells: [[4, 2]], value: "town.37" }, "Paint 1 ground cell");
    })()`);
    await evaluate(`document.activeElement?.blur()`);
    await key("s", "KeyS", CTRL);
    await waitFor("failed folder save reported", `__studio.app.notices.some((n) => n.level === "error" && n.text.includes("injected shell failure"))`);
    const failed = await evaluate<{ notice: string; dirty: boolean }>(`({ notice: __studio.app.notices.filter((n) => n.level === "error").at(-1).text, dirty: __studio.app.session.isDirty() })`);
    const afterFailure = await evaluate<Record<string, string>>(readFolder);
    const failureFiles = await evaluate<string[]>(listFolder);
    results.folderFailure = { notice: failed.notice, moveSupported };
    expect("folder: a failed shell write leaves the previous save on disk", JSON.stringify(afterFailure) === JSON.stringify(onDisk.files) && failed.dirty, JSON.stringify({ dirty: failed.dirty, changed: Object.keys(afterFailure).filter((path) => afterFailure[path] !== onDisk.files[path]) }));
    expect("folder: the failure notice says the previous version was restored", /restored maps\/forest\.json, so the folder still holds the previous version/.test(failed.notice), failed.notice);
    expect("folder: the failed save leaves no temporary files", JSON.stringify(failureFiles) === JSON.stringify(afterSave), JSON.stringify(failureFiles));
    await evaluate(`(() => { const ref = __studio.files.target.ref; ref.dir = ref.realDir; delete ref.realDir; })()`);
    await key("s", "KeyS", CTRL);
    await waitFor("retried folder save", `!__studio.app.session.isDirty()`);
    const retried = await evaluate<Record<string, string>>(readFolder);
    const retriedPack = parseShardedPack(await evaluate<string>(`__studio.app.session.exportText()`));
    expect("folder: saving again after the failure writes the edit", retried["project.json"] === retriedPack.shellText && [...retriedPack.shards].every(([entry, text]) => retried[entry] === text) && retried["maps/forest.json"] !== onDisk.files["maps/forest.json"], "retry saved");

    // Save pressed twice: the first save is held at its first file write;
    // the second waits for it (touching nothing), Save is disabled and the
    // status bar says "saving…" meanwhile, and afterwards the folder holds
    // one whole version (the later one).
    await evaluate(`(() => {
      const ref = __studio.files.target.ref;
      const real = ref.dir;
      ref.realDir = real;
      window.__saveOps = [];
      window.__releaseSave = null;
      const held = new Promise((resolve) => { window.__releaseSave = resolve; });
      let holding = true;
      const gate = async (op, path) => {
        window.__saveOps.push(op + " " + path);
        if (holding && op === "write") { holding = false; window.__saveHeld = true; await held; }
      };
      ref.dir = {
        ...real,
        read: async (path) => { await gate("read", path); return real.read(path); },
        write: async (path, text) => { await gate("write", path); return real.write(path, text); },
        remove: async (path) => { await gate("remove", path); return real.remove(path); },
        ...(real.rename ? { rename: async (from, to) => { await gate("rename", to); return real.rename(from, to); } } : {}),
      };
      __studio.app.run("paint-cells", { map: "forest", layer: "ground", cells: [[5, 2]], value: "town.37" }, "Paint 1 ground cell");
    })()`);
    await evaluate(`document.activeElement?.blur()`);
    await key("s", "KeyS", CTRL);
    await waitFor("first folder save held", `window.__saveHeld === true && __studio.files.saving === 1`);
    const opsAtHold = await evaluate<number>(`window.__saveOps.length`);
    await evaluate(`__studio.app.run("paint-cells", { map: "cave", layer: "ground", cells: [[2, 2]], value: "dun.30" }, "Paint 1 ground cell")`);
    await evaluate(`document.activeElement?.blur()`);
    await key("s", "KeyS", CTRL);
    await evaluate(`document.querySelector("#studio-save").click()`);
    await sleep(300);
    const whileHeld = await evaluate<{ saving: number; ops: number; disabled: boolean; label: string; status: string }>(`({
      saving: __studio.files.saving,
      ops: window.__saveOps.length,
      disabled: document.querySelector("#studio-save").disabled,
      label: document.querySelector("#studio-save").getAttribute("aria-label"),
      status: document.querySelector("#status-saved").textContent,
    })`);
    const savingShot = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, "folder-saving.png"), Buffer.from(savingShot.data, "base64"));
    results.folderSaving = { ...whileHeld, opsAtHold, shot: join(OUT, "folder-saving.png").slice(ROOT.length + 1) };
    expect("folder: a second Save while one runs is queued and touches nothing", whileHeld.saving === 2 && whileHeld.ops === opsAtHold, JSON.stringify({ saving: whileHeld.saving, ops: whileHeld.ops, opsAtHold }));
    expect("folder: Save is disabled and the status bar says saving… meanwhile", whileHeld.disabled && whileHeld.label === "Saving to sunstone/…" && whileHeld.status === "saving…", JSON.stringify(whileHeld));
    await evaluate(`window.__releaseSave()`);
    await waitFor("queued folder save finished", `__studio.files.saving === 0 && !__studio.app.session.isDirty()`);
    const queued = await evaluate<Record<string, string>>(readFolder);
    const queuedPack = parseShardedPack(await evaluate<string>(`__studio.app.session.exportText()`));
    const queuedFiles = await evaluate<string[]>(listFolder);
    const queuedStatus = await evaluate<string>(`document.querySelector("#status-saved").textContent`);
    expect("folder: after two overlapping Saves the shell and every map file are the later version", queued["project.json"] === queuedPack.shellText && [...queuedPack.shards].every(([entry, text]) => queued[entry] === text) && JSON.stringify(queuedFiles) === JSON.stringify(afterSave) && queuedStatus === "saved to sunstone/", JSON.stringify({ files: queuedFiles, status: queuedStatus }));
    await evaluate(`(() => { const ref = __studio.files.target.ref; ref.dir = ref.realDir; delete ref.realDir; })()`);

    // ---- limits: oversized input is refused before it is read ----
    phase = "limits";
    const openBefore = await evaluate<string>(`__studio.app.session.exportText()`);
    await evaluate(`(() => {
      const input = document.querySelector("#studio-open-input");
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(64 * 1024 * 1024 + 1)], "huge.json", { type: "application/json" }));
      input.files = transfer.files;
      input.dispatchEvent(new Event("change"));
    })()`);
    await waitFor("oversized file refused", `__studio.app.notices.some((n) => n.level === "error" && n.text.startsWith("huge.json is"))`);
    const refused = await evaluate<{ text: string; same: boolean }>(`({ text: __studio.app.notices.filter((n) => n.level === "error").at(-1).text, same: __studio.app.session.exportText() === ${JSON.stringify(openBefore)} })`);
    expect("limits: a 64 MiB + 1 byte file is refused with a visible error and the open document stays", refused.same && refused.text === "huge.json is 67,108,865 bytes; project files can be at most 32 MiB and sharded packs at most 64 MiB.", refused.text);
    const page = readFileSync(join(SITE, "studio", "index.html"), "utf8");
    const boot = page.match(/<script>[\s\S]*?<\/script>/g) ?? [];
    expect("limits: the served page carries the browser host's boot script once", boot.length === 1 && boot[0]!.includes('"pocket-rpgkit:studio:theme"') && !page.includes("studio:host-boot"), `${boot.length} inline script(s)`);

    // ---- perf ----
    phase = "perf";
    const largePath = join(OUT, "large-100x100.json");
    writeFileSync(largePath, largeProject());
    await setFile("#studio-open-input", largePath);
    await waitFor("large map", `__studio.app.mapId === "large"`);
    await sleep(400);
    const rebuild = await evaluate<number>(`__studio.canvas.lastRebuildMs`);
    // Zoom and pan as a user would: wheel steps at the pointer, then a long
    // middle-button drag. Frame cost is the draw() time Studio records.
    await evaluate(`__studio.canvas.stats.recent.length = 0`);
    const center = await evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector(".map-canvas").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    for (const delta of [-100, -100, -100, 100, 100, -100]) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: center.x, y: center.y, deltaX: 0, deltaY: delta });
      await sleep(40);
    }
    await mouse("mouseMoved", center.x, center.y, "none");
    await mouse("mousePressed", center.x, center.y, "middle");
    for (let i = 1; i <= 60; i++) {
      await mouse("mouseMoved", center.x - i * 8, center.y - i * 5, "middle");
      await sleep(16);
    }
    await mouse("mouseReleased", center.x - 480, center.y - 300, "middle");
    await sleep(100);
    const navFrames = await evaluate<number[]>(`__studio.canvas.stats.recent.slice()`);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(`__studio.canvas.fit()`);
    await sleep(200);
    await evaluate(`__studio.canvas.stats.recent.length = 0`);
    const strokeCells: [number, number][] = [];
    for (let i = 0; i < 200; i++) strokeCells.push([5 + (i % 90), 5 + Math.floor(i / 90) * 3 + (i % 7)]);
    const strokeStart = performance.now();
    await drag(strokeCells);
    const strokeWall = performance.now() - strokeStart;
    const strokeFrames = await evaluate<number[]>(`__studio.canvas.stats.recent.slice()`);
    const commitMs = await evaluate<number>(`__studio.app.lastOpMs`);
    const cacheUpdate = await evaluate<{ ms: number; cells: number }>(`({ ms: __studio.canvas.lastRebuildMs, cells: __studio.canvas.lastRebuildCells })`);
    const painted = await evaluate<{ label: string } | undefined>(`__studio.app.session.history().at(-1)`);
    const summary = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
      return { frames: values.length, median: +pick(0.5).toFixed(2), p95: +pick(0.95).toFixed(2), max: +(sorted.at(-1) ?? 0).toFixed(2) };
    };
    const perf = { rebuildMs: +rebuild.toFixed(1), navigate: summary(navFrames), stroke: summary(strokeFrames), strokeCommitMs: +commitMs.toFixed(1), cacheUpdateAfterCommit: { ms: +cacheUpdate.ms.toFixed(2), cells: cacheUpdate.cells }, strokeWallMs: Math.round(strokeWall), lastStep: painted?.label };
    results.perf = perf;
    expect("perf: zoom/pan frames on 100×100 stay under 8 ms (p95)", perf.navigate.frames > 20 && perf.navigate.p95 < 8, JSON.stringify(perf.navigate));
    expect("perf: brush stroke frames stay under 8 ms (max)", perf.stroke.frames > 5 && perf.stroke.max < 8, JSON.stringify(perf.stroke));
    expect("perf: the commit repaints no cell the preview already drew", cacheUpdate.cells === 0, JSON.stringify(cacheUpdate));
    expect("perf: a 200-cell stroke commits as one step", /Paint \d+ ground cells/.test(perf.lastStep ?? "") , `${perf.lastStep}, commit ${perf.strokeCommitMs} ms`);

    // ---- map editing shot: Sunstone forest, zoomed, passage overlay ----
    phase = "map-shot";
    await navigate(`${base}?example=sunstone`);
    await waitFor("sheet art", `__studio.art.sheetStatus("town").source === "bundled"`);
    await clickSelector('.map-row[data-map="forest"]');
    await sleep(200);
    for (const tileCell of [61, 37, 26, 3]) {
      const point = await evaluate<{ x: number; y: number }>(`(() => {
        const r = document.querySelector(".palette-canvas").getBoundingClientRect();
        return { x: r.left + (${tileCell % 12} + 0.5) * r.width / 12, y: r.top + (${Math.floor(tileCell / 12)} + 0.5) * r.height / 11 };
      })()`);
      await click(point.x, point.y);
    }
    await key("p", "KeyP", 0, "p");
    await evaluate(`__studio.canvas.setZoom(3)`);
    const hoverAt = await cell(7, 6);
    await mouse("mouseMoved", hoverAt.x, hoverAt.y, "none");
    await shot("studio-map-editing");
    await key("p", "KeyP", 0, "p");

    // ---- problems ----
    phase = "problems";
    await navigate(`${base}?example=sunstone`);
    await waitFor("sheet art", `__studio.art.sheetStatus("town").source === "bundled"`);
    // A dangling transfer and an unknown item: both are rpgkit-check findings.
    await evaluate(`__studio.app.run("insert-command", { map: "village", event: "elder", page: 0, address: { path: [], index: 0 }, command: { op: "transfer", map: "forest", x: 40, y: 40 } }, "Add a transfer")`);
    await evaluate(`__studio.app.run("insert-command", { map: "village", event: "sign", page: 0, address: { path: [], index: 0 }, command: { op: "item", item: "moonstone", set: "add", count: 1 } }, "Add an item")`);
    await sleep(500);
    await clickSelector("#status-problems");
    await sleep(200);
    const problemCount = await evaluate<number>(`document.querySelectorAll(".problem").length`);
    expect("problems: rpgkit-check findings are listed", problemCount >= 2, `${problemCount} problems`);
    await clickSelector(".problem");
    const located = await evaluate<{ kind: string; eventId?: string }>(`__studio.app.selection`);
    expect("problems: clicking a problem selects its event", located.kind === "event", JSON.stringify(located));
    await shot("studio-problems");

    // ---- narrow ----
    phase = "narrow";
    await clickSelector("#status-problems");
    await viewport(820, 1180);
    await evaluate(`__studio.canvas.fit()`);
    await shot("studio-narrow");
    const narrow = await evaluate<{ overflowX: boolean; canvas: number }>(`({ overflowX: document.documentElement.scrollWidth > innerWidth + 1, canvas: document.querySelector(".map-canvas").getBoundingClientRect().width })`);
    expect("narrow: the layout fits an 820 px window", !narrow.overflowX && narrow.canvas > 700, JSON.stringify(narrow));

    // ---- dark theme shot last so the stored theme does not leak ----
    phase = "dark";
    await viewport(1440, 900);
    await navigate(`${base}?example=sunstone`);
    await waitFor("sheet art", `__studio.art.sheetStatus("town").source === "bundled"`);
    await clickSelector("#studio-theme");
    await sleep(200);
    const theme = await evaluate<string>(`document.documentElement.dataset.theme`);
    expect("theme: the toggle switches theme", theme === "dark", theme);
    const elder2 = await cell(9, 5);
    await key("v", "KeyV", 0, "v");
    await click(elder2.x, elder2.y);
    await shot("studio-dark");
  } catch (error) {
    failures.push({ check: phase, message: error instanceof Error ? error.message : String(error) });
    console.log(`  FAIL ${phase}: ${error instanceof Error ? error.stack : error}`);
    await shot(`error-${phase}`).catch(() => {});
  } finally {
    const bad = requests.filter((r) => r.status >= 400 && !r.url.endsWith("favicon.ico"));
    expect("network: no failed requests", bad.length === 0, bad.length ? bad.map((r) => `${r.status} ${r.url}`).join(", ") : `${requests.length} requests`);
    expect("console: no errors", consoleErrors.length === 0, consoleErrors.length ? consoleErrors.join("\n") : "clean");
    await Bun.write(join(OUT, "report.json"), JSON.stringify({ failures, results, consoleErrors }, null, 2) + "\n");
    cdp.close();
    chrome.proc.kill();
    await chrome.proc.exited;
    server.stop(true);
    rmSync(profile, { recursive: true, force: true });
  }
}

await main();
console.log(`\nstudio-verify: ${failures.length === 0 ? "PASS" : `FAIL (${failures.length})`}; report in ${OUT}`);
process.exit(failures.length === 0 ? 0 : 1);
