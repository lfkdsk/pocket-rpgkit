// Optional per-frame tracing hook used by native QuickJS benchmarks. Normal
// applications do not install it, so no timings or counters become runtime
// state and the reducer remains wall-clock free. Mirrors
// startup-profile.ts: marks are cheap no-ops without a host sink, and the
// segment names are a contract with tools/kb6-quickjs-bench.rs (kit) and the
// game repo's g6-quickjs-bench.rs copy (Tuxemon journey).

export type FrameProfileMark = (stage: string) => void;

declare global {
  // eslint-disable-next-line no-var
  var __rpgkitFrameProfileMark: FrameProfileMark | undefined;
}

export function frameProfileMark(stage: string): void {
  globalThis.__rpgkitFrameProfileMark?.(stage);
}
