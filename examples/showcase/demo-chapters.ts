// One validated safe-point chapter for every feature-gallery hall. These are
// derived from the authored project instead of duplicated as hand-written
// save payloads, so map ids, entry positions and extension defaults cannot
// drift away from the gallery itself.

import type { Session } from "../../src/engine/session.ts";
import { startSession } from "../../src/engine/session.ts";
import { createSessionSnapshot } from "../../src/engine/save.ts";
import type { Project } from "../../src/engine/types.ts";
import type { DemoOptions, DemoSpawn } from "../../src/ui/demo/index.ts";
import { HALL_ENTRY, LOBBY_ID } from "./hall-kit.ts";
import { SHOWCASE_HALLS } from "./showcase-data.ts";

const HALL_CHAPTER_ENTRY = { ...HALL_ENTRY } as const satisfies DemoSpawn;

export function createShowcaseDemo(project: Project, session: Session): DemoOptions {
  const spawns: Record<string, DemoSpawn> = {
    [LOBBY_ID]: { x: project.start.x, y: project.start.y, dir: project.start.dir },
  };
  const chapters = SHOWCASE_HALLS.map((hall) => {
    spawns[hall.id] = { ...HALL_CHAPTER_ENTRY };
    const state = startSession({
      ...project,
      start: { map: hall.id, ...HALL_CHAPTER_ENTRY },
    }, session);
    return {
      id: hall.id,
      title: `${hall.number}. ${hall.title}`,
      snapshot: createSessionSnapshot(session, state, 0),
    };
  });
  return { chapters, warp: { spawns } };
}
