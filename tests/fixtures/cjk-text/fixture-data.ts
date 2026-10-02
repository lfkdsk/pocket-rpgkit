// tests/fixtures/cjk-text/fixture-data.ts — a small Simplified Chinese
// project for the CJK text sim (tests/cjk-text-sim.test.ts): one autorun
// event whose pages exercise the dialog box's line breaking, then a choice
// and a shop with Chinese labels. Every string is a literal here, so the
// build bakes its glyphs; fonts/ holds the fallback face cut to exactly the
// characters below (bun tools/cjk-font.ts, see fonts/NotoSansCJKsc-subset.md).
//
// At 480 px the message rows are 444 px wide: 37 fullwidth characters.

import type { GameEvent, Item, MapDef } from "../../../src/engine/types.ts";

export const MAP_ID = "cjk-field";
export const MAP_SIZE = { width: 4, height: 4 } as const;

/** The text pages in order; the test reads them to check the rows. */
export const PAGES: readonly (readonly string[])[] = [
  // 0: long dialog, two authored lines wider than the box.
  [
    "欢迎来到帕帕镇！这里是所有训练师旅程的起点，从这里出发，你会遇到许许多多的怪兽和朋友。",
    "记得常回家看看，妈妈会一直在门口等你回来，帮你把怪兽们照顾得好好的。",
  ],
  // 1: kinsoku. Line one's 38th character is "。": it may not start a row,
  // so "屋" moves down with it. Line two's 37th character is "「": it may
  // not end a row, so it moves down to its quotation.
  [
    "从帕帕镇一路向北走，穿过安静的草地和小桥，就能看到那座古老的灯塔下面的小屋。灯塔守护人在等你。",
    "灯塔守护人站在门口，看到你走过来，笑着挥了挥手，然后很大声地对你们大家说「欢迎回来！」",
  ],
  // 2: mixed Chinese, English words and numbers, and the player name.
  [
    "训练师Alex派出了Bigfin！它的HP是120/120，在Route 1的草丛里还没有遇到过对手。",
    "{name}，你准备好和它对战了吗？我们在Tuxemon中心见！",
  ],
  // 3: a page pre-wrapped to four rows whose last row overflows once the
  // player name is substituted: the box reflows it as one paragraph.
  [
    "从前有一位年轻的训练师，他每天清晨都会去海边散步，看日出。",
    "海风吹过沙滩，浪花一层一层地拍打着岸边那些黑色的礁石。",
    "他总是在想，大海的另一边到底住着什么样的怪兽，又有多少？",
    "有一天，{name}终于下定了决心，要坐上港口那艘白色的小帆船，去大海的对岸看一看！",
  ],
  // 4: a supplementary-plane character types as one step.
  ["\u{20BB7}野先生说：“慢慢来，路还很长。”"],
];

/** A message longer than one box (after the pages above): at the 480 px
 *  design width it wraps to more than four rows, so it shows a page at a
 *  time and each page takes a confirm. Same characters as above, so the
 *  font subset does not change. */
export const LONG_PAGE: readonly string[] = [
  "{name}，灯塔守护人说：你每天清晨都会去海边散步，看着白色的小帆船从港口开出去，又一艘一艘地回来。",
  "沙滩上的礁石都很黑，浪花一层一层地拍打着岸边，风吹过草地和小桥，花都开了。",
  "训练师们都说，HP 120的Bigfin是Route 1里很好的怪兽，你还没有见过它。",
  "我们一起走到古老的灯塔下面，开始一场旅程吧！妈妈会在门口等你回家，帮你把怪兽们照顾得好好的。",
];

export const CHOICE_PROMPT = "要和训练师Alex进行一场怪兽对战吗？";
export const CHOICE_OPTIONS = [
  "好的，马上开始！",
  "等一下，我想先去Tuxemon中心治疗一下我的怪兽们",
  "不了，谢谢。",
] as const;
export const AFTER_CHOICE = "那我们出发吧！";

export const ITEMS: Item[] = [
  { id: "potion", name: "伤药", sprite: "potion", price: 30 },
  { id: "super-potion", name: "超级伤药（附赠一个漂亮的小盒子）", sprite: "potion", price: 120 },
  { id: "ball", name: "Tuxeball 捕捉球", sprite: "ball", price: 200 },
];

export function dialogEvent(): GameEvent {
  return {
    id: "cjk-dialog",
    x: 1,
    y: 1,
    pages: [
      {
        trigger: "autorun",
        commands: [
          ...PAGES.map((lines) => ({ op: "text" as const, lines: [...lines] })),
          { op: "text" as const, lines: [...LONG_PAGE] },
          {
            op: "choices",
            prompt: CHOICE_PROMPT,
            options: CHOICE_OPTIONS.map((text) => ({ text, commands: [{ op: "text" as const, lines: [AFTER_CHOICE] }] })),
          },
          // Enough gold that the goods are not dimmed, so the selected row
          // shows its accent colour.
          { op: "gold", set: "add", amount: 500 },
          { op: "shop", id: "cjk-shop", goods: ITEMS.map((item) => ({ item: item.id, stock: 3 })) },
          { op: "switch", id: "cjk-done", value: true },
        ],
      },
      { condition: { switch: "cjk-done" }, trigger: "action", commands: [] },
    ],
  };
}

export const MAP: MapDef = {
  id: MAP_ID,
  name: "帕帕镇",
  width: MAP_SIZE.width,
  height: MAP_SIZE.height,
  sheets: ["plain"],
  ground: new Array(MAP_SIZE.width * MAP_SIZE.height).fill("plain.0"),
  events: [dialogEvent()],
};
