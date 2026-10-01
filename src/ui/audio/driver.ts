// src/ui/audio/driver.ts — the opt-in bridge from reducer audio intent to the
// PocketJS audio module. One driver owns every stream and drains audio.poll()
// exactly once, so events for one voice cannot be swallowed by another.

import {
  AUDIO_RING_FRAMES,
  decodeWav,
  type AudioOps,
  type WavPcm,
} from "@pocketjs/framework/audio";
import { get as pakGet } from "@pocketjs/framework/pak";
import { audioTrackVolume, type AudioMeState, type AudioState, type AudioTrackState } from "../../engine/audio.ts";
import type { SoundCue } from "../../engine/interpreter.ts";

const MAX_STREAMS = 4;
const TICKS_PER_SECOND = 60;

type PersistentKind = "bgm" | "bgs" | "me";
type VoiceKind = PersistentKind | "se";

export interface AudioDriverState {
  readonly frame: number;
  readonly interp: {
    readonly audio?: Readonly<AudioState>;
    readonly cues: readonly Readonly<SoundCue>[];
  };
}

export type AudioResourceReader = (pakKey: string) => Uint8Array;

interface Voice {
  readonly handle: number;
  readonly kind: VoiceKind;
  readonly id: string;
  readonly pakKey: string;
  readonly pcm: WavPcm;
  readonly pitch: number;
  readonly looping: boolean;
  readonly serial: number;
  /** Absolute output-frame cursor. Pitch is applied only when selecting source samples. */
  cursor: number;
  /** Guest-side mirror of the host ring's free source-frame capacity. */
  free: number;
  volume: number;
  desiredPlaying: boolean;
  hostPlaying: boolean;
  endSent: boolean;
  finished: boolean;
}

function clampVolume(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(1, percent / 100));
}

function normalizedPitch(pitch: number): number {
  if (!Number.isFinite(pitch)) return 100;
  return Math.max(1, Math.round(pitch));
}

function outputFrameAtTick(ticks: number, sampleRate: number): number {
  if (!Number.isFinite(ticks) || ticks <= 0) return 0;
  return Math.floor(ticks * sampleRate / TICKS_PER_SECOND);
}

function oneShotOutputFrames(pcm: WavPcm, pitch: number): number {
  return Math.ceil(pcm.frames * 100 / pitch);
}

/**
 * Central four-stream driver. Persistent reducer tracks are reconciled before
 * transient SE, and every host event is dispatched here by handle.
 */
export class AudioDriver {
  private readonly voices = new Map<number, Voice>();
  private readonly persistent: Partial<Record<PersistentKind, Voice>> = {};
  private readonly pcmCache = new Map<string, WavPcm | null>();
  private lastFrame: number | undefined;
  private nextSerial = 1;

  constructor(
    private readonly ops: AudioOps,
    private readonly resources: Readonly<Record<string, string>>,
    private readonly readResource: AudioResourceReader = pakGet,
  ) {}

  /** Reconcile one reducer frame, then fill every credited ring. */
  sync(state: AudioDriverState): void {
    this.drainEvents();

    const repeated = this.lastFrame === state.frame;
    const rewound = this.lastFrame !== undefined && state.frame < this.lastFrame;
    if (rewound) this.destroyAll();

    if (!repeated) {
      this.reconcilePersistent(state.interp.audio);
      // A refold ends on historical cues. Rebuild persistent tracks at their
      // restored positions, but never replay those one-shot side effects.
      if (!rewound) {
        for (const cue of state.interp.cues) this.startSe(cue);
      }
      this.lastFrame = state.frame;
    }

    this.pumpAll();
  }

  dispose(): void {
    this.destroyAll();
    this.lastFrame = undefined;
  }

  private drainEvents(): void {
    for (let line = this.ops.poll(); line !== undefined; line = this.ops.poll()) {
      let event: { t?: unknown; h?: unknown; free?: unknown };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        continue;
      }
      if (typeof event.h !== "number") continue;
      const voice = this.voices.get(event.h);
      if (!voice) continue;
      if (event.t === "credit" && typeof event.free === "number") {
        voice.free = Math.max(0, Math.min(AUDIO_RING_FRAMES, Math.floor(event.free)));
      } else if (event.t === "ended") {
        voice.hostPlaying = false;
        voice.finished = true;
        if (voice.kind === "se") this.destroyVoice(voice);
      }
    }
  }

  private reconcilePersistent(audio: Readonly<AudioState> | undefined): void {
    this.reconcileTrack("bgm", audio?.bgm, !audio?.bgm?.paused && !audio?.me, true);
    this.reconcileTrack("bgs", audio?.bgs, audio?.bgs !== undefined, true);
    this.reconcileTrack("me", audio?.me, audio?.me !== undefined, false);
  }

  private reconcileTrack(
    kind: PersistentKind,
    track: Readonly<AudioTrackState | AudioMeState> | undefined,
    playing: boolean,
    looping: boolean,
  ): void {
    let voice = this.persistent[kind];
    if (!track) {
      if (voice) this.destroyVoice(voice);
      return;
    }

    const pakKey = this.resources[track.id];
    if (!pakKey) {
      if (voice) this.destroyVoice(voice);
      return;
    }
    const pitch = normalizedPitch(track.pitch);
    const sameTrack = voice && voice.id === track.id && voice.pakKey === pakKey && voice.pitch === pitch;
    if (voice && !sameTrack) {
      this.destroyVoice(voice);
      voice = undefined;
    }

    if (voice && !voice.finished) {
      const desired = outputFrameAtTick(track.positionTicks, voice.pcm.sampleRate);
      // Credits make the consumed position observable without querying the
      // host. A mismatch is a save/load seek or another discontinuous fold.
      if (this.playedOutputFrame(voice) !== desired) {
        this.destroyVoice(voice);
        voice = undefined;
      }
    } else if (voice?.finished && looping) {
      this.destroyVoice(voice);
      voice = undefined;
    }

    if (!voice) {
      const pcm = this.loadPcm(pakKey);
      if (!pcm) return;
      const cursor = outputFrameAtTick(track.positionTicks, pcm.sampleRate);
      voice = this.createVoice(kind, track.id, pakKey, pcm, pitch, looping, cursor);
      if (!voice) return;
      this.persistent[kind] = voice;
    }

    const volume = clampVolume(audioTrackVolume(track));
    if (voice.volume !== volume) {
      voice.volume = volume;
      this.ops.setVolume(voice.handle, volume);
    }
    voice.desiredPlaying = playing && !voice.finished;
    if (!voice.desiredPlaying && voice.hostPlaying) {
      this.ops.pause(voice.handle);
      voice.hostPlaying = false;
    }
  }

  private startSe(cue: Readonly<SoundCue>): void {
    const pakKey = this.resources[cue.name];
    if (!pakKey) return;
    const pcm = this.loadPcm(pakKey);
    if (!pcm) return;
    const voice = this.createVoice(
      "se",
      cue.name,
      pakKey,
      pcm,
      normalizedPitch(cue.pitch),
      false,
      0,
    );
    if (!voice) return;
    const volume = clampVolume(cue.volume);
    voice.volume = volume;
    this.ops.setVolume(voice.handle, volume);
    voice.desiredPlaying = true;
  }

  private loadPcm(pakKey: string): WavPcm | null {
    if (this.pcmCache.has(pakKey)) return this.pcmCache.get(pakKey)!;
    let pcm: WavPcm | null = null;
    try {
      const decoded = decodeWav(this.readResource(pakKey));
      if (decoded.frames > 0) pcm = decoded;
    } catch {
      // Optional audio must not turn a missing or malformed resource into a
      // gameplay failure. Cache the miss so it stays off the frame path.
    }
    this.pcmCache.set(pakKey, pcm);
    return pcm;
  }

  private createVoice(
    kind: VoiceKind,
    id: string,
    pakKey: string,
    pcm: WavPcm,
    pitch: number,
    looping: boolean,
    cursor: number,
  ): Voice | undefined {
    if (!this.makeRoom()) return undefined;
    let handle: number;
    try {
      handle = this.ops.createStream(pcm.sampleRate, pcm.channels);
    } catch {
      return undefined;
    }
    if (!Number.isInteger(handle) || handle < 0) return undefined;
    const voice: Voice = {
      handle,
      kind,
      id,
      pakKey,
      pcm,
      pitch,
      looping,
      serial: this.nextSerial++,
      cursor,
      free: AUDIO_RING_FRAMES,
      volume: -1,
      desiredPlaying: false,
      hostPlaying: false,
      endSent: false,
      finished: false,
    };
    this.voices.set(handle, voice);
    return voice;
  }

  /** Persistent tracks and new SE both evict only the oldest transient voice. */
  private makeRoom(): boolean {
    if (this.voices.size < MAX_STREAMS) return true;
    let oldest: Voice | undefined;
    for (const voice of this.voices.values()) {
      if (voice.kind === "se" && (!oldest || voice.serial < oldest.serial)) oldest = voice;
    }
    if (!oldest) return false;
    this.destroyVoice(oldest);
    return true;
  }

  private playedOutputFrame(voice: Voice): number {
    return voice.cursor - (AUDIO_RING_FRAMES - voice.free);
  }

  private pumpAll(): void {
    // Map insertion order makes write/play/end ordering deterministic.
    for (const voice of [...this.voices.values()]) this.pumpVoice(voice);
  }

  private pumpVoice(voice: Voice): void {
    if (voice.finished) return;
    const total = voice.looping ? Number.POSITIVE_INFINITY : oneShotOutputFrames(voice.pcm, voice.pitch);
    while (voice.free > 0 && voice.cursor < total) {
      const wanted = Math.min(voice.free, total - voice.cursor);
      const frames = Math.floor(wanted);
      if (frames <= 0) break;
      const data = this.renderFrames(voice, frames);
      const reported = this.ops.writePcm(voice.handle, data.buffer as ArrayBuffer);
      const accepted = Number.isFinite(reported)
        ? Math.max(0, Math.min(frames, Math.floor(reported)))
        : 0;
      if (accepted === 0) break;
      voice.cursor += accepted;
      voice.free -= accepted;
    }

    const queued = AUDIO_RING_FRAMES - voice.free;
    if (voice.desiredPlaying && !voice.hostPlaying && queued > 0) {
      this.ops.play(voice.handle);
      voice.hostPlaying = true;
    }
    if (!voice.looping && voice.cursor >= total && !voice.endSent) {
      voice.endSent = true;
      this.ops.endStream(voice.handle);
    }
  }

  private renderFrames(voice: Voice, frames: number): Int16Array {
    const channels = voice.pcm.channels;
    const out = new Int16Array(frames * channels);
    for (let output = 0; output < frames; output++) {
      let source = Math.floor((voice.cursor + output) * voice.pitch / 100);
      if (voice.looping) source %= voice.pcm.frames;
      for (let channel = 0; channel < channels; channel++) {
        out[output * channels + channel] = voice.pcm.data[source * channels + channel]!;
      }
    }
    return out;
  }

  private destroyVoice(voice: Voice): void {
    if (!this.voices.delete(voice.handle)) return;
    if (voice.kind !== "se" && this.persistent[voice.kind] === voice) {
      delete this.persistent[voice.kind];
    }
    this.ops.destroyStream(voice.handle);
  }

  private destroyAll(): void {
    for (const voice of [...this.voices.values()]) this.destroyVoice(voice);
  }
}

export function createAudioDriver(
  ops: AudioOps,
  resources: Readonly<Record<string, string>>,
  readResource: AudioResourceReader = pakGet,
): AudioDriver {
  return new AudioDriver(ops, resources, readResource);
}
