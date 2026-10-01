// End-to-end reducer coverage for examples/showcase. Every room is entered
// through its real lobby portal, approached on foot, and triggered through
// the action button before its feature-specific state is inspected.

import { describe, expect, test } from "bun:test";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { AttractController } from "../src/engine/attract.ts";
import { expandTapeRuns } from "../src/engine/tape.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionInput,
  type SessionState,
} from "../src/engine/session.ts";
import { buildShowcaseProject, SHOWCASE_HALLS } from "../examples/showcase/showcase-data.ts";
import { HALL_DEMO, hallDoorPosition } from "../examples/showcase/hall-kit.ts";
import { SHOWCASE_EXTENSIONS } from "../examples/showcase/extensions.ts";
import { showcaseBattleRules } from "../examples/showcase/showcase-battle-rules.ts";
import { NAME_INPUT_SCENE_ID, nameInputRules } from "../src/engine/name-input.ts";
import {
  SHOWCASE_TOUR_RUNS,
  SHOWCASE_TOUR_VISITS,
} from "../examples/showcase/demo-tape.ts";

const project = buildShowcaseProject();
const options = {
  extensions: SHOWCASE_EXTENSIONS,
  battle: showcaseBattleRules,
  scenes: { [NAME_INPUT_SCENE_ID]: nameInputRules },
};

class Driver {
  readonly session: Session;
  state: SessionState;

  constructor() {
    this.session = createSession(project, 60, options);
    this.state = startSession(project, this.session);
    this.tick();
  }

  tick(input: Partial<SessionInput> = {}): SessionState {
    this.state = stepSession(this.session, this.state, { buttons: 0, ...input });
    if (this.state.interp.error) throw new Error(this.state.interp.error.message);
    return this.state;
  }

  pulseConfirm(): void {
    this.tick({ buttons: BTN.CIRCLE, confirmEdge: true });
    this.tick();
  }

  pulseCancel(): void {
    this.tick({ buttons: BTN.CROSS, cancelEdge: true });
    this.tick();
  }

  private moveAxis(axis: "x" | "y", target: number, expectedMap: string): void {
    for (let frame = 0; frame < 1_200; frame++) {
      if (this.state.mapId !== expectedMap) return;
      const value = axis === "x" ? this.state.move.tx : this.state.move.ty;
      if (value === target && !this.state.move.moving) return;
      const button = axis === "x"
        ? target > value ? BTN.RIGHT : BTN.LEFT
        : target > value ? BTN.DOWN : BTN.UP;
      this.tick({ buttons: button });
    }
    throw new Error(`showcase test: never reached ${axis}=${target} on ${expectedMap}`);
  }

  private settleMap(mapId: string): void {
    this.until(
      (state) => state.mapId === mapId && state.fade === null && state.interp.main === null && !state.move.moving,
      { autoText: false, limit: 600 },
    );
  }

  enter(number: number): void {
    const hall = SHOWCASE_HALLS.find((candidate) => candidate.number === number);
    if (!hall) throw new Error(`showcase test: unknown hall ${number}`);
    const index = SHOWCASE_HALLS.indexOf(hall);
    const { x: doorX, y: doorY } = hallDoorPosition(index, SHOWCASE_HALLS.length);

    // Horizontal first avoids the guide and directory sign on the lobby's
    // centre aisle. Walking onto the authored portal performs the transfer.
    this.moveAxis("x", doorX, "showcase-lobby");
    this.moveAxis("y", doorY, "showcase-lobby");
    this.settleMap(hall.id);
    expect(this.state.mapId).toBe(hall.id);

    // Approach the curator from below; the room sign stays beside the entry.
    this.moveAxis("x", HALL_DEMO.x, hall.id);
    this.moveAxis("y", HALL_DEMO.y + 1, hall.id);
    expect([this.state.move.tx, this.state.move.ty, this.state.move.facing]).toEqual([
      HALL_DEMO.x,
      HALL_DEMO.y + 1,
      2,
    ]);
    this.pulseConfirm();
  }

  until(
    predicate: (state: SessionState) => boolean,
    opts: { autoText?: boolean; limit?: number } = {},
  ): SessionState {
    const autoText = opts.autoText ?? true;
    for (let frame = 0; frame < (opts.limit ?? 4_000); frame++) {
      if (predicate(this.state)) return this.state;
      if (autoText && this.state.interp.modal?.kind === "text") this.pulseConfirm();
      else this.tick();
    }
    throw new Error(`showcase test: condition timed out on ${this.state.mapId}`);
  }

  finish(extra?: (state: SessionState) => boolean): SessionState {
    return this.until((state) =>
      state.interp.main === null && state.interp.modal === null && state.scene === null &&
      state.fade === null && state.playerRoute === null && (extra?.(state) ?? true));
  }
}

function enter(number: number): Driver {
  const driver = new Driver();
  driver.enter(number);
  return driver;
}

describe("showcase rooms — real lobby entry and repeatable demonstrations", () => {
  test("1. screen effects reaches day/dusk/night, flash, then clears the named presentation state", () => {
    const d = enter(1);
    const night = d.until((state) => state.interp.screen?.tints?.["time-of-day"]?.to.b === 140);
    expect(night.interp.screen?.tints?.["time-of-day"]?.to).toEqual({ r: 28, g: 54, b: 140, a: 112 });
    const flashed = d.until((state) => state.interp.screen?.flash !== undefined);
    expect(flashed.interp.screen?.flash?.from.a).toBeGreaterThan(0);
    const done = d.finish();
    expect(done.interp.screen?.tints?.["time-of-day"]).toBeUndefined();
    expect(done.interp.screen?.flash).toBeUndefined();
    expect(done.interp.screen?.shake).toBeUndefined();
    expect(done.interp.screen?.backdrop).toBeUndefined();
    expect(done.interp.screen?.balloons).toBeUndefined();
  });

  test("2. map animations coexist above/below and follow/pin before stopAnim clears them", () => {
    const d = enter(2);
    const active = d.until((state) => (state.interp.anims?.length ?? 0) >= 4);
    expect(active.interp.anims?.map((anim) => [anim.id, anim.layer, anim.target])).toEqual([
      ["tile-loop", "below", null],
      ["player-aura", "above", "player"],
      ["moving-aura", "above", { event: "animation-target" }],
      ["pinned-aura", "above", null],
    ]);
    const done = d.finish();
    expect(done.interp.anims).toBeUndefined();
    expect(done.sw.switches["presentation.anim.release"]).toBe(false);
  });

  test("3. appearance, layer variants, and tileProperty conditions execute and restore sparsely", () => {
    const d = enter(3);
    const night = d.until((state) => state.interp.layers?.weather?.variant === "night");
    expect(night.interp.layers?.weather).toEqual({ visible: true, variant: "night" });
    const blocked = d.until((state) => state.interp.tileProperties?.["222"]?.passage === "block");
    expect(blocked.interp.tileProperties?.["222"]).toEqual({ passage: "block", enter: ["left"], exit: ["right"] });
    const done = d.finish();
    expect(done.sw.playerAppearance).toBeUndefined();
    expect(done.interp.eventAppearances).toBeUndefined();
    expect(done.interp.layers).toBeUndefined();
    expect(done.interp.tileProperties).toBeUndefined();
  });

  test("4. bounded wander, run/through/facing controls, pathTo, approach, and stop finish cleanly", () => {
    const d = enter(4);
    const done = d.finish();
    expect(done.chars.chars["motion-runner"]).toMatchObject({ moving: false });
    expect(done.interp.moveControls?.events["motion-runner"]).toMatchObject({
      running: false,
      directionFix: false,
      through: false,
      routeStopped: true,
    });
    expect(done.interp.moveControls?.events["bounded-wanderer"]).toMatchObject({ moveType: "static" });
    expect(done.playerRoute).toBeNull();
  });

  test("5. extChoice reads live rows and its resolver atomically writes extension and variables", () => {
    const d = enter(5);
    const choosing = d.until((state) => state.interp.modal?.kind === "choices");
    expect(choosing.interp.modal).toMatchObject({
      kind: "choices",
      keys: ["compass", "lantern", "crown"],
      enabled: [true, false, true],
      index: 0,
    });
    d.pulseConfirm();
    const done = d.finish();
    expect(done.sw.variables).toMatchObject({
      "showcase.choiceIndex": 0,
      "showcase.choiceKey": "compass",
      "showcase.choiceCancelled": 0,
      "showcase.resolvedIndex": 0,
      "showcase.resolvedCount": 1,
      "showcase.extensionRuns": 1,
    });
    expect(done.ext).toMatchObject({ visits: 1, completed: 1, selections: ["compass"], lastChoice: "compass" });
  });

  test("6. battle processing reaches the win, lose, and escape authored branches", () => {
    const play = (result: "win" | "lose" | "escape"): SessionState => {
      const d = enter(6);
      d.until((state) => state.scene?.kind === "battle");
      const frozenFrame = d.state.interp.frame;
      const frozenAnims = structuredClone(d.state.interp.anims);
      const frozenAge = frozenFrame - frozenAnims![0]!.start;
      const frozenPaused = d.state.scene!.pausedTicks;
      for (let frame = 0; frame < 10; frame++) d.tick();
      expect(d.state.interp.anims, `${result} resident map animation`).toEqual(frozenAnims);
      expect(d.state.scene?.pausedTicks, `${result} frozen ticks`).toBe(frozenPaused + 10);
      let strikes = 0;
      for (let frame = 0; frame < 600 && d.state.scene; frame++) {
        const battle = d.state.scene.state as Record<string, unknown>;
        if (battle.phase === "command") {
          if (result === "escape") d.pulseCancel();
          else {
            if (result === "lose" && battle.commandIndex === 0) {
              d.tick({ buttons: BTN.RIGHT });
              d.tick();
            }
            d.pulseConfirm();
            strikes++;
          }
        } else if (battle.phase === "message" &&
          Number(battle.nowTick) >= Number(battle.readyTick)) d.pulseConfirm();
        else d.tick();
      }
      expect(d.state.scene).toBeNull();
      const resumed = d.until((state) => state.interp.modal?.kind === "text" && state.interp.anims?.[0]?.id === "arena-loop");
      expect(resumed.interp.frame - resumed.interp.anims![0]!.start, `${result} resumed animation age`)
        .toBeLessThanOrEqual(frozenAge + 1);
      const done = d.finish();
      expect(strikes, result).toBeLessThanOrEqual(2);
      expect(done.interp.anims, result).toBeUndefined();
      return done;
    };

    for (const result of ["win", "lose", "escape"] as const) {
      const done = play(result);
      expect(done.sw.variables["showcase.battleResult"], result).toBe(result);
      expect(done.sw.switches[`showcase.battle.${result}`], result).toBe(true);
      expect(done.sw.switches[`showcase.branch.${result}`], result).toBe(true);
      for (const other of ["win", "lose", "escape"] as const) {
        if (other !== result) expect(done.sw.switches[`showcase.branch.${other}`], result).toBeUndefined();
      }
    }
  });

  test("7. shop purchase changes gold, inventory, and finite stock before the shop can reopen", () => {
    const d = enter(7);
    const opened = d.until((state) => state.interp.modal?.kind === "shop");
    expect(opened.interp.modal).toMatchObject({ kind: "shop", stage: "buy", gold: 80 });
    d.pulseConfirm();
    expect(d.state.sw.gold).toBe(70);
    expect(d.state.sw.items.potion).toBe(1);
    expect(d.state.sw.shopStock["showcase-curio-shop:potion"]).toBe(3);
    d.pulseCancel();
    const done = d.finish();
    expect(done.interp.modal).toBeNull();
  });

  test("8. streamed-world curator routes the 16x32 player across the large-room viewport", () => {
    const d = enter(8);
    const done = d.finish();
    expect(done.sw.switches["showcase.streaming.complete"]).toBe(true);
    expect([done.move.tx, done.move.ty]).toEqual([17, 3]);
  });

  test("9. theme and portrait room leaves the application-observed sunrise switch on", () => {
    const d = enter(9);
    const done = d.finish();
    expect(done.sw.switches["showcase.theme.alt"]).toBe(true);
    expect(done.sw.switches["showcase.theme.complete"]).toBe(true);
  });

  test("10. lockInput remains busy to observers and worldIdle opens only after the action ends", () => {
    const d = enter(10);
    const done = d.finish((state) => state.sw.switches["motion.idle.gate-done"] === true);
    expect(done.interp.inputLocked).toBe(false);
    expect(done.sw.switches["motion.idle.busy-seen"]).toBe(true);
    expect(done.sw.switches["motion.idle.unlocked"]).toBe(true);
    expect(done.sw.switches["motion.idle.action-done"]).toBe(true);
    expect(done.sw.switches["motion.idle.safe"]).toBe(true);
    expect(done.sw.switches["motion.idle.premature"]).toBe(false);
  });

  test("11. save room publishes one safe-point request for the app-owned real SaveMenu", () => {
    const d = enter(11);
    const done = d.finish();
    expect(done.sw.variables["showcase.save.request"]).toBe(1);
    expect(done.sw.switches["showcase.save.complete"]).toBe(true);
  });

  test("12. attract room explains takeover and rewind, then records completion", () => {
    const d = enter(12);
    const done = d.finish();
    expect(done.sw.switches["showcase.attract.explained"]).toBe(true);
  });

  test("13. sound studio mixes tracks, suspends BGM for ME, then restores and stops cleanly", () => {
    const d = enter(13);
    const mixed = d.until((state) => state.interp.modal?.kind === "text" && state.interp.audio?.bgs !== undefined);
    expect(mixed.interp.audio).toMatchObject({
      bgm: { id: "town-theme", volume: 42, pitch: 100 },
      bgs: { id: "ice-ambience", volume: 16, pitch: 80 },
    });
    expect(mixed.sw.switches["showcase.audio.playing"]).toBe(true);

    const fanfare = d.until((state) => state.interp.audio?.me?.id === "bark-fanfare");
    expect(fanfare.interp.audio?.me).toMatchObject({ id: "bark-fanfare", durationTicks: 21 });

    const paused = d.until((state) => state.interp.audio?.bgm?.paused === true);
    expect(paused.interp.audio?.bgm?.id).toBe("town-theme");

    const done = d.finish();
    expect(done.sw.switches["showcase.audio.complete"]).toBe(true);
    expect(done.interp.audio?.bgm).toBeUndefined();
    expect(done.interp.audio?.bgs).toBeUndefined();
    expect(done.interp.audio?.savedBgm).toMatchObject({ id: "town-theme", volume: 42, pitch: 100 });
  });

  test("14. registration desk commits a player name and expands it in the next greeting", () => {
    const d = enter(14);
    d.until((state) => state.scene?.kind === "scene");
    d.pulseConfirm(); // append A to the default Player name
    d.tick({ buttons: BTN.LEFT, leftEdge: true }); // cursor wraps to CANCEL
    d.tick();
    d.tick({ buttons: BTN.LEFT, leftEdge: true }); // then to OK
    d.tick();
    d.pulseConfirm();
    const greeting = d.until((state) => state.scene === null && state.interp.modal?.kind === "text");
    expect(greeting.sw.playerName).toBe("PlayerA");
    expect(greeting.interp.modal).toMatchObject({
      kind: "text",
      lines: [
        "CURATOR: Welcome, PlayerA! Your badge is ready.",
        "The player name now belongs to session and save state.",
      ],
    });
    const done = d.finish();
    expect(done.sw.switches["showcase.registration.complete"]).toBe(true);
    expect(done.sw.switches["showcase.registration.cancelled"]).toBeUndefined();
  });
});

describe("showcase attract tape", () => {
  const tape = expandTapeRuns(SHOWCASE_TOUR_RUNS);

  test("the frozen source visits every hall in authored order", () => {
    expect(SHOWCASE_TOUR_VISITS.join("\n")).toBe(SHOWCASE_HALLS.map((hall) => hall.id).join("\n"));
    expect(tape.length).toBe(2_037);
    const doors = SHOWCASE_HALLS.map((_, index) => hallDoorPosition(index, SHOWCASE_HALLS.length));
    expect(new Set(doors.map(({ x, y }) => `${x},${y}`)).size).toBe(SHOWCASE_HALLS.length);
  });

  test("60/30/20 Hz consume the same source tape into identical reducer state", () => {
    const finals: string[] = [];
    for (const hz of [60, 30, 20] as const) {
      const controller = new AttractController(project, tape, {
        hz,
        tapeHz: 60,
        idleFrames: hz * 10,
        endHoldFrames: 60_000,
        ...options,
      });
      controller.startAttract();
      const seen = new Set<string>();
      for (let guard = 0; controller.status().demoFrame < tape.length && guard < 4_000; guard++) {
        controller.step(0);
        if (controller.state.mapId !== "showcase-lobby") seen.add(controller.state.mapId);
      }
      expect([...seen].sort(), `${hz} Hz rooms`).toEqual(SHOWCASE_HALLS.map((hall) => hall.id).sort());
      expect(controller.status().demoFrame, `${hz} Hz source frames`).toBe(tape.length);
      finals.push(JSON.stringify(controller.state));
    }
    expect(finals[1]).toBe(finals[0]);
    expect(finals[2]).toBe(finals[0]);
  });

  test("L rewind restores the same source state as a fresh from-zero replay", () => {
    const run = (sourceFrames: number): AttractController => {
      const controller = new AttractController(project, tape, {
        hz: 60,
        tapeHz: 60,
        endHoldFrames: 60_000,
        ...options,
      });
      controller.startAttract();
      while (controller.length < sourceFrames) controller.step(0);
      return controller;
    };
    const target = 700;
    const oracle = run(target);
    const rewound = run(target + 180);
    rewound.step(BTN.LTRIGGER);
    expect(rewound.length).toBe(target);
    expect(rewound.state).toEqual(oracle.state);
    expect(rewound.status().rewound).toBe(true);
  });
});
