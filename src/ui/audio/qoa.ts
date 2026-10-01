// Streaming QOA decoder for the opt-in host-audio entry.
//
// QOA frames carry their own LMS state. QoaStream keeps only one 20-sample
// slice per channel and advances it on demand, so filling a small host credit
// never expands the rest of the track into PCM. The arithmetic and tables
// follow Dominic Szablewski's MIT-licensed phoboslab/qoa implementation,
// pinned for the reference vectors at bc0589710ff6aa2f50e08fb4d0a815d567bc0f3e.
// SPDX-License-Identifier: MIT

const QOA_MAGIC = 0x716f6166; // "qoaf"
const QOA_MAX_CHANNELS = 8;
const QOA_SLICE_LEN = 20;
const QOA_SLICES_PER_FRAME = 256;
const QOA_FRAME_LEN = QOA_SLICE_LEN * QOA_SLICES_PER_FRAME;
const QOA_LMS_LEN = 4;

const QOA_DEQUANT_TAB = new Int16Array([
  1, -1, 3, -3, 5, -5, 7, -7,
  5, -5, 18, -18, 32, -32, 49, -49,
  16, -16, 53, -53, 95, -95, 147, -147,
  34, -34, 113, -113, 203, -203, 315, -315,
  63, -63, 210, -210, 378, -378, 588, -588,
  104, -104, 345, -345, 621, -621, 966, -966,
  158, -158, 528, -528, 950, -950, 1477, -1477,
  228, -228, 760, -760, 1368, -1368, 2128, -2128,
  316, -316, 1053, -1053, 1895, -1895, 2947, -2947,
  422, -422, 1405, -1405, 2529, -2529, 3934, -3934,
  548, -548, 1828, -1828, 3290, -3290, 5117, -5117,
  696, -696, 2320, -2320, 4176, -4176, 6496, -6496,
  868, -868, 2893, -2893, 5207, -5207, 8099, -8099,
  1064, -1064, 3548, -3548, 6386, -6386, 9933, -9933,
  1286, -1286, 4288, -4288, 7718, -7718, 12005, -12005,
  1536, -1536, 5120, -5120, 9216, -9216, 14336, -14336,
]);

interface QoaFrame {
  readonly offset: number;
  readonly start: number;
  readonly length: number;
  readonly dataOffset: number;
}

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! * 0x100 + bytes[offset + 1]!;
}

function u24(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! * 0x10000 + bytes[offset + 1]! * 0x100 + bytes[offset + 2]!;
}

function u32(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! * 0x1000000 + bytes[offset + 1]! * 0x10000 + bytes[offset + 2]! * 0x100 + bytes[offset + 3]!;
}

function s16(bytes: Uint8Array, offset: number): number {
  const value = u16(bytes, offset);
  return value & 0x8000 ? value - 0x10000 : value;
}

function clampS16(value: number): number {
  return value > 32767 ? 32767 : value < -32768 ? -32768 : value;
}

function prediction(history: Int32Array, weights: Int32Array, channel: number): number {
  const base = channel * QOA_LMS_LEN;
  let sum = 0;
  for (let i = 0; i < QOA_LMS_LEN; i++) sum += weights[base + i]! * history[base + i]!;
  return sum >> 13;
}

function updateLms(
  history: Int32Array,
  weights: Int32Array,
  channel: number,
  sample: number,
  residual: number,
): void {
  const base = channel * QOA_LMS_LEN;
  const delta = residual >> 4;
  for (let i = 0; i < QOA_LMS_LEN; i++) {
    const index = base + i;
    weights[index] = weights[index]! + (history[index]! < 0 ? -delta : delta);
  }
  history[base] = history[base + 1]!;
  history[base + 1] = history[base + 2]!;
  history[base + 2] = history[base + 3]!;
  history[base + 3] = sample;
}

/** Read one 3-bit residual code from a QOA slice without allocating BigInts. */
function sliceCode(bytes: Uint8Array, offset: number, sample: number): number {
  const bit = 4 + sample * 3;
  const byte = offset + (bit >> 3);
  const word = bytes[byte]! * 0x100 + (bytes[byte + 1] ?? 0);
  return (word >> (13 - (bit & 7))) & 7;
}

/** Immutable parsed QOA container; opening a stream gives it private decode state. */
export class QoaFile {
  readonly sampleRate: number;
  readonly channels: number;
  readonly frames: number;
  private readonly index: readonly QoaFrame[];

  constructor(readonly bytes: Uint8Array) {
    if (bytes.length < 16 || u32(bytes, 0) !== QOA_MAGIC) throw new Error("audio: not a QOA file");
    this.frames = u32(bytes, 4);
    if (this.frames < 1) throw new Error("audio: QOA has no samples");
    this.channels = bytes[8]!;
    this.sampleRate = u24(bytes, 9);
    if (this.channels < 1 || this.channels > QOA_MAX_CHANNELS || this.sampleRate < 1) {
      throw new Error("audio: invalid QOA stream format");
    }

    const index: QoaFrame[] = [];
    let offset = 8;
    let start = 0;
    while (start < this.frames) {
      if (offset + 8 > bytes.length) throw new Error("audio: truncated QOA frame header");
      const channels = bytes[offset]!;
      const rate = u24(bytes, offset + 1);
      const length = u16(bytes, offset + 4);
      const size = u16(bytes, offset + 6);
      const headerSize = 8 + QOA_LMS_LEN * 4 * channels;
      const slices = Math.ceil(length / QOA_SLICE_LEN);
      const encodedSize = headerSize + slices * channels * 8;
      if (
        channels !== this.channels || rate !== this.sampleRate || length < 1 || length > QOA_FRAME_LEN ||
        start + length > this.frames || size < encodedSize || offset + size > bytes.length
      ) {
        throw new Error("audio: invalid QOA frame");
      }
      index.push({ offset, start, length, dataOffset: offset + headerSize });
      offset += size;
      start += length;
    }
    if (start !== this.frames || offset !== bytes.length) throw new Error("audio: inconsistent QOA length");
    this.index = index;
  }

  stream(): QoaStream {
    return new QoaStream(this.bytes, this.sampleRate, this.channels, this.frames, this.index);
  }
}

/** Stateful, forward-optimized sample reader over one immutable QOA file. */
export class QoaStream {
  private readonly history: Int32Array;
  private readonly weights: Int32Array;
  private readonly slicePcm: Int16Array;
  private frameIndex = -1;
  private sliceIndex = -1;
  private decoded = 0;

  constructor(
    private readonly bytes: Uint8Array,
    readonly sampleRate: number,
    readonly channels: number,
    readonly frames: number,
    private readonly index: readonly QoaFrame[],
  ) {
    this.history = new Int32Array(channels * QOA_LMS_LEN);
    this.weights = new Int32Array(channels * QOA_LMS_LEN);
    this.slicePcm = new Int16Array(channels * QOA_SLICE_LEN);
  }

  /** Source frames actually expanded so far; useful for proving lazy decode. */
  get decodedFrames(): number {
    return this.decoded;
  }

  sample(frame: number, channel: number): number {
    if (!Number.isInteger(frame) || frame < 0 || frame >= this.frames) return 0;
    if (!Number.isInteger(channel) || channel < 0 || channel >= this.channels) return 0;
    const targetFrame = this.findFrame(frame);
    const descriptor = this.index[targetFrame]!;
    const local = frame - descriptor.start;
    const targetSlice = Math.floor(local / QOA_SLICE_LEN);
    if (targetFrame !== this.frameIndex || targetSlice < this.sliceIndex) this.beginFrame(targetFrame);
    while (this.sliceIndex < targetSlice) this.decodeNextSlice();
    return this.slicePcm[(local % QOA_SLICE_LEN) * this.channels + channel]!;
  }

  /** Decode a contiguous source range into interleaved destination frames. */
  readInto(output: Int16Array, outputFrame: number, sourceFrame: number, frames: number): void {
    if (
      !Number.isInteger(outputFrame) || outputFrame < 0 ||
      !Number.isInteger(sourceFrame) || sourceFrame < 0 ||
      !Number.isInteger(frames) || frames < 0 ||
      sourceFrame + frames > this.frames ||
      (outputFrame + frames) * this.channels > output.length
    ) {
      throw new RangeError("audio: QOA read outside stream");
    }

    let source = sourceFrame;
    let destination = outputFrame;
    let left = frames;
    while (left > 0) {
      const targetFrame = this.findFrame(source);
      const descriptor = this.index[targetFrame]!;
      const local = source - descriptor.start;
      const targetSlice = Math.floor(local / QOA_SLICE_LEN);
      if (targetFrame !== this.frameIndex || targetSlice < this.sliceIndex) this.beginFrame(targetFrame);
      while (this.sliceIndex < targetSlice) this.decodeNextSlice();

      const sliceOffset = local % QOA_SLICE_LEN;
      const take = Math.min(left, QOA_SLICE_LEN - sliceOffset, descriptor.length - local);
      const inputSample = sliceOffset * this.channels;
      const outputSample = destination * this.channels;
      const samples = take * this.channels;
      for (let sample = 0; sample < samples; sample++) {
        output[outputSample + sample] = this.slicePcm[inputSample + sample]!;
      }
      source += take;
      destination += take;
      left -= take;
    }
  }

  private findFrame(sample: number): number {
    const current = this.index[this.frameIndex];
    if (current && sample >= current.start && sample < current.start + current.length) return this.frameIndex;
    // Official encoders emit full 5120-sample frames except for the tail;
    // clamp the direct guess, then fall back to a binary search for valid
    // files whose frame lengths differ.
    const guess = Math.min(this.index.length - 1, Math.floor(sample / QOA_FRAME_LEN));
    const guessed = this.index[guess]!;
    if (sample >= guessed.start && sample < guessed.start + guessed.length) return guess;
    let lo = 0;
    let hi = this.index.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const frame = this.index[mid]!;
      if (sample < frame.start) hi = mid - 1;
      else if (sample >= frame.start + frame.length) lo = mid + 1;
      else return mid;
    }
    throw new Error("audio: QOA sample outside frame index");
  }

  private beginFrame(frameIndex: number): void {
    this.frameIndex = frameIndex;
    this.sliceIndex = -1;
    const frame = this.index[frameIndex]!;
    let offset = frame.offset + 8;
    for (let channel = 0; channel < this.channels; channel++) {
      const base = channel * QOA_LMS_LEN;
      for (let i = 0; i < QOA_LMS_LEN; i++) this.history[base + i] = s16(this.bytes, offset + i * 2);
      offset += 8;
      for (let i = 0; i < QOA_LMS_LEN; i++) this.weights[base + i] = s16(this.bytes, offset + i * 2);
      offset += 8;
    }
  }

  private decodeNextSlice(): void {
    const frame = this.index[this.frameIndex]!;
    const next = this.sliceIndex + 1;
    const sliceStart = next * QOA_SLICE_LEN;
    const length = Math.min(QOA_SLICE_LEN, frame.length - sliceStart);
    if (length <= 0) throw new Error("audio: QOA slice outside frame");
    for (let channel = 0; channel < this.channels; channel++) {
      const offset = frame.dataOffset + (next * this.channels + channel) * 8;
      const scalefactor = this.bytes[offset]! >> 4;
      for (let i = 0; i < length; i++) {
        const residual = QOA_DEQUANT_TAB[scalefactor * 8 + sliceCode(this.bytes, offset, i)]!;
        const reconstructed = clampS16(prediction(this.history, this.weights, channel) + residual);
        this.slicePcm[i * this.channels + channel] = reconstructed;
        updateLms(this.history, this.weights, channel, reconstructed, residual);
      }
    }
    this.sliceIndex = next;
    this.decoded += length;
  }
}
