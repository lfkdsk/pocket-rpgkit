// tests/rpgmaker-import.test.ts — the RPG Maker MV/MZ importer end to end
// on the two self-written fixture projects (tests/fixtures/rpgmaker):
// schema-valid output, byte-stable files, the CLI, coverage accounting, the
// generated tile sheets' passage, and the committed play fixture
// (tests/fixtures/rmi-play/games.ts) staying in step with the importer.
// The keyed playthroughs are in rpgmaker-import-journey.test.ts.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import schema from "../src/data/schema.json";
import { validateSchema } from "../src/engine/schema-validate.ts";
import { buildPassage, canStepFrom } from "../src/engine/passability.ts";
import type { Project } from "../src/engine/types.ts";
import { RM_COMMANDS } from "../tools/rpgmaker-import/catalog.ts";
import { importToDirectory } from "../tools/rpgmaker-import/index.ts";
import { loadRmProject, RmLoadError } from "../tools/rpgmaker-import/load.ts";
import { importRmProject } from "../tools/rpgmaker-import/project.ts";
import { commandTableLines, staticCommandTable } from "../tools/rpgmaker-import/report.ts";
import { writePngBytes } from "../tools/rpgmaker-import/png.ts";
import { RMI_GAMES } from "./fixtures/rmi-play/games.ts";

const ROOT = join(import.meta.dir, "..");
const HOLLOW = join(ROOT, "tests/fixtures/rpgmaker/hollow-mz");
const STAGE = join(ROOT, "tests/fixtures/rpgmaker/stage-mv");

const hollow = await importRmProject(loadRmProject(HOLLOW));
const stage = await importRmProject(loadRmProject(STAGE));

function files(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(dir, p), readFileSync(p));
    }
  };
  walk(dir);
  return out;
}

function allCommands(project: Project): { op: string }[] {
  const out: { op: string }[] = [];
  const visit = (list: readonly unknown[]): void => {
    for (const c of list as Record<string, unknown>[]) {
      out.push(c as { op: string });
      for (const key of ["then", "else", "onWin", "onLose", "onEscape", "onDone", "onCancel"]) {
        if (Array.isArray(c[key])) visit(c[key] as unknown[]);
      }
      if (c.op === "choices") {
        for (const o of c.options as { commands: unknown[] }[]) visit(o.commands);
        if (c.cancel) visit((c.cancel as { commands: unknown[] }).commands);
      }
    }
  };
  for (const map of project.maps) for (const ev of map.events ?? []) for (const p of ev.pages) visit(p.commands);
  for (const ce of project.commonEvents ?? []) visit(ce.commands);
  return out;
}

describe("rpgmaker-import: output", () => {
  for (const [name, result] of [["hollow-mz", hollow], ["stage-mv", stage]] as const) {
    test(`${name}: the project validates against the kit schema`, () => {
      expect(validateSchema(result.project, schema as Record<string, unknown>)).toEqual([]);
    });
  }

  test("maps, sheets and start come from the RM data", () => {
    expect(hollow.project.maps.map((m) => [m.id, m.width, m.height])).toEqual([
      ["map001", 24, 16],
      ["map002", 13, 10],
      ["map003", 20, 15],
    ]);
    expect(hollow.project.start).toEqual({ map: "map001", x: 11, y: 9, dir: "down" });
    expect(hollow.project.playerName).toBe("Wren");
    expect(hollow.project.sheets.map((s) => s.id)).toEqual(["ts1", "ts2"]);
    // MV is 48 px: composed at 48 and averaged down, every sheet is 16 px.
    expect(stage.project.maps.map((m) => [m.id, m.width, m.height])).toEqual([["map001", 17, 13]]);
    for (const r of [hollow, stage]) {
      for (const sheet of r.project.sheets) {
        const img = r.images.get(`tiles/${sheet.id}.png`)!;
        expect([img.width, img.height]).toEqual([sheet.cols * 16, sheet.rows * 16]);
      }
    }
  });

  test("plugin and script commands are visible placeholders, battles a battle op", () => {
    const texts = allCommands(hollow.project).filter((c) => c.op === "text") as unknown as { lines: string[] }[];
    expect(texts.some((t) => t.lines.join(" ").includes("Plugin command not ported"))).toBe(true);
    expect(texts.some((t) => t.lines.join(" ").includes("Script not ported"))).toBe(true);
    const battles = allCommands(hollow.project).filter((c) => c.op === "battle") as unknown as {
      setup: Record<string, unknown>;
      onWin?: unknown[];
      onLose?: unknown[];
      onEscape?: unknown[];
    }[];
    expect(battles).toHaveLength(1);
    expect(battles[0]!.setup).toMatchObject({ troop: 1, name: "Golem", canEscape: true, canLose: true });
    expect(battles[0]!.onWin?.length).toBeGreaterThan(0);
    expect(battles[0]!.onLose?.length).toBeGreaterThan(0);
    expect(battles[0]!.onEscape?.length).toBeGreaterThan(0);
    for (const code of ["355", "357"]) {
      const row = hollow.cov.list("command").find((r) => r.key === code)!;
      expect(row.counts.Placeholder).toBeGreaterThan(0);
      expect(row.counts.Native + row.counts.Degraded + row.counts.Dropped).toBe(0);
    }
    expect(stage.cov.list("command").find((r) => r.key === "356")!.counts.Placeholder).toBe(1);
  });

  test("silent placeholders drop the text but still count as Placeholder", async () => {
    const silent = await importRmProject(loadRmProject(HOLLOW), { placeholders: "silent" });
    const texts = allCommands(silent.project).filter((c) => c.op === "text") as unknown as { lines: string[] }[];
    expect(texts.some((t) => t.lines.join(" ").includes("not ported"))).toBe(false);
    expect(silent.cov.list("command").find((r) => r.key === "357")!.counts.Placeholder).toBeGreaterThan(0);
  });

  test("tile passage: walls block, the fence blocks one edge, the walked-into door is opened", () => {
    const map = hollow.project.maps[0]!;
    const table = buildPassage(map, new Map(hollow.project.sheets.map((s) => [s.id, s])));
    // House wall (A3) at (9,4) blocks; grass at (11,9) passes.
    expect(canStepFrom(table, 9, 6, 2)).toBe(false);
    expect(canStepFrom(table, 11, 9, 3)).toBe(true);
    // The fence (B tile, passage bit 0x01 = down) on row y=6 east of the
    // house: leaving it downward and entering it from below are blocked,
    // walking along it is not.
    const fenceSheet = hollow.project.sheets[0]!;
    expect(Object.values(fenceSheet.dirBlock ?? {})).toContainEqual(["down"]);
    // The door (11,5) is a same-as-characters touch event on the wall: its
    // cell is opened so stepping onto it starts the transfer.
    expect(map.passage).toContainEqual([5 * map.width + 11, "pass"]);
    expect(canStepFrom(table, 11, 6, 2)).toBe(true);
  });

  test("the starting party member's switch is stored inverted", async () => {
    const r = await importRmProject(loadRmProject(HOLLOW));
    const ids = new Set<string>();
    for (const c of allCommands(r.project)) if (c.op === "switch") ids.add((c as unknown as { id: string }).id);
    // Actor 2 joins (129): a plain party switch; actor 1 is never toggled.
    expect(ids.has("party-actor002")).toBe(true);
    expect([...ids].some((id) => id.startsWith("party-out-"))).toBe(false);
  });

  test("coverage counts every command the fixtures use, by code", () => {
    const used = new Set<string>();
    for (const r of [hollow, stage]) for (const row of r.cov.list("command")) used.add(row.key);
    for (const code of ["101", "102", "111", "112", "117", "121", "122", "123", "125", "126", "129", "201", "203", "205",
      "211", "213", "214", "221", "222", "223", "224", "225", "230", "231", "235", "241", "250", "301", "302", "355", "356", "357"]) {
      expect(used.has(code)).toBe(true);
    }
    // Tile constructs are counted too.
    const tiles = new Set(hollow.cov.list("tile").map((r) => r.key));
    for (const key of ["A1 water", "A1 waterfall", "A2 ground", "A3 roof", "A4 wall top", "A5", "B-E", "shadow", "star (upper layer)"]) {
      expect(tiles.has(key)).toBe(true);
    }
  });

  test("the static table lists every MV/MZ command code with a handling", () => {
    const rows = staticCommandTable();
    const codes = RM_COMMANDS.filter((c) => !c.continuation).map((c) => c.code);
    expect(rows.map((r) => r.code)).toEqual(codes);
    for (const r of rows) expect(r.disposition).not.toBe("—");
    const by = new Map(rows.map((r) => [r.code, r]));
    expect(by.get(101)!.disposition).toBe("Native");
    expect(by.get(355)!.disposition).toBe("Placeholder");
    expect(by.get(357)!.disposition).toBe("Placeholder");
    expect(by.get(301)!.disposition).toBe("Placeholder");
    expect(by.get(236)!.needsKit).not.toBe("");
  });

  test("an encrypted deployment is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "rmi-enc-"));
    try {
      const data = join(dir, "data");
      mkdirSync(data);
      writeFileSync(join(data, "System.json"), JSON.stringify({ hasEncryptedImages: true, partyMembers: [] }));
      expect(() => loadRmProject(dir)).toThrow(RmLoadError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("rpgmaker-import: files and determinism", () => {
  test("the CLI writes byte-identical output twice, inline and sharded", async () => {
    const base = mkdtempSync(join(tmpdir(), "rmi-cli-"));
    try {
      const run = (out: string, ...extra: string[]) => {
        const proc = Bun.spawnSync([process.execPath, join(ROOT, "tools/rpgmaker-import"), HOLLOW, "--out", out, ...extra], { cwd: ROOT });
        expect(proc.exitCode).toBe(0);
        return files(out);
      };
      const a = run(join(base, "a"));
      const b = run(join(base, "b"));
      expect([...a.keys()]).toEqual([...b.keys()]);
      for (const [k, v] of a) expect(v.equals(b.get(k)!)).toBe(true);
      for (const f of ["project.json", "assets.json", "coverage.md", "coverage.json", "tiles/ts1.png", "tiles/ts2.png"]) {
        expect(a.has(f)).toBe(true);
      }
      const project = JSON.parse(a.get("project.json")!.toString("utf8")) as Project;
      expect(project).toEqual(JSON.parse(JSON.stringify(hollow.project)));
      const sharded = run(join(base, "s"), "--shard");
      const shell = JSON.parse(sharded.get("project.json")!.toString("utf8"));
      expect(shell.mapIndex.map((e: { id: string }) => e.id)).toEqual(["map001", "map002", "map003"]);
      expect([...sharded.keys()].filter((k) => k.startsWith("maps/"))).toHaveLength(3);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 30_000);

  test("generated images are a pure function of the project", async () => {
    const again = await importRmProject(loadRmProject(STAGE));
    expect([...again.images.keys()]).toEqual([...stage.images.keys()]);
    for (const [k, img] of stage.images) {
      expect(Buffer.from(writePngBytes(img)).equals(Buffer.from(writePngBytes(again.images.get(k)!)))).toBe(true);
    }
  });

  test("the committed play fixture holds the importer's current output", async () => {
    // tests/fixtures/rmi-play/games.ts is regenerated by its gen-assets.ts;
    // a stale copy would test yesterday's importer.
    expect(RMI_GAMES.hollow.project).toEqual(JSON.parse(JSON.stringify(hollow.project)));
    expect(RMI_GAMES.stage.project).toEqual(JSON.parse(JSON.stringify(stage.project)));
  });

  test("the importer is not part of any game bundle", () => {
    for (const name of ["sunstone", "meadow", "showcase", "grow", "wander", "rmi-play"]) {
      const bundle = join(ROOT, "dist", `${name}.js`);
      const text = readFileSync(bundle, "utf8");
      expect(text.includes("FLOOR_AUTOTILE_TABLE")).toBe(false);
      expect(text.includes("rpgkit-rpgmaker-assets")).toBe(false);
    }
  });
});

test("docs/rpgmaker-import.md embeds the current command table", () => {
  const doc = readFileSync(join(ROOT, "docs/rpgmaker-import.md"), "utf8");
  const begin = doc.indexOf("<!-- rpgmaker-commands:begin -->\n");
  const end = doc.indexOf("\n<!-- rpgmaker-commands:end -->");
  expect(begin).toBeGreaterThan(0);
  expect(doc.slice(begin + "<!-- rpgmaker-commands:begin -->\n".length, end)).toBe(commandTableLines().join("\n"));
});
