// src/ui/demo/text.ts — the demo menu's English words (engine/ui-text.ts
// keys); plain TypeScript so tests and tools can read them.

import type { UiTextTable } from "../../engine/ui-text.ts";

/** English defaults of the demo menu's words (engine/ui-text.ts keys). */
export const DEMO_MENU_UI_TEXT = {
  "demo.menuTitle": "DEMO CONTROLS",
  "demo.tabChapters": "CHAPTERS",
  "demo.tabWarp": "MAP WARP",
  "demo.tabAutoplay": "AUTOPLAY",
  "demo.tabSelected": "[{tab}]",
  "demo.empty": "No entries configured.",
  "demo.speed": "Speed {speed}x",
  "demo.speedHint": "A: change",
  "demo.legend": "left/right: page   up/down: choose   A: select   B: close",
  "demo.legendBack": "A/B: back",
  "demo.loading": "Loading map...",
  "demo.warped": "Warped — story state may not match this map",
  "demo.error": "DEMO ERROR",
  "demo.badLink": "BAD DEMO LINK",
  "demo.errorUnknownChapter": "Unknown chapter {id}.",
  "demo.errorUnknownMap": "Unknown map {id}.",
  "demo.errorUnknownAutoplay": "Unknown autoplay chapter {id}.",
  "demo.errorXY": "x and y must be supplied together.",
  "demo.badLinkChooseOne": "Choose exactly one of chapter, map, or autoplay.",
  "demo.badLinkSpeed": "Speed requires autoplay; x and y require map.",
} as const satisfies Partial<UiTextTable>;
