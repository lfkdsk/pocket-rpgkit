# Protocols

One page of pointers to the protocols that keep Pocket RPG Kit usable from
many frontends. An editor, a web page, a CLI, or an AI agent only has to
honor these; the runtime itself does not care which frontend produced its
data.

Each section names the file that is the normative specification. When this
page and a normative file disagree, the normative file wins.

## 1. Project data format — `rpgkit-project/v1`

**Normative: [`../src/data/schema.json`](../src/data/schema.json)** (JSON
Schema 2020-12). A document is a JSON object whose `format` is the literal
`"rpgkit-project/v1"`; the schema defines every field, including the event
commands and the four triggers. The matching TypeScript types are
[`../src/engine/types.ts`](../src/engine/types.ts).

- **Changes** are recorded in
  [`../src/data/CHANGELOG.md`](../src/data/CHANGELOG.md). The format string
  stays `v1` while changes are amendments; see
  [section 6](#6-version-and-compatibility-rules) for what that means in
  practice.
- **Sharded projects.** A large project may replace its `maps` array with a
  `mapIndex` (`ProjectShell` in `types.ts`) plus one canonical JSON entry per
  map. The splitter is `splitProjectMaps` in
  [`../tools/lib/map-project.ts`](../tools/lib/map-project.ts); the runtime
  side is `createJsonMapRepository` in
  [`../src/engine/map-repository.ts`](../src/engine/map-repository.ts). Each
  index entry carries the map's SHA-256, and the shell carries a
  `mapManifestHash` over its canonical JSON. The preimage is the shell with
  **both** declared hash fields removed first — `mapManifestHash` and
  `mapSchemaHash` (`shellWithoutDeclaredHashes` in `map-repository.ts`);
  canonical JSON sorts keys recursively (`canonicalJson` in
  [`../src/engine/save.ts`](../src/engine/save.ts)). `assertShellManifestFresh`
  (exported from `pocket-rpgkit/engine`) verifies a packaged shell before
  release.
- **Schema identity.** `MAP_SCHEMA_HASH` in `map-repository.ts` is
  `sha256(canonicalJson(schema.json))`. It identifies the schema a sharded
  project was built against; a session rejects a shell whose `mapSchemaHash`
  differs, and sharded save envelopes carry the same identity. The literal is
  kept in source so inline bundles need not embed the schema, and a test pins
  it to `data/schema.json` so the two cannot drift apart.
- **Saves** are a separate envelope, `rpgkit-save/v1`
  (`src/engine/save.ts`): FNV-checksummed, validated by
  `src/engine/save-validate.ts` before live state is replaced.

## 2. Edit protocol — `rpgkit-edit`

**Normative: [`edit-api.md`](edit-api.md)** (parameters, outputs, error
codes, exit codes, MCP reference).

A JSON-in/JSON-out editing interface for scripts and agents, over a CLI or
MCP stdio. Every request parses and validates the input document first;
every effective mutation validates again before publishing. An inline
project's file is then atomically replaced (temp file, a re-check that the
target still holds the bytes the edit started from, rename). A sharded project publishes a sequence of per-file renames —
changed shards first, the shell manifest last — with best-effort rollback
of already-published shards if a later rename fails; this is **not**
crash-atomic. See `editor/api/file.ts` and
[`edit-api.md`](edit-api.md#response-envelope) (the atomicity paragraph).

- **Operations** (21): `open`, `list-maps`, `list-events`, `list-pages`,
  `list-commands`, `validate`, `update-map`, `paint-tile`, `paint-rect`,
  `fill-region`, `paint-passage`, `add-event`, `update-event`,
  `delete-event`, `add-page`, `update-page`, `delete-page`,
  `insert-command`, `delete-command`, `update-command`, `save`.
- **Addresses** are stable text paths: `map:<id>`,
  `map:<id>/event:<eid>/page:<i>/command:<key>`, with recursive command keys
  such as `i2:then#0` (if), `c2:option:1#0` (choices), `b2:win#0`
  (battle).
- **Reversible patches** use the `rpgkit-edit/patch-v1` envelope:
  `{ format, beforeHash, afterHash, changes[] }`, each change a JSON Pointer
  plus a `before`/`after` side (`{exists:false}` or `{exists:true,value}`).
  Hashes are SHA-256 over canonical semantic JSON. Forward applies in order
  expecting `before`; reverse applies backwards expecting `after`; a base
  hash mismatch fails closed. Implementation: `editor/api/operations.ts`
  (`diffJson`, `applyEditPatch`).
- **Sharded projects are first-class.** The same 21 commands open a
  `ProjectShell`; reads and ordinary mutations load only the addressed
  shard, and `save` publishes only the changed shards plus the shell. Two
  operations load every shard: `validate`, and a real map-id rename (so
  transfers in other maps can follow the rename). A
  shell response's `diff`/`patch` addresses a logical
  `{ kind: "rpgkit-edit/sharded-document-v1", shell, shards }` document,
  with patch paths under `/shell/...` or `/shards/<entry>/...` (the entry is
  one RFC 6901 token). Full contract: [`edit-api.md`](edit-api.md),
  "Sharded `ProjectShell` documents".
- **Browser packs.** The in-browser editor additionally reads and writes a
  self-contained `rpgkit-edit/sharded-pack-v1` file
  (`{ kind, shell: "<json text>", shards: { "<entry>": "<json text>" } }`).
  It is a browser-storage/transport format, not an edit-protocol operation;
  see [`editor/README.md`](../editor/README.md) ("Sharded packs").

## 3. QA protocol — `rpgkit-check`

**Normative: [`qa-checks.md`](qa-checks.md)** (check parameters, output
fields, finding codes, exit codes).

Six checks over any inline `rpgkit-project/v1` document, from the CLI or as
MCP tools mounted on the edit server: `lint` (static health), `locks`
(input-lock audit), `freeze` (forever-blocking scan), `reach`
(real-engine reachability with a replayable witness tape), `explore`
(headless coverage), `shot` (schematic passability/event PNGs).

Five checks (`lint`, `locks`, `freeze`, `reach`, `explore`) print the shared
envelope:

```json
{ "check": "lint", "findings": [], "summary": { "maps": 3 } }
```

`locks` and `freeze` add a `rows` table; `reach` and `explore` add
check-specific fields (budgets, maps reached, events seen). `shot` is the
exception: it prints a bare array of `{ resolution, file, bytes, sha256 }`
entries, one per rendered PNG, with no envelope.

Exit codes (from `tools/rpgkit-check/cli.ts`):

| code | meaning |
| --- | --- |
| 0 | no error-severity findings — warnings and info never fail a check |
| 1 | the report contains at least one `error`-severity finding |
| 2 | usage error, invalid `--json`, a thrown error, or a document that cannot be loaded (a load failure still prints a structured report with `doc/*` findings and `summary.loadError`) |

Because `shot` returns an array (no `findings`), it exits 0 on success even
when it renders warning-worthy content.

## 4. Proposal protocol — `rpgkit-edit/proposal-v1`

**Normative: [`../editor/proposals/schema.json`](../editor/proposals/schema.json)**
(JSON Schema 2020-12), implemented in `editor/proposals/` and
`editor/api/proposals.ts`. Status: **implemented** (desktop editor review
queue; inline projects only).

A proposal is one JSON file describing reviewed edits before they touch a
project. Proposals live in a sidecar directory next to the project file:
`<projectFile>.proposals/<id>.json`; fully reviewed proposals move to
`<projectFile>.proposals/archive/<id>.json`. The filename must equal the
proposal's `id`.

```json
{
  "id": "docs-demo",
  "title": "Rename the project",
  "rationale": "Demonstrate a reviewed edit.",
  "author": "docs",
  "createdAt": "2026-10-01T12:00:00Z",
  "baseHash": "b61f2311f44fcca2636d048898ac4f4abe1bd99d2fe27a82fdef6cebede30a65",
  "hunks": [
    {
      "id": "rename",
      "summary": "Change the project title",
      "changes": [
        { "path": "/title", "before": { "exists": true, "value": "Proposal Demo" }, "after": { "exists": true, "value": "Proposal Demo (edited)" } }
      ]
    }
  ]
}
```

The example above is exercised by a test end to end: it validates against
the schema, its `baseHash` matches the semantic hash of the minimal project
below, and the hunk applies cleanly to it, leaving the title changed.

```json
{
  "format": "rpgkit-project/v1",
  "title": "Proposal Demo",
  "tileSize": 16,
  "start": { "map": "yard", "x": 0, "y": 0, "dir": "down" },
  "sheets": [{ "id": "town", "cols": 12, "rows": 11, "pak": "chunks" }],
  "items": [],
  "maps": [{ "id": "yard", "name": "Yard", "width": 1, "height": 1, "sheets": ["town"], "ground": ["town.0"], "events": [] }]
}
```

Contract:

- **Required fields** (no `format` field; `additionalProperties` is false):
  `id` (`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`), `title` (1–160 chars),
  `rationale` (1–4000), `author` (1–160), `createdAt` (UTC ISO-8601 with
  `Z`), `baseHash` (64 lowercase hex), and `hunks` (at least one).
- **Hunks** need `id`, `summary` (1–240) and at least one `change`; a hunk
  may carry a `decision` while under review.
- **Changes** are `{ path, before, after }`. `path` is a JSON Pointer
  (root `""` or leading `/`); `before`/`after` are sides
  (`{ "exists": false }` or `{ "exists": true, "value": <any JSON> }`).
  Beyond the schema, the implementation requires unique hunk ids, canonical
  decimal array tokens, and non-overlapping change paths across hunks.
- **Applying** (`applyProposalHunks`): every selected hunk must assess
  `clean` (each change's `before` matches the project), then the changes
  apply through the proposal module's own `setSide` and the result is
  schema-validated as one transaction. `setSide` permits adding, replacing
  or deleting an **object property**, and replacing an **existing array
  index**; it refuses array appends (`/-`), array element deletes, and
  removing the document root. To grow an array, replace the whole array at
  its parent path.
- **`baseHash`** is the SHA-256 of the project's canonical semantic JSON
  (`proposalSemanticHash`). A mismatch means the proposal is stale; the
  editor shows live conflict state per hunk (`clean` / `conflict` /
  `already-applied` / `partially-applied`).
- **Decisions** are `{ "status": "accepted" | "rejected", "decidedAt":
  <UTC ISO-8601> }`, omitted while a hunk waits for review. Review
  persistence may only add decisions, never rewrite the proposal payload.
  Accepting/rejecting happens in the desktop editor; the CLI offers
  `propose`, `list-proposals`, `show-proposal` and `withdraw-proposal`.

## 5. Preview protocol — `rpgkit-preview/v1`

**Normative: this section.** A web frontend embeds the real engine in an
iframe and drives it with `postMessage`. The kit ships a host app (the
`preview` player page, `tools/preview/`) and a reference frontend
(`/preview-demo.html` on the site, source
[`../tools/web/preview-demo.html`](../tools/web/preview-demo.html)). The
host plays an arbitrary `rpgkit-project/v1` document through the production
`GameView` with the editor playtest art, so no game bundle or baked pak is
needed.

### Transport

- Every request is a `postMessage` JSON object. The host only accepts
  messages from origins it is configured for: its own origin always, plus
  any `?preview-origin=<origin>` query parameters on the host page URL
  (repeatable, comma-separated). Messages from other origins are dropped
  without a reply. The opaque `null` origin is never allowed.
- Replies target `event.origin`; the host never uses `*` for replies.
- A frontend must accept replies and the `ready` event only from the iframe
  window it embedded (`event.source === hostFrame.contentWindow`), in
  addition to checking `event.origin`. A message from any other window —
  even same-origin — is a spoof and is ignored. The reference frontend
  does both checks.

### Limits

Every host enforces these bounds before doing expensive work
(stringify, validation, traversal). The constants live in
`tools/preview/protocol.ts` (`PREVIEW_LIMITS`); an over-budget message is
refused with `error.code: "too-large"` and never reaches the backend.

| Bound | Value | What is counted |
| --- | --- | --- |
| Whole message | 4 MiB | Structural JSON size: string UTF-8 bytes, 8 per number, 4 per boolean/null, plus container overhead. The check walks only until the budget is exceeded, so an oversized message costs work proportional to the budget, not to the message. |
| Chapters per `load` | 64 | `chapters.length` |
| One chapter snapshot | 1 MiB | Save-code string bytes, or the structural size of a snapshot object |
| One chapter tape | 36,000 frames | `tape.length` (u16 masks) |
| `requestId` | 128 bytes | UTF-8 length |

String bytes follow the UTF-8 encoding of the wire string itself: a lone
surrogate counts as the 3-byte U+FFFD (exactly what `TextEncoder` produces),
and a high/low surrogate pair counts as one 4-byte scalar. The walk stops the
moment the running total exceeds the budget, so an oversized string costs
work proportional to the budget, not to the string.

### Messages

All requests carry `protocol: "rpgkit-preview/v1"`. `load`, `start` and
`state` require a `requestId` string; `input` and `stop` may omit it (no
reply is sent then). A `requestId` that is present but not a non-empty
bounded string (a number, an object, an empty string, or over 128 bytes)
refuses the whole message: it is never demoted to a fire-and-forget
notification, and it gets no reply (there is no valid correlation key).

| Request | Fields | Reply `result` |
| --- | --- | --- |
| `load` | `document`: project JSON text or object; optional `chapters`: `[{id, title, snapshot, tape?}]` (save snapshot/code + u16 tape, for `start` by chapter) | `{title, maps: [{id, name, width, height}], start: {map, x, y, dir}}` |
| `start` | `map` + `x` + `y` + optional `dir` (`down`/`left`/`up`/`right`), **or** `chapter` (a chapter id supplied with `load`) | `{map, x, y, dir}` after the warp/restore |
| `state` | — | `{status, map, x, y, px, py, dir, moving, switches, variables, gold, items}` |
| `input` | `buttons`: u16 mask; optional `frames` (1–600, default 1) | empty ok |
| `stop` | — | empty ok; unmounts the project |

Reply envelope: `{protocol, type: "reply", requestId, ok: true, result}` or
`{..., ok: false, error: {code, message}}`. The host also sends one
unsolicited event on boot: `{protocol, type: "event", event: "ready",
version: 1}` (to `window.parent`, target `*`).

`load` validates the document through the editor's schema gate; a JSON or
schema failure is refused with `error.code: "bad-document"` and the first
error. Sharded (`mapIndex`) documents are refused. `start` to a tile uses
the demo runtime's validated warp (the cell must be in bounds, standable and
free of authored events). A chapter start restores the snapshot and, when
the chapter carries a tape, plays it from the snapshot's frame zero.
`input` holds the mask for `frames` host frames then releases, through the
attract controller's tape path, so edges arise exactly as from live input.

A notification (`input`/`stop` without `requestId`) has no reply channel:
the host runs it inside the same error boundary as replies, so a backend
error stays contained and never reaches the browser's event loop. The
notification contract is silent failure.

Error codes: `bad-message`, `bad-version`, `not-loaded` (before `load` or
after `stop`), `bad-document`, `unknown-map`, `bad-start`,
`unknown-chapter`, `bad-input`, `too-large` (a wire limit from the table
above), `internal`.

The same operations are available on the host page as
`globalThis.__rpgkitPreview` for same-origin drivers and tests. The pure
protocol core (allowlist, parsing, dispatch, byte budget) is
`tools/preview/protocol.ts`, unit-tested in
`tests/preview-protocol.test.ts`; the end-to-end browser path — including
the limit boundary, requestId refusal, notification containment and
same-origin spoof rejection — is `tools/web-verify.ts` (the `preview`
check).

## 6. Version and compatibility rules

- **`rpgkit-project/v1`.** The schema is the contract; every change is
  recorded in `src/data/CHANGELOG.md` and, if normative, changes
  `MAP_SCHEMA_HASH`. The format string stays `v1` for amendments — new
  optional fields, new commands or conditions, and loosened constraints.
  The v1 history also contains a small number of **semantic changes** that
  were folded in as amendments with explicit migration notes, including:
  `dirBlock` edges became bidirectional (a one-way exit now needs a
  `passage` override); moving characters are stopped only by `blocks: true`
  pages; `variable` division floors toward negative infinity and
  div/mod-by-zero leaves the variable unchanged; transfer failures enter
  the fatal content-error state instead of throwing from the host; and save
  validation requires safe integers. A document that relied on the old
  behavior follows the changelog note. A genuinely breaking change — one
  that cannot be absorbed as an amendment — gets a new marker
  (`rpgkit-project/v2`) and a new changelog entry. Frontends detect
  compatibility from the `format` field, and sharded projects additionally
  from `mapSchemaHash` against the host's `MAP_SCHEMA_HASH`.
- **`rpgkit-save/v1`.** The envelope carries `format` and `version`; a
  mismatch is a typed rejection, never a silent migration. The public
  `SaveErrorCode` values are `bad-json` (empty, malformed or non-UTF-8 save
  data), `format` (not an `rpgkit-save/v1` envelope), `version` (envelope
  version this build cannot load), `checksum` (FNV mismatch), `content`
  (sharded-project identity mismatch) and `shape` (envelope or state fails
  validation). Old saves that omit newer optional fields keep their
  defaults.
- **`rpgkit-edit/patch-v1`.** The patch format is versioned in its `format`
  field. `beforeHash`/`afterHash` fail closed, so a patch can neither probe
  nor apply against a changed base.
- **`rpgkit-preview/v1`.** The protocol string travels on every message and
  the host announces itself with a `ready` event. Additive changes — new
  optional request fields, new message types, new error codes — stay v1; a
  frontend ignores what it does not know. Changing the meaning or shape of
  an existing message, or removing one, bumps the protocol to `v2`, and a
  host replies `bad-version` to a protocol it does not speak. Frontends
  should wait for `ready`, then gate features on the announced protocol and
  version.
