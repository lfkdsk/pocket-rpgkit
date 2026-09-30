# rpgkit engine

Pure-TS simulation core for Pocket RPG Kit. Every module here is a plain
reducer: no host imports, no wall clock, no `Math.random`. The host folds
`step(state, input) -> state` once per virtual frame and renders from
state.

## Modules

- `camera.ts` — free-scroll camera reducer, the follow camera, and the BTN
  mask mirror.
- `viewport.ts` — centering offset for maps smaller than the host viewport.
- `start.ts` — camera placement derived from a project's start tile.
- `tiles.ts` — tile ids and the baked-chunk constants.
- `motion-clock.ts` — the fixed 60 Hz motion reference and how many
  reference ticks one host frame folds.
- `passability.ts`, `movement.ts` — tile collision (undirected `dirBlock`
  plus one-sided `dirEdges`, cooked into flat solid/edge masks with
  blocking bodies) and the grid mover.
- `pathfind.ts` — deterministic 4-neighbour BFS behind the `pathTo` /
  `approach` move steps (fixed neighbour order, respects all edge guards
  and bodies; the search is sliced across reference ticks to bound QuickJS
  frame cost).
- `interpreter.ts` — event pages, triggers, the 22-command interpreter
  (the v1 15 plus `lockInput` / `unlockInput` / `place` / `shop` / `ext` /
  `extChoice` / `battle`), the typewriter clock, the seeded RNG, saveable
  switch state.
- `extensions.ts` — namespaced pure command/condition/dynamic-choice handlers,
  the opaque JSON extension slot, validation and save codecs.
- `battle.ts` — game-owned battle reducer and scene contracts.
- `chars.ts` — per-map character motion: page patrol routes, autonomous
  random/approach, command-forced routes, body collision (only
  `blocks: true` pages stop a character, as they stop the player).
- `session.ts` — the multi-map fold: transfer (map swap + fade), moveRoute
  completion and battle-scene lifecycle across mover/characters/interpreter.
- `clone.ts` — host-portable deep copy (the desktop QuickJS realm has no
  `structuredClone`).
- `schema-validate.ts` — zero-dependency checker for the JSON schema
  subset `../data/schema.json` uses.
- `save.ts`, `save-validate.ts`, `save-restore.ts`, `save-menu.ts` —
  save envelope/codecs, structural validation, the map-aware restore gate,
  and the save-menu navigation reducer.
- `attract.ts`, `tape.ts` — the attract/takeover/rewind controller over
  one unified u16 input stream, bounded runtime keyframes, and RLE/devtools
  tape helpers.
- `journey-search.ts` — A* over real reducer frames, for deterministic
  journey drivers on hosts whose frame spans several reference ticks.
- `types.ts` — the `rpgkit-project/v1` vocabulary (normative schema:
  `../data/schema.json`).

## P1② ↔ P1③ integration contract

The interpreter does not move the player. The host owns a mover (P1②'s
`stepMovement`) and feeds the interpreter the player's tile each frame.

```ts
import {
  createWorld, createInterpState, stepInterp, isBusy, messageHoldsPlayer,
  continueExternal, type InterpInput, type World, type InterpState,
} from "./interpreter.ts";

const world: World = createWorld(map, project.commonEvents ?? [], hz, {
  messageBlocksPlayer: project.system?.messageBlocksPlayer,
});
let interp = createInterpState();

// each virtual frame, AFTER the mover has run:
if (!isBusy(interp) && !messageHoldsPlayer(world, interp)) {
  // mover runs only while no blocking fiber owns the session (an open
  // dialog, a choices box, a wait, an autorun) and, when the project opts
  // in, no parallel page's box is open either.
  movement = stepMovement(movement, buttons, passageTable);
}
const input: InterpInput = {
  confirmEdge, cancelEdge, upEdge, downEdge,   // pressed-this-frame edges
  playerCell: { x: tileX, y: tileY },          // mover cell this frame
  prevCell: { x: prevTileX, y: prevTileY },    // mover cell last frame
  facing,                                      // 0 down, 1 left, 2 up, 3 right
};
interp = stepInterp(world, interp, input);

// P1④ hooks: when a fiber parks on a transfer or a waiting move route, the
// result carries exactly one pending* payload; perform the work, then resume:
if (interp.pendingTransfer) { /* swap map, move player; fade frames */ }
if (interp.pendingMoveRoute) { /* walk the route steps */ }
interp = continueExternal(interp, fiberKey);
```

Conventions:

- `facing` is the `Facing` index both the camera and mover emit:
  0 down, 1 left, 2 up, 3 right. Action-button events trigger on the event
  one tile **in front** of `playerCell` on that facing.
- **Event areas:** an event with `w`/`h` occupies a rectangle from
  `(x,y)` (default 1×1). `playerTouch` fires on the frame the player's
  cell **enters** any cell of that rectangle — stepping from one area cell
  to another re-fires; standing still never does, and leaving clears the
  latch. `action` fires when the faced tile or the player's own tile is
  inside the rectangle.
- **Compound and facing conditions:** a page condition's
  `all: Condition[]` is an AND of the same conditions `if` accepts
  (including a switch demanded OFF and a `{kind:"facing", dir}` test); it
  ANDs with the flat condition fields. A `playerTouch` page whose `all`
  reads facing also fires on a **turn in place** (`prevFacing !== facing`)
  while the player stands in its area, so an exit mat gated on "facing
  up" does not open when crossed sideways. Character synchronization,
  parallel-fiber cancellation, trigger arbitration, and the UI all select
  pages against the same live facing.
- **World-idle conditions:** `{kind:"worldIdle", negate?}` is shared by
  `condition.all` and `if`. It is true only when the current map has no
  blocking main fiber, `inputLocked`, modal, fatal error, player route,
  pending transfer/battle, fade, active scene, or host-owned menu. A
  PARALLEL fiber or NPC route alone does not remove player control and does
  not block it. The value is derived at each read and is absent from saves.
  Trigger/page selection samples it before fibers run; an `if` instruction
  recomputes it from the live working state, so later fibers see locks,
  modals and external requests published earlier in that same tick.
- **Per-visit locals:** a switch or variable id prefixed `local.`
  is reset on every map entry; it never survives a transfer.
- **Place and initial facing:** the `place` command relocates
  `"this"` or `{event}` to a tile (and optional facing); a page `dir` sets
  the facing the character shows when that page spawns it or on a page
  switch.
- **Input lock:** `lockInput`/`unlockInput` are a cross-event lock:
  while held the mover ignores the d-pad and confirm starts no action
  event, but `autorun`/`parallel` fibers still fold. The lock is per map
  visit and its held state round-trips through a save.
- **Message hold:** `createWorld(..., { messageBlocksPlayer: true })`
  (from `project.system.messageBlocksPlayer`) makes any open text/choices
  box hold the player, a PARALLEL page's included:
  `messageHoldsPlayer(world, state)` is then true, the mover must not run,
  and the trigger scan starts no action or playerTouch page, so the
  confirm that advances the box never also starts the faced event.
  `autorun`/`parallel` pages keep running. Off by default (v1).
- `isBusy(state)` is true while a blocking (action / playerTouch / autorun)
  fiber runs. The mover freezes for its whole duration. PARALLEL pages run
  concurrently and never set busy (only the message hold above can make
  their box hold the player).
- Edges are one frame wide: the host computes `pressed = buttons & ~prev`
  for CIRCLE (confirm), CROSS (cancel), UP and DOWN and passes booleans.
- `state.cues` lists sound effects emitted by commands on the latest step;
  drain it after every step (it is cleared at the top of the next one).
- All switch/variable/item/gold values and the mulberry32 RNG cursor live
  in `state.sw`, a plain JSON-serializable object: the P1⑤ save snapshot.
- **Invariant: every write into `state.sw`'s numeric banks (`gold`,
  `items`, `shopStock`, `variables`, and the project's `initialGold` seed)
  goes through `clampFiniteVar`.** JSON Schema's `integer` only rejects a
  fractional part, so an authored value like `1e308` (a legal double with
  none) passes schema validation while landing far outside a safe integer;
  unclamped arithmetic on it (a shop sale, `gold add`, `1e308 * 1e308`, …)
  can overflow to `Infinity`, which `JSON.stringify` turns into `null` and
  the save loader then refuses to read back. Any future numeric write
  into `state.sw` — battle rewards, an `ext` command's bank, anything else
  that must survive a save round-trip — must clamp through the same
  function instead of writing raw arithmetic. This covers every entry
  point, not just authored commands: `createSwitchState`'s public
  constructor normalizes a hand-built bank the same way, and both
  `createInterpState` (fresh session) and `save-restore.ts`'s
  `restoreSessionSnapshot` (loaded save) route through it; an extension
  command's `result.writes` and a `BattleCompletion.writes` numeric entry
  clamp on their way into `state.sw.variables` too. `cloneInterp` itself
  stays a plain field copy — it also runs on every live step, where a
  content-error check (e.g. `resolveTransfer`'s non-integer coordinate
  guard) must still see an out-of-range value a bug introduced mid-frame,
  not have it silently floored away first. `save-validate.ts` backs the
  restore path up structurally: a decoded envelope whose
  `gold`/`items`/`shopStock`/numeric `variables` entries are not
  `Number.isSafeInteger` is refused with a typed `SaveError` before
  `restoreSessionSnapshot` ever runs, so a hand-crafted file cannot
  reintroduce a value normal play can no longer produce.

## P1④ session (multi-map) fold

For a multi-map game the host does not drive the mover and interpreter by
hand; `session.ts` folds all three reducers per virtual frame:

```ts
import { createSession, startSession, stepSession } from "./session.ts";

const session = createSession(project);        // maps, worlds, passage tables
let state = startSession(project, session);    // project.start position/dir
state = stepSession(session, state, {          // once per virtual frame
  buttons, confirmEdge, cancelEdge, upEdge, downEdge,
});
```

`stepSession` owns the frame order:

1. **characters.syncPages** — reconcile NPCs with active pages; a page
   switch aborts a forced route and resumes its parked waiter.
2. **mover** — frozen while a blocking fiber runs, a choices box is
   open, the input lock is held, the message hold applies, or the
   player's own command route is driving; collision adds blocking
   (`blocks: true`) character bodies.
3. **characters.stepChars** — patrol / random / approach / forced motion.
4. **interpreter.stepInterp** — fed the live NPC cells for trigger scans.
5. **external requests** — a `transfer` swaps map/fresh-interp/characters
   while keeping `state.sw`; `moveRoute` installs on an NPC (or the
   player) and resumes its fiber when the route lands; `battle` derives one
   seed from `state.sw.rng` and parks its fiber in `state.scene`.

Transfer semantics:

- A transfer rebuilds the map interpreter and returns every character to
  its authored cell (MV map-load semantics); switches, items, variables,
  gold and the RNG cursor in `state.sw` survive. Same-map transfers reset
  the same way.
- `fade > 0` freezes gameplay for the fade: fade-out half, swap on the
  first fully-black frame, fade-in half (`fadeOpacity(state.fade)` is the
  overlay alpha the UI binds).
- The render structure that makes a transfer cheap is one ground and one
  upper `Image` per **current** map plus per-map NPC containers: a swap is
  an `Image` src change and a container `display` toggle — O(maps), not the
  1998-op sliding-chunk burst the R1 review measured.

## Extensions and battle scenes

`createSession(project, hz, options)` accepts `options.maps`,
`options.extensions`, `options.battle`, and `options.verifyMapManifest`. The
last option recomputes a sharded shell's declared content hash for untrusted
inputs; packaged splitter output uses its build-time hash directly. The former
bare-repository third argument remains accepted for v1 callers.
`assertShellManifestFresh(shell)` exports the matching build/test-time check:
an application that packages a shell calls it after writing the shell to disk,
so a stale or hand-edited declared hash fails the build instead of shipping.

An `ext` command handler receives cloned JSON arguments, read-only built-in
banks and `random()`, the only permitted entropy source. It returns a new
`ext` value and/or finite number/string variable replacements, per-item count
replacements, and a wallet replacement. All returned banks validate before
any commit, and later instructions in the same interpreter tick see the new
items and gold. An `ext` condition is read-only and cannot draw randomness.
`SessionState.ext` defaults to `null`; its validator runs on every boundary,
its optional codec wraps save/restore bytes, and save checksums cover the
encoded form. Inline projects validate every namespaced call at
`createSession`; sharded projects also validate each acquired map.
`allowUnknown` is an explicit preview-only escape hatch.

`{ op:"extChoice", call, args, prompt, cancel?, write? }` uses a registered
`options.extensions.choices[call]` handler. Its pure
`options(readContext, args)` function receives no RNG and returns live rows
`{ key, label, enabled?, data? }`; the interpreter recomputes them every
reference tick while the modal is open. Keys are non-empty, unique stable
logical identities. A surviving key preserves the cursor through reordering;
if it disappears, the old index is clamped and the replacement row cannot be
confirmed until the following tick. Disabled rows remain navigable and render
dimmed but ignore confirm. Data defaults to `null`, must be JSON, and is cloned
for the resolver. A non-cancellable list must expose at least one enabled row;
only a cancellable list may be empty.

On confirm, the optional `resolve` callback receives the current command
context and `{ kind:"select", index, key, data }`; on an enabled cancel it
receives `{ kind:"cancel" }`. The resolver alone has the saved-RNG `random()`
function, so opening, refreshing, or navigating the modal consumes no entropy.
The command's optional `write` record names distinct variable destinations:
selection writes zero-based index/key/`0`, while cancel writes `-1`/`""`/`1`.
Those values and the resolver's `ExtensionCommandResult` publish atomically,
and a resolver write targeting the same id is rejected instead of receiving
an implicit precedence. The next instruction sees the committed result on the
same reference tick.

The dynamic list reuses the authored-choice modal and four-row scroll window,
so it captures the d-pad, blocks its owning fiber, and makes `worldIdle` false.
Existing safe-point policy deliberately rejects a save while it is open.
Modal state remains plain JSON and rewind rebuilds it through the ordinary
pure fold; reference-tick option refresh and input edges therefore remain
identical across supported host rates. Unknown choice calls are rejected with
other missing extension registrations, or become immediate no-ops only under
the explicit preview `allowUnknown` option.

A `battle` command parks its fiber and publishes a setup JSON value. General
interpreter execution remains parallel fibers (ascending event key) before the
blocking main fiber, preserving same-tick visibility for every other command.
Battle publication is ordered separately: requests newly emitted in a tick
are staged and appended to the persistent queue main first, then parallel
fibers by ascending event key. The queue head starts immediately when the
scene slot is free. After a scene completes and resumes its owner, the next
queued request starts on the next reference tick. A `start()` result of
`null` resumes that fiber immediately and consumes no scene slot.
`BattleRules.start(ext, setup, seed, context)` may decline with `null`;
otherwise its returned JSON state becomes `SessionState.scene.state`.
`context` is a read-only snapshot of the session's ext, switches, variables,
items and gold at battle entry. Existing three-parameter implementations stay
compatible because the additional argument may be ignored.
`BattleRules.step(state, input, ticks)` receives only scene input, once per
host frame, with fixed-reference `ticks`. `done` returns ext, a
win/lose/escape/draw result, optional variable/switch/item/gold replacements,
and an optional transfer. Completion validates every value before committing
any of them, runs the result branch, then runs the transfer; the transfer can
therefore rebuild the map interpreter without discarding branch effects.

`ExtensionCommandResult.items` and `BattleCompletion.items` replace only the
listed ids. Counts are floored through `clampFiniteVar`, clamped non-negative
and to `system.inventory.maxPerItem`, with zero removing an id. Removals and
updates to already-held kinds happen first. New positive kinds are considered
in lexical id order until `system.inventory.maxKinds`; excess kinds are
dropped. `gold` similarly replaces the wallet after finite-integer and
non-negative clamping. Both paths write `SessionState.sw`, the same backpack
and wallet used by shops and authored commands. The values therefore retain
the existing save, rewind and multi-Hz behavior; the save gate itself is
unchanged, so an active battle remains non-saveable.

Scene-time map behavior freezes the map by default, matching RPG Maker MV and
Tuxemon:

- manual player input is routed only to the battle reducer;
- page synchronization, player/NPC autonomous or forced movement, and every
  map interpreter fiber stay frozen;
- the absolute interpreter clock remains rate-stable while relative wait and
  typewriter timers are shifted with it, so paused commands do not elapse;
- `GameView` hides the map/dialog tree and renders the registered battle
  component from `{ state, width, height }` only.

Pass `scene: { worldContinues: true }` to `createSession`, `GameView`, or
`AttractController` to opt into background map simulation. Any battle request
published in that mode joins the same FIFO instead of replacing a request or
throwing because another scene is active. Invalid registered `BattleRules`
return values remain programmer-contract errors; authored combinations of
battle events do not throw from `stepSession`.

A variable-addressed `transfer` resolves against the live variable bank. An
unset/wrong-typed map, coordinate, or direction operand, and a resolved map id
that the project does not own, record a fatal content error instead of
throwing from `stepSession`. The playfield then remains frozen, `GameView`
shows the error message, and the save gate rejects the state. Extension and
`BattleRules` callback return-shape assertions are different: they are
registered game-code contract failures and intentionally still throw.

An active scene or a non-empty battle queue is not a save point. Scene and
queue state still live in the ordinary reducer snapshot used by attract
rewind, so a refold may cross map/queue/battle boundaries byte-for-byte. The
controller takes a full `SessionState` keyframe after each such boundary and
every 3,600 reducer/source frames by default. A keyframe also carries the held
mask, tape/divergence cursors, display stage and type/read-hold clocks needed to
restore the controller exactly; display-only ticks do not move the periodic
counter. Consequently capture positions depend on the source stream, not the
host's 60/30/20/4 Hz paint rate.

Rewind chooses the newest retained keyframe at or before its target and folds
only subsequent reducer inputs. `keyframeIntervalFrames` changes the interval;
`keyframeMaxBytes` defaults to 8 MiB and evicts oldest snapshots first. A zero
budget disables snapshots, and a target older than the retained window falls
back to the clean frame-zero replay. `keyframeStats()`,
`keyframeEstimatedBytes`, and `rewindHistoryEstimatedBytes` expose the bounded
serialized-payload estimate and last suffix length for tests/devtools. Actual
JS object overhead is host-specific. These snapshots are transient controller
state and are not written to save envelopes.

`worldIdle` treats any non-null scene as busy even when
`scene.worldContinues:true` lets map fibers keep folding. Transfer fades and
the session's player route are likewise supplied to condition evaluation as
derived blockers. The save menu remains host-owned: while it is displayed the
host pauses the session fold, and `isSessionWorldIdle(state, true)` reports the
same state as busy without adding menu data to `SessionState`. Attract mode is
an input/presentation controller rather than another game scene, so the phase
itself is not a blocker; source frames evaluate ordinary session state, while
display-only read/end holds do not fold conditions at all. Rewind restores a
snapshot and re-derives the value, preserving byte-identical replay.

An old v1 snapshot with `pendingBattle: null` hydrates to an empty queue; a
populated legacy slot is explicitly rejected because it represents queued
external work, which has never been a legal save point.
