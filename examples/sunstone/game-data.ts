// examples/sunstone/game-data.ts — "The Sunstone of Bramble Hollow", the
// three-map sample game (village → forest → cave), written against the
// rpgkit-project/v1 types. It exercises:
//
//   - the two-way transfer chain (north gates / return pads, one faded),
//   - the guard's page.moveRoute patrol and the boy/slime/bat random
//     wanderers,
//   - a moveType:"approach" NPC (the curious slime, village west green),
//   - the "porter" event whose action runs a command moveRoute: the
//     player is turned with a fire-and-forget route while the porter
//     walks a waited route the dialog fiber parks on.
//
// Geometry is authored in code; gen-assets.ts bakes the chunks and
// data/sunstone.json is the emitted project document.

import type {
  Command,
  GameEvent,
  MapDef,
  Project,
  Sheet,
  TileId,
} from "../../src/engine/types.ts";

const TOWN: Sheet = { id: "town", cols: 12, rows: 11, pak: "chunks" };
const DUN: Sheet = {
  id: "dun",
  cols: 12,
  rows: 11,
  pak: "chunks",
  defaultPassage: "block",
  pass: [24, 25, 30, 42, 48, 50, 52],
};

const t = (cell: number): TileId => `town.${cell}`;
const d = (cell: number): TileId => `dun.${cell}`;
const txt = (lines: string[]): Command => ({ op: "text", lines });

function fill<X>(w: number, h: number, v: X): X[] {
  return Array.from({ length: w * h }, () => v);
}

function paint(map: MapDef, x: number, y: number, tile: TileId, flag?: "pass" | "block"): void {
  map.ground[y * map.width + x] = tile;
  if (flag) (map.passage ??= []).push([y * map.width + x, flag]);
}

function upper(map: MapDef, x: number, y: number, tile: TileId, block = false): void {
  (map.upper ??= []).push([y * map.width + x, tile]);
  if (block) (map.passage ??= []).push([y * map.width + x, "block"]);
}

// --- map 1: village (20x13) ------------------------------------------------

function village(): MapDef {
  const W = 20;
  const H = 13;
  const m: MapDef = {
    id: "village",
    name: "Bramble Hollow",
    width: W,
    height: H,
    sheets: [TOWN.id],
    ground: fill(W, H, t(0)),
    events: [],
  };
  // Dirt road across row 7; the north gate opening at (9,0).
  for (let x = 0; x < W; x++) paint(m, x, 7, t([39, 40, 41, 42][x % 4]!));
  paint(m, 9, 0, t(42));
  // Stone plaza around the well.
  for (let y = 5; y <= 9; y++) {
    for (let x = 8; x <= 11; x++) {
      if (!(x === 9 && y === 7)) paint(m, x, y, t(43));
    }
  }
  upper(m, 10, 6, t(104), true);
  // Tree ring; (9,0) stays open for the north road.
  const ring = [3, 4, 17, 29, 30, 3, 4];
  for (let x = 0; x < W; x++) {
    if (x !== 9) upper(m, x, 0, t(ring[x % ring.length]!), true);
    upper(m, x, H - 1, t(ring[(x + 2) % ring.length]!), true);
  }
  for (let y = 1; y < H - 1; y++) {
    upper(m, 0, y, t(ring[y % ring.length]!), true);
    upper(m, W - 1, y, t(ring[(y + 3) % ring.length]!), true);
  }
  // Fenced west garden.
  for (let x = 2; x <= 6; x++) {
    upper(m, x, 2, t(70), true);
    upper(m, x, 5, t(68), true);
  }
  for (let y = 3; y <= 4; y++) {
    upper(m, 2, y, t(69), true);
    upper(m, 6, y, t(71), true);
  }
  upper(m, 4, 5, t(85), true);
  paint(m, 4, 3, t(43));
  upper(m, 3, 3, t(29));
  upper(m, 5, 4, t(17));
  // East house with a walkable door at (16,5).
  for (let x = 14; x <= 18; x++) upper(m, x, 2, t(44), true);
  for (const x of [14, 15, 17, 18]) upper(m, x, 5, t(44), true);
  paint(m, 16, 5, t(88));
  for (let y = 3; y <= 4; y++) {
    upper(m, 14, y, t(46), true);
    upper(m, 18, y, t(47), true);
  }
  for (let y = 3; y <= 4; y++) for (let x = 15; x <= 17; x++) paint(m, x, y, t(43));
  upper(m, 15, 3, t(93));
  // Decor.
  upper(m, 3, 9, t(29));
  upper(m, 16, 10, t(17));
  paint(m, 2, 11, t(1));
  upper(m, 12, 3, t(3), true);
  upper(m, 13, 2, t(4), true);
  upper(m, 12, 9, t(30), true);
  upper(m, 13, 7, t(83), true);

  m.events = [
    {
      id: "ambient-music",
      name: "Bramble Hollow Theme",
      x: 0,
      y: 0,
      pages: [
        {
          trigger: "parallel",
          commands: [
            { op: "playBgm", id: "sunstone-theme", volume: 28 },
            { op: "selfSwitch", key: "A", value: true },
          ],
        },
        {
          condition: { selfSwitch: "A" },
          trigger: "parallel",
          commands: [],
        },
      ],
    },
    {
      id: "elder",
      name: "Village Elder",
      x: 9,
      y: 5,
      pages: [
        {
          trigger: "action",
          sprite: "wiz",
          blocks: true,
          commands: [
            txt([
              "ELDER: The Sunstone that lit our valley",
              "was taken into the cave beyond the wood.",
              "Thorns seal the forest path. Take the key",
              "from the village chest, hero.",
            ]),
            {
              op: "choices",
              prompt: "Ask about the road ahead?",
              options: [
                {
                  text: "The forest?",
                  commands: [
                    txt(["ELDER: A rune stone sleeps among the trees.", "Touch it, and the cave gate will know you."]),
                  ],
                },
                {
                  text: "Farewell",
                  commands: [txt(["ELDER: Walk tall. The hollow believes in you."])],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      id: "merchant",
      name: "Traveling Merchant",
      x: 11,
      y: 5,
      pages: [
        {
          trigger: "action",
          sprite: "merchant",
          blocks: true,
          commands: [
            txt(["MERCHANT: Wares for the bold! One torch,", "ten coin. It is dark past the thorns."]),
            {
              op: "choices",
              prompt: "Buy a torch for 10 gold?",
              options: [
                {
                  text: "Buy torch",
                  commands: [
                    {
                      op: "if",
                      if: { kind: "gold", amount: 10 },
                      then: [
                        { op: "gold", set: "sub", amount: 10 },
                        { op: "item", item: "torch", set: "add", count: 1 },
                        txt(["MERCHANT: A deal well struck. Mind the drip", "in the cave — it is never water."]),
                      ],
                      else: [
                        txt(["MERCHANT: Your purse is lighter than air.", "The old chest by the gate has coin."]),
                      ],
                    },
                  ],
                },
                {
                  text: "Not now",
                  commands: [txt(["MERCHANT: I will be here. Stone endures."])],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      id: "sign",
      name: "Village Sign",
      x: 13,
      y: 7,
      pages: [
        {
          trigger: "action",
          sprite: null,
          commands: [txt(["<Bramble Hollow>", "North: Whispering Wood.", "Do not feed the bats."])],
        },
      ],
    },
    {
      id: "boy",
      name: "Curious Boy",
      x: 7,
      y: 9,
      pages: [
        {
          trigger: "action",
          sprite: "boy",
          blocks: true,
          moveType: "random",
          commands: [txt(["BOY: The slimes in the cave only move", "when you are not looking. Probably."])],
        },
      ],
    },
    {
      id: "guard",
      name: "Off-duty Guard",
      x: 3,
      y: 7,
      pages: [
        {
          trigger: "action",
          sprite: "villager",
          blocks: true,
          moveRoute: {
            repeat: true,
            skippable: false,
            steps: ["moveRight", "moveRight", "wait", "faceUp", "wait", "moveLeft", "moveLeft", "faceDown"],
          },
          commands: [txt(["GUARD: Patrol duty. Two steps right, two", "back. I have memorized every pebble."])],
        },
      ],
    },
    {
      // P1④ approach NPC: ambles toward the player inside a six-tile
      // Manhattan sight, then talks when faced.
      id: "curious-slime",
      name: "Curious Slime",
      x: 3,
      y: 10,
      pages: [
        {
          trigger: "action",
          sprite: "slime",
          blocks: true,
          moveType: "approach",
          commands: [txt(["The slime bobs eagerly, as if asking", "to come along. It cannot."])],
        },
      ],
    },
    {
      // P1④ command-route demo: a fire-and-forget route turns the player
      // while a waited route walks the porter out and back; the dialog
      // fiber stays parked ("external") until he lands.
      id: "porter",
      name: "Station Porter",
      x: 12,
      y: 11,
      pages: [
        {
          trigger: "action",
          sprite: "merchant",
          blocks: true,
          commands: [
            txt(["PORTER: Eyes front, hero. Watch my step."]),
            {
              op: "moveRoute",
              target: "player",
              wait: false,
              route: { steps: ["faceUp"], repeat: false, skippable: false },
            },
            {
              op: "moveRoute",
              target: "this",
              wait: true,
              route: {
                steps: ["moveRight", "moveRight", "wait", "moveLeft", "moveLeft"],
                repeat: false,
                skippable: false,
              },
            },
            txt(["PORTER: Two east, two west. Back at post."]),
          ],
        },
      ],
    },
    {
      id: "village-chest",
      name: "Village Chest",
      x: 17,
      y: 3,
      pages: [
        {
          trigger: "action",
          sprite: "chest-closed",
          blocks: true,
          commands: [
            { op: "gold", set: "add", amount: 25 },
            { op: "item", item: "thorn-key", set: "add", count: 1 },
            { op: "selfSwitch", key: "A", value: true },
            txt(["Found 25 gold and an IRON KEY.", "Its teeth are shaped like brambles."]),
          ],
        },
        {
          condition: { selfSwitch: "A" },
          trigger: "action",
          sprite: "chest-open",
          blocks: true,
          commands: [txt(["The chest is empty. Your chest, however,", "is full of purpose."])],
        },
      ],
    },
    {
      id: "north-gate",
      name: "Path to the Wood",
      x: 9,
      y: 0,
      pages: [
        {
          trigger: "playerTouch",
          sprite: null,
          commands: [{ op: "transfer", map: "forest", x: 10, y: 13, dir: "up" }],
        },
      ],
    },
  ];
  return m;
}

// --- map 2: forest (18x14) -------------------------------------------------

function forest(): MapDef {
  const W = 18;
  const H = 14;
  const m: MapDef = {
    id: "forest",
    name: "Whispering Wood",
    width: W,
    height: H,
    sheets: [TOWN.id],
    ground: fill(W, H, t(0)),
    events: [],
  };
  // Three-wide winding corridor: south pad column 10, west to column 5,
  // up to row 4, east to column 9, north to the thorn gate.
  const path = new Set<number>();
  const seg = (x0: number, y0: number, x1: number, y1: number): void => {
    const dx = Math.sign(x1 - x0);
    const dy = Math.sign(y1 - y0);
    let x = x0;
    let y = y0;
    for (;;) {
      path.add(y * W + x);
      if (dx !== 0) {
        path.add((y - 1) * W + x);
        path.add((y + 1) * W + x);
      }
      if (dy !== 0) {
        path.add(y * W + x - 1);
        path.add(y * W + x + 1);
      }
      if (x === x1 && y === y1) break;
      x += dx;
      y += dy;
    }
  };
  seg(10, 13, 10, 9);
  seg(10, 9, 5, 9);
  seg(5, 9, 5, 4);
  seg(5, 4, 9, 4);
  seg(9, 4, 9, 0);
  const trees = [3, 4, 30, 31, 5, 6, 18, 19, 20];
  for (let i = 0; i < W * H; i++) {
    if (!path.has(i)) {
      const x = i % W;
      const y = Math.floor(i / W);
      upper(m, x, y, t(trees[(x * 7 + y * 3) % trees.length]!), true);
    }
  }
  paint(m, 10, 13, t(40));
  upper(m, 7, 8, t(29));
  upper(m, 4, 6, t(17));
  upper(m, 10, 6, t(17));
  paint(m, 10, 11, t(42));
  paint(m, 6, 4, t(41));
  upper(m, 7, 5, t(29));

  m.events = [
    {
      id: "forest-return",
      name: "Path to Village",
      x: 9,
      y: 13,
      pages: [
        {
          trigger: "playerTouch",
          sprite: null,
          commands: [{ op: "transfer", map: "village", x: 9, y: 1, dir: "down" }],
        },
      ],
    },
    {
      id: "thorn-gate",
      name: "Wall of Thorns",
      x: 9,
      y: 0,
      pages: [
        {
          trigger: "action",
          sprite: "thorn",
          blocks: true,
          commands: [
            {
              op: "if",
              if: { kind: "item", id: "thorn-key", count: 1 },
              then: [
                { op: "se", name: "unlock" },
                { op: "selfSwitch", key: "A", value: true },
                txt(["The iron key bites. The thorns part", "with a sound like tearing silk."]),
                { op: "transfer", map: "cave", x: 9, y: 11, dir: "up", fade: 0.4 },
              ],
              else: [txt(["Living thorns seal the path north.", "A key shaped like brambles would open them."])],
            },
          ],
        },
        {
          condition: { selfSwitch: "A" },
          trigger: "playerTouch",
          sprite: null,
          commands: [{ op: "transfer", map: "cave", x: 9, y: 11, dir: "up", fade: 0.4 }],
        },
      ],
    },
    {
      id: "fairy",
      name: "Wood Sprite",
      x: 6,
      y: 6,
      pages: [
        {
          trigger: "action",
          sprite: "slime",
          blocks: true,
          commands: [txt(["SPRITE: The cave remembers every footstep.", "Wake the rune stone east of here, and", "its iron gate will unclench."])],
        },
      ],
    },
    {
      id: "forest-chest",
      name: "Mossy Chest",
      x: 6,
      y: 8,
      pages: [
        {
          trigger: "action",
          sprite: "chest-closed",
          blocks: true,
          commands: [
            { op: "gold", set: "add", amount: 15 },
            { op: "selfSwitch", key: "A", value: true },
            txt(["Moss showers off the lid. Found 15 gold."]),
          ],
        },
        {
          condition: { selfSwitch: "A" },
          trigger: "action",
          sprite: "chest-open",
          blocks: true,
          commands: [txt(["Only moss and one disappointed spider."])],
        },
      ],
    },
    {
      id: "rune-stone",
      name: "Rune Stone",
      x: 9,
      y: 4,
      pages: [
        {
          trigger: "action",
          sprite: "runestone",
          blocks: true,
          commands: [
            { op: "se", name: "chime" },
            { op: "switch", id: "rune-lit", value: true },
            { op: "selfSwitch", key: "A", value: true },
            txt(["You lay your palm on the stone.", "A cold blue light answers, and holds."]),
          ],
        },
        {
          condition: { selfSwitch: "A" },
          trigger: "action",
          sprite: "runestone-lit",
          commands: [txt(["The rune burns blue. Somewhere north,", "iron is moving."])],
        },
      ],
    },
  ];
  return m;
}

// --- map 3: cave (18x13) ---------------------------------------------------

function cave(): MapDef {
  const W = 18;
  const H = 13;
  const m: MapDef = {
    id: "cave",
    name: "Sunstone Cave",
    width: W,
    height: H,
    sheets: [DUN.id],
    ground: fill<TileId>(W, H, null),
    events: [],
  };
  // Dug chamber rows 4..12, cols 1..16; blocking void everywhere else.
  for (let y = 4; y <= 12; y++) {
    for (let x = 1; x <= 16; x++) paint(m, x, y, d(48 + ((x + y) % 4 === 0 ? 2 : 0)));
  }
  // Back wall rows 2-3 with the gate corridor on column 9.
  for (let x = 1; x <= 16; x++) {
    if (x !== 9) {
      paint(m, x, 2, d(40), "block");
      paint(m, x, 3, d(40), "block");
    }
  }
  paint(m, 9, 3, d(52)); // gate event stands on walkable sand
  paint(m, 9, 2, d(30), "pass"); // antechamber approach
  paint(m, 9, 1, d(30), "pass"); // altar floor under the relic chest
  paint(m, 8, 1, d(28), "block");
  paint(m, 10, 1, d(28), "block");
  paint(m, 8, 2, d(28), "block");
  paint(m, 10, 2, d(28), "block");
  for (let y = 4; y <= 12; y++) {
    paint(m, 1, y, d(40), "block");
    paint(m, 16, y, d(40), "block");
  }
  for (const y of [4, 6, 8, 10]) paint(m, 9, y, d(42));
  paint(m, 9, 11, d(42));
  upper(m, 4, 8, d(54));
  upper(m, 13, 6, d(55));
  upper(m, 5, 10, d(62));
  paint(m, 13, 10, d(24));
  paint(m, 14, 10, d(25));
  paint(m, 3, 5, d(24));

  m.events = [
    {
      id: "cave-ambience",
      name: "Dripping Water",
      x: 17,
      y: 1,
      pages: [
        {
          trigger: "parallel",
          sprite: null,
          commands: [
            { op: "wait", seconds: 6 },
            { op: "se", name: "drip", volume: 40 },
          ],
        },
      ],
    },
    {
      id: "cave-return",
      name: "Exit to the Wood",
      x: 9,
      y: 12,
      pages: [
        {
          trigger: "playerTouch",
          sprite: null,
          commands: [{ op: "transfer", map: "forest", x: 10, y: 13, dir: "down" }],
        },
      ],
    },
    {
      id: "rune-gate",
      name: "Iron Gate",
      x: 9,
      y: 3,
      pages: [
        {
          trigger: "action",
          sprite: "irongate",
          blocks: true,
          commands: [
            {
              op: "if",
              if: { kind: "switch", id: "rune-lit", value: true },
              then: [
                { op: "se", name: "unlock" },
                { op: "selfSwitch", key: "A", value: true },
                txt(["Blue light pours from the stone in your", "pack. The gate folds itself open."]),
              ],
              else: [txt(["Bars of cold iron. Runes welded along", "them wait for a light they recognize."])],
            },
          ],
        },
        {
          // Opened gate: no body, no sprite, no commands — the corridor
          // tile is walkable and stepping through does nothing.
          condition: { selfSwitch: "A" },
          trigger: "playerTouch",
          sprite: null,
          commands: [],
        },
      ],
    },
    {
      id: "slime",
      name: "Cave Slime",
      x: 5,
      y: 7,
      pages: [
        {
          trigger: "action",
          sprite: "slime",
          blocks: true,
          moveType: "random",
          commands: [txt(["BLUB.", "(It is, against all advice, fed.)"])],
        },
      ],
    },
    {
      id: "bat",
      name: "Cave Bat",
      x: 12,
      y: 8,
      pages: [
        {
          trigger: "action",
          sprite: "bat",
          blocks: true,
          moveType: "random",
          commands: [txt(["The bat pretends it is a stalactite.", "Its commitment is impressive."])],
        },
      ],
    },
    {
      id: "relic-chest",
      name: "Sunstone Altar",
      x: 9,
      y: 2,
      pages: [
        {
          trigger: "action",
          sprite: "chest-relic",
          blocks: true,
          commands: [
            { op: "se", name: "chime", volume: 80 },
            { op: "item", item: "sunstone", set: "add", count: 1 },
            { op: "switch", id: "won", value: true },
            { op: "selfSwitch", key: "A", value: true },
            txt(["Inside waits the SUNSTONE, warm as a", "small sunrise. Light returns to the hollow."]),
          ],
        },
        {
          condition: { selfSwitch: "A" },
          trigger: "action",
          sprite: "chest-open",
          blocks: true,
          commands: [txt(["The altar breathes slow, satisfied."])],
        },
      ],
    },
    {
      id: "victory",
      name: "Dawn Returns",
      x: 9,
      y: 1,
      pages: [
        {
          condition: { switch: "won" },
          trigger: "autorun",
          sprite: null,
          commands: [
            { op: "wait", seconds: 0.5 },
            txt(["THE END.", "You carried the Sunstone home.", "Bramble Hollow wakes gold again."]),
            { op: "selfSwitch", key: "A", value: true },
            { op: "exit" },
          ],
        },
        {
          condition: { selfSwitch: "A" },
          trigger: "parallel",
          sprite: null,
          commands: [],
        },
      ],
    },
  ];
  return m;
}

const NPC_SPRITES = {
  wiz: "wiz.png",
  boy: "boy.png",
  merchant: "merchant.png",
  villager: "villager.png",
  slime: "slime.png",
  bat: "bat.png",
  // The Kenney chest cells ship as chest-a/b/c.
  "chest-closed": "chest-a.png",
  "chest-open": "chest-b.png",
  "chest-relic": "chest-c.png",
  thorn: "thorn.png",
  irongate: "irongate.png",
  runestone: "runestone.png",
  "runestone-lit": "runestone-lit.png",
} as const;

export function buildGame(): { project: Project; maps: MapDef[] } {
  const maps = [village(), forest(), cave()];
  // Collapse duplicate passage overrides (a solid upper object and an
  // explicit paint can name the same cell); the schema requires unique
  // index entries. A "pass" wins over a "block" only when both appear,
  // which never happens in authored data.
  for (const m of maps) {
    if (!m.passage) continue;
    const byIndex = new Map<number, "pass" | "block">();
    for (const [idx, flag] of m.passage) byIndex.set(idx, byIndex.get(idx) === "pass" ? "pass" : flag);
    m.passage = [...byIndex.entries()].sort((a, b) => a[0] - b[0]);
  }
  const sprites: Project["sprites"] = {};
  for (const [name, file] of Object.entries(NPC_SPRITES)) {
    sprites[name] = { kind: "image", src: `assets/npc/${file}` };
  }
  const project: Project = {
    format: "rpgkit-project/v1",
    title: "The Sunstone of Bramble Hollow",
    tileSize: 16,
    start: { map: "village", x: 9, y: 9, dir: "up" },
    initialGold: 5,
    sheets: [TOWN, DUN],
    items: [
      { id: "thorn-key", name: "Iron Key", sprite: "town.108" },
      { id: "torch", name: "Torch", sprite: "town.109", usable: true },
      { id: "sunstone", name: "Sunstone", sprite: "town.110" },
    ],
    sprites,
    audio: { "sunstone-theme": "audio:qoa.music/sunstone-theme" },
    maps,
  };
  return { project, maps };
}

export const GAME_EVENTS_TOTAL: number = ((): number => {
  const { maps } = buildGame();
  return maps.reduce((n, m) => n + (m.events as GameEvent[]).length, 0);
})();
