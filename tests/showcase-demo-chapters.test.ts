// The showcase's web/menu chapters are generated safe points at the authored
// entrance of every hall. Test both structural and map/extension-aware restore
// so a superficially valid but unusable snapshot cannot reach the demo menu.

import { describe, expect, test } from "bun:test";
import { createShowcaseDemo } from "../examples/showcase/demo-chapters.ts";
import { buildShowcaseProject, SHOWCASE_HALLS } from "../examples/showcase/showcase-data.ts";
import { SHOWCASE_EXTENSIONS } from "../examples/showcase/extensions.ts";
import { showcaseBattleRules } from "../examples/showcase/showcase-battle-rules.ts";
import { restoreSessionSnapshot } from "../src/engine/save-restore.ts";
import { validateSnapshot } from "../src/engine/save-validate.ts";
import { createSession } from "../src/engine/session.ts";
import { NAME_INPUT_SCENE_ID, nameInputRules } from "../src/engine/name-input.ts";
import { HALL_ENTRY } from "../examples/showcase/hall-kit.ts";

describe("showcase demo chapters", () => {
  test("every hall has an ordered, restorable entry snapshot", () => {
    const project = buildShowcaseProject();
    const session = createSession(project, 60, {
      extensions: SHOWCASE_EXTENSIONS,
      battle: showcaseBattleRules,
      scenes: { [NAME_INPUT_SCENE_ID]: nameInputRules },
    });
    const demo = createShowcaseDemo(project, session);

    expect(demo.chapters.map(({ id }) => id)).toEqual(SHOWCASE_HALLS.map(({ id }) => id));
    expect(demo.chapters.map(({ title }) => title)).toEqual(
      SHOWCASE_HALLS.map(({ number, title }) => `${number}. ${title}`),
    );
    expect(demo.chapters.every((chapter) => chapter.tape === undefined)).toBe(true);

    for (const [index, chapter] of demo.chapters.entries()) {
      if (typeof chapter.snapshot === "string") throw new Error("showcase chapters must expose generated snapshots");
      expect(validateSnapshot(chapter.snapshot), chapter.id).toBeNull();
      const restored = restoreSessionSnapshot(session, chapter.snapshot);
      expect(restored, chapter.id).toMatchObject({
        mapId: SHOWCASE_HALLS[index]!.id,
        frame: 0,
        move: {
          tx: HALL_ENTRY.x,
          ty: HALL_ENTRY.y,
          px: HALL_ENTRY.x * 16,
          py: HALL_ENTRY.y * 16,
          facing: 2,
          phase: 0,
          moving: false,
        },
        sw: { gold: 80 },
        ext: { visits: 0, completed: 0, selections: [], cancellations: 0, lastChoice: null },
      });
    }
  });

  test("warp spawns use the lobby and authored hall entrances", () => {
    const project = buildShowcaseProject();
    const session = createSession(project, 60, {
      extensions: SHOWCASE_EXTENSIONS,
      battle: showcaseBattleRules,
      scenes: { [NAME_INPUT_SCENE_ID]: nameInputRules },
    });
    const spawns = createShowcaseDemo(project, session).warp!.spawns!;
    expect(spawns[project.start.map]).toEqual({ x: 15, y: 10, dir: "up" });
    for (const hall of SHOWCASE_HALLS) expect(spawns[hall.id], hall.id).toEqual(HALL_ENTRY);
  });
});
