import { describe, expect, test } from "bun:test";
import { buildMiniProject } from "../examples/meadow/mini-project.ts";
import { buildGame } from "../examples/sunstone/game-data.ts";
import {
  COMPACT_MAP_MAGIC,
  decodeCompactMap,
} from "../src/engine/compact-map.ts";
import {
  canonicalMapJson,
  createJsonMapRepository,
  sha256Text,
} from "../src/engine/map-repository.ts";
import { canonicalJson } from "../src/engine/save.ts";
import type { Command, MapDef, Project } from "../src/engine/types.ts";
import { STREAMED_PROJECT } from "./fixtures/streamed/fixture-data.ts";
import { encodeCompactMap } from "../tools/lib/compact-map.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function largeMap(): MapDef {
  const width = 256;
  const height = 256;
  const cells = width * height;
  const ground = new Array<string>(cells).fill("tiles.0");
  for (let index = 0; index < cells; index += 257) {
    ground[index] = `tiles.${1 + (index % 15)}`;
  }
  const upper: [number, string][] = [];
  for (let index = 31; index < cells; index += 127) {
    upper.push([index, `tiles.${1 + (index % 15)}`]);
  }
  const passage: [number, "pass" | "block"][] = [];
  for (let index = 17; index < cells; index += 113) {
    passage.push([index, passage.length % 2 === 0 ? "block" : "pass"]);
  }
  return {
    id: "large",
    name: "Large synthetic map",
    width,
    height,
    sheets: ["tiles"],
    ground,
    upper,
    passage,
    events: [{
      id: "corner",
      x: 255,
      y: 255,
      pages: [{ trigger: "action", commands: [{ op: "text", lines: ["edge"] }] }],
    }],
  };
}

function largeProject(count = 6): Project {
  const maps = Array.from({ length: count }, (_, index) => ({
    ...largeMap(),
    id: `large-${index}`,
    name: `Large synthetic map ${index}`,
  }));
  return {
    format: "rpgkit-project/v1",
    title: "large compact project",
    tileSize: 16,
    start: { map: maps[0]!.id, x: 0, y: 0, dir: "down" },
    sheets: [{ id: "tiles", pak: "tiles", cols: 16, rows: 1 }],
    items: [],
    maps,
  };
}

function nestedIf(depth: number): Command {
  let command: Command = { op: "exit" };
  for (let index = 0; index < depth; index++) {
    command = { op: "if", if: { kind: "switch", id: `s${index}` }, then: [command] };
  }
  return command;
}

function splitterProject(): Project {
  const tiny: MapDef = {
    id: "a-tiny",
    name: "x",
    width: 1,
    height: 1,
    sheets: ["tiles"],
    ground: ["tiles.0"],
    events: [],
  };
  const room: MapDef = {
    id: "z-room",
    name: "Compressible room",
    width: 16,
    height: 16,
    sheets: ["tiles"],
    ground: new Array(16 * 16).fill("tiles.0"),
    events: [],
  };
  return {
    format: "rpgkit-project/v1",
    title: "compact splitter fixture",
    tileSize: 16,
    start: { map: tiny.id, x: 0, y: 0, dir: "down" },
    sheets: [{ id: "tiles", pak: "tiles", cols: 16, rows: 1 }],
    items: [],
    maps: [room, tiny],
  };
}

describe("compact map codec", () => {
  test("keeps the frozen rpgkit-map/1 bytes and decodes the static payload", () => {
    const map: MapDef = {
      id: "m", name: "M", width: 1, height: 1, sheets: ["t"], ground: ["t.0"],
      events: [{
        id: "e", x: 0, y: 0,
        pages: [{ trigger: "action", commands: [{ op: "text", lines: ["hi"] }] }],
      }],
    };
    const v1 = "{\"$\":\"rpgkit-map/1\",\"e\":[{\"\":[1,\"e\",4,[{\"\":[0,[{\"\":[2,[\"hi\"],3,\"text\"]}],5,\"action\"]}],6,0,7,0]}],\"g\":[\"j\",[\"t.0\"]],\"h\":1,\"i\":\"m\",\"k\":[\"commands\",\"id\",\"lines\",\"op\",\"pages\",\"trigger\",\"x\",\"y\"],\"n\":\"M\",\"s\":[\"t\"],\"w\":1}";

    expect(encodeCompactMap(map).text).toBe(v1);
    expect(canonicalJson(decodeCompactMap(JSON.parse(v1)))).toBe(canonicalJson(map));
  });

  test("Sunstone, Meadow and streamed fixtures round-trip canonically with deterministic ASCII bytes", () => {
    const fixtures: [string, Project][] = [
      ["Sunstone", buildGame().project],
      ["Meadow", buildMiniProject()],
      ["streamed", STREAMED_PROJECT],
    ];

    for (const [fixtureName, project] of fixtures) {
      let jsonBytes = 0;
      let compactBytes = 0;
      for (const map of project.maps) {
        const first = encodeCompactMap(map);
        const second = encodeCompactMap(map);
        const decoded = decodeCompactMap(JSON.parse(first.text));

        expect(first.text, `${fixtureName}/${map.id} text determinism`).toBe(second.text);
        expect([...first.bytes], `${fixtureName}/${map.id} byte determinism`).toEqual([...second.bytes]);
        expect(first.text, `${fixtureName}/${map.id} ASCII transport`).not.toMatch(/[^\x00-\x7f]/);
        expect(first.bytes.length, `${fixtureName}/${map.id} one byte per ASCII code unit`).toBe(first.text.length);
        expect(canonicalJson(decoded), `${fixtureName}/${map.id} canonical round-trip`)
          .toBe(canonicalJson(map));

        jsonBytes += canonicalMapJson(map).length;
        compactBytes += first.bytes.length;
      }
      expect(compactBytes, `${fixtureName} compact corpus size`).toBeLessThan(jsonBytes);
    }
  });

  test("the maximum-size synthetic map is deterministic, compact, and reversible", () => {
    const map = largeMap();
    const first = encodeCompactMap(map);
    const second = encodeCompactMap(map);
    const value = JSON.parse(first.text) as Record<string, unknown>;

    expect(first.bytes).toEqual(second.bytes);
    expect(first.bytes.length).toBeLessThan(canonicalMapJson(map).length);
    expect((value.g as unknown[])[0]).toBe("s");
    expect(canonicalJson(decodeCompactMap(value))).toBe(canonicalJson(map));
  });

  test("round-trips the imported-content maximum of 1,008 nested command levels", () => {
    const map: MapDef = {
      id: "deep", name: "Deep commands", width: 1, height: 1,
      sheets: ["tiles"], ground: ["tiles.0"],
      events: [{
        id: "deep-event", x: 0, y: 0,
        pages: [{ trigger: "action", commands: [nestedIf(1_008)] }],
      }],
    };
    const encoded = encodeCompactMap(map);
    expect(canonicalJson(decodeCompactMap(JSON.parse(encoded.text)))).toBe(canonicalJson(map));
  });

  test("preserves optional empty arrays separately from absent optional fields", () => {
    const empty: MapDef = {
      id: "empty-optionals",
      name: "Empty optionals",
      width: 2,
      height: 1,
      sheets: [],
      ground: ["tiles.0", null],
      upper: [],
      passage: [],
      events: [],
    };
    const absent: MapDef = {
      id: "absent-optionals",
      name: "Absent optionals",
      width: 1,
      height: 1,
      ground: [null],
    };

    const decodedEmpty = decodeCompactMap(JSON.parse(encodeCompactMap(empty).text));
    const decodedAbsent = decodeCompactMap(JSON.parse(encodeCompactMap(absent).text));
    expect(canonicalJson(decodedEmpty)).toBe(canonicalJson(empty));
    expect(canonicalJson(decodedAbsent)).toBe(canonicalJson(absent));
    for (const key of ["sheets", "upper", "passage", "events"]) {
      expect(hasOwn(decodedEmpty, key), `empty map retains ${key}`).toBe(true);
      expect(hasOwn(decodedAbsent, key), `absent map omits ${key}`).toBe(false);
    }
  });

  test("non-increasing sparse layers fall back to raw pairs without reordering or deduplication", () => {
    const map: MapDef = {
      id: "authored-order",
      name: "Authored order",
      width: 4,
      height: 1,
      sheets: ["tiles"],
      ground: new Array(4).fill("tiles.0"),
      upper: [[3, "tiles.1"], [1, "tiles.2"], [1, "tiles.1"]],
      passage: [[2, "pass"], [1, "block"], [1, "pass"]],
      events: [],
    };
    const encoded = encodeCompactMap(map);
    const value = JSON.parse(encoded.text) as Record<string, unknown>;

    expect((value.u as unknown[])[0]).toBe("j");
    expect((value.p as unknown[])[0]).toBe("j");
    expect(canonicalJson(decodeCompactMap(value))).toBe(canonicalJson(map));
  });

  test("rejects malformed compact envelopes", () => {
    const malformed: [string, unknown, RegExp][] = [
      ["marker", { $: "rpgkit-map/0" }, /missing rpgkit-map\/1 marker/],
      ["ground tag", {
        $: COMPACT_MAP_MAGIC, i: "m", n: "m", w: 1, h: 1, g: ["x", ["tiles.0"]],
      }, /unsupported ground encoding/],
      ["run overflow", {
        $: COMPACT_MAP_MAGIC, i: "m", n: "m", w: 2, h: 1,
        g: ["r", ["tiles.0"], [3, 0]],
      }, /ground runs exceed map dimensions/],
      ["zero sparse delta", {
        $: COMPACT_MAP_MAGIC, i: "m", n: "m", w: 2, h: 1,
        g: ["s", ["tiles.0", "tiles.1"], 0, [0, 1]],
      }, /ground exception deltas must be positive/],
      ["event key", {
        $: COMPACT_MAP_MAGIC, i: "m", n: "m", w: 1, h: 1,
        g: ["j", ["tiles.0"]], k: ["id"], e: [{ "": [4, "bad"] }],
      }, /event key index is out of range/],
      ["oversized passage range", {
        $: COMPACT_MAP_MAGIC, i: "m", n: "m", w: 1, h: 1,
        g: ["j", ["tiles.0"]], p: ["g", [["block", "r", [0, 4_294_967_295]]]],
      }, /range is out of bounds/],
      ["invalid raw upper value", {
        $: COMPACT_MAP_MAGIC, i: "m", n: "m", w: 1, h: 1,
        g: ["j", ["tiles.0"]], u: ["j", [[0, { nope: true }]]],
      }, /tile must be a string or null/],
      ["invalid raw passage value", {
        $: COMPACT_MAP_MAGIC, i: "m", n: "m", w: 1, h: 1,
        g: ["j", ["tiles.0"]], p: ["j", [[0, "open"]]],
      }, /value must be pass or block/],
      ["unknown envelope field", {
        $: COMPACT_MAP_MAGIC, i: "m", n: "m", w: 1, h: 1,
        g: ["j", ["tiles.0"]], future: true,
      }, /unknown envelope field/],
      ["extra raw tuple field", {
        $: COMPACT_MAP_MAGIC, i: "m", n: "m", w: 1, h: 1,
        g: ["j", ["tiles.0"], "extra"],
      }, /raw ground encoding must have two fields/],
    ];

    for (const [name, value, error] of malformed) {
      expect(() => decodeCompactMap(value), name).toThrow(error);
    }
  });
});

describe("compact map splitter and repository", () => {
  test("json, compact and auto splitter modes select stable transports and checksums", () => {
    const project = splitterProject();
    const json = splitProjectMaps(project, { entryEncoding: "json" });
    const compact = splitProjectMaps(project, { entryEncoding: "compact" });
    const auto = splitProjectMaps(project, { entryEncoding: "auto" });

    expect(json.entries.map((entry) => entry.encoding)).toEqual(["json", "json"]);
    expect(compact.entries.map((entry) => entry.encoding)).toEqual(["compact", "compact"]);
    expect(auto.entries.map((entry) => [entry.meta.id, entry.encoding])).toEqual([
      ["a-tiny", "json"],
      ["z-room", "compact"],
    ]);
    expect(json.entries.map((entry) => entry.path)).toEqual([
      "maps/a-tiny.json",
      "maps/z-room.json",
    ]);
    expect(compact.entries.map((entry) => entry.path)).toEqual([
      "maps/a-tiny.rkm",
      "maps/z-room.rkm",
    ]);
    expect(auto.entries.every((entry) => entry.path.endsWith(".rkm"))).toBe(true);

    for (const split of [json, compact, auto]) {
      for (const entry of split.entries) {
        expect(entry.meta.sha256).toBe(sha256Text(entry.text));
      }
    }
    expect(JSON.parse(json.entries[0]!.text).id).toBe("a-tiny");
    expect(JSON.parse(compact.entries[0]!.text).$).toBe(COMPACT_MAP_MAGIC);

    const mixedTexts = new Map(auto.entries.map((entry) => [entry.path, entry.text]));
    const mixed = createJsonMapRepository(auto.shell.mapIndex, {
      read: () => undefined,
      readText: (entry) => mixedTexts.get(entry),
    }, { verify: true, validate: "full" });
    for (const map of project.maps) {
      expect(canonicalJson(mixed.acquire(map.id))).toBe(canonicalJson(map));
    }
  });

  test("repositories acquire compact maps identically through readText and byte sources", () => {
    const project = splitterProject();
    const split = splitProjectMaps(project, { entryEncoding: "compact" });
    const texts = new Map(split.entries.map((entry) => [entry.path, entry.text]));
    const bytes = new Map(split.entries.map((entry) => [entry.path, entry.bytes]));
    let byteFallbackReads = 0;
    const fromText = createJsonMapRepository(split.shell.mapIndex, {
      read() {
        byteFallbackReads++;
        return undefined;
      },
      readText: (entry) => texts.get(entry),
    }, { verify: true, validate: "full" });
    const fromBytes = createJsonMapRepository(split.shell.mapIndex, {
      read: (entry) => bytes.get(entry),
    }, { verify: true, validate: "full" });

    for (const map of project.maps) {
      expect(canonicalJson(fromText.acquire(map.id))).toBe(canonicalJson(map));
      expect(canonicalJson(fromBytes.acquire(map.id))).toBe(canonicalJson(map));
    }
    expect(byteFallbackReads).toBe(0);
  });

  test("splits and acquires a multi-megabyte synthetic project", () => {
    const project = largeProject();
    const jsonBytes = project.maps.reduce((sum, map) => sum + canonicalMapJson(map).length, 0);
    expect(jsonBytes).toBeGreaterThan(4_000_000);

    const split = splitProjectMaps(project, { entryEncoding: "compact" });
    const texts = new Map(split.entries.map((entry) => [entry.path, entry.text]));
    const repository = createJsonMapRepository(split.shell.mapIndex, {
      read: () => undefined,
      readText: (entry) => texts.get(entry),
    }, { verify: true, validate: "full" });

    expect(split.entries).toHaveLength(project.maps.length);
    expect(split.entries.reduce((sum, entry) => sum + entry.bytes.length, 0)).toBeLessThan(jsonBytes);
    for (const map of project.maps) {
      expect(canonicalJson(repository.acquire(map.id))).toBe(canonicalJson(map));
    }
  });
});
