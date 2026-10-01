import type { AudioOps } from "../../vendor/pocketjs/framework/src/audio-api.ts";

export interface BrowserAudioHost {
  ns: AudioOps;
  beginFrame(): void;
  reset(): void;
}

export interface MasterAudioHost extends BrowserAudioHost {
  readonly masterVolume: number;
  readonly muted: boolean;
  /** Prime/resume WebAudio synchronously inside the first user gesture. */
  activate(): void;
  setMasterVolume(volume: number): void;
  setMuted(muted: boolean): void;
}

/**
 * Add player-owned master volume without changing the guest audio contract.
 * Muting only writes zero volume: streams and the native audio clock keep
 * running, and unmuting restores each stream's most recent guest volume.
 */
export function createMasterAudioHost(host: BrowserAudioHost): MasterAudioHost {
  const raw = host.ns;
  const streamVolumes = new Map<number, number>();
  let masterVolume = 1;
  let muted = false;

  const clampVolume = (value: number): number => Math.max(0, Math.min(1, value));
  const effectiveVolume = (guestVolume: number): number => (muted ? 0 : guestVolume * masterVolume);
  const applyVolumes = (): void => {
    for (const [handle, guestVolume] of streamVolumes) raw.setVolume(handle, effectiveVolume(guestVolume));
  };

  const ns: AudioOps = {
    createStream(sampleRate, channels) {
      const handle = raw.createStream(sampleRate, channels);
      if (handle >= 0) {
        streamVolumes.set(handle, 1);
        const volume = effectiveVolume(1);
        if (volume !== 1) raw.setVolume(handle, volume);
      }
      return handle;
    },
    destroyStream(handle) {
      streamVolumes.delete(handle);
      raw.destroyStream(handle);
    },
    writePcm: (handle, pcm) => raw.writePcm(handle, pcm),
    play: (handle) => raw.play(handle),
    pause: (handle) => raw.pause(handle),
    stop: (handle) => raw.stop(handle),
    setVolume(handle, volume) {
      if (!streamVolumes.has(handle)) {
        raw.setVolume(handle, volume);
        return;
      }
      const guestVolume = clampVolume(volume);
      streamVolumes.set(handle, guestVolume);
      raw.setVolume(handle, effectiveVolume(guestVolume));
    },
    endStream: (handle) => raw.endStream(handle),
    poll: () => raw.poll(),
  };

  return {
    ns,
    beginFrame: () => host.beginFrame(),
    activate() {
      // createAudioHost constructs its lazy AudioContext in createStream(),
      // while play() requests resume. Doing both synchronously in the gesture
      // handler also covers games whose first sound is created by that same
      // input and therefore would otherwise miss the host's lazy listener.
      const handle = ns.createStream(11_025, 1);
      ns.play(handle);
      if (handle >= 0) ns.destroyStream(handle);
    },
    reset() {
      host.reset();
      streamVolumes.clear();
    },
    setMasterVolume(volume) {
      const next = clampVolume(volume);
      if (next === masterVolume) return;
      masterVolume = next;
      applyVolumes();
    },
    setMuted(value) {
      const next = Boolean(value);
      if (next === muted) return;
      muted = next;
      applyVolumes();
    },
    get masterVolume() {
      return masterVolume;
    },
    get muted() {
      return muted;
    },
  };
}
