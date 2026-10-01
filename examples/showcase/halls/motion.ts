import { text, type HallDefinition } from "../hall-kit.ts";

export const MOTION_HALLS: HallDefinition[] = [
  {
    id: "showcase-movement-controls",
    number: 4,
    title: "Movement Controls & Routes",
    commands: [
      "moveControl",
      "bounded wander",
      "moveRoute",
      "pathTo",
      "approach",
    ],
    palette: ["#3b2d1f", "#8f5f32"],
    demo: [
      { op: "place", target: { event: "motion-runner" }, x: 4, y: 4, dir: "up" },
      { op: "moveControl", target: { event: "motion-runner" }, control: { kind: "stop" } },
      {
        op: "moveControl",
        target: { event: "motion-runner" },
        control: { kind: "moveType", value: "static" },
      },
      {
        op: "moveControl",
        target: { event: "motion-runner" },
        control: { kind: "speed", value: 5 },
      },
      {
        op: "moveControl",
        target: { event: "motion-runner" },
        control: { kind: "run", value: false },
      },
      {
        op: "moveControl",
        target: { event: "motion-runner" },
        control: { kind: "directionFix", value: false },
      },
      {
        op: "moveControl",
        target: { event: "motion-runner" },
        control: { kind: "through", value: false },
      },
      { op: "place", target: { event: "bounded-wanderer" }, x: 14, y: 4, dir: "down" },
      { op: "moveControl", target: { event: "bounded-wanderer" }, control: { kind: "stop" } },
      {
        op: "moveControl",
        target: { event: "bounded-wanderer" },
        control: { kind: "moveType", value: "static" },
      },
      {
        op: "moveControl",
        target: { event: "bounded-wanderer" },
        control: { kind: "speed", value: 3 },
      },
      {
        op: "moveControl",
        target: { event: "bounded-wanderer" },
        control: { kind: "run", value: false },
      },
      {
        op: "moveControl",
        target: { event: "bounded-wanderer" },
        control: { kind: "directionFix", value: false },
      },
      {
        op: "moveControl",
        target: { event: "bounded-wanderer" },
        control: { kind: "through", value: false },
      },
      { op: "place", target: { event: "route-blocker" }, x: 7, y: 4, dir: "down" },
      { op: "place", target: { event: "approach-anchor" }, x: 17, y: 9, dir: "left" },
      text("Every actor was reset.", "This demonstration is safe to repeat."),
      {
        op: "moveControl",
        target: { event: "bounded-wanderer" },
        control: {
          kind: "wander",
          bounds: { x: 13, y: 3, width: 4, height: 3 },
          frequency: 5,
        },
      },
      text("The gold curator now wanders inside", "a four-by-three tile rectangle."),
      {
        op: "moveControl",
        target: { event: "motion-runner" },
        control: { kind: "speed", value: 5 },
      },
      {
        op: "moveControl",
        target: { event: "motion-runner" },
        control: { kind: "run", value: true },
      },
      {
        op: "moveControl",
        target: { event: "motion-runner" },
        control: { kind: "directionFix", value: true },
      },
      {
        op: "moveControl",
        target: { event: "motion-runner" },
        control: { kind: "through", value: true },
      },
      {
        op: "moveRoute",
        target: { event: "motion-runner" },
        wait: true,
        route: {
          steps: ["moveRight", "moveRight", "moveRight", "moveRight"],
          repeat: false,
          skippable: false,
        },
      },
      text("Speed plus run crossed the blocking crystal.", "directionFix kept the runner facing up."),
      {
        op: "moveControl",
        target: { event: "motion-runner" },
        control: { kind: "directionFix", value: false },
      },
      {
        op: "moveControl",
        target: { event: "motion-runner" },
        control: { kind: "through", value: false },
      },
      {
        op: "moveControl",
        target: { event: "motion-runner" },
        control: { kind: "run", value: false },
      },
      {
        op: "moveRoute",
        target: { event: "motion-runner" },
        wait: true,
        route: {
          steps: [{ pathTo: { x: 12, y: 9, retries: 3 } }],
          repeat: false,
          skippable: false,
        },
      },
      text("pathTo planned a route around live obstacles."),
      {
        op: "moveRoute",
        target: { event: "motion-runner" },
        wait: true,
        route: {
          steps: [{ approach: { target: { event: "approach-anchor" }, side: "left", retries: 3 } }],
          repeat: false,
          skippable: false,
        },
      },
      text("approach chose the anchor's left side.", "The runner stopped nearby and faced it."),
      {
        op: "moveRoute",
        target: { event: "motion-runner" },
        wait: false,
        route: {
          steps: ["moveLeft", "moveRight"],
          repeat: true,
          skippable: false,
        },
      },
      { op: "wait", seconds: 0.65 },
      { op: "moveControl", target: { event: "motion-runner" }, control: { kind: "stop" } },
      { op: "wait", seconds: 0.15 },
      { op: "moveControl", target: { event: "bounded-wanderer" }, control: { kind: "stop" } },
      {
        op: "moveControl",
        target: { event: "bounded-wanderer" },
        control: { kind: "moveType", value: "static" },
      },
      text("stop ended the repeating route.", "moveType static also ended autonomous wander."),
    ],
    events: [
      {
        id: "motion-runner",
        name: "Route runner",
        x: 4,
        y: 4,
        pages: [{
          trigger: "action",
          sprite: "guide",
          blocks: true,
          commands: [text("I demonstrate speed, running, collision,", "and movement routes.")],
        }],
      },
      {
        id: "bounded-wanderer",
        name: "Bounded wanderer",
        x: 14,
        y: 4,
        pages: [{
          trigger: "action",
          sprite: "curator",
          blocks: true,
          moveType: "static",
          moveSpeed: 3,
          commands: [text("My random movement stays inside", "the corner's four-by-three tile rectangle.")],
        }],
      },
      {
        id: "route-blocker",
        name: "Blocking route prop",
        x: 7,
        y: 4,
        pages: [{
          trigger: "action",
          sprite: "portal",
          blocks: true,
          commands: [text("I block ordinary movement.", "The through control can cross my tile.")],
        }],
      },
      {
        id: "approach-anchor",
        name: "Approach target",
        x: 17,
        y: 9,
        pages: [{
          trigger: "action",
          sprite: "guide",
          blocks: true,
          commands: [text("approach picks a side, stops nearby,", "and faces its target.")],
        }],
      },
    ],
  },
  {
    id: "showcase-input-and-idle",
    number: 10,
    title: "Input Locks & World Idle",
    commands: ["lockInput", "unlockInput", "worldIdle"],
    palette: ["#312244", "#6d597a"],
    demo: [
      { op: "switch", id: "motion.idle.armed", value: false },
      { op: "switch", id: "motion.idle.busy-seen", value: false },
      { op: "switch", id: "motion.idle.unlocked", value: false },
      { op: "switch", id: "motion.idle.action-done", value: false },
      { op: "switch", id: "motion.idle.safe", value: false },
      { op: "switch", id: "motion.idle.premature", value: false },
      { op: "switch", id: "motion.idle.gate-done", value: false },
      text(
        "The next pause locks walking and new interactions.",
        "The observers were reset for a fresh run.",
      ),
      { op: "lockInput" },
      { op: "switch", id: "motion.idle.armed", value: true },
      { op: "wait", seconds: 0.75 },
      { op: "unlockInput" },
      { op: "switch", id: "motion.idle.unlocked", value: true },
      text(
        "Input is unlocked; this action is still active.",
        "The worldIdle autorun waits for it to end.",
      ),
      { op: "switch", id: "motion.idle.action-done", value: true },
    ],
    events: [
      {
        id: "locked-world-observer",
        name: "Locked-world parallel observer",
        x: 18,
        y: 12,
        pages: [
          { trigger: "action", commands: [] },
          {
            condition: {
              all: [
                { kind: "switch", id: "motion.idle.armed" },
                { kind: "switch", id: "motion.idle.busy-seen", value: false },
                { kind: "worldIdle", negate: true },
              ],
            },
            trigger: "parallel",
            commands: [
              { op: "switch", id: "motion.idle.busy-seen", value: true },
              { op: "exit" },
            ],
          },
          {
            condition: { switch: "motion.idle.busy-seen" },
            trigger: "action",
            commands: [],
          },
        ],
      },
      {
        id: "idle-world-gate",
        name: "World-idle autorun gate",
        x: 18,
        y: 13,
        pages: [
          { trigger: "action", commands: [] },
          {
            condition: {
              all: [
                { kind: "switch", id: "motion.idle.armed" },
                { kind: "worldIdle" },
              ],
            },
            trigger: "autorun",
            commands: [
              {
                op: "if",
                if: { kind: "switch", id: "motion.idle.busy-seen" },
                then: [{
                  op: "if",
                  if: { kind: "switch", id: "motion.idle.unlocked" },
                  then: [{
                    op: "if",
                    if: { kind: "switch", id: "motion.idle.action-done" },
                    then: [{ op: "switch", id: "motion.idle.safe", value: true }],
                    else: [{ op: "switch", id: "motion.idle.premature", value: true }],
                  }],
                  else: [{ op: "switch", id: "motion.idle.premature", value: true }],
                }],
                else: [{ op: "switch", id: "motion.idle.premature", value: true }],
              },
              {
                op: "if",
                if: { kind: "switch", id: "motion.idle.safe" },
                then: [text(
                  "worldIdle is true: input is unlocked,",
                  "and the initiating action has ended.",
                  "The parallel observer saw the lock as busy.",
                )],
                else: [text(
                  "The idle proof started too early.",
                  "Run the demonstration again to reset it.",
                )],
              },
              { op: "switch", id: "motion.idle.gate-done", value: true },
            ],
          },
          {
            condition: { switch: "motion.idle.gate-done" },
            trigger: "action",
            commands: [],
          },
        ],
      },
    ],
  },
];
