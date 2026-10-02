// Save-code workload evaluated by ks2-save-code-quickjs-bench.rs in
// PocketJS's shipping QuickJS guest: encoding and decoding one save code,
// compressed and plain. Inputs are Sunstone's cave chapter save point, a
// synthetic large-game state, and optionally an external envelope the
// runner passes in (for example a save from a large imported game).

import {
  createSessionSnapshot,
  decodeEnvelopeText,
  decodeSaveCode,
  encodeSaveCode,
  type SaveSnapshot,
} from "../src/engine/save.ts";
import { deflateRaw, inflateRaw } from "../src/engine/deflate.ts";
import { utf8Encode, encodeEnvelope } from "../src/engine/save.ts";
import { createSession } from "../src/engine/session.ts";
import type { MapContentIdentity } from "../src/engine/map-repository.ts";
import { buildGame } from "../examples/sunstone/game-data.ts";
import { playWinningRun } from "../examples/sunstone/journey.ts";

interface Input {
  snapshot: SaveSnapshot;
  content: MapContentIdentity | null;
  compressed: string;
  plain: string;
  envelope: Uint8Array;
  packed: Uint8Array;
}

const inputs: Record<string, Input> = {};

function add(name: string, snapshot: SaveSnapshot, content: MapContentIdentity | null = null): void {
  const envelope = utf8Encode(encodeEnvelope(snapshot, content));
  inputs[name] = {
    snapshot,
    content,
    compressed: encodeSaveCode(snapshot, content),
    plain: encodeSaveCode(snapshot, content, { compress: false }),
    envelope,
    packed: deflateRaw(envelope),
  };
}

const { project } = buildGame();
const run = playWinningRun(60);
const session = createSession(project, 60);
const cave = run.milestones.cave;
add("sunstone", createSessionSnapshot(session, run.states[cave]!, run.masks[cave]!));

const big = createSessionSnapshot(session, run.states[cave]!, 0);
for (let i = 0; i < 600; i++) big.interp.sw.variables[`story.npc_${i % 97}.talked_${i}`] = i % 7;
for (let i = 0; i < 300; i++) big.interp.sw.self[`cave/npc_${i}`] = "A";
big.ext = {
  party: Array.from({ length: 30 }, (_, i) => ({
    slug: `monster_${i % 11}`,
    level: 5 + i,
    moves: ["tackle", "growl", "ember", "bubble"].slice(0, 1 + (i % 4)),
    stats: { hp: 20 + i, attack: 10 + (i % 5), defense: 8, speed: 9 },
  })),
};
add("large", big);

declare global {
  // eslint-disable-next-line no-var
  var __ks2Add: (name: string, envelopeText: string) => string;
  // eslint-disable-next-line no-var
  var __ks2Run: (name: string, op: string, iterations: number) => number;
  // eslint-disable-next-line no-var
  var __ks2Sizes: () => string;
}

/** Register an external envelope (its own content identity is kept). */
globalThis.__ks2Add = (name, envelopeText) => {
  const content = (JSON.parse(envelopeText) as { content?: MapContentIdentity }).content ?? null;
  add(name, decodeEnvelopeText(envelopeText, content), content);
  return name;
};

globalThis.__ks2Sizes = () =>
  Object.entries(inputs)
    .map(([name, input]) => `${name} plain=${input.plain.length} compressed=${input.compressed.length} envelope_bytes=${input.envelope.length} deflate_bytes=${input.packed.length}`)
    .join("\n");

globalThis.__ks2Run = (name, op, iterations) => {
  const input = inputs[name]!;
  let sink = 0;
  for (let i = 0; i < iterations; i++) {
    switch (op) {
      case "encode":
        sink += encodeSaveCode(input.snapshot, input.content).length;
        break;
      case "encodePlain":
        sink += encodeSaveCode(input.snapshot, input.content, { compress: false }).length;
        break;
      case "decode":
        sink += decodeSaveCode(input.compressed, input.content).interp.frame;
        break;
      case "decodePlain":
        sink += decodeSaveCode(input.plain, input.content).interp.frame;
        break;
      case "deflate":
        sink += deflateRaw(input.envelope).length;
        break;
      case "inflate":
        sink += inflateRaw(input.packed).length;
        break;
      default:
        throw new Error(`unknown op ${op}`);
    }
  }
  return sink;
};
