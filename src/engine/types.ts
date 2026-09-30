// src/engine/types.ts — data types for rpgkit-project/v1 (the schema
// in data/schema.json is normative). P1① carried the map/sheet subset; P1③
// widens to the event vocabulary the interpreter consumes (R2 report §2–3):
// pages, triggers, the 15-op command list, page conditions. The interpreter
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

/** Target of a turn-toward / approach step: the player or a named event. */
export type CharTarget = "player" | { event: string };

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
  | PathStep;

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
  /** True only while the map world is the unobstructed top-level state.
   *  `negate` asks for any blocking world state instead. */
  | { kind: "worldIdle"; negate?: boolean }
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
  | { op: "wait"; seconds: number }
  | { op: "gold"; set: "add" | "sub"; amount: number }
  | { op: "item"; item: string; set: "add" | "sub"; count: number }
  | { op: "se"; name: string; volume?: number; pitch?: number }
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
  /** Cross-event input lock. While the lock is held the mover
   *  ignores the d-pad and action presses cannot start an event; autorun
   *  and parallel fibers keep folding. MV lock_controls/unlock_controls. */
  | { op: "lockInput" }
  | { op: "unlockInput" }
  /** Relocate an event to a tile (MV Set Event Location),
   *  optionally facing a direction there. "this" moves the running event;
   *  { event } moves another map event. Applied on the next character
   *  sync, so a page with blocks:true occupies the new cell. */
  | { op: "place"; target: "this" | { event: string }; x: number; y: number; dir?: Dir }
  /** Game-owned pure command handler, registered on createSession(). */
  | { op: "ext"; call: string; args: JsonValue }
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
  commonEvents?: CommonEvent[];
  maps: MapDef[];
}

/** One independently addressable map payload in a sharded project. The
 * checksum is SHA-256 over canonical UTF-8 JSON for the MapDef. */
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
