// Optional startup tracing hook used by native QuickJS benchmarks. Normal
// applications do not install it, so no timings or counters become runtime
// state and the reducer remains wall-clock free.

export type StartupProfileMark = (stage: string) => void;

declare global {
  // eslint-disable-next-line no-var
  var __rpgkitStartupProfileMark: StartupProfileMark | undefined;
}

export function startupProfileMark(stage: string): void {
  globalThis.__rpgkitStartupProfileMark?.(stage);
}
