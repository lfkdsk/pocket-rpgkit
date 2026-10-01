import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QoaFile } from "../src/ui/audio/qoa.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "qoa");

function referenceSamples(): Int16Array {
  const bytes = new Uint8Array(readFileSync(join(FIXTURE, "official-stereo.s16le")));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Int16Array(bytes.byteLength / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true);
  return samples;
}

describe("streaming QOA decoder", () => {
  test("is bit-exact against the official C decoder across channels and frames", () => {
    const bytes = new Uint8Array(readFileSync(join(FIXTURE, "official-stereo.qoa")));
    const file = new QoaFile(bytes);
    const stream = file.stream();
    const expected = referenceSamples();

    expect({ frames: file.frames, channels: file.channels, sampleRate: file.sampleRate })
      .toEqual({ frames: 5_143, channels: 2, sampleRate: 22_050 });
    expect(expected.length).toBe(file.frames * file.channels);
    for (let frame = 0; frame < file.frames; frame++) {
      for (let channel = 0; channel < file.channels; channel++) {
        expect(stream.sample(frame, channel), `frame ${frame}, channel ${channel}`)
          .toBe(expected[frame * file.channels + channel]);
      }
    }
    expect(stream.decodedFrames).toBe(file.frames);
  });

  test("decodes only the slices requested and can seek or loop backward", () => {
    const bytes = new Uint8Array(readFileSync(join(FIXTURE, "official-stereo.qoa")));
    const stream = new QoaFile(bytes).stream();
    const expected = referenceSamples();

    expect(stream.decodedFrames).toBe(0);
    expect(stream.sample(7, 0)).toBe(expected[14]);
    expect(stream.decodedFrames).toBe(20);
    expect(stream.sample(21, 1)).toBe(expected[43]);
    expect(stream.decodedFrames).toBe(40);
    expect(stream.sample(5_125, 0)).toBe(expected[10_250]);
    expect(stream.decodedFrames).toBe(60);
    expect(stream.sample(0, 1)).toBe(expected[1]);
    expect(stream.decodedFrames).toBe(80);
  });

  test("fills interleaved blocks exactly across slice and QOA frame boundaries", () => {
    const bytes = new Uint8Array(readFileSync(join(FIXTURE, "official-stereo.qoa")));
    const stream = new QoaFile(bytes).stream();
    const expected = referenceSamples();
    const output = new Int16Array(16 * 2).fill(12_345);

    stream.readInto(output, 2, 5_117, 12);
    expect([...output.subarray(0, 4)]).toEqual([12_345, 12_345, 12_345, 12_345]);
    expect([...output.subarray(4, 28)]).toEqual([...expected.subarray(5_117 * 2, 5_129 * 2)]);
    expect([...output.subarray(28)]).toEqual([12_345, 12_345, 12_345, 12_345]);
    expect(() => stream.readInto(output, 0, 5_140, 4)).toThrow(/outside stream/);
    expect(() => stream.readInto(output, 15, 0, 2)).toThrow(/outside stream/);
  });

  test("rejects malformed headers, frames, truncation, and trailing bytes", () => {
    const valid = new Uint8Array(readFileSync(join(FIXTURE, "official-stereo.qoa")));
    const changed = (offset: number, value: number): Uint8Array => {
      const copy = valid.slice();
      copy[offset] = value;
      return copy;
    };
    expect(() => new QoaFile(valid.subarray(0, 15))).toThrow(/QOA/);
    expect(() => new QoaFile(changed(0, 0))).toThrow(/QOA/);
    expect(() => new QoaFile(changed(8, 0))).toThrow(/QOA/);
    expect(() => new QoaFile(valid.subarray(0, valid.length - 1))).toThrow(/QOA/);
    const trailing = new Uint8Array(valid.length + 1);
    trailing.set(valid);
    expect(() => new QoaFile(trailing)).toThrow(/QOA/);
  });
});
