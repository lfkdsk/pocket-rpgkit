// Pure engine workloads bundled once per compared checkout and evaluated by
// tools/pr1-quickjs-bench.rs in PocketJS's real desktop QuickJS guest.

import { WanderSim } from "../examples/wander/wander-sim.ts";
import { buildGame } from "../examples/sunstone/game-data.ts";
import { createSession, startSession, stepSession } from "../src/engine/session.ts";
import { battleEvent, MAP, MAP_ID } from "../tests/fixtures/kb4-battle/fixture-data.ts";
import { kb4BattleRules } from "../tests/fixtures/kb4-battle/rules.ts";

type BenchName = "sunstoneIdle" | "sunstoneWalk" | "wanderAuto" | "battleScene";

const sunstone = buildGame().project;
const idleSession = createSession(sunstone, 60);
const walkSession = createSession(sunstone, 60);
let idleState = startSession(sunstone, idleSession);
let walkState = startSession(sunstone, walkSession);
let walkFrame = 0;

for (let frame = 0; frame < 180; frame++) {
  idleState = stepSession(idleSession, idleState, { buttons: 0 });
  const buttons = frame % 64 < 32 ? 0x0020 : 0x0080;
  walkState = stepSession(walkSession, walkState, { buttons });
}

const wander = new WanderSim({ seed: 0x5eed0001, hz: 60, viewW: 480, viewH: 272 });
for (let frame = 0; frame < 360; frame++) wander.step(0);

const battleMap = { ...MAP, events: [battleEvent({ enemyHp: 999_999 })] };
const battleProject = {
  format: "rpgkit-project/v1" as const,
  title: "PR1 QuickJS battle scene",
  tileSize: 16 as const,
  start: { map: MAP_ID, x: 2, y: 2, dir: "down" as const },
  sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" as const }],
  items: [],
  maps: [battleMap],
};
const battleSession = createSession(battleProject, 60, { battle: kb4BattleRules });
let battleState = stepSession(battleSession, startSession(battleProject, battleSession), { buttons: 0 });

const benches: Record<BenchName, () => number> = {
  sunstoneIdle: () => {
    idleState = stepSession(idleSession, idleState, { buttons: 0 });
    return idleState.frame;
  },
  sunstoneWalk: () => {
    const buttons = walkFrame++ % 64 < 32 ? 0x0020 : 0x0080;
    walkState = stepSession(walkSession, walkState, { buttons });
    return walkState.frame;
  },
  wanderAuto: () => {
    wander.step(0);
    return wander.now;
  },
  battleScene: () => {
    battleState = stepSession(battleSession, battleState, { buttons: 0 });
    return battleState.frame;
  },
};

declare global {
  // eslint-disable-next-line no-var
  var __pr1Run: (name: BenchName, iterations: number) => number;
  // eslint-disable-next-line no-var
  var __pr1Sink: number;
}

globalThis.__pr1Sink = 0;
globalThis.__pr1Run = (name, iterations) => {
  const bench = benches[name];
  if (!bench) throw new Error(`unknown PR1 benchmark ${name}`);
  let sink = globalThis.__pr1Sink | 0;
  for (let i = 0; i < iterations; i++) sink = (sink ^ bench()) | 0;
  globalThis.__pr1Sink = sink;
  return sink;
};
