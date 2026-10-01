// Interactive showcase rooms: game-owned extensions, Battle Processing, and
// the built-in shop. The lobby/project wires the corresponding extension and
// battle registrations; the rooms themselves remain ordinary event content.

import type { HallDefinition } from "../hall-kit.ts";
import { text } from "../hall-kit.ts";

export const INTERACTIVE_HALLS: HallDefinition[] = [
  {
    id: "showcase-extensions",
    number: 5,
    title: "Extensions & Live Choices",
    commands: ["ext", "extChoice"],
    palette: ["#20374d", "#294a62"],
    demo: [
      text(
        "CURATOR: This list belongs to game code.",
        "Its labels and locks come from live reducer state.",
      ),
      { op: "ext", call: "showcase.begin_choice", args: { hall: 5 } },
      {
        op: "extChoice",
        call: "showcase.keepsake",
        args: { collection: "curator-keepsakes" },
        prompt: "Choose a reducer-owned keepsake",
        cancel: true,
        write: {
          index: "showcase.choiceIndex",
          key: "showcase.choiceKey",
          cancelled: "showcase.choiceCancelled",
        },
      },
      {
        op: "if",
        if: { kind: "variable", id: "showcase.choiceCancelled", op: "==", value: 1 },
        then: [text("CURATOR: Cancellation is data too.", "The resolver recorded it without hidden state.")],
        else: [{
          op: "if",
          if: { kind: "variable", id: "showcase.choiceIndex", op: "==", value: 0 },
          then: [text("CURATOR: The Compass key was selected.", "Stable keys survive a live list refresh.")],
          else: [{
            op: "if",
            if: { kind: "variable", id: "showcase.choiceIndex", op: "==", value: 1 },
            then: [text("CURATOR: The Lantern unlocks on a return visit.", "Both ext state and variables updated atomically.")],
            else: [text("CURATOR: Gold made the Crown row available.", "The provider read the live built-in wallet.")],
          }],
        }],
      },
      { op: "ext", call: "showcase.complete_choice", args: { hall: 5 } },
    ],
  },
  {
    id: "showcase-battle",
    number: 6,
    title: "Battle Processing",
    commands: ["battle"],
    palette: ["#39243f", "#513052"],
    demo: [
      text(
        "CURATOR: This arena is a pure battle reducer.",
        "The map loop freezes while the scene owns input.",
      ),
      {
        op: "mapAnim",
        id: "arena-loop",
        anim: "showcase-ring",
        target: "player",
        layer: "below",
        loop: true,
      },
      {
        op: "battle",
        setup: { playerHp: 12, enemyHp: 8 },
        onWin: [
          { op: "switch", id: "showcase.branch.win", value: true },
          text("CURATOR: WIN branch resumed.", "The arena wrote its result back to the session."),
        ],
        onLose: [
          { op: "switch", id: "showcase.branch.lose", value: true },
          text("CURATOR: LOSE branch resumed.", "Yielding is safe in this training hall."),
        ],
        onEscape: [
          { op: "switch", id: "showcase.branch.escape", value: true },
          text("CURATOR: ESCAPE branch resumed.", "The parked event continued on its own branch."),
        ],
      },
      { op: "stopAnim", id: "arena-loop" },
      text("CURATOR: The map loop resumed, then stopped.", "Strike twice to win; Yield loses; Run escapes."),
    ],
  },
  {
    id: "showcase-shop",
    number: 7,
    title: "Buy, Sell & Stock",
    commands: ["shop"],
    palette: ["#45351f", "#5b4827"],
    demo: [
      text(
        "CURATOR: Spend the shared 80 gold, then try selling.",
        "Stock and inventory live in session state.",
      ),
      {
        op: "shop",
        id: "showcase-curio-shop",
        sell: true,
        sellList: "disable",
        goods: [
          { item: "potion", price: 10, sellPrice: 5, stock: 4 },
          { item: "ether", price: 25, sellPrice: 12, stock: 2 },
          { item: "showcase-token", price: 40, sellPrice: 20, stock: 1 },
        ],
      },
      text("CURATOR: The same shop id keeps its remaining stock.", "Open it again to see the persisted counters."),
    ],
  },
];
