# `rpgkit-edit` API reference

`rpgkit-edit` exposes the editor's pure document model as a stable
JSON-in/JSON-out command line, for scripts and coding agents. Every request
parses and validates the input document first; every effective mutation is
validated again, returns JSON Pointer changes with before/after values and a
reversible `rpgkit-edit/patch-v1` patch, and atomically replaces the file.

The same operations are available as MCP tools; see [MCP tools](#mcp-tools).

## Invocation

```sh
bun run rpgkit-edit <command> --file <project.json> [--json '<args>'] [--dry-run]
```

The commands are `open`, `list-maps`, `list-events`, `list-pages`,
`list-commands`, `update-map`, `paint-tile`, `paint-rect`, `fill-region`,
`paint-passage`, `add-event`, `update-event`, `delete-event`, `add-page`,
`update-page`, `delete-page`, `insert-command`, `delete-command`,
`update-command`, `validate`, and `save`.

### Common flags

| flag | meaning |
| --- | --- |
| `--file <path>` | project document. Required for every command. |
| `--json <json>` | arguments object: an inline JSON string or `@path/to/args.json`. Defaults to `{}`. |
| `--dry-run` | mutating commands only: run the full validation/diff/patch path but never write. |
| `--help`, `-h` | print usage, exit 0. |

## Response envelope

Every command prints exactly one JSON object on stdout.

Success:

```json
{
  "ok": true,
  "command": "paint-tile",
  "project": { "format": "rpgkit-project/v1", "title": "...", "documentKind": "inline", "editable": true, "mapCount": 3, "revision": "57b3…" },
  "changed": true,
  "addresses": ["map:village/layer:ground/tile:1,1"],
  "diff": [ { "path": "/maps/0/ground/21", "before": { "exists": true, "value": "town.0" }, "after": { "exists": true, "value": "town.42" } } ],
  "patch": { "format": "rpgkit-edit/patch-v1", "beforeHash": "…", "afterHash": "…", "changes": [ … ] },
  "result": { "map": "village", "layer": "ground", "tile": "town.42", "cells": 1 },
  "file": "sunstone/data/sunstone.json",
  "dryRun": false,
  "written": true
}
```

- `project` is a summary of the document; `revision` is the SHA-256 of its
  canonical semantic JSON.
- `changed` is false when the edit was a no-op (for example painting a tile
  with the value it already has); `diff` and `patch` are still returned.
- `patch` is present on successful mutating commands.
- `result` is command-specific; documented per command below.
- `file`, `dryRun`, and `written` are added by the file adapter.

Failure:

```json
{ "ok": false, "command": "delete-page", "error": { "code": "LAST_PAGE", "message": "…" }, "file": "…", "dryRun": false, "written": false }
```

`error` may also carry `path`, `expected`, `actual`, or `details`. Error
codes include `READ_FAILED`, `WRITE_FAILED`, `WRITE_CONFLICT`,
`PATH_OUTSIDE_ROOT` (file layer), `UNKNOWN_COMMAND`, `INVALID_ARGUMENT`,
`INVALID_DOCUMENT`, `READ_ONLY_PROJECT_SHELL`, `MAP_NOT_FOUND`,
`EVENT_NOT_FOUND`, `PAGE_NOT_FOUND`, `OUT_OF_BOUNDS`, `INVALID_TILE`,
`DUPLICATE_EVENT`, `LAST_PAGE`, `COMMAND_ADDRESS_NOT_FOUND`,
`READ_ONLY_COMMAND`, `INVALID_COMMAND_FIELD`, `INVALID_PATCH`,
`PATCH_BASE_MISMATCH`, `PATCH_CHANGE_MISMATCH`, `INVALID_JSON_VALUE`,
`INVALID_EDIT`, and `INTERNAL_ERROR`.

Writes are atomic: a temp file in the same directory is written, its bytes
re-checked against the in-memory result, and renamed over the target. If the
file changed on disk between read and write, the command fails with
`WRITE_CONFLICT` and writes nothing.

## Addresses

Stable text addresses identify every editable thing:

```
map:<id>
map:<id>/layer:<ground|upper|passage>/tile:<x>,<y>
map:<id>/event:<eid>
map:<id>/event:<eid>/page:<i>
map:<id>/event:<eid>/page:<i>/command:<key>
```

Command keys address the recursive command tree:

| key | meaning |
| --- | --- |
| `root#2` | command 2 at the page root |
| `i2:then#0` | command 0 in the `then` branch of the `if` at index 2 (`i2:else#…` for else) |
| `c2:option:1#0` | command 0 in option 1 of the `choices` at index 2 |
| `c2:cancel#0` | command 0 in the cancel branch of the `choices` at index 2 |
| `b2:win#0` | command 0 in the win branch of the `battle` at index 2 (`b2:lose#…`, `b2:escape#…`) |

The structured form used by the command-editing args is
`{ "path": [ …segments ], "index": n }`, where each segment is one of
`{ "kind": "if", "index": n, "branch": "then"|"else" }`,
`{ "kind": "choices", "index": n, "branch": "option", "option": n }`,
`{ "kind": "choices", "index": n, "branch": "cancel" }`, or
`{ "kind": "battle", "index": n, "branch": "win"|"lose"|"escape" }`.
For inserts, `index` may equal the addressed list's length.

## Read commands

### `open`

Args: none. `result` is the project summary plus `start` and the sheet list.

```sh
$ bun run rpgkit-edit open --file examples/sunstone/data/sunstone.json
{"ok":true,"command":"open","project":{"format":"rpgkit-project/v1","title":"The Sunstone of Bramble Hollow","documentKind":"inline","editable":true,"mapCount":3,"revision":"57b33669…"},"changed":false,"addresses":[],"diff":[],"result":{"format":"rpgkit-project/v1","title":"The Sunstone of Bramble Hollow","documentKind":"inline","editable":true,"mapCount":3,"revision":"57b33669…","start":{"map":"village","x":9,"y":9,"dir":"up"},"sheets":[{"id":"town","cols":12,"rows":11},{"id":"dun","cols":12,"rows":11}]},"file":"…","dryRun":false,"written":false}
```

### `list-maps`

Args: none. `result` is an array of map rows. Inline documents report
`name`, `width`, `height`, `sheets`, and `eventCount`; sharded shells report
the `entry` and `sha256` of each map payload instead.

```sh
$ bun run rpgkit-edit list-maps --file examples/sunstone/data/sunstone.json
[
  { "address": "map:village", "id": "village", "name": "Bramble Hollow", "width": 20, "height": 13, "sheets": ["town"], "eventCount": 9 },
  { "address": "map:forest", "id": "forest", "name": "Whispering Wood", "width": 18, "height": 14, "sheets": ["town"], "eventCount": 5 },
  { "address": "map:cave", "id": "cave", "name": "Sunstone Cave", "width": 18, "height": 13, "sheets": ["dun"], "eventCount": 7 }
]
```

### `list-events`

Args: `map` (string, required). Requires an inline document. `result` is an
array of `{ address, id, name?, x, y, w, h, pageCount }`.

```sh
$ bun run rpgkit-edit list-events --file examples/sunstone/data/sunstone.json --json '{"map":"village"}'
[
  { "address": "map:village/event:elder", "id": "elder", "name": "Village Elder", "x": 9, "y": 5, "w": 1, "h": 1, "pageCount": 1 },
  { "address": "map:village/event:merchant", "id": "merchant", "name": "Traveling Merchant", "x": 11, "y": 5, "w": 1, "h": 1, "pageCount": 1 }
]
```

### `list-pages`

Args: `map`, `event` (both required). `result` is an array of
`{ address, index, trigger, condition?, sprite?, blocks, commandCount }` in
authored (priority) order.

```sh
$ bun run rpgkit-edit list-pages --file examples/sunstone/data/sunstone.json --json '{"map":"village","event":"elder"}'
[ { "address": "map:village/event:elder/page:0", "index": 0, "trigger": "action", "sprite": "wiz", "blocks": true, "commandCount": 4 } ]
```

### `list-commands`

Args: `map`, `event`, `page` (integer ≥ 0; all required). `result` is an
array of flattened rows, one per command in the page's recursive tree:
`{ address, commandAddress, key, depth, branch?, summary, readOnly, command }`.
`commandAddress` is the structured `{ path, index }` form accepted by the
command-editing commands. `readOnly` is true for ops the field editor does
not own.

```sh
$ bun run rpgkit-edit list-commands --file examples/sunstone/data/sunstone.json --json '{"map":"village","event":"elder","page":0}'
map:village/event:elder/page:0/command:root#0 | root#0 | Text: ELDER: The Sunstone that lit our valley / was taken into the ca…
map:village/event:elder/page:0/command:root#1 | root#1 | Choices: Ask about the road ahead? (2)
map:village/event:elder/page:0/command:c1:option:0#0 | c1:option:0#0 | Text: ELDER: A rune stone sleeps among the trees. / Touch it, and the…
map:village/event:elder/page:0/command:c1:option:1#0 | c1:option:1#0 | Text: ELDER: Walk tall. The hollow believes in you.
```

### `validate`

Args: none. Always `ok: true`; `result` is
`{ valid: boolean, errors: [{ path, msg }] }`. Invalid documents are
reported, not failures. Runs schema validation plus structural checks
(duplicate ids, bounds, start map).

```sh
$ bun run rpgkit-edit validate --file examples/sunstone/data/sunstone.json
{ "valid": true, "errors": [] }
```

## Map editing

### `update-map`

Args: `map` (required), `changes` (object with at least one of `id`, `name`,
`width`, `height`, `sheets`). `id` matches `^[a-z0-9_-]+$`; `name` is 1–40
characters; `width`/`height` are 1–256; `sheets` is a non-empty unique list.
Renaming an id follows `start.map` and every transfer that names it;
resizing crops events fully outside the new bounds and reports them in
`croppedEvents`.

```sh
$ bun run rpgkit-edit update-map --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","changes":{"name":"Bramble Hollow Village"}}'
{"ok":true,"changed":true,"addresses":["map:village"],"patch":{…},"result":{"map":{"id":"village","name":"Bramble Hollow Village",…},"croppedEvents":[]}}
```

### `paint-tile`

Args: `map` (required), `x`, `y` (required, in bounds), `tile` (required: a
`"sheet.cell"` id declared by the map, or `null` to erase), `layer`
(`"ground"` or `"upper"`, default `"ground"`).

```sh
$ bun run rpgkit-edit paint-tile --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","x":0,"y":0,"tile":"town.0"}'
{"ok":true,"changed":false,"addresses":["map:village/layer:ground/tile:0,0"],"patch":{…},"result":{"map":"village","layer":"ground","tile":"town.0","cells":1}}
```

(`changed` is false here because cell 0,0 already held `town.0`.)

### `paint-rect`

Args: `map`, `x`, `y` (required), `width`, `height` (positive integers; the
rect must fit the map), `tile` (required, `null` erases), `layer` (default
`"ground"`). One stroke, one patch.

```sh
$ bun run rpgkit-edit paint-rect --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","x":0,"y":0,"width":2,"height":2,"tile":"town.0"}'
{"ok":true,"changed":false,"addresses":["map:village/layer:ground/tile:0,0","map:village/layer:ground/tile:1,0","map:village/layer:ground/tile:0,1","map:village/layer:ground/tile:1,1"],"result":{"map":"village","layer":"ground","tile":"town.0","cells":4}}
```

### `fill-region`

Args: `map`, `x`, `y` (required), `tile` (required, `null` erases), `layer`
(default `"ground"`). Four-way flood fill of the contiguous region
containing (x, y).

```sh
$ bun run rpgkit-edit fill-region --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","x":0,"y":0,"tile":"town.0"}'
{"ok":true,"changed":false,"addresses":[],"result":{"map":"village","layer":"ground","tile":"town.0","cells":0}}
```

(`cells` is 0 because the region at 0,0 was already `town.0`.)

### `paint-passage`

Args: `map`, `x`, `y` (required, in bounds), `value` (required: `"pass"`,
`"block"`, or `null` to clear the override).

```sh
$ bun run rpgkit-edit paint-passage --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","x":0,"y":0,"value":"pass"}'
{"ok":true,"changed":true,"addresses":["map:village/layer:passage/tile:0,0"],"result":{"map":"village","x":0,"y":0,"value":"pass"}}
```

## Event and page editing

### `add-event`

Args: `map` (required), `event` (required: a full event object). Required
fields: `id` (`^[A-Za-z0-9_-]+$`, unique on the map), `x`, `y` (non-negative
integers), `pages` (non-empty array). Optional: `name`, `w`, `h` (positive
integers). The footprint must fit the map.

```sh
$ bun run rpgkit-edit add-event --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","event":{"id":"doc-demo","x":5,"y":5,"pages":[{"trigger":"action","commands":[{"op":"text","lines":["Hi."]}]}]}}'
{"ok":true,"changed":true,"addresses":["map:village/event:doc-demo"],"result":{"id":"doc-demo","x":5,"y":5,"pages":[{"trigger":"action","commands":[{"op":"text","lines":["Hi."]}]}]}}
```

### `update-event`

Args: `map`, `event` (the existing id), `changes` (object: any of `id`,
`name`, `x`, `y`, `w`, `h`; `null` removes optional `name`/`w`/`h`). Page
content is not editable here.

```sh
$ bun run rpgkit-edit update-event --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","event":"sign","changes":{"name":"Village Signpost"}}'
{"ok":true,"changed":true,"addresses":["map:village/event:sign"],"result":{"id":"sign","name":"Village Signpost","x":13,"y":7,"pages":[…]}}
```

### `delete-event`

Args: `map`, `event`. `result` is `{ deleted: <event> }`.

```sh
$ bun run rpgkit-edit delete-event --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","event":"boy"}'
{"ok":true,"changed":true,"addresses":["map:village/event:boy"],"result":{"deleted":{"id":"boy","name":"Curious Boy","x":7,"y":9,"pages":[…]}}}
```

### `add-page`

Args: `map`, `event`, `page` (a full page object), `index` (optional,
0..page count; default appends). A page requires `trigger`
(`action`/`playerTouch`/`autorun`/`parallel`) and `commands`; optional fields
are `condition`, `sprite` (string or null), `blocks`, `moveType`,
`moveRoute`, `moveSpeed` (1–6), `moveFrequency` (1–5), `directionFix`,
`through`, `facingMode`, and `dir`. Higher index means higher runtime
priority.

```sh
$ bun run rpgkit-edit add-page --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","event":"boy","page":{"trigger":"action","commands":[{"op":"text","lines":["Hmm?"]}]}}'
{"ok":true,"changed":true,"addresses":["map:village/event:boy/page:1"],"result":{"trigger":"action","commands":[{"op":"text","lines":["Hmm?"]}]}}
```

### `update-page`

Args: `map`, `event`, `page` (integer), `value` (a full replacement page).

```sh
$ bun run rpgkit-edit update-page --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","event":"boy","page":0,"value":{"trigger":"action","commands":[{"op":"text","lines":["Hey!"]}]}}'
{"ok":true,"changed":true,"addresses":["map:village/event:boy/page:0"],"result":{"trigger":"action","commands":[{"op":"text","lines":["Hey!"]}]}}
```

### `delete-page`

Args: `map`, `event`, `page`. Refuses to delete an event's last page with
`LAST_PAGE`. `result` is `{ deleted: <page> }`.

```sh
$ bun run rpgkit-edit delete-page --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","event":"boy","page":1}'
{"ok":true,"changed":true,"result":{"deleted":{"trigger":"action","commands":[{"op":"text","lines":["Hmm?"]}]}}}
```

## Command editing

### `insert-command`

Args: `map`, `event`, `page`, `address` (`{ path, index }`; `index` may equal
the list length), `command` (an object with a non-empty `op` string).
Opaque runtime commands are inserted intact; the whole-project schema gate
after the mutation decides validity.

```sh
$ bun run rpgkit-edit insert-command --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","event":"boy","page":0,"address":{"path":[],"index":0},"command":{"op":"text","lines":["Hi there!"]}}'
{"ok":true,"changed":true,"addresses":["map:village/event:boy/page:0/command:root#0"],"result":{"op":"text","lines":["Hi there!"]}}
```

### `delete-command`

Args: `map`, `event`, `page`, `address`. The address must resolve to an
existing command. `result` is `{ deleted: <command> }`.

```sh
$ bun run rpgkit-edit delete-command --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","event":"elder","page":0,"address":{"path":[],"index":0}}'
{"ok":true,"changed":true,"addresses":["map:village/event:elder/page:0/command:root#0"],"result":{"deleted":{"op":"text","lines":["ELDER: The Sunstone that lit our valley","was taken into the cave beyond the wood.","Thorns seal the forest path. Take the key","from the village chest, hero."]}}}
```

### `update-command`

Args: `map`, `event`, `page`, `address`, `field` (non-empty string), `value`
(string: the editor's text spelling, e.g. `"10"`, `"true"`, or
newline-separated text lines). Only editor-owned ops are field-editable:
`text`, `choices`, `switch`, `variable`, `selfSwitch`, `if`, `transfer`,
`wait`, `gold`, `item`, `se`, `erase`, `exit`, `common`, `lockInput`,
`unlockInput`, `place`, and `moveRoute`. Other ops fail with
`READ_ONLY_COMMAND`; a bad field or value fails with `INVALID_COMMAND_FIELD`
listing the legal fields.

The audio ops `playBgm`, `fadeoutBgm`, `stopBgm`, `pauseBgm`, `resumeBgm`,
`playBgs`, `fadeoutBgs`, `playMe`, `playSe`, `saveBgm`, and `replayBgm` are
accepted by `insert-command`, returned intact by `list-commands`, and checked
by whole-project validation. They are deliberately read-only for
`update-command`, as is the `bgmPlaying` condition inside a page or `if`;
field-level controls have not landed in the editor yet.

```sh
$ bun run rpgkit-edit update-command --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","event":"elder","page":0,"address":{"path":[],"index":0},"field":"lines","value":"New text"}'
{"ok":true,"changed":true,"addresses":["map:village/event:elder/page:0/command:root#0"],"result":{"op":"text","lines":["New text"]}}
```

## `save`

Apply a previously captured patch. Args: `patch` (a full
`rpgkit-edit/patch-v1` object), `direction` (`"forward"` default, or
`"reverse"` to undo).

`result` is `{ direction, beforeHash, afterHash }`. Errors: `INVALID_PATCH`
(malformed), `PATCH_BASE_MISMATCH` (the document's semantic hash is not the
patch's expected base), `PATCH_CHANGE_MISMATCH` (a change's precondition does
not match), `INVALID_EDIT` (the patched result would be invalid).

```sh
$ jq '{patch:.patch}' preview.json > apply.json
$ bun run rpgkit-edit save --file examples/sunstone/data/sunstone.json --json @apply.json
{"ok":true,"changed":true,"result":{"direction":"forward","beforeHash":"01fb89c775a8…","afterHash":"76b5f5ca537e…"}}
$ jq '.direction="reverse"' apply.json > reverse.json
$ bun run rpgkit-edit save --file examples/sunstone/data/sunstone.json --json @reverse.json
{"ok":true,"changed":true,"result":{"direction":"reverse","beforeHash":"76b5f5ca537e…","afterHash":"01fb89c775a8…"}}
```

## The `rpgkit-edit/patch-v1` envelope

```json
{
  "format": "rpgkit-edit/patch-v1",
  "beforeHash": "01fb89c775a8f229acefccbc79c29d23110b323fec6178fb75f03ebf546a54b5",
  "afterHash": "76b5f5ca537e0c00e105d2a34c7a3a2636c67a0f0d20495968d20b253205b398",
  "changes": [
    {
      "path": "/maps/0/ground/21",
      "before": { "exists": true, "value": "town.0" },
      "after": { "exists": true, "value": "town.42" }
    }
  ]
}
```

- `beforeHash`/`afterHash` are lowercase SHA-256 hex of the document's
  canonical semantic JSON (sorted keys).
- `path` is an RFC 6901 JSON Pointer.
- `before`/`after` sides distinguish a missing value (`{ "exists": false }`)
  from a JSON null (`{ "exists": true, "value": null }`).
- Forward applies changes in order, expecting `before` and writing `after`;
  reverse applies them in reverse order, expecting `after` and writing
  `before`. The base hash must match or the save fails closed.

## Exit codes

| code | meaning |
| --- | --- |
| 0 | success |
| 1 | edit failure: the response is `{ "ok": false, "error": … }` (unknown command, not found, out of bounds, last page, patch mismatch, and so on) |
| 2 | CLI usage error: missing `--file`, malformed `--json`, unknown flag; stdout is a `CLI_USAGE` error object |

## MCP tools

The MCP server (`bun run rpgkit-edit:mcp`, or
`bun tools/rpgkit-edit/mcp.ts --root <project-dir>`) speaks newline-delimited
JSON-RPC 2.0 over stdio and mounts both the edit tools and the QA check
tools (see [qa-checks.md](qa-checks.md)). Every tool takes a `file` argument
that must resolve inside `--root`; mutating tools also take `dryRun`.

| MCP tool | CLI command | required args | optional args |
| --- | --- | --- | --- |
| `rpgkit_project_open` | `open` | `file` | — |
| `rpgkit_maps_list` | `list-maps` | `file` | — |
| `rpgkit_events_list` | `list-events` | `file`, `map` | — |
| `rpgkit_pages_list` | `list-pages` | `file`, `map`, `event` | — |
| `rpgkit_commands_list` | `list-commands` | `file`, `map`, `event`, `page` | — |
| `rpgkit_map_update` | `update-map` | `file`, `map`, `changes` | `dryRun` |
| `rpgkit_tile_paint` | `paint-tile` | `file`, `map`, `x`, `y`, `tile` | `layer`, `dryRun` |
| `rpgkit_tile_rect` | `paint-rect` | `file`, `map`, `x`, `y`, `width`, `height`, `tile` | `layer`, `dryRun` |
| `rpgkit_tile_fill` | `fill-region` | `file`, `map`, `x`, `y`, `tile` | `layer`, `dryRun` |
| `rpgkit_passage_paint` | `paint-passage` | `file`, `map`, `x`, `y`, `value` | `dryRun` |
| `rpgkit_event_add` | `add-event` | `file`, `map`, `event` | `dryRun` |
| `rpgkit_event_update` | `update-event` | `file`, `map`, `event`, `changes` | `dryRun` |
| `rpgkit_event_delete` | `delete-event` | `file`, `map`, `event` | `dryRun` |
| `rpgkit_page_add` | `add-page` | `file`, `map`, `event`, `page` | `index`, `dryRun` |
| `rpgkit_page_update` | `update-page` | `file`, `map`, `event`, `page`, `value` | `dryRun` |
| `rpgkit_page_delete` | `delete-page` | `file`, `map`, `event`, `page` | `dryRun` |
| `rpgkit_command_insert` | `insert-command` | `file`, `map`, `event`, `page`, `address`, `command` | `dryRun` |
| `rpgkit_command_delete` | `delete-command` | `file`, `map`, `event`, `page`, `address` | `dryRun` |
| `rpgkit_command_update` | `update-command` | `file`, `map`, `event`, `page`, `address`, `field`, `value` | `dryRun` |
| `rpgkit_project_validate` | `validate` | `file` | — |
| `rpgkit_project_save` | `save` | `file`, `patch` | `direction`, `dryRun` |

Register it with an absolute script path and root, for example:

```sh
claude mcp add --scope project rpgkit-edit -- \
  bun /absolute/path/to/pocket-rpgkit/tools/rpgkit-edit/mcp.ts \
  --root /absolute/path/to/game-project
```
