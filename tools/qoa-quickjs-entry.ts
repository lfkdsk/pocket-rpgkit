// Streaming QOA workload evaluated by qoa-quickjs-bench.rs in PocketJS's
// shipping QuickJS guest. Each iteration renders one conservative 60 Hz
// credit refill (368 mono source frames at 22.05 kHz).

import { QoaFile } from "../src/ui/audio/qoa.ts";

const SAMPLE_RATE = 22_050;
const TRACK_FRAMES = SAMPLE_RATE * 4;
const PUMP_FRAMES = 368;
const QOA_FRAME_FRAMES = 5_120;
const SLICE_FRAMES = 20;

function write16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value >>> 8;
  bytes[offset + 1] = value;
}

function write24(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value >>> 16;
  bytes[offset + 1] = value >>> 8;
  bytes[offset + 2] = value;
}

function write32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value >>> 24;
  bytes[offset + 1] = value >>> 16;
  bytes[offset + 2] = value >>> 8;
  bytes[offset + 3] = value;
}

/** A deterministic, valid mono QOA stream with varied slice payloads. */
function benchmarkQoa(): Uint8Array {
  let size = 8;
  for (let start = 0; start < TRACK_FRAMES; start += QOA_FRAME_FRAMES) {
    const frames = Math.min(QOA_FRAME_FRAMES, TRACK_FRAMES - start);
    size += 8 + 16 + Math.ceil(frames / SLICE_FRAMES) * 8;
  }
  const bytes = new Uint8Array(size);
  write32(bytes, 0, 0x716f6166);
  write32(bytes, 4, TRACK_FRAMES);
  let offset = 8;
  let seed = 0x5eed1234;
  for (let start = 0; start < TRACK_FRAMES; start += QOA_FRAME_FRAMES) {
    const frames = Math.min(QOA_FRAME_FRAMES, TRACK_FRAMES - start);
    const slices = Math.ceil(frames / SLICE_FRAMES);
    const frameSize = 8 + 16 + slices * 8;
    bytes[offset] = 1;
    write24(bytes, offset + 1, SAMPLE_RATE);
    write16(bytes, offset + 4, frames);
    write16(bytes, offset + 6, frameSize);
    // The 16-byte LMS state stays zero. Every following 64-bit slice is an
    // unconstrained QOA scalefactor/residual word, so an LCG gives a stable
    // mix of every decoder path without shipping an external recording.
    let data = offset + 24;
    for (let slice = 0; slice < slices; slice++) {
      for (let byte = 0; byte < 8; byte++) {
        seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) | 0;
        bytes[data++] = seed >>> 24;
      }
    }
    offset += frameSize;
  }
  return bytes;
}

const file = new QoaFile(benchmarkQoa());
const stream = file.stream();
let streamCursor = 0;
let controlCursor = 0;
let sink = 0;

function runStream(): void {
  const output = new Int16Array(PUMP_FRAMES);
  let outputFrame = 0;
  while (outputFrame < output.length) {
    const take = Math.min(output.length - outputFrame, file.frames - streamCursor);
    stream.readInto(output, outputFrame, streamCursor, take);
    outputFrame += take;
    streamCursor += take;
    if (streamCursor === file.frames) streamCursor = 0;
  }
  sink = (sink ^ output[0]! ^ output[output.length - 1]!) | 0;
}

function runControl(): void {
  const output = new Int16Array(PUMP_FRAMES);
  for (let frame = 0; frame < output.length; frame++) {
    output[frame] = controlCursor++;
    if (controlCursor === TRACK_FRAMES) controlCursor = 0;
  }
  sink = (sink ^ output[0]! ^ output[output.length - 1]!) | 0;
}

declare global {
  // eslint-disable-next-line no-var
  var __qoaRun: (name: "control" | "stream368", iterations: number) => number;
}

globalThis.__qoaRun = (name, iterations) => {
  const run = name === "stream368" ? runStream : name === "control" ? runControl : undefined;
  if (!run) throw new Error(`unknown QOA benchmark ${name}`);
  for (let iteration = 0; iteration < iterations; iteration++) run();
  return sink;
};
