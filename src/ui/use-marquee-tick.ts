// src/ui/use-marquee-tick.ts — a tick that advances while any of a view's
// bounded cells marquees, so clipped rows scroll sideways through their
// full text. One tick per view (DialogBox, SaveMenu, the demo menu, the
// name-input scene): every marquee cell reads marqueeOffset(overflow, tick),
// a pure function of the tick, so a rewind or a replay shows the same
// frame. When no cell marquees the tick rests and the view emits no
// per-frame work.

import { createSignal, type Accessor } from "solid-js";
import { onFrame } from "@pocketjs/framework/lifecycle";

/** A tick accessor that advances every frame while `active()` is true. */
export function useMarqueeTick(active: Accessor<boolean>): Accessor<number> {
  const [tick, setTick] = createSignal(0);
  onFrame(() => {
    if (active()) setTick((value) => value + 1);
  });
  return tick;
}
