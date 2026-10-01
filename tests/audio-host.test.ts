import { afterEach, describe, expect, test } from "bun:test";
import { AUDIO_RING_FRAMES, type AudioOps } from "@pocketjs/framework/audio";
import { audioFramesForTick } from "../vendor/pocketjs/contracts/spec/audio.ts";
import { createSimAudioSink } from "../vendor/pocketjs/hosts/sim/audio.ts";
import { AudioDriver, createAudioEffects, type AudioDriverState } from "../src/ui/audio/index.ts";

interface MockStream {
  readonly rate: number;
  readonly channels: number;
  free: number;
}

class MockAudioOps implements AudioOps {
  nextHandle = 1;
  readonly streams = new Map<number, MockStream>();
  readonly created: Array<{ handle: number; rate: number; channels: number }> = [];
  readonly destroyed: number[] = [];
  readonly writes: Array<{ handle: number; frames: number; samples: number[] }> = [];
  readonly plays: number[] = [];
  readonly pauses: number[] = [];
  readonly stops: number[] = [];
  readonly volumes: Array<{ handle: number; volume: number }> = [];
  readonly ended: number[] = [];
  readonly events: string[] = [];
  polls = 0;

  createStream(rate: number, channels: number): number {
    const handle = this.nextHandle++;
    this.streams.set(handle, { rate, channels, free: AUDIO_RING_FRAMES });
    this.created.push({ handle, rate, channels });
    return handle;
  }

  destroyStream(handle: number): void {
    this.streams.delete(handle);
    this.destroyed.push(handle);
  }

  writePcm(handle: number, buffer: ArrayBuffer): number {
    const stream = this.streams.get(handle);
    if (!stream) return 0;
    const input = new Int16Array(buffer);
    const frames = Math.min(stream.free, Math.floor(input.length / stream.channels));
    this.writes.push({
      handle,
      frames,
      samples: Array.from(input.slice(0, frames * stream.channels)),
    });
    stream.free -= frames;
    return frames;
  }

  play(handle: number): void { this.plays.push(handle); }
  pause(handle: number): void { this.pauses.push(handle); }
  stop(handle: number): void { this.stops.push(handle); }
  setVolume(handle: number, volume: number): void { this.volumes.push({ handle, volume }); }
  endStream(handle: number): void { this.ended.push(handle); }

  poll(): string | undefined {
    this.polls++;
    return this.events.shift();
  }

  /** Report that the native clock consumed `frames` since the previous sync. */
  credit(handle: number, frames: number): void {
    const stream = this.streams.get(handle)!;
    stream.free = Math.min(AUDIO_RING_FRAMES, stream.free + frames);
    this.events.push(JSON.stringify({ t: "credit", h: handle, free: stream.free }));
  }
}

function wav(samples: readonly number[], sampleRate = 11_025, channels = 1): Uint8Array {
  const dataBytes = samples.length * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, sample, true));
  return bytes;
}

function frame(
  value: number,
  audio?: AudioDriverState["interp"]["audio"],
  cues: AudioDriverState["interp"]["cues"] = [],
): AudioDriverState {
  return { frame: value, interp: { audio, cues } };
}

const originalAudio = (globalThis as { audio?: unknown }).audio;
afterEach(() => {
  (globalThis as { audio?: unknown }).audio = originalAudio;
});

describe("opt-in audio host", () => {
  test("missing host and missing resources are silent", () => {
    (globalThis as { audio?: unknown }).audio = undefined;
    const Effects = createAudioEffects({});
    expect(Effects({ state: () => frame(0) as never })).toBeNull();

    const ops = new MockAudioOps();
    let reads = 0;
    const driver = new AudioDriver(ops, { known: "audio:wav.missing" }, () => {
      reads++;
      throw new Error("not packed");
    });
    expect(() => driver.sync(frame(1, {
      bgm: { id: "known", volume: 100, pitch: 100, positionTicks: 0 },
    }, [{ name: "unknown", volume: 100, pitch: 100 }]))).not.toThrow();
    driver.sync(frame(2, {
      bgm: { id: "known", volume: 100, pitch: 100, positionTicks: 1 },
    }));
    expect(reads).toBe(1);
    expect(ops.created).toEqual([]);
  });

  test("uses full pak keys, seeks, resamples by deterministic source index, and fills all credit", () => {
    const ops = new MockAudioOps();
    const reads: string[] = [];
    const driver = new AudioDriver(
      ops,
      { field: "audio:wav.music/field" },
      (key) => {
        reads.push(key);
        return wav([10, 20, 30, 40]);
      },
    );
    driver.sync(frame(7, {
      bgm: { id: "field", volume: 75, pitch: 50, positionTicks: 1 },
    }));

    expect(reads).toEqual(["audio:wav.music/field"]);
    expect(ops.created).toEqual([{ handle: 1, rate: 11_025, channels: 1 }]);
    expect(ops.writes).toHaveLength(1);
    expect(ops.writes[0]!.frames).toBe(AUDIO_RING_FRAMES);
    // tick 1 seeks to output frame 183; at 50% pitch the first source frame is
    // floor(183 * .5) % 4 = 3, followed by the nearest-neighbour repeat.
    expect(ops.writes[0]!.samples.slice(0, 6)).toEqual([40, 10, 10, 20, 20, 30]);
    expect(ops.volumes).toEqual([{ handle: 1, volume: 0.75 }]);
    expect(ops.plays).toEqual([1]);
  });

  test("keeps BGM/BGS/ME ahead of deterministic oldest-SE eviction", () => {
    const ops = new MockAudioOps();
    const resources = Object.fromEntries(
      ["bgm", "bgs", "me", "a", "b", "c"].map((id) => [id, `audio:wav.${id}`]),
    );
    const driver = new AudioDriver(ops, resources, () => wav([1, 2, 3, 4]));
    driver.sync(frame(1, {
      bgm: { id: "bgm", volume: 100, pitch: 100, positionTicks: 0 },
      bgs: { id: "bgs", volume: 100, pitch: 100, positionTicks: 0 },
      me: {
        id: "me", volume: 100, pitch: 100, positionTicks: 0,
        durationTicks: 60, leftTicks: 60,
      },
    }, [
      { name: "a", volume: 100, pitch: 100 },
      { name: "b", volume: 100, pitch: 100 },
      { name: "c", volume: 100, pitch: 100 },
    ]));

    expect(ops.created).toHaveLength(6);
    expect(ops.streams.size).toBe(4);
    expect(ops.destroyed).toEqual([4, 5]);
    expect([...ops.streams.keys()]).toEqual([1, 2, 3, 6]);
    expect(ops.pauses).toEqual([]); // BGM was never opened while ME owns it.
    expect(ops.plays).toEqual([2, 3, 6]);
    // Evicted SE are destroyed before the common pump; the surviving SE and
    // ME are one-shots, while BGM/BGS never receive endStream.
    expect(ops.ended).toEqual([3, 6]);
  });

  test("applies reducer fade volume monotonically while refilling credits", () => {
    const ops = new MockAudioOps();
    const driver = new AudioDriver(ops, { field: "audio:wav.field" }, () => wav([1, 2, 3, 4]));
    const positionFrames = (ticks: number): number => Math.floor(ticks * 11_025 / 60);

    for (let tick = 0; tick < 4; tick++) {
      if (tick > 0) ops.credit(1, positionFrames(tick) - positionFrames(tick - 1));
      driver.sync(frame(tick + 1, {
        bgm: {
          id: "field",
          volume: 80,
          pitch: 100,
          positionTicks: tick,
          fade: { totalTicks: 4, leftTicks: 4 - tick },
        },
      }));
    }

    expect(ops.created).toHaveLength(1);
    expect(ops.volumes.map(({ volume }) => volume)).toEqual([0.8, 0.6, 0.4, 0.2]);
    expect(ops.writes.slice(1).map(({ frames }) => frames).reduce((a, b) => a + b, 0))
      .toBe(positionFrames(3));
  });

  test("same frame does not replay SE; rewind rebuilds tracks and suppresses historical cues", () => {
    const ops = new MockAudioOps();
    const resources = { field: "audio:wav.field", click: "audio:wav.click" };
    const driver = new AudioDriver(ops, resources, () => wav([5, 6, 7, 8]));
    const state = frame(10, {
      bgm: { id: "field", volume: 100, pitch: 100, positionTicks: 9 },
    }, [{ name: "click", volume: 100, pitch: 100 }]);
    driver.sync(state);
    driver.sync(state);
    expect(ops.created).toHaveLength(2);

    driver.sync(frame(7, {
      bgm: { id: "field", volume: 100, pitch: 100, positionTicks: 6 },
    }, [{ name: "click", volume: 100, pitch: 100 }]));

    expect(ops.destroyed).toEqual([1, 2]);
    expect(ops.created).toHaveLength(3); // rebuilt BGM only; rewind cue was suppressed.
    expect(ops.streams.size).toBe(1);
  });

  test("the virtual-clock host consumes the exact PCM budget and sees a monotonic fade", () => {
    const sink = createSimAudioSink();
    const driver = new AudioDriver(
      sink.ns as unknown as AudioOps,
      { tone: "audio:wav.tone" },
      () => wav([100, -100, 200, -200], 11_025),
    );
    const ticks = 60;
    for (let tick = 0; tick < ticks; tick++) {
      driver.sync(frame(tick + 1, {
        bgm: {
          id: "tone",
          volume: 80,
          pitch: 100,
          positionTicks: tick,
          fade: { totalTicks: ticks, leftTicks: ticks - tick },
        },
      }));
      sink.tick();
    }

    const expected = Array.from({ length: ticks }, (_, tick) => audioFramesForTick(11_025, tick))
      .reduce((sum, frames) => sum + frames, 0);
    expect(sink.consumedFrames()).toBe(expected);
    expect(expected).toBe(11_025);
    expect(sink.log.some((line) => line.includes('"underrun"'))).toBe(false);
    const volumes = sink.log
      .filter((line) => line.startsWith("op setVolume "))
      .map((line) => Number(line.split(" ")[3]));
    expect(volumes).toHaveLength(ticks);
    expect(volumes.every((value, index) => index === 0 || value < volumes[index - 1]!)).toBe(true);
  });
});
