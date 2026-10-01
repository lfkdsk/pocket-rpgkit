# `rpgkit-check` QA checks reference

`rpgkit-check` runs QA tools over any `rpgkit-project/v1` document. The
dynamic checks (`locks`, `freeze`, `reach`, `explore`) drive the real engine
on a copy of the project; `lint` is static; `shot` renders schematic maps.
Game-owned extension calls, battles and scenes run through noop fallbacks
(unknown extensions are accepted as no-ops, battles complete instantly,
scenes complete on their first frame through `onDone`), so the checks
measure event/lock/world liveness, not game logic.

## Invocation

```sh
bun run rpgkit-check <check> --file <doc.json> [--json '<args>'] [--out <dir>]
```

Checks: `lint`, `locks`, `freeze`, `reach`, `explore`, `shot`. The short
names above and the full `rpgkit-<check>` forms are both accepted.

| flag | meaning |
| --- | --- |
| `--file <path>` | project document (inline `rpgkit-project/v1` JSON). Required. Sharded `ProjectShell` documents are rejected with `doc/shell-unsupported`. |
| `--json <json>`, `--args <json>` | arguments object for the check. CLI flags win over `--json` keys. |
| `--out <dir>` | output directory for `shot` (default `.`). |

Every check prints one pretty-printed JSON report on stdout. The shared
envelope is:

```json
{
  "check": "lint",
  "findings": [
    { "check": "lint", "severity": "error", "message": "…", "suggestion": "…", "loc": { "map": "village", "event": "elder", "page": 0, "commandPath": [2, "then", 0], "pointer": "/maps/0/…" } }
  ],
  "summary": { "maps": 3, "events": 21, "pages": 28, "commands": 64 }
}
```

`loc` fields are all optional; `commandPath` interleaves indexes and branch
tags (`then`, `else`, `options`, `cancel`, `onWin`, `onLose`, `onEscape`,
`onDone`, `onCancel`, `common`). `shot` returns an array instead of the
envelope (see below).

## Exit codes

| code | meaning |
| --- | --- |
| 0 | no error-severity findings (warnings and info do not fail a check) |
| 1 | the report contains at least one `error` finding |
| 2 | usage error, invalid `--json`, thrown error, or a document that cannot be loaded (a load failure still prints a structured report with `doc/*` findings and `summary.loadError`) |

## `lint` — static health check

Args: `file` only. Pure function of the document: switch/variable use,
provably-dead pages, missing references (including declared audio ids), empty choices, and static map
reachability. `summary` adds `maps`, `events`, `pages`, `commands`, and
per-severity counts.

```sh
$ bun run rpgkit-check lint --file examples/sunstone/data/sunstone.json
{ "check": "lint", "findings": [], "summary": { "maps": 3, "events": 21, "pages": 28, "commands": 64 } }
```

## `locks` — permanent input-lock check

Args: `file`, `frames` (number, default `12000`). Every page containing a
`lockInput` (including inside called common events) is instrumented and run
in isolation on the real engine; the lock must be released by `unlockInput`
or a map transfer within the frame budget.

`summary`: `pages`, `lockCommands`, `dynamicChecks`, `unlocked`,
`transferred`, `unresolved`, `errors`. `rows` carries one entry per checked
page: `{ map, event, name, page, trigger, locks, outcome, lockedAt,
resolvedAt, error? }` with `outcome` one of `unlocked`, `transferred`,
`unresolved`, `error`. Each `unresolved`/`error` row emits a
`locks/permanent-lock` error.

```sh
$ bun run rpgkit-check locks --file examples/sunstone/data/sunstone.json --json '{"frames":1200}'
{ "check": "locks", "findings": [], "summary": { "pages": 0, "lockCommands": 0, "dynamicChecks": 0, "unlocked": 0, "transferred": 0, "unresolved": 0, "errors": 0 }, "rows": [] }
```

(Sunstone has no `lockInput` commands, so nothing is checked.)

## `freeze` — freeze scan

Args: `file`, `windowFrames` (number, default `6000` — 100 s at 60 Hz). The
scan runs `windowFrames × 2` frames per map, entering each map at a
collected transfer landing or its centre, auto-advancing dialogs and
rotating the d-pad. A row is flagged when input is locked for the whole
window, a busy fiber makes no world progress for the whole window, or the
interpreter throws.

`summary`: `maps`, `windowFrames`, `scannedFramesPerMap`, `permanentLocks`,
`permanentBlockingFibers`, `errors`, `flagged`. `rows` (flagged entries
only): `{ map, start, finalMap, final, cells, frames, inputLocked,
blocking, error? }`. Every flagged row is an error.

```sh
$ bun run rpgkit-check freeze --file examples/sunstone/data/sunstone.json --json '{"windowFrames":600}'
{ "check": "freeze", "findings": [], "summary": { "maps": 3, "windowFrames": 600, "scannedFramesPerMap": 1200, "permanentLocks": 0, "permanentBlockingFibers": 0, "errors": 0, "flagged": 0 }, "rows": [] }
```

## `reach` — real-engine reachability with replayable witnesses

`reach` searches the real engine (no second interpreter): a breadth-first
search over world-idle session states, where each edge is a macro that walks
the engine's own passage table to a triggerable event, triggers it, and rides
the result out to world idle — through text, shops, choices (one branch per
option), battles, and transfers. Every map it calls **reached** carries a
button-mask tape the tool itself replays in a fresh session to verify the
arrival; a map it calls **notFound** is one no witness was found for within
budget — a **lead, not a proof**, with frontier stats naming the inbound
transfers whose source pages never ran.

**A "reached" verdict is only as good as the replay.** The witness is a
60 Hz tape (one PSP button mask per reference tick) recorded in constant
6-tick blocks with every pressed edge on a block boundary. Each witness is
replayed and verified at 60 Hz in a fresh session (one `stepSession` call
per tick): the replay must land on the target map with the recorded state
hash, or the map is **not** called reached — a witness that fails its own
fresh-session replay is a `reach/witness-replay-failed` error. The tool
makes no claim about other host frame rates: a witness is verified at
60 Hz only.

Args: `file`, `start` (optional object: `{ map?, x?, y?, dir?, switches?,
variables?, items?, gold? }`; defaults to the project start with a fresh
bank), and the budgets `maxFrames` / `maxStates` / `maxSeconds`.
`battle` (registered `BattleRules`) is available on the TypeScript API
only — battle rules are functions and cannot be passed through the CLI or
MCP JSON; those entry points always run the default `encounters-declined`
policy, so a map gated on a battle outcome is notFound there.

**Budgets are execution limits, not hints.** The frame budget counts the
ticks the search really executes: a choices fan-out's shared walk/dialog
prefix is charged once, not once per branch. The frame and wall-clock
budgets are checked inside each macro's ride-out / battle / wait loop
(before and after every 6-tick block, and between a held edge's release
block and its edge block — the release block's ticks count as already
spent at that check), so the whole search runs at most one block past the
limit: `framesRun <= maxFrames + 6`. The block-constant tape makes one
block (6 ticks) the minimum unit of work, so `maxFrames=1` runs one
block. `endedReason` is one of
`exhausted`, `frame-budget`, `state-budget`, `time-budget`.
`maxFrames` and `maxStates` are non-negative integers; `maxSeconds` is a
non-negative number (fractional allowed). The CLI exposes the budgets as
`--max-frames <n>`, `--max-states <n>`, `--max-seconds <n>` (space and
`=` forms); CLI flags win over the same keys in `--json`.

`summary`: `maps`, `reached`, `notFound`, `statesExplored`, `statesQueued`,
`framesRun`, `endedReason`. The report also carries `start` (`"map@x,y"`),
`battlePolicy`, `budgets`, `maps` (per-map `status`, `frames`,
`witness`, `stateHash`, or `frontier`), `reachableMaps`, `notFoundMaps`, and
`assumptions`. A missing or unstandable start is a `reach/start-unreachable`
error. Structural checks run alongside the search: a transfer to a map the
project does not define is a `reach/transfer-target-missing` **error**; a
transfer landing on a blocked tile is a `reach/transfer-landing-blocked`
**warning**; maps no literal transfer points at and dynamic-target transfers
are listed as `reach/map-orphan` / `reach/dynamic-transfer` **info**.

```sh
$ bun run rpgkit-check reach --file examples/sunstone/data/sunstone.json
{
  "check": "reach",
  "findings": [],
  "summary": { "maps": 3, "reached": 3, "notFound": 0, "statesExplored": 112, "framesRun": 120000, "endedReason": "frame-budget" },
  "start": "village@9,9",
  "battlePolicy": "encounters-declined",
  "budgets": { "maxFrames": 120000, "maxStates": 3000, "maxSeconds": 60 },
  "reachableMaps": [ "village", "forest", "cave" ],
  "notFoundMaps": [],
  "maps": [
    { "map": "village", "status": "reached", "frames": 0, "witness": { "hz": 60, "masks": [] }, "stateHash": "…" },
    { "map": "forest", "status": "reached", "frames": 162, "witness": { "hz": 60, "masks": ["… 162 masks …"] }, "stateHash": "…" },
    { "map": "cave", "status": "reached", "frames": 696, "witness": { "hz": 60, "masks": ["… 696 masks …"] }, "stateHash": "…" }
  ],
  "assumptions": ["… the search's known imprecisions …"]
}
```

The per-map witnesses and `stateHash` feed `shot`'s `reach` overlay and the
editor's play-test debugger.

## `explore` — headless exploration coverage

Args: `file`, `frames` (number, default `6000`), `stuckFrames` (number,
default `600`). A headless player walks the game, auto-answering choices,
and reports which event pages never ran. This is a coverage tool, not a
player: story-gated events are reported, not failures.

`summary`: `frames`, `framesRun`, `mapsVisited`, `mapsTotal`,
`eventsTotal`, `eventsTriggered`, `eventsNeverTriggered`, `triggersTotal`,
`autoChoices`, `errors`, `endedReason`. `endedReason` is one of `budget`,
`complete`, `stuck`, `error`. `events` holds per-event stats with per-page
fiber-start counts; `neverTriggered` holds
`{ map, event, name, page, reason }` with reason `no-active-page`,
`map-unvisited`, `unreachable`, `budget`, `stuck`, or `attempted-no-fiber`.
Each never-triggered page is an `explore/never-triggered` **info** finding;
an interpreter error during exploration is an `explore/error` error and
fails the check.

```sh
$ bun run rpgkit-check explore --file examples/sunstone/data/sunstone.json --json '{"frames":1200,"stuckFrames":300}'
{
  "check": "explore",
  "findings": [ { "severity": "info", "message": "event \"thorn-gate\" (Wall of Thorns) on \"forest\" page 1 never ran within the 1200-frame observation window (attempted-no-fiber)" } ],
  "summary": { "frames": 1200, "framesRun": 1200, "mapsVisited": 3, "mapsTotal": 3, "eventsTotal": 21, "eventsTriggered": 19, "eventsNeverTriggered": 3, "triggersTotal": 23, "autoChoices": 2, "errors": 0, "endedReason": "budget" },
  "mapsVisited": [ "village", "forest", "cave" ],
  "neverTriggered": [
    { "map": "forest", "event": "forest-return", "reason": "budget" },
    { "map": "forest", "event": "thorn-gate", "reason": "attempted-no-fiber" },
    { "map": "cave", "event": "cave-return", "reason": "budget" }
  ]
}
```

## `shot` — schematic screenshots

Args: `file`, `map` (required), `x`, `y` (required numbers), `dir`
(optional), `sw` (optional `{ switches?, variables?, items?, gold? }`
switch bank), `reach` (optional array of `"map@x,y"` node keys to tint as
reachable, as produced by `reach`), `out` (optional, default `"."`).

Renders two deterministic, byte-identical PNGs per call — PSP 480×272 and
desktop 960×544 — named `<map>-<x>-<y>.<width>x<height>.png`. Green cells
are standable, gray cells blocked, orange boxes mark events, the white box
is the player, and the cyan box is the start. Returns an array (not the
shared envelope):

```sh
$ bun run rpgkit-check shot --file examples/sunstone/data/sunstone.json --json '{"map":"village","x":9,"y":9,"out":"shots"}'
[
  { "resolution": { "width": 480, "height": 272 }, "file": "shots/village-9-9.480x272.png", "bytes": 5122, "sha256": "c05a2426…" },
  { "resolution": { "width": 960, "height": 544 }, "file": "shots/village-9-9.960x544.png", "bytes": 20128, "sha256": "687fe260…" }
]
```

`shot` requires `dist/rpgkit-shot.js` (`bun run build:example`) and
`vendor/pocketjs/hosts/web/pocketjs.wasm` (`bun run build:wasm`); a missing
prerequisite is a thrown error (exit 2).

## Finding codes

### Document loading (`doc/*`, all errors)

| code | meaning | typical fix |
| --- | --- | --- |
| `doc/unreadable` | the file cannot be read | pass a path to an `rpgkit-project/v1` JSON document |
| `doc/invalid-json` | the file is not parseable JSON | fix the JSON syntax |
| `doc/schema` | JSON Schema violation (the location is in `loc.pointer`) | bring the document back to what the editor exports |
| `doc/shell-unsupported` | the document is a sharded `ProjectShell` | pass the editor's inline export, or materialize the shell first |
| `lint/map-id-duplicate` | duplicate map id | map ids must be unique; the engine keys worlds and transfers by them |
| `lint/event-id-duplicate` | duplicate event id within a map | event ids must be unique within a map; the engine keys characters and self-switches by them |

### `lint`

| code | severity | meaning | typical fix |
| --- | --- | --- | --- |
| `lint/switch-read-never-set` | warning | a switch is read by a condition but never set in the document | it always evaluates to its default; if a save or an extension seeds it, ignore the finding |
| `lint/switch-set-never-read` | info | a switch is set but never read | dead write within the document; external code may still read it |
| `lint/variable-read-never-set` | info | a variable is read but never set | may be seeded by a save or extension; otherwise it always reads its default |
| `lint/variable-set-never-read` | info | a variable is set but never read | dead write within the document |
| `lint/selfswitch-read-never-set` | warning | a page requires self switch K=true that no page of the event ever sets | the page can never win; add a `selfSwitch` set or drop the condition |
| `lint/page-condition-contradiction` | error | a page condition is provably false | the page never activates; fix the contradictory clauses |
| `lint/page-shadowed` | error | an earlier page's condition implies a later page's, so the earlier never wins | delete the dead page or strengthen its condition |
| `lint/start-map-missing` | error | the start map is absent, or the start position is out of bounds | fix `start.map` or move the start inside the map |
| `lint/transfer-target-missing` | error | a transfer names an unknown map, or its landing is out of bounds | add the map or fix the id/landing; a transfer to a missing map throws at runtime |
| `lint/place-target-missing` | error | a `place` names an unknown event, or its landing is out of bounds | fix the event id or the landing |
| `lint/route-target-missing` | error | a `moveRoute` names an unknown event | fix the event id |
| `lint/appearance-target-missing` | error | an `appearance` command or condition names an event not on the host map | fix the event id or remove the clause |
| `lint/common-event-missing` | error | a `common` op calls an unknown common event | add the common event or fix the id |
| `lint/item-missing` | error | an item/shop/condition references an item not in the catalog | add the item to the catalog or fix the id |
| `lint/audio-missing` | error | an audio command or `bgmPlaying` condition references an id absent from a declared `project.audio` table | add the logical id to `project.audio` or fix the reference; projects without an audio table remain valid for state-only use |
| `lint/sprite-missing` | error | a page sprite, `appearance` sprite, or appearance-condition sprite key is not in `project.sprites` | add the sprite or fix the key |
| `lint/sheet-missing` | error | a map sheet, tile id prefix, walker sheet, or item sprite references an unknown sheet | add the sheet or fix the id |
| `lint/tileproperty-out-of-bounds` | error | a `tileProperty` command (throws at runtime) or condition (always false) addresses a cell outside the host map | move the cell inside the map or remove the clause |
| `lint/map-unreachable` | warning | no sequence of literal-id transfers reaches the map from the start map | dynamic transfers can still reach it; add a transfer path or remove the map |
| `lint/choices-empty` | error or warning | a choices modal with no options and no cancel (error), or empty branches (warning) | add an option or a cancel branch; give branches commands or remove them |
| `lint/scene-id` | info | a scene id is used by the document but has no registration in it | scene rules are code-side (`SessionOptions.scenes`); register `SceneRules` for it (the kit ships `nameInputRules` for `rpgkit.nameInput`) or fix the id — an unregistered id throws at session startup |

### `locks`

| code | severity | meaning | typical fix |
| --- | --- | --- | --- |
| `locks/permanent-lock` | error | a page locks input and the isolated engine run never released it within the frame budget | release the lock with `unlockInput` on the lock's own branch, or hand it to an automatic event that provably releases it |

### `freeze` (all errors)

| code | meaning | typical fix |
| --- | --- | --- |
| `freeze/interpreter-error` | the interpreter threw after N frames; the scan aborts the map | fix the command that throws |
| `freeze/permanent-lock` | the input lock was held for the whole window | every `lockInput` needs a matching `unlockInput` on every page path |
| `freeze/blocking-fiber` | a busy fiber made no world progress for the whole window | add an exit condition (a switch/selfSwitch flip, an `erase`, a transfer) so the fiber can end |

### `reach`

| code | severity | meaning | typical fix |
| --- | --- | --- | --- |
| `reach/start-unreachable` | error | the start map is missing, or the start tile is not standable | fix `start.map` or move the start to a standable tile |
| `reach/map-not-found` | warning | no replayable witness to the map was found within budget | a lead, not a proof; puzzles, shops, extensions, dynamic transfers, and battle outcomes under non-default rules may still reach it — the frontier names the inbound pages that never ran |
| `reach/witness-replay-failed` | error | a recorded witness did not replay to its map and state in a fresh session | a check-tool bug; report it with the project |
| `reach/transfer-target-missing` | error | a literal transfer targets a map the project does not define | fix the transfer's `map` |
| `reach/transfer-landing-blocked` | warning | a transfer lands on a non-standable tile | move the landing or make the tile standable |
| `reach/map-orphan` | info | no literal transfer points at the map | expected for a map only reached by a dynamic transfer or extension; remove it otherwise |
| `reach/dynamic-transfer` | info | a transfer's target is a variable/expression, not a literal map id | the search does not follow it; ensure the target is reachable another way |

### `explore`

| code | severity | meaning | typical fix |
| --- | --- | --- | --- |
| `explore/never-triggered` | info | an event page never ran within the observation window | expected for story-gated events; `attempted-no-fiber` suggests checking erasure, an empty page, or a facing condition |
| `explore/error` | error | the interpreter errored during exploration | fix the event that errored |

## MCP tools

`rpgkit-check` starts no server of its own; the editing server mounts the
six checks as MCP tools (see [edit-api.md](edit-api.md)). The tool names are
`rpgkit-lint`, `rpgkit-locks`, `rpgkit-freeze`, `rpgkit-reach`,
`rpgkit-explore`, and `rpgkit-shot`, each taking the same arguments as the
CLI `--json` object plus `file`. Only `rpgkit-shot` writes files; the rest
are read-only.
