// Deterministic build-time encoder for Quite OK Audio (QOA).
//
// Derived from Dominic Szablewski's MIT-licensed reference implementation at
// https://github.com/phoboslab/qoa/tree/bc0589710ff6aa2f50e08fb4d0a815d567bc0f3e
// Copyright (c) 2023 Dominic Szablewski. SPDX-License-Identifier: MIT

const QOA_SLICE_LEN = 20;
const QOA_SLICES_PER_FRAME = 256;
const QOA_FRAME_LEN = QOA_SLICES_PER_FRAME * QOA_SLICE_LEN;
const QOA_LMS_LEN = 4;
const QOA_MAX_CHANNELS = 2;
const QOA_SAMPLE_RATES = [11_025, 22_050, 44_100] as const;
const QOA_MAX_FRAMES = 0xffff_ffff;
const QOA_MAGIC = 0x716f6166; // "qoaf"

const QOA_QUANT_TAB = new Int8Array([
  7, 7, 7, 5, 5, 3, 3, 1,
  0,
  0, 2, 2, 4, 4, 6, 6, 6,
]);

const QOA_RECIPROCAL_TAB = new Int32Array([
  65536, 9363, 3121, 1457, 781, 475, 311, 216, 156, 117, 90, 71, 57, 47, 39, 32,
]);

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

interface Lms {
  readonly history: Int32Array;
  readonly weights: Int32Array;
}

function newLms(): Lms {
  return {
    history: new Int32Array(QOA_LMS_LEN),
    weights: new Int32Array(QOA_LMS_LEN),
  };
}

function copyLms(source: Lms): Lms {
  return {
    history: Int32Array.from(source.history),
    weights: Int32Array.from(source.weights),
  };
}

function lmsPredict(lms: Lms): number {
  let prediction = 0;
  for (let i = 0; i < QOA_LMS_LEN; i++) {
    prediction += lms.weights[i]! * lms.history[i]!;
  }
  return prediction >> 13;
}

function lmsUpdate(lms: Lms, sample: number, residual: number): void {
  const delta = residual >> 4;
  for (let i = 0; i < QOA_LMS_LEN; i++) {
    lms.weights[i] = lms.weights[i]! + (lms.history[i]! < 0 ? -delta : delta);
  }
  for (let i = 0; i < QOA_LMS_LEN - 1; i++) lms.history[i] = lms.history[i + 1]!;
  lms.history[QOA_LMS_LEN - 1] = sample;
}

function qoaDiv(value: number, scalefactor: number): number {
  const reciprocal = QOA_RECIPROCAL_TAB[scalefactor]!;
  let quotient = (value * reciprocal + (1 << 15)) >> 16;
  quotient += Number(value > 0) - Number(value < 0) - Number(quotient > 0) + Number(quotient < 0);
  return quotient;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function clampS16(value: number): number {
  return clamp(value, -32768, 32767);
}

function writeU64(bytes: Uint8Array, offset: number, value: bigint): number {
  bytes[offset] = Number((value >> 56n) & 0xffn);
  bytes[offset + 1] = Number((value >> 48n) & 0xffn);
  bytes[offset + 2] = Number((value >> 40n) & 0xffn);
  bytes[offset + 3] = Number((value >> 32n) & 0xffn);
  bytes[offset + 4] = Number((value >> 24n) & 0xffn);
  bytes[offset + 5] = Number((value >> 16n) & 0xffn);
  bytes[offset + 6] = Number((value >> 8n) & 0xffn);
  bytes[offset + 7] = Number(value & 0xffn);
  return offset + 8;
}

/**
 * Encode interleaved signed 16-bit PCM into a complete static QOA file.
 * `samples.length / channels` is the sample-frame count stored in the header.
 */
export function encodeQoa(samples: Int16Array, channels: number, sampleRate: number): Uint8Array {
  if (!Number.isInteger(channels) || channels < 1 || channels > QOA_MAX_CHANNELS) {
    throw new Error(`qoa: channels must be an integer in 1..${QOA_MAX_CHANNELS}`);
  }
  if (!(QOA_SAMPLE_RATES as readonly number[]).includes(sampleRate)) {
    throw new Error(`qoa: sample rate must be ${QOA_SAMPLE_RATES.join(", ")} Hz`);
  }
  if (!Number.isSafeInteger(samples.length) || samples.length === 0) {
    throw new Error("qoa: samples must not be empty");
  }
  if (samples.length % channels !== 0) {
    throw new Error("qoa: interleaved sample length must be divisible by channels");
  }

  const totalFrames = samples.length / channels;
  if (totalFrames > QOA_MAX_FRAMES) {
    throw new Error(`qoa: sample-frame count must fit in uint32 (${QOA_MAX_FRAMES} max)`);
  }

  const numFrames = Math.ceil(totalFrames / QOA_FRAME_LEN);
  const numSlices = Math.ceil(totalFrames / QOA_SLICE_LEN);
  const encodedSize =
    8 + numFrames * 8 + numFrames * QOA_LMS_LEN * 4 * channels + numSlices * 8 * channels;
  const bytes = new Uint8Array(encodedSize);
  let offset = writeU64(bytes, 0, (BigInt(QOA_MAGIC) << 32n) | BigInt(totalFrames));

  const lms: Lms[] = [];
  for (let channel = 0; channel < channels; channel++) {
    const state = newLms();
    state.weights[2] = -(1 << 13);
    state.weights[3] = 1 << 14;
    lms.push(state);
  }

  for (let frameStart = 0; frameStart < totalFrames; frameStart += QOA_FRAME_LEN) {
    const frameLength = Math.min(QOA_FRAME_LEN, totalFrames - frameStart);
    const slices = Math.ceil(frameLength / QOA_SLICE_LEN);
    const frameSize = 8 + QOA_LMS_LEN * 4 * channels + 8 * slices * channels;
    offset = writeU64(
      bytes,
      offset,
      (BigInt(channels) << 56n) |
        (BigInt(sampleRate) << 32n) |
        (BigInt(frameLength) << 16n) |
        BigInt(frameSize),
    );

    for (let channel = 0; channel < channels; channel++) {
      let history = 0n;
      let weights = 0n;
      for (let i = 0; i < QOA_LMS_LEN; i++) {
        history = (history << 16n) | BigInt(lms[channel]!.history[i]! & 0xffff);
        weights = (weights << 16n) | BigInt(lms[channel]!.weights[i]! & 0xffff);
      }
      offset = writeU64(bytes, offset, history);
      offset = writeU64(bytes, offset, weights);
    }

    // The reference encoder resets this search-order hint for every frame. It
    // changes only which equal-rank scalefactor wins, not the candidate set.
    const previousScalefactor = new Int32Array(channels);
    for (let sliceStart = 0; sliceStart < frameLength; sliceStart += QOA_SLICE_LEN) {
      const sliceLength = Math.min(QOA_SLICE_LEN, frameLength - sliceStart);
      for (let channel = 0; channel < channels; channel++) {
        let bestRank = Number.POSITIVE_INFINITY;
        let bestSlice = 0n;
        let bestState = newLms();
        let bestScalefactor = 0;

        for (let candidate = 0; candidate < 16; candidate++) {
          const scalefactor = (candidate + previousScalefactor[channel]!) & 15;
          const trial = copyLms(lms[channel]!);
          let slice = BigInt(scalefactor);
          let rank = 0;

          for (let index = 0; index < sliceLength; index++) {
            const sample = samples[(frameStart + sliceStart + index) * channels + channel]!;
            const predicted = lmsPredict(trial);
            const residual = sample - predicted;
            const scaled = qoaDiv(residual, scalefactor);
            const quantized = QOA_QUANT_TAB[clamp(scaled, -8, 8) + 8]!;
            const dequantized = QOA_DEQUANT_TAB[scalefactor * 8 + quantized]!;
            const reconstructed = clampS16(predicted + dequantized);

            const weights = trial.weights;
            let weightsPenalty = ((
              weights[0]! * weights[0]! +
              weights[1]! * weights[1]! +
              weights[2]! * weights[2]! +
              weights[3]! * weights[3]!
            ) >> 18) - 0x8ff;
            if (weightsPenalty < 0) weightsPenalty = 0;

            const error = sample - reconstructed;
            rank += error * error + weightsPenalty * weightsPenalty;
            if (rank > bestRank) break;

            lmsUpdate(trial, reconstructed, dequantized);
            slice = (slice << 3n) | BigInt(quantized);
          }

          if (rank < bestRank) {
            bestRank = rank;
            bestSlice = slice;
            bestState = trial;
            bestScalefactor = scalefactor;
          }
        }

        previousScalefactor[channel] = bestScalefactor;
        lms[channel] = bestState;
        bestSlice <<= BigInt((QOA_SLICE_LEN - sliceLength) * 3);
        offset = writeU64(bytes, offset, bestSlice);
      }
    }
  }

  if (offset !== encodedSize) {
    throw new Error(`qoa: encoded size mismatch (${offset} written, ${encodedSize} allocated)`);
  }
  return bytes;
}
