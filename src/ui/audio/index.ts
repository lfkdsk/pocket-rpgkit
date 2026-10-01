// src/ui/audio/index.ts — explicitly imported host-audio effects for GameView.
// Keeping this module out of the ordinary UI/host barrels is what makes the
// PocketJS audio SDK and pak reader unreachable for games that do not opt in.

import { onCleanup } from "solid-js";
import { audioHost } from "@pocketjs/framework/audio";
import { simulationHz } from "@pocketjs/framework/clock";
import { onFrame } from "@pocketjs/framework/lifecycle";
import type { GameEffectsComponent } from "../GameView.tsx";
import { createAudioDriver } from "./driver.ts";

export * from "./driver.ts";
export * from "./qoa.ts";

/** Build an invisible GameView child that owns the audio-only frame hook. */
export function createAudioEffects(
  resources: Readonly<Record<string, string>>,
): GameEffectsComponent {
  return function AudioEffects(props) {
    const host = audioHost();
    // Unsupported hosts remain completely silent and do not acquire a frame
    // callback. The reducer and presentation continue unchanged.
    if (!host) return null;
    const driver = createAudioDriver(host, resources, undefined, 60 / simulationHz());
    onFrame(() => driver.sync(props.state()));
    onCleanup(() => driver.dispose());
    return null;
  };
}
