// tests/fixtures/map-blocked/map-blocked.tsx — sim fixture for the async
// map-loading path: map_b's shard bytes are never resident, so the transfer
// boundary reports MapNotReadyError and GameView waits on prepareSessionMap.
// The rejection reason is injected per boot (including falsy ones such as
// undefined) to prove the view surfaces a stable error instead of hanging
// on the loading screen forever.

import { mount } from "@pocketjs/framework";
import { GameView } from "../../../src/ui/GameView.tsx";
import { createJsonMapRepository } from "../../../src/engine/map-repository.ts";
import { splitProjectMaps } from "../../../tools/lib/map-project.ts";
import type { Project } from "../../../src/engine/types.ts";
import { GAME_ASSETS } from "./assets-game.ts";
import { MAP_A, MAP_B, MAPS } from "./fixture-data.ts";

declare global {
  // eslint-disable-next-line no-var
  var __mapBlockedReject: unknown;
  // eslint-disable-next-line no-var
  var __mapBlockedLoading: (string | null)[] | undefined;
}

const project: Project = {
  format: "rpgkit-project/v1",
  title: "map-blocked fixture",
  tileSize: 16,
  start: { map: MAP_A.id, x: 1, y: 1, dir: "down" },
  sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
  items: [],
  maps: [...MAPS],
};

const split = splitProjectMaps(project);
const files = new Map(split.entries.map((entry) => [entry.meta.id, entry.bytes]));
const loading: (string | null)[] = [];
globalThis.__mapBlockedLoading = loading;

const repository = createJsonMapRepository(split.shell.mapIndex, {
  read: (entry) => {
    const meta = split.shell.mapIndex.find((m) => m.entry === entry);
    // The start map stays resident; map_b's bytes never are.
    return meta && meta.id !== MAP_B.id ? files.get(meta.id) : undefined;
  },
  prepare: async () => {
    throw globalThis.__mapBlockedReject;
  },
});

mount(() => (
  <GameView
    project={split.shell}
    maps={repository}
    assets={GAME_ASSETS}
    onMapLoading={(mapId) => loading.push(mapId)}
  />
));
