// src/engine/types.ts — data types for rpgkit-project/v1 (the schema
// in data/schema.json is normative). P1① carried the map/sheet subset; P1③
// widens to the event vocabulary the interpreter consumes (R2 report §2–3):
// pages, triggers, the command list, page conditions. The interpreter
// (interpreter.ts) is a pure fold over these types: no host imports. P1②
// adds the sheet dirBlock directional masks consumed by passability.ts.

export type Dir = "down" | "left" | "right" | "up";

/** Values which can cross the project/session/save boundary. Extension and
 * battle payloads deliberately stay inside this JSON subset: a reducer state
 * must not acquire host objects, functions, dates, NaN or undefined. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Event variables are numeric for the built-in arithmetic commands, but an
 * extension may also write a string. String values make MV-style variable
 * transfers useful with this format's string map ids and directions. */
export type VariableValue = number | string;

/** Read a command operand from the live variable bank. */
export interface VariableRef {
  variable: string;
}

export type TransferMap = string | VariableRef;
export type TransferCoordinate = number | VariableRef;
export type TransferDirection = Dir | "keep" | VariableRef;

/** Integer RGBA colour used by deterministic full-screen effects. Alpha is
 * the layer opacity: 0 is transparent and 255 is opaque. Keeping channels
 * numeric avoids host-specific CSS colour parsing in reducer state. */
export interface ScreenColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Facing as an engine index: 0 down, 1 left, 2 up, 3 right. Matches the
 *  BTN-driven order the camera reducer emits and the hero atlas file order. */
export type Facing = 0 | 1 | 2 | 3;

/** A tile id "sheet.cell" (e.g. "grass.43"); null is a blocking void. */
export type TileId = string | null;

export interface Sheet {
  id: string;
  cols: number;
  rows: number;
  /** Cooked TILESET pak entry ("chunks" marks the P1① prebaked-chunk build,
   *  which owns no per-tile entry). */
  pak?: string;
  defaultPassage?: "pass" | "block";
  block?: number[];
  pass?: number[];
  /** Cell index (as string) -> directions of the edges that cell forbids
   *  crossing: the mask blocks LEAVING that cell through a named edge and
   *  ENTERING it through that same edge from outside (P1②, task-1206). */
  dirBlock?: Record<string, Dir[]>;
  /** Cell index (as string) -> per-edge DIRECTIONAL passage rules. Unlike
   *  `dirBlock` this is one-sided: a rule
   *  guards ONLY the edge of the cell it is authored on, so a ledge/one-way
   *  door can forbid "enter from the west" while leaving "leave to the
   *  west" open. `enter` lists directions from which the cell may NOT be
   *  entered (the step crosses that edge INTO the cell); `exit` lists
   *  directions in which the cell may NOT be left. `dirBlock` keeps its
   *  undirected meaning and the two combine (a crossing blocked by either
   *  is blocked). */
  dirEdges?: Record<string, { enter?: Dir[]; exit?: Dir[] }>;
}

// --- events ----------------------------------------------------------------

export type Trigger = "action" | "playerTouch" | "autorun" | "parallel";

/** A route target other than the mover itself: "player" or another map
 *  event by id (MV Set Movement Route on any event). */
export type RouteTarget = "player" | "this" | { event: string };

/** A character whose runtime walking appearance can be changed. */
export type AppearanceTarget = RouteTarget;

/** A viewport-independent camera focus. Character targets are sampled when
 * the command starts; `player` means smoothly return to live player follow. */
export type CameraTarget = "player" | "this" | { event: string } | { x: number; y: number };

/** Per-cell passage fields a runtime tileProperty command can replace.
 * Missing fields keep their authored value; an empty direction list
 * explicitly opens every edge in that half of the crossing. */
export interface TilePropertyOverride {
  passage?: "pass" | "block";
  enter?: Dir[];
  exit?: Dir[];
}

/** Target of a turn-toward / approach step: the player or a named event. */
export type CharTarget = "player" | { event: string };

/** RPG Maker-style per-character movement settings. Speed is the MV 1..6
 *  exponential level (5 is this runtime's legacy eight-tick step); running
 *  adds one effective level, capped at 6. Frequency is the MV 1..5
 *  autonomous-decision level. */
export type MoveSpeed = 1 | 2 | 3 | 4 | 5 | 6;
export type MoveFrequency = 1 | 2 | 3 | 4 | 5;
export type FacingMode = "followMovement" | "locked" | "scripted";

/** Inclusive tile rectangle used by runtime random wandering. */
export interface WanderBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A persistent (for the current map/page visit) movement-setting change.
 *  A route step wraps one of these as `{control}` and applies it to its own
 *  actor; the standalone moveControl command names any actor. */
export type MoveControl =
  | { kind: "wander"; bounds?: WanderBounds; frequency?: MoveFrequency }
  | { kind: "moveType"; value: "page" | "static" | "approach" }
  | { kind: "stop" }
  | { kind: "speed"; value: MoveSpeed }
  | { kind: "run"; value: boolean }
  | { kind: "frequency"; value: MoveFrequency }
  | { kind: "directionFix"; value: boolean }
  | { kind: "through"; value: boolean }
  | { kind: "facingMode"; value: FacingMode };

/** A deterministic-path step. The expansion runs when the step
 *  STARTS, once:
 *  - turnTowardPlayer / {turnToward} — face a live character in place.
 *  - {pathTo} — deterministic 4-neighbour BFS to a tile. The BFS runs at
 *    the step's first boundary tick. An unreachable path or blocked next
 *    step waits a bounded interval, then recomputes from live state up to
 *    `retries` times (default 10) before the route continues.
 *  - {approach} — BFS to the adjacent tile on a character's side and face
 *    that character on arrival. `side` says which side of the target to
 *    stand on (a step from that side TOWARD the target enters it); default
 *    is the mover's current side; `distance` defaults to 1. */
export type PathStep =
  | "turnTowardPlayer"
  | { turnToward: CharTarget }
  | { pathTo: { x: number; y: number; retries?: number } }
  | { approach: { target: CharTarget; side?: Dir; distance?: number; retries?: number } };

export type MoveStep =
  | "moveDown" | "moveLeft" | "moveRight" | "moveUp"
  | "stepForward"
  | "faceDown" | "faceLeft" | "faceRight" | "faceUp"
  | "wait" | "turnRandom"
  | PathStep
  | { control: MoveControl };

export interface MoveRoute {
  steps: MoveStep[];
  repeat: boolean;
  skippable: boolean;
}

/** A condition inside an `if` command (compare against live reducer state).
 *  The same union backs PageCondition.all: a switch clause
 *  there may demand either value, unlike the bare page-condition `switch`
 *  field which only asks for ON. `facing` reads the live player facing and
 *  is meaningful only where a facing context exists (the trigger scan, an
 *  `if` folded on the map); elsewhere it evaluates false. `worldIdle` is
 *  likewise a runtime-only derived value: it is never stored in a project
 *  save, and low-level callers without a world-activity context cannot
 *  prove it true. */
export type Condition =
  | { kind: "switch"; id: string; value?: boolean }
  | { kind: "variable"; id: string; op: ">=" | "<=" | "==" | "!="; value: number }
  | { kind: "selfSwitch"; key: "A" | "B" | "C" | "D"; value?: boolean }
  | { kind: "item"; id: string; count: number }
  | { kind: "gold"; amount: number }
  | { kind: "facing"; dir: Dir }
  /** Compare the character's effective walking-sprite key. null denotes
   *  the built-in player art or an event page with no sprite. */
  | { kind: "appearance"; target: AppearanceTarget; sprite: string | null }
  /** Compare explicitly authored runtime tile-property overrides. Every
   *  present field must match; null means that field has no override. */
  | {
      kind: "tileProperty";
      x: number;
      y: number;
      passage?: "pass" | "block" | null;
      enter?: Dir[] | null;
      exit?: Dir[] | null;
    }
  /** True only while the map world is the unobstructed top-level state.
   *  `negate` asks for any blocking world state instead. */
  | { kind: "worldIdle"; negate?: boolean }
  /** True while a BGM is audibly advancing. A paused BGM or one suspended
   *  behind an ME is not playing. `id` omitted matches any BGM. */
  | { kind: "bgmPlaying"; id?: string; negate?: boolean }
  /** Game-owned pure condition handler, registered on createSession(). */
  | { kind: "ext"; call: string; args: JsonValue };

export interface VariableSet {
  op: "set" | "add" | "sub";
  value: number;
}
export interface VariableRandom {
  op: "random";
  min: number;
  max: number;
}
/** T2-16: the operand is another variable's live value instead of a
 *  literal. "copy" assigns it outright; the arithmetic ops combine the
 *  target's current value with the source's (target OP source). Division
 *  and modulo by a source that reads 0 leave the variable unchanged rather
 *  than producing NaN/Infinity, keeping the saved bank plain finite JSON
 *  numbers. */
export interface VariableOpRef {
  op: "copy" | "add" | "sub" | "mul" | "div" | "mod";
  from: string;
}

/** Optional built-in result sinks for an extension-provided choice. All
 * values are variable ids. On selection they receive index/key/0; on cancel
 * they receive -1/""/1 respectively. */
export interface ExtensionChoiceWrite {
  index?: string;
  key?: string;
  cancelled?: string;
}

/** T2-10/B1: one row of a shop's goods list. `price` overrides the item's
 *  own catalog price for buying at THIS shop only, falling back to it when
 *  omitted. `sellPrice` overrides this shop's buy-back price for the item
 *  (independent of any other shop's `sellPrice` for the same item);
 *  omitted falls back to floor(item.price / 2) as before. `stock` is a
 *  finite quantity this shop carries: a purchase decrements it and a
 *  sell-back at this same shop increments it (persisted per shop `id` +
 *  item id); omitted means unlimited. `condition` reuses the page-
 *  condition clause shape (K1's `all`/flat fields): the row is hidden
 *  while it does not hold. */
export interface ShopGood {
  item: string;
  price?: number;
  sellPrice?: number;
  stock?: number;
  condition?: PageCondition;
}

export type Command =
  | { op: "text"; lines: string[]; cps?: number }
  | {
      op: "choices";
      prompt: string;
      options: { text: string; commands: Command[] }[];
      cancel?: { commands: Command[] };
    }
  | { op: "switch"; id: string; value: boolean }
  | { op: "variable"; id: string; set: VariableSet | VariableRandom | VariableOpRef }
  | { op: "selfSwitch"; key: "A" | "B" | "C" | "D"; value: boolean }
  | { op: "if"; if: Condition; then: Command[]; else?: Command[] }
  | {
      op: "transfer";
      map: TransferMap;
      x: TransferCoordinate;
      y: TransferCoordinate;
      dir?: TransferDirection;
      fade?: number;
    }
  | { op: "moveRoute"; target: RouteTarget; wait?: boolean; route: MoveRoute }
  | { op: "moveControl"; target: RouteTarget; control: MoveControl }
  /** Change a walking character's image/opacity/visibility. null resets one
   *  field. Event changes last until that event changes page; player changes
   *  cross maps. `saveDefault` makes a player sprite the reset baseline. */
  | {
      op: "appearance";
      target: AppearanceTarget;
      sprite?: string | null;
      opacity?: number | null;
      visible?: boolean | null;
      saveDefault?: boolean;
    }
  /** Change one named visual layer for this map visit. A null field restores
   *  its asset default; variant names resolve through GameAssets. */
  | { op: "layer"; layer: string; visible?: boolean | null; variant?: string | null }
  /** Override passage and/or one-sided blocked edges at one map cell for
   *  this visit. null clears that field back to the authored map value. */
  | {
      op: "tileProperty";
      x: number;
      y: number;
      passage?: "pass" | "block" | null;
      enter?: Dir[] | null;
      exit?: Dir[] | null;
    }
  /** Fade the complete presentation independently of map transfer. Fade-out
   * retains its final colour until a later fade-in removes it. */
  | {
      op: "screenFade";
      direction: "out" | "in";
      duration: number;
      color?: ScreenColor;
      wait?: boolean;
    }
  /** Tween one named, composable full-screen colour layer. A target with
   * alpha 0 removes the layer when the tween completes. */
  | { op: "screenTint"; layer: string; color: ScreenColor; duration: number; wait?: boolean }
  /** Replace the transient flash. `intensity` scales colour alpha (0..255). */
  | { op: "screenFlash"; color: ScreenColor; intensity: number; duration: number; wait?: boolean }
  /** Deterministic horizontal shake. Strength is pixels and speed is cycles
   * per virtual second; the reference-tick triangle wave uses no RNG. */
  | { op: "screenShake"; strength: number; speed: number; duration: number; wait?: boolean }
  /** Scroll the viewport focus to a tile/character, or return to live player
   * follow. The reducer stores world focus, never resolution-specific clamp. */
  | { op: "camera"; target: CameraTarget; duration: number; wait?: boolean }
  /** Show one project animation above a character, replacing that target's
   * previous balloon. Omit `icon` to clear it. With duration omitted it
   * persists (and loops) until cleared; a waited balloon needs a duration. */
  | { op: "balloon"; target: RouteTarget; icon?: string; duration?: number; wait?: boolean }
  /** Persistent full-screen cutscene backdrop, rendered below dialogs and
   * retained across transfers. The named asset must be a screen layer;
   * omitting/nulling variant closes the backdrop. */
  | { op: "screenBackdrop"; layer: string; variant?: string | null }
  | { op: "wait"; seconds: number }
  | { op: "gold"; set: "add" | "sub"; amount: number }
  | { op: "item"; item: string; set: "add" | "sub"; count: number }
  | { op: "se"; name: string; volume?: number; pitch?: number }
  | { op: "playBgm"; id: string; volume?: number; pitch?: number }
  | { op: "fadeoutBgm"; duration: number }
  | { op: "stopBgm" }
  | { op: "pauseBgm" }
  | { op: "resumeBgm" }
  | { op: "playBgs"; id: string; volume?: number; pitch?: number }
  | { op: "fadeoutBgs"; duration: number }
  /** ME is a deterministic one-shot. `duration` is virtual seconds; when
   *  it expires, an unpaused BGM resumes from its held position. */
  | { op: "playMe"; id: string; duration: number; volume?: number; pitch?: number }
  | { op: "playSe"; id: string; volume?: number; pitch?: number }
  | { op: "saveBgm" }
  | { op: "replayBgm" }
  | { op: "erase" }
  | { op: "exit" }
  | { op: "common"; id: string }
  /** T2-10 shop: a goods list plus buy/sell. `id` namespaces this shop's
   *  persisted stock counters (SessionState.sw.shopStock) so two shops
   *  selling the same item track independent inventories; it must be
   *  stable across saves (like an event id). `sell` (default true) is
   *  MV's "purchase only" flag inverted: false hides the sell tab
   *  entirely. `sellList` governs how an unsellable row (ShopGood or the
   *  Item itself, see ShopGood/Item) appears in the sell tab: "disable"
   *  (default, MV parity) lists it dimmed and unconfirmable; "hide"
   *  (Tuxemon parity, only resellable items) omits it. */
  | { op: "shop"; id: string; goods: ShopGood[]; sell?: boolean; sellList?: "disable" | "hide" }
  /** Play a frame animation on the map (Tuxemon play_map_animation /
   *  play_tile_animation, RPG Maker Show Animation). The instance is
   *  reducer state keyed by `id`: it starts on the tick the command runs
   *  with the saved frame clock as its origin, so playback is identical
   *  under rewind and after a save/load. A replay with a live instance of
   *  the same `id` replaces it. Position is EITHER a tile (`x`/`y`, both
   *  required) OR a character to follow (`target`: "player" or a map
   *  event by id); a bound instance keeps painting on the character's
   *  live pixel position as it moves. `follow:false` with a `target`
   *  snapshots the character's tile at execution and pins the instance
   *  there (Tuxemon play_map_animation parity: it reads character.tile_pos
   *  once and stores the coordinates, never a live reference). An event
   *  target must name a live character: one that is erased, on an inactive
   *  page, or never spawned has no live position, so the command plays
   *  nothing (a content error) instead of falling back to the event's
   *  authored x/y (Tuxemon get_npc looks up the live _on_map set only). A
   *  following instance whose target leaves the map mid-playback keeps
   *  playing, pinned to the target's last live cell. `layer`
   *  "above" (default, Tuxemon layer 4) paints over characters, "below"
   *  under them. `loop` overrides the AnimationDef default. `wait` parks
   *  the fiber until one playthrough completes for a one-shot animation,
   *  or until `stopAnim` stops the instance for a looping one; stopping
   *  the instance releases the wait early either way. Animations are
   *  per-map-visit state: a transfer clears them. */
  | {
      op: "mapAnim";
      id: string;
      anim: string;
      x?: number;
      y?: number;
      target?: "player" | { event: string };
      follow?: boolean;
      layer?: "below" | "above";
      loop?: boolean;
      wait?: boolean;
    }
  /** Stop map animations: one instance by `id`, every instance of one
   *  animation by `anim`, or every live map animation when neither is
   *  given. A fiber parked on a stopped instance's `wait` resumes. */
  | { op: "stopAnim"; id?: string; anim?: string }
  /** Cross-event input lock. While the lock is held the mover
   *  ignores the d-pad and action presses cannot start an event; autorun
   *  and parallel fibers keep folding. MV lock_controls/unlock_controls. */
  | { op: "lockInput" }
  | { op: "unlockInput" }
  /** Relocate the player or an event to a tile (MV Set Event Location).
   *  Event placement is durable for this map visit; player placement takes
   *  effect at the same end-of-tick session boundary. */
  | { op: "place"; target: RouteTarget; x: number; y: number; dir?: Dir }
  /** Game-owned pure command handler, registered on createSession(). */
  | { op: "ext"; call: string; args: JsonValue }
  /** A choice list supplied from live state by a registered pure extension.
   * The optional resolver may update extension/built-in state after a pick. */
  | {
      op: "extChoice";
      call: string;
      args: JsonValue;
      prompt: string;
      cancel?: boolean;
      write?: ExtensionChoiceWrite;
    }
  /** MV-style Battle Processing. The game assigns meaning to setup and owns
   * the pure battle reducer; the interpreter only parks/resumes the fiber. */
  | {
      op: "battle";
      setup: JsonValue;
      onWin?: Command[];
      onLose?: Command[];
      onEscape?: Command[];
    };

/** A page's activation gate. Every present clause must hold (AND). The
 *  four flat fields stay the v1 spelling; `all` is the compound
 *  spelling: every Condition in the list must hold, and it ANDs with the
 *  flat fields when both are authored. An `all` entry of kind "facing"
 *  additionally makes a playerTouch page re-fire when the
 *  player turns while standing in its area. */
export interface PageCondition {
  switch?: string;
  selfSwitch?: "A" | "B" | "C" | "D";
  variable?: { id: string; op: ">=" | "<=" | "==" | "!="; value: number };
  item?: string;
  all?: Condition[];
}

export interface Page {
  condition?: PageCondition;
  trigger: Trigger;
  sprite?: string | null;
  blocks?: boolean;
  /** Autonomous motion (MV moveType): "static" stands still, "random"
   *  wanders on the seeded RNG, "approach" takes one step toward the
   *  player on a timer. An explicit moveRoute overrides all three. */
  moveType?: "static" | "random" | "approach";
  /** MV page defaults. Runtime overrides reset when this event changes
   *  page, and all overrides reset on map entry. */
  moveSpeed?: MoveSpeed;
  moveFrequency?: MoveFrequency;
  directionFix?: boolean;
  through?: boolean;
  facingMode?: FacingMode;
  moveRoute?: MoveRoute;
  /** Facing the character shows when the page spawns it (the
   *  first page that creates the CharState, and again after a page
   *  switch). Defaults to down. */
  dir?: Dir;
  commands: Command[];
}

export interface GameEvent {
  id: string;
  name?: string;
  x: number;
  y: number;
  /** The event occupies the w×h rectangle with (x,y) as its
   *  top-left corner. playerTouch fires when the player enters ANY cell of
   *  the rectangle; action fires when the player confirms facing any cell
   *  of it (or stands in it). Defaults to 1×1; the schema requires >= 1. */
  w?: number;
  h?: number;
  pages: Page[];
}

export interface MapDef {
  id: string;
  name: string;
  width: number;
  height: number;
  /** Sheet ids this map draws from. */
  sheets?: string[];
  /** Row-major, length width*height; null is a void (nothing baked). */
  ground: TileId[];
  /** Sparse star layer drawn above characters: [row-major index, tile id]. */
  upper?: [number, TileId][];
  /** Per-cell passage overrides: [index, "pass"|"block"]. */
  passage?: [number, "pass" | "block"][];
  /** Interactive events (P1③: page selection + interpretation). */
  events?: GameEvent[];
}

export interface Item {
  id: string;
  name: string;
  sprite: string;
  usable?: boolean;
  /** T2-10: the item's own shop price. A shop's `goods` entry may override
   *  it per-shop for buying, and override its own sellPrice per-shop for
   *  selling; a shop with no such override sells this item at
   *  floor(price / 2). */
  price?: number;
  /** T2-10/B4: whether this item can be sold for gold at all. Absent
   *  defaults to true whenever its effective sell price (a shop's
   *  ShopGood.sellPrice override, else floor(price/2)) is > 0; an item
   *  whose effective sell price is 0 is never sellable regardless of this
   *  flag. An unsellable row still lists in the sell tab (disabled) unless
   *  the shop's `sellList` is "hide". */
  sellable?: boolean;
}

export interface CommonEvent {
  id: string;
  name?: string;
  trigger: "none" | "parallel";
  conditionSwitch?: string;
  commands: Command[];
}

/** A static character painted from one baked image (16x16). Page.sprite
 *  resolves through the image map. */
export interface ImageSpriteDef {
  kind: "image";
  src: string;
}

/** A grid walker sheet the asset cooker slices into twelve static frames
 *  (four facings x idle/step-L/step-R). Defaults describe the Tuxemon
 *  character sheet: 3 columns (walk-L, idle, walk-R) x 4 rows
 *  (down, left, right, up) of 16x32 cells; see tools/lib/bake.ts
 *  TUXEMON_WALKER_LAYOUT for the engine facing-row remap. The runtime draws
 *  the frame chosen from the saved CharState facing + mover phase, never a
 *  host auto-play clock, so saves stay deterministic. */
export interface WalkerSheetSpriteDef {
  kind: "walker";
  /** Build-time source sheet id/path. The runtime does not load it. */
  sheet: string;
  /** Frame height in px: 32 (default) for a 16x32 sheet whose top row
   *  overflows upward, or 16 for a square sheet. */
  h?: 16 | 32;
  /** Sheet columns (default 3: walk-L, idle, walk-R). */
  cols?: number;
  /** Sheet rows (default 4: down, left, right, up). */
  rows?: number;
}

/** Legacy v1 walker declaration retained for documents that already point
 *  at one animated atlas per direction. New importers should prefer a
 *  WalkerSheetSpriteDef and cook deterministic static frames. */
export interface WalkerAtlasSpriteDef {
  kind: "walker";
  atlases: { down: string; left: string; right: string; up: string };
  frames: number;
  step: number;
}

export type WalkerSpriteDef = WalkerSheetSpriteDef | WalkerAtlasSpriteDef;

/** Page.sprite resolves through this map: a static image or a walker sheet
 *  the cooker slices into per-facing/pose frames. */
export type SpriteDef = ImageSpriteDef | WalkerSpriteDef;

/** A frame animation a `mapAnim` command plays on the map. The sheet is
 *  cooked into one static baked image per authored frame (the same pipeline
 *  as walker sheets), so the runtime frame index is a pure function of the
 *  saved reference tick: rewind and save/load reproduce pixels exactly,
 *  and no host auto-play clock is involved. */
export interface AnimationDef {
  id: string;
  /** Build-time source sheet. The asset cooker slices it into frames; the
   *  runtime never loads it. A sheet the cooker cannot find is a build
   *  error (the importer references animations by name). */
  sheet: string;
  /** Frame size in px; defaults to 16x16 (one tile). A taller frame is
   *  anchored to its tile's bottom edge, like a 16x32 walker. */
  frameW?: number;
  frameH?: number;
  /** Sheet columns for row-major frame indexing; the cooker's own sheet
   *  metadata applies when omitted. */
  cols?: number;
  /** Frame indices into the sheet (row-major), in play order. Defaults to
   *  0..`count`-1 when `count` is given instead. */
  frames?: number[];
  /** Frame count when `frames` is omitted (sequential play order). */
  count?: number;
  /** Duration of each frame in virtual seconds. Compiled to reference
   *  ticks with the world's hz, so the same virtual instant shows the same
   *  frame at 60/30/20/4 Hz. */
  frameDuration: number;
  /** Default loop behavior; a `mapAnim` command's `loop` overrides it. */
  loop?: boolean;
}

/** Project-wide runtime options (RPG Maker's System settings). Every field
 *  is optional and its absence keeps the v1 behavior. */
export interface ProjectSystem {
  /** While ANY fiber's text or choices box is open — a parallel page's
   *  included — the player cannot move and no action or playerTouch page
   *  starts, so the confirm that advances the box never also talks to the
   *  faced event (MV $gameMessage.isBusy, Tuxemon's dialog state swallows
   *  input). autorun and parallel pages keep running. Default false: v1
   *  holds the player only for a blocking fiber or a choices box. */
  messageBlocksPlayer?: boolean;
  /** Engine-level backpack tunables (T2-10/B1). */
  inventory?: {
    /** Max count of a single item id the backpack holds; default 99
     *  (SHOP_ITEM_CAP). A buy that would exceed it is refused. */
    maxPerItem?: number;
    /** Max number of DISTINCT item ids the backpack holds; absent means
     *  unlimited. A buy that would introduce a new kind past this cap is
     *  refused even with room under maxPerItem/gold. */
    maxKinds?: number;
  };
}

export interface Project {
  format: "rpgkit-project/v1";
  title: string;
  tileSize: 16;
  start: { map: string; x: number; y: number; dir: Dir };
  /** Runtime options; see ProjectSystem. */
  system?: ProjectSystem;
  initialGold?: number;
  /** Default name substituted for the {name} text token in a fresh
   *  playthrough. Stored in the switch bank after that, so a rename (a future
   *  op) survives saves and transfers. */
  playerName?: string;
  sheets: Sheet[];
  items: Item[];
  /** Page.sprite key -> static character image. */
  sprites?: Record<string, SpriteDef>;
  /** Frame animations playable with the `mapAnim` command, by id. */
  animations?: AnimationDef[];
  /** Logical audio id -> WAV or QOA pak key (`audio:wav.*` / `audio:qoa.*`).
   *  Host playback is opt-in; the reducer remains fully functional when this
   *  is absent. */
  audio?: Record<string, string>;
  commonEvents?: CommonEvent[];
  maps: MapDef[];
}

/** One independently addressable map payload in a sharded project. The
 * checksum is SHA-256 over the entry's exact UTF-8 bytes. Entries may be
 * canonical MapDef JSON or the self-describing compact transport; the path
 * intentionally does not select the decoder. */
export interface MapIndexEntry {
  id: string;
  width: number;
  height: number;
  entry: string;
  sha256: string;
}

/** A large-project document keeps global data inline but moves MapDef
 * payloads into independently addressable entries. The optional hashes are
 * emitted by the kit splitter and become the runtime/save content identity.
 * Hand-built shells without a manifest remain usable because the runtime
 * computes one; untrusted declared manifests can be explicitly rechecked. */
export interface ProjectShell extends Omit<Project, "maps"> {
  mapIndex: readonly MapIndexEntry[];
  mapManifestHash?: string;
  mapSchemaHash?: string;
}

export type ProjectSource = Project | ProjectShell;

/** Synchronous map acquisition at the simulation boundary. A browser-backed
 * implementation may expose prepare(); acquire() then throws MapNotReadyError
 * until those bytes are resident. Callers pause and retry the same logical
 * input frame after prepare() resolves. */
export interface MapRepository {
  meta(id: string): MapIndexEntry | undefined;
  /** Return a runtime-validated MapDef. Implementations that decode untyped
   * bytes should validate before returning; createJsonMapRepository checks
   * compilation-critical structure by default and offers full schema
   * validation. Session additionally verifies repository metadata and
   * payload dimensions against mapIndex. */
  acquire(id: string): MapDef;
  /** Optional deterministic preparation unit for synchronous repositories.
   * One call performs at most one implementation-defined unit and returns
   * the map only once repository work is complete. Session uses this during
   * a non-zero transfer fade; acquire() still completes all remaining work. */
  acquireStep?(id: string): MapDef | undefined;
  releaseExcept(ids: readonly string[]): void;
  prepare?(id: string): Promise<void>;
}

/** Pure simulation state for the camera slice. Position is the world-space
 *  top-left of the camera in pixels; the player focus stays screen-centered
 *  (its world position is cam + viewport center). */
export interface CameraState {
  x: number;
  y: number;
  facing: Facing;
}
