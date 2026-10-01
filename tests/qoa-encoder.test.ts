import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QoaFile } from "../src/ui/audio/qoa.ts";
import { encodeQoa } from "../tools/lib/qoa.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "qoa");

function decodedSamples(file: QoaFile): Int16Array {
  const stream = file.stream();
  const samples = new Int16Array(file.frames * file.channels);
  for (let frame = 0; frame < file.frames; frame++) {
    for (let channel = 0; channel < file.channels; channel++) {
      samples[frame * file.channels + channel] = stream.sample(frame, channel);
    }
  }
  expect(stream.decodedFrames).toBe(file.frames);
  return samples;
}

describe("build-time QOA encoder", () => {
  test("is byte-deterministic for identical PCM", () => {
    const pcm = Int16Array.from(
      { length: 63 },
      (_, index) => (index * 7_919) % 60_001 - 30_000,
    );

    const first = encodeQoa(pcm, 1, 22_050);
    const second = encodeQoa(Int16Array.from(pcm), 1, 22_050);

    expect(second).toEqual(first);
    expect([...first.subarray(0, 8)]).toEqual([0x71, 0x6f, 0x61, 0x66, 0, 0, 0, 63]);
  });

  test("matches the official C encoder byte for byte", () => {
    const frames = 5_143;
    const pcm = new Int16Array(frames * 2);
    for (let frame = 0; frame < frames; frame++) {
      pcm[frame * 2] = ((frame * 7_919) & 0xffff) - 32_768;
      pcm[frame * 2 + 1] = ((frame * 1_237 + Math.floor(frame / 37) * 991) & 0xffff) - 32_768;
    }
    const official = new Uint8Array(readFileSync(join(FIXTURE, "official-stereo.qoa")));
    expect(encodeQoa(pcm, 2, 22_050)).toEqual(official);
  });

  test("rejects invalid channels, sample rates, sample layout, and frame count", () => {
    const mono = new Int16Array([1]);
    for (const channels of [0, 3, 9, 1.5, Number.NaN]) {
      expect(() => encodeQoa(mono, channels, 22_050)).toThrow(/channels/);
    }
    for (const sampleRate of [0, 8_000, 48_000, 0x100_0000, 22_050.5, Number.NaN]) {
      expect(() => encodeQoa(mono, 1, sampleRate)).toThrow(/sample rate/);
    }
    expect(() => encodeQoa(new Int16Array(), 1, 22_050)).toThrow(/must not be empty/);
    expect(() => encodeQoa(new Int16Array(3), 2, 22_050)).toThrow(/divisible by channels/);

    // A real Int16Array cannot be this large on all supported hosts. The
    // encoder validates length before reading samples or allocating output, so
    // an array-shaped value exercises the QOA u32 header boundary safely.
    const tooManyFrames = { length: 0x1_0000_0000 } as Int16Array;
    expect(() => encodeQoa(tooManyFrames, 1, 22_050)).toThrow(/fit in uint32/);
  });

  test("pads a short tail slice into a parseable file", () => {
    const pcm = Int16Array.from(
      { length: 23 },
      (_, index) => (index - 11) * 2_000,
    );
    const encoded = encodeQoa(pcm, 1, 22_050);

    // File header + frame header + mono LMS + two 8-byte slices.
    expect(encoded.byteLength).toBe(8 + 8 + 16 + 2 * 8);
    const file = new QoaFile(encoded);
    expect({ frames: file.frames, channels: file.channels, sampleRate: file.sampleRate }).toEqual({
      frames: 23,
      channels: 1,
      sampleRate: 22_050,
    });
    const decoded = decodedSamples(file);
    expect(decoded).toHaveLength(23);
    expect([...decoded].every((sample) => sample >= -32768 && sample <= 32767)).toBe(true);
  });

  test("emits stereo slices readable sample-by-sample by the runtime decoder", () => {
    const frames = 37;
    const pcm = new Int16Array(frames * 2);
    for (let frame = 0; frame < frames; frame++) {
      pcm[frame * 2] = -24_000 + frame * 900;
      pcm[frame * 2 + 1] = 24_000 - frame * 500;
    }

    const file = new QoaFile(encodeQoa(pcm, 2, 44_100));
    expect({ frames: file.frames, channels: file.channels, sampleRate: file.sampleRate }).toEqual({
      frames,
      channels: 2,
      sampleRate: 44_100,
    });
    const decoded = decodedSamples(file);
    expect(decoded).toHaveLength(frames * 2);
    expect(Array.from({ length: frames }, (_, frame) => decoded[frame * 2])
      .some((left, frame) => left !== decoded[frame * 2 + 1])).toBe(true);
  });
});
