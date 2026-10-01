// First-visit map transport workload for slim-map-quickjs-bench.rs. Encoding
// happens once while the bundle is evaluated; every timed iteration starts
// from fresh entry text and exercises work performed in the QuickJS guest.

import { decodeCompactMap } from "../src/engine/compact-map.ts";
import {
  canonicalMapJson,
  createMapRepository,
} from "../src/engine/map-repository.ts";
import type { MapDef, MapIndexEntry } from "../src/engine/types.ts";
import { encodeCompactMap } from "./lib/compact-map.ts";

type BenchName = "jsonParse" | "compactDecode" | "jsonFirstVisit" | "compactFirstVisit";

const width = 256;
const height = 256;
const cells = width * height;
const ground = new Array<string>(cells).fill("tiles.0");
for (let index = 0; index < cells; index += 257) ground[index] = `tiles.${1 + index % 15}`;
const upper: [number, string][] = [];
for (let index = 31; index < cells; index += 127) upper.push([index, `tiles.${1 + index % 15}`]);
const passage: [number, "pass" | "block"][] = [];
for (let index = 17; index < cells; index += 113) {
  passage.push([index, passage.length % 2 === 0 ? "block" : "pass"]);
}
const map: MapDef = {
  id: "qjs-large",
  name: "QuickJS large map",
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

const jsonText = canonicalMapJson(map);
const compactText = encodeCompactMap(map).text;
const decoded = decodeCompactMap(JSON.parse(compactText));
if (canonicalMapJson(decoded) !== jsonText) throw new Error("compact benchmark fixture did not round-trip");

const meta: MapIndexEntry = {
  id: map.id,
  width,
  height,
  entry: "maps/qjs-large.rkm",
  // Synchronous package sources skip verification by default. A syntactically
  // valid value keeps index validation in both first-visit cases identical.
  sha256: "0".repeat(64),
};

function firstVisit(text: string): MapDef {
  return createMapRepository([meta], {
    read: () => undefined,
    readText: () => text,
  }).acquire(map.id);
}

function consume(value: MapDef): number {
  return value.ground.length ^ (value.upper?.length ?? 0) ^
    (value.passage?.length ?? 0) ^ (value.events?.length ?? 0);
}

const benches: Record<BenchName, () => number> = {
  jsonParse: () => consume(JSON.parse(jsonText) as MapDef),
  compactDecode: () => consume(decodeCompactMap(JSON.parse(compactText))),
  jsonFirstVisit: () => consume(firstVisit(jsonText)),
  compactFirstVisit: () => consume(firstVisit(compactText)),
};

declare global {
  // eslint-disable-next-line no-var
  var __slimMapRun: (name: BenchName, iterations: number) => number;
  // eslint-disable-next-line no-var
  var __slimMapInfo: string;
  // eslint-disable-next-line no-var
  var __slimMapSink: number;
}

globalThis.__slimMapSink = 0;
globalThis.__slimMapInfo = `SLIM_MAP_QJS_INFO width=${width} height=${height} cells=${cells} json_bytes=${jsonText.length} compact_bytes=${compactText.length}`;
globalThis.__slimMapRun = (name, iterations) => {
  const bench = benches[name];
  if (!bench) throw new Error(`unknown compact-map benchmark ${name}`);
  let sink = globalThis.__slimMapSink | 0;
  for (let iteration = 0; iteration < iterations; iteration++) sink = (sink ^ bench()) | 0;
  globalThis.__slimMapSink = sink;
  return sink;
};
