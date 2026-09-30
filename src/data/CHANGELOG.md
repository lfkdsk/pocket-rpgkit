# rpgkit-project format changelog

The format marker on every project document is the `format` string,
currently `"rpgkit-project/v1"` (`src/data/schema.json` is normative;
`src/engine/types.ts` carries the TypeScript types).

## v1 — 2026-09-23 (component extraction release 0.1.0)

First frozen release of the format, extracted from the PocketJS app
`apps/rpgkit` integration branch I3 (`pocketjs@780218d7` plus the merged
P1①–P1⑤ runtime work).

- Project: `format`, `title`, `tileSize` (16), `start` (map/x/y/dir),
  optional `initialGold`, `sheets`, `items`, optional `sprites`,
  `commonEvents`, `maps`.
- Maps: dense row-major `ground` tile ids (`"sheet.cell"`, `null` is a
  blocking void), sparse `upper` star layer, sparse `passage` overrides,
  `events`.
- Sheets: 16px-cell grids with `defaultPassage`, `block`/`pass` cell lists,
  and per-cell `dirBlock` edge masks (see the 2026-09-27 amendment).
- Events: ordered pages; each page has one trigger
  (`action` | `playerTouch` | `autorun` | `parallel`), an optional
  condition (`switch` | `selfSwitch` | `variable` | `item`), an optional
  static `sprite`, `blocks`, autonomous `moveType`
  (`static` | `random` | `approach`) or an authored `moveRoute`, and a
  command list.
- Commands, 15: `text`, `choices`, `switch`, `variable`, `selfSwitch`,
  `if`, `transfer`, `moveRoute`, `wait`, `gold`, `item`, `se`, `erase`,
  `exit`, `common`.

## v1 amendment — 2026-09-27 (release 0.2.0)

Two changes landed in the PocketJS working copy after the extraction and
are folded into v1 here, while the only v1 documents are this
repository's own examples:

- `dirBlock` follows RPG Maker MV's directional passage: an entry bars
  its edge in **both** directions (leaving the cell through that edge and
  entering it through that edge from outside). A step is refused when the
  source cell bars the step direction or the target cell bars the reverse
  one. v1.0 read the mask as exit-only; a document that relied on a
  one-way exit must now use a `passage` override instead.
- Event ids, and `switch`/`variable` ids, may contain uppercase letters
  (`^[A-Za-z0-9_-]+$`, `^[A-Za-z0-9_.-]+$`). Every document valid under
  v1.0 stays valid.

## v1 amendment — 2026-09-29 (K1 event-model extension)

Six optional, backwards-compatible event-model additions (T2-1, T2-2,
T2-3, T2-6, T2-7, T2-8). Every v1.0/v1.1 document stays valid; all new
fields and commands are optional and the v1 spellings keep their meaning.

- **Event areas (T2-1):** an event may occupy a rectangle with optional
  `w` / `h` (default 1×1; minimum 1). A `playerTouch` page fires when the
  player enters ANY cell of the rectangle (each step onto a fresh area
  cell is a new entry), and an `action` page fires when the player
  confirms while the faced tile OR the occupied tile lies inside it.
- **Compound page conditions (T2-2):** a page condition may carry
  `all: Condition[]`, an AND of existing switch (either value), variable,
  self-switch, item and gold conditions. It ANDs with the flat
  `switch` / `selfSwitch` / `variable` / `item` fields when both are used.
- **Facing conditions (T2-3):** a new `{ kind: "facing", dir }` condition
  (usable in `if` and in `condition.all`) tests the live player facing. A
  `playerTouch` page whose condition reads facing also re-fires when the
  player turns in place while standing inside its area — modelling a
  door/exit mat that only opens when faced, not when crossed sideways.
- **Per-visit `local.` variables (T2-6):** any switch or variable whose id
  starts with `local.` is reset on every map entry (it does not survive a
  transfer). Non-`local.` ids remain project-wide.
- **Place event and initial facing (T2-7):** a `place` command
  (`{ op: "place", target, x, y, dir? }`, target `"this"` or
  `{ event: id }`) relocates an event to a tile, optionally facing a
  direction (MV Set Event Location). A page may also set `dir` for the
  facing its character shows when that page spawns it (and after a page
  switch).
- **Cross-event input lock (T2-8):** `{ op: "lockInput" }` and
  `{ op: "unlockInput" }`. While the lock is held the mover ignores the
  d-pad and action presses start no event; `autorun` / `parallel` pages
  keep running. The lock is per map visit (a transfer clears it) and its
  held state is preserved by a save.

## v1 amendment — 2026-09-29 (player name, tall walkers)

- `playerName` optionally supplies the fresh-session value substituted for
  `{name}` in text and choice prompts. The value lives in save state after
  startup.
- A `walker` sprite may name a build-time source `sheet` id/path with optional `h`, `cols` and
  `rows`. The default is a 3-column by 4-row sheet of 16×32 frames; the asset
  cooker slices it into idle/left-step/right-step images for four facings.
  The original per-direction `atlases` walker declaration remains valid.

## v1 amendment — 2026-09-29 (movement extensions)

- **One-sided passage edges:** a sheet may declare `dirEdges`, keyed by
  cell, with optional `enter` and `exit` direction lists. `enter` refuses
  stepping into the cell across that edge; `exit` refuses leaving it across
  that edge. The existing `dirBlock` keeps its symmetric meaning (both
  leaving and entering through the edge).
- **Routes on any event:** `moveRoute` takes an optional `target`
  (`"player"`, `"this"` or `{ event: id }`) with the existing `wait`
  semantics.
- **Turn and path steps:** route steps `turnTowardPlayer`,
  `{ turnToward: target }`, `{ pathTo: { x, y, retries? } }` and
  `{ approach: { target, retries? } }`. Path searches are deterministic
  breadth-first searches split across reference ticks (independent of the
  host rate); a blocked step waits and replans at most `retries` times
  before the route ends.

## v1 amendment — 2026-09-29 (on-demand map entries)

- A project may retain the original inline `maps` array or replace it with a
  `mapIndex`. Each index entry identifies one independently addressable map by
  `id`, `width`, `height`, `entry` and canonical-JSON `sha256`; optional
  `mapManifestHash` and `mapSchemaHash` bind saves to the exact content build.
  Existing inline documents and saves keep their original behavior.
- `ProjectShell` plus `MapRepository` loads only the starting map and the
  destination of each transfer. Parsed map data, compiled interpreter worlds,
  passage tables and render residency are derived caches, not project state or
  save data. A restore reacquires its saved map; a manifest/schema mismatch is
  rejected before map acquisition.
- An async-backed repository may prepare missing bytes outside the reducer.
  The UI pauses and retries the same input frame after preparation, so network
  timing cannot alter the simulation timeline.

## v1 amendment — 2026-09-29 (K4: shop, scrolling choices, variable arithmetic)

Three optional, backwards-compatible additions from Scout S1 §5–6
(T2-9, T2-10, T2-16). Every existing v1 document stays valid.

- **Shop (T2-10, extended for B1):** a new `shop` command
  (`{ op: "shop", id, goods: ShopGood[], sell?, sellList? }`, MV Shop
  Processing). `id` namespaces this shop's persisted stock counters and
  must be stable across saves. `goods` is the buy list; each entry is
  `{ item, price?, sellPrice?, stock?, condition? }`: `price` overrides
  the item's own catalog price for buying at this shop only (falling
  back to it when omitted); `sellPrice` overrides this shop's buy-back
  price for the item (falling back to floor(item.price / 2)); `stock` is
  a finite quantity this shop carries — a buy decrements it and a
  sell-back at this same shop increments it, persisted per shop `id` +
  item id — omitted means unlimited; `condition` reuses the
  page-condition clause shape (switch/selfSwitch/variable/item/`all`)
  and hides the row while it does not hold. `sell` (default true) shows
  a sell tab for the player's whole inventory. `sellList` (default
  `"disable"`) governs an unsellable row (Item.sellable:false, or an
  effective sell price of 0): `"disable"` lists it dimmed and
  unconfirmable (MV parity); `"hide"` omits it (Tuxemon parity, only
  resellable items). Item gains optional `price` (shop price) and
  `sellable` (default: sellable whenever its effective sell price is >
  0) fields. Project gains an optional `system.inventory` block:
  `maxPerItem` (default 99, the prior fixed cap) and `maxKinds`
  (default unlimited) bound the backpack; a purchase that would exceed
  either, or that the player cannot afford, or that has no stock left,
  is refused (the row stays selectable, just inert).
- **More than 4 choices (T2-9, extended for B2):** `choices.options`
  widens from 2-4 to 2-8 entries, and an option's `text` from 24 to 64
  characters. The box still shows 4 rows at a time; past 4 options it
  scrolls a window that follows the live cursor, and a label longer
  than the box truncates with a trailing ellipsis instead of
  overflowing it.
- **Variable-operand arithmetic (T2-16, extended for B3):** `variable`'s
  `set` accepts a third shape, `{ op: "copy" | "add" | "sub" | "mul" |
  "div" | "mod", from: id }`, reading another variable's live value
  instead of a literal (`target OP source`; `copy` assigns it
  outright). Every variable write — this shape and the literal
  `set`/`add`/`sub`/`random` shapes alike — lands as a finite integer
  clamped to `[-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]`; a
  non-integer result (a division quotient) floors toward negative
  infinity (`-7 / 2 = -4`, matching MV's `Math.floor` and Tuxemon's
  `//`, not the prior `Math.trunc`). Division and modulo by a source
  that currently reads 0 leave the variable unchanged (Tuxemon's
  `safe_floordiv` returns the left operand; MV would write a
  non-finite result, which this format does not follow), so the saved
  variable bank stays plain finite JSON numbers even for an
  authoring-time value schema accepts but arithmetic would otherwise
  overflow (`1e308 * 1e308` clamps instead of becoming `Infinity`).

## v1 amendment — 2026-09-29 (message hold, character bodies)

- **Message hold (optional):** a project may carry
  `system: { messageBlocksPlayer: true }`. While any text or choices box
  is open — including one a `parallel` page shows — the player cannot move
  and no `action` or `playerTouch` page starts, so the confirm press that
  advances the box never also starts the faced event. `autorun` and
  `parallel` pages keep running. The option defaults to `false`, and a
  document without it behaves exactly as before: only a blocking
  (`action` / `playerTouch` / `autorun`) fiber or a choices box holds the
  player, and a parallel page's text line does not.
- **Character bodies follow `blocks`:** a moving character (page
  `moveRoute`, `random` / `approach` motion, a `moveRoute` command, and the
  `pathTo` / `approach` searches) is now stopped only by pages with
  `blocks: true` (and by the player), the rule the player's own movement
  already followed. Before, every event with an active page stopped a
  character, so a sprite-less `blocks: false` marker such as a transfer mat
  could hold a non-skippable cutscene route forever. The player's own
  `pathTo` / `approach` search no longer routes around `blocks: false`
  events either. A document that relied on a `blocks: false` event to stop
  a character must give that page `blocks: true`. This repository's
  examples and goldens are unchanged.

## v1 amendment — 2026-09-29 (on-demand map loading performance)

- The standard JSON map repository skips redundant entry SHA-256 work for
  trusted synchronous package sources and uses compilation-critical structural
  validation by default. Async-prepared sources still verify checksums by
  default, and callers can explicitly request checksum or full schema checks.
- Split map entries are fully schema-validated at build time, emitted as stable
  ASCII JSON, and may be read as bytes through the bounded fast decoder.
- Non-zero transfer fades may prepare a destination in fixed deterministic
  units before the original map-swap tick. Preparation remains derived cache
  data; zero-fade transfers retain their all-at-once behavior.
- Filesystem save helpers accept the shell content identity for writing,
  loading and listing slots, so a different map manifest or schema is rejected.
- A splitter-emitted shell manifest is used directly as the content/save
  identity for trusted application packages, avoiding a redundant synchronous
  SHA-256 during startup. Shells without a declared manifest are still hashed;
  untrusted declared manifests can opt into recomputation with
  `verifyMapManifest: true`. Map-index structure is always validated.

## v1 amendment — 2026-09-29 (extension state and Battle Processing)

- **Plugin commands and conditions:** `{ "op": "ext", "call":
  "namespace.name", "args": <json> }` and `{ "kind": "ext", ... }` invoke
  pure game handlers registered in `createSession` options. Unknown calls are
  rejected up front; an explicit preview mode may treat them as command
  no-ops / false conditions.
- **Extension state:** `SessionState.ext` is an opaque JSON slot, defaulting
  to `null`, with optional game validator and save codec. Saves, checksums and
  rewind include it. Checksum-valid older v1 saves that omit the slot hydrate
  it as `null`.
- **Variable transfer operands:** `transfer.map`, `x`, `y` and `dir` may use
  `{ "variable": "id" }` instead of a literal. They resolve from the live
  variable bank when the command executes. Unset/wrong-typed operands and
  unknown resolved maps now enter the fatal content-error state (frozen,
  visible in `GameView`, and non-saveable) instead of throwing from the host
  frame loop.
- **Battle Processing:** `{ "op": "battle", "setup": <json>, "onWin"?,
  "onLose"?, "onEscape"? }` parks its event fiber in a game-owned pure battle
  scene. The scene is seeded from one saved session RNG draw, advances in
  fixed reference ticks, writes extension/variable state on completion and
  resumes through the matching branch. A completion transfer follows the
  branch. Active battles cannot be saved but are included in attract rewind.
- **Battle queue and world policy:** concurrent requests now queue in
  deterministic main-then-parallel-key order instead of overwriting a parked
  fiber. This ordering applies only while appending newly emitted battle
  requests; the established generic fold remains parallel-key-first and main
  last. The next battle starts on the reference tick after completion.
  Battles freeze page sync, movement, and map fibers by default; games may
  explicitly choose `scene.worldContinues`. Active scenes and non-empty
  queues are both non-saveable, and authored requests during a scene no
  longer throw.
- **Battle result switches:** `BattleCompletion.switches` atomically writes
  boolean switches alongside extension state and variable `writes`.
- The editor's schema-backed raw JSON model validates and round-trips both
  additions without requiring a specialized form. Existing projects and
  saves retain their prior behavior and defaults.

## v1 amendment — 2026-09-29 (K4 fix 3: finite-state construction/restore/ext/battle)

- **Shared finite-integer normalization now covers construction and
  restore, not just runtime writes:** `createSwitchState`'s public
  constructor clamps `gold`/`items`/`variables`/`shopStock` through the
  same normalizer every authored command write already used; both
  `createInterpState` (fresh session) and `restoreSessionSnapshot` (loaded
  save) route through it, so a hand-built initial state or a
  checksum-valid saved bank cannot carry a value outside
  `[-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]`. An extension
  command's `result.writes` and a `BattleCompletion.writes` numeric entry
  clamp the same way on their way into the live variable bank.
  `save-validate.ts` now requires these four banks to be
  `Number.isSafeInteger`, not merely finite, rejecting a hand-crafted
  envelope with a typed `SaveError` instead of silently restoring an
  out-of-range value.

## v1 amendment — 2026-09-29 (shared battle and extension inventory)

- `BattleRules.start` receives a fourth read-only context containing the live
  extension state, switches, variables, items and gold. The session always
  supplies it; existing three-parameter JavaScript/TypeScript implementations
  remain compatible and ignore the extra argument.
- `ExtensionCommandResult` and `BattleCompletion` may return `items` and
  `gold` replacements. They update the same `SessionState.sw` backpack and
  wallet used by item/gold commands and shops, atomically with extension,
  variable and switch writes and before a subsequent command or battle-result
  branch.
- `items` replaces only listed ids. Each finite count is floored through
  `clampFiniteVar`, clamped to `[0, system.inventory.maxPerItem]`, and a zero
  result removes the id. Removals and replacements of currently held kinds
  happen first; previously unheld positive ids are then admitted in lexical
  id order until `system.inventory.maxKinds`, and excess ids are discarded.
  `gold` is likewise floored/clamped to a safe integer and then to zero or
  above. This ordering is deterministic regardless of object insertion order.
- The values use the existing save/snapshot/rewind path and fixed-rate fold.
  `canSave` is unchanged: an active battle or queued external work is still
  not a save point.

## v1 amendment — 2026-09-30 (shell manifest freshness check)

- `assertShellManifestFresh(shell)` exports the build/test-time freshness
  check for a packaged shell's declared `mapManifestHash`: it recomputes the
  manifest hash over the shell content and throws with both the declared and
  computed digests on mismatch, and likewise rejects a missing or malformed
  declaration. The runtime trust default is unchanged, so an application that
  packages a `ProjectShell` must call this in its build or test pipeline
  after writing the shell. `splitProjectMaps` self-checks its own output.

Breaking changes to any of the above require a new marker
(`rpgkit-project/v2`) and a new entry here.
