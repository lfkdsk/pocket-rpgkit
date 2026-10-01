// Showcase rooms whose feature is supplied by the renderer/application
// shell rather than a large event-command sequence.

import type { HallDefinition } from "../hall-kit.ts";
import { text } from "../hall-kit.ts";

export const SYSTEM_HALLS: HallDefinition[] = [
  {
    id: "hall-streaming",
    number: 8,
    title: "Streamed World",
    commands: ["streamed chunks", "animated tiles", "16x32 walker"],
    palette: ["#153f52", "#1f6070"],
    demo: [
      text(
        "CURATOR: This room is not a baked bitmap.",
        "Its 128px chunks enter and leave a viewport pool.",
      ),
      { op: "moveRoute", target: "player", wait: true, route: {
        repeat: false,
        skippable: true,
        steps: [{ pathTo: { x: 17, y: 3 } }],
      } },
      text(
        "CURATOR: Water sparks use native atlas animation.",
        "Your two-tile-tall walker stays foot-anchored.",
      ),
      { op: "switch", id: "showcase.streaming.complete", value: true },
    ],
  },
  {
    id: "hall-theme",
    number: 9,
    title: "Themes & Portraits",
    commands: ["GameView theme", "speaker portrait"],
    palette: ["#4e284f", "#753a67"],
    demo: [
      { op: "switch", id: "showcase.theme.alt", value: false },
      text("CURATOR: This is the gallery's midnight theme.", "My name prefix selects a 64px portrait."),
      { op: "switch", id: "showcase.theme.alt", value: true },
      text("CURATOR: The same dialog now uses the sunrise theme.", "Theme colors belong to the application, not saves."),
      { op: "switch", id: "showcase.theme.complete", value: true },
    ],
  },
  {
    id: "hall-save",
    number: 11,
    title: "Saves & Save Codes",
    commands: ["SaveMenu", "encodeSaveCode", "decodeSaveCode"],
    palette: ["#283750", "#3e5675"],
    demo: [
      text("CURATOR: The app will snapshot this safe point.", "Watch the real SaveMenu show export and import."),
      { op: "variable", id: "showcase.save.request", set: { op: "add", value: 1 } },
      { op: "switch", id: "showcase.save.complete", value: true },
    ],
  },
  {
    id: "hall-attract",
    number: 12,
    title: "Attract Tour & Rewind",
    commands: ["attract tape", "takeover", "rewind"],
    palette: ["#2d244e", "#4f3f85"],
    demo: [
      text(
        "CURATOR: Leave the controls idle for ten seconds.",
        "The recorded tour visits every room at every rate.",
      ),
      text("Press any key to take over; press L to rewind.", "SELECT opens chapters and map warp."),
      { op: "switch", id: "showcase.attract.explained", value: true },
    ],
  },
  {
    id: "hall-audio",
    number: 13,
    title: "Sound Studio",
    commands: ["playBgm/Bgs/Me/Se", "pause/resume", "fade/replay"],
    palette: ["#3a2357", "#78508f"],
    demo: [
      { op: "playBgm", id: "town-theme", volume: 42 },
      { op: "playBgs", id: "ice-ambience", volume: 16, pitch: 80 },
      { op: "playSe", id: "coin-chime", volume: 76 },
      {
        op: "if",
        if: { kind: "bgmPlaying", id: "town-theme" },
        then: [{ op: "switch", id: "showcase.audio.playing", value: true }],
      },
      text(
        "CURATOR: Town music and crystal ambience mix live.",
        "The coin chime is a one-shot sound effect.",
      ),
      { op: "saveBgm" },
      { op: "playMe", id: "bark-fanfare", duration: 0.35, volume: 82 },
      { op: "wait", seconds: 0.4 },
      { op: "pauseBgm" },
      text("CURATOR: The melody is paused now.", "Confirm to resume, fade, and restore it."),
      { op: "resumeBgm" },
      { op: "playSe", id: "ice-ambience", volume: 62, pitch: 125 },
      { op: "fadeoutBgs", duration: 0.25 },
      { op: "fadeoutBgm", duration: 0.4 },
      { op: "wait", seconds: 0.45 },
      { op: "replayBgm" },
      { op: "playSe", id: "coin-chime", volume: 76, pitch: 115 },
      text("CURATOR: The saved melody returns at its old position.", "Music, ambience, fanfares, and cues share one clock."),
      { op: "stopBgm" },
      { op: "switch", id: "showcase.audio.complete", value: true },
    ],
  },
];
