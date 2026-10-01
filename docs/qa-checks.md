# `rpgkit-check` QA checks reference

`rpgkit-check` runs QA tools over any `rpgkit-project/v1` document. The
dynamic checks (`locks`, `freeze`, `reach`, `explore`) drive the real engine
on a copy of the project; `lint` is static; `shot` renders schematic maps.

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
`common`). `shot` returns an array instead of the envelope (see below).

## Exit codes

| code | meaning |
| --- | --- |
| 0 | no error-severity findings (warnings and info do not fail a check) |
| 1 | the report contains at least one `error` finding |
| 2 | usage error, invalid `--json`, thrown error, or a document that cannot be loaded (a load failure still prints a structured report with `doc/*` findings and `summary.loadError`) |

## `lint` — static health check

Args: `file` only. Pure function of the document: switch/variable use,
provably-dead pages, missing references, empty choices, and static map
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

## `reach` — experimental state-based reachability

`reach` is **experimental**: it builds the multi-map walk graph from a real
session state and reports which maps the player can reach. Its model
freezes story state, dry-runs entry pages for a fixed 10-tick window, does
not re-expand recursive common events, does not model battle outcomes or
extension commands, and does not follow transfers with a variable target.

**Both directions of a verdict can be wrong.** A "reachable" map may only
be reachable through an unmodelled recursive common event or a battle
branch, and an "unreachable" map may be gated on state the frozen model
cannot produce (for example a non-zero item or gold baseline carried
through a forced entry transfer). Treat every verdict as a **lead, not a
proof**; each report carries `experimental: true` and an `assumptions` list
naming the twelve known imprecisions. The check is being reworked into a
real engine search with a replayable witness for each verdict.

Args: `file`, `start` (optional object: `{ map?, x?, y?, dir?, switches?,
variables?, items?, gold? }`; defaults to the project start with a fresh
bank).

`summary`: `maps`, `totalStandable`, `reachableTiles`, `reachableMaps`,
`unreachableMaps`, `buildMs`. The report also carries `start`
(`"map@x,y"`), `reachableTilesByMap`, `reachableMaps`, `unreachableMaps`,
and `assumptions`. A missing or unstandable start is a
`reach/start-unreachable` error; a map with no reachable tiles is a
`reach/map-unreachable` **warning** and does not fail the check.

```sh
$ bun run rpgkit-check reach --file examples/sunstone/data/sunstone.json
{
  "check": "reach",
  "experimental": true,
  "findings": [ { "severity": "warning", "message": "under the frozen-story-state assumptions, no path to map \"cave\" was found (start map \"village\" has 213 reachable tiles); this is a lead, not a proof — see the report's assumptions for the known imprecisions" } ],
  "summary": { "maps": 3, "totalStandable": 219, "reachableTiles": 213, "reachableMaps": 2, "unreachableMaps": 1, "buildMs": 8 },
  "start": "village@9,9",
  "reachableMaps": [ "village", "forest" ],
  "unreachableMaps": [ "cave" ],
  "assumptions": [ "story variables are frozen except for state propagated through forced entry transfers", "… 11 more" ]
}
```

(The cave is gated behind the thorn-gate event's story state, so the frozen
model cannot reach it — the expected warning for this project.)

The `"map@x,y"` node keys and reachable sets feed `shot`'s `reach` overlay.

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
| `lint/sprite-missing` | error | a page sprite, `appearance` sprite, or appearance-condition sprite key is not in `project.sprites` | add the sprite or fix the key |
| `lint/sheet-missing` | error | a map sheet, tile id prefix, walker sheet, or item sprite references an unknown sheet | add the sheet or fix the id |
| `lint/tileproperty-out-of-bounds` | error | a `tileProperty` command (throws at runtime) or condition (always false) addresses a cell outside the host map | move the cell inside the map or remove the clause |
| `lint/map-unreachable` | warning | no sequence of literal-id transfers reaches the map from the start map | dynamic transfers can still reach it; add a transfer path or remove the map |
| `lint/choices-empty` | error or warning | a choices modal with no options and no cancel (error), or empty branches (warning) | add an option or a cancel branch; give branches commands or remove them |

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
| `reach/map-unreachable` | warning | no path to the map was found under the frozen-story-state assumptions | a lead, not a proof; dynamic transfers, extensions, recursive common events, and battle branches may still reach it |

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
