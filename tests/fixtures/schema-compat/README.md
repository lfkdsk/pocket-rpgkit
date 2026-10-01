# Schema compatibility fixtures

One directory per earlier schema identity, named `gen-<first 8 hex digits>`.
Each holds the sharded `project.json` and a mid-game `save.json` written by
the RPG Kit revision of that generation; `maps/` holds the map entries, which
are byte-identical in every generation. `tests/schema-compat.test.ts` opens
each shell and restores each save with the current runtime.

Regenerate one generation from the revision that produced it:

```sh
rev=<commit>            # last commit before the schema changed again
dir=$(mktemp -d)
git archive "$rev" src tools/lib | tar -x -C "$dir"
bun tests/fixtures/schema-compat/generate.ts "$dir" "$dir/out"
cp "$dir/out/project.json" "$dir/out/save.json" tests/fixtures/schema-compat/gen-<hash8>/
```

When a schema change is additive, add a fixture for the outgoing identity
(generate it from the commit before the change) together with its entry in
`MAP_SCHEMA_COMPATIBLE_HASHES` and the CHANGELOG table. When it is breaking,
the outgoing identity's fixture stays as a refused one, and it gets a
`witness.json`: a case in `witness.ts` that is valid under both schemas but
plays differently, recorded by the commit before the change.

```sh
bun tests/fixtures/schema-compat/witness.ts "$dir" <case>   # $dir as above
```

| Directory | Written by | Loads | Counterexample |
| --- | --- | --- | --- |
| `gen-0b9fff5b` | `d4353eef` | yes | |
| `gen-47cf3d8f` | `ee84c7b3` | no | `stale-parallel-battle`: a battle queued by a parallel page whose page went inactive still started |
| `gen-8ffba1d4` | `c93a1ec7` | no | |
| `gen-2d99dc69` | `df2d1c3e` | no | |
| `gen-cc709a6f` | `698094bd` | no | |
| `gen-37e18ded` | `60c9ea20` | no | |
| `gen-9553e885` | `7c81e5da` | no | |
| `gen-96239876` | `231d6a3f` | no | |
| `gen-0ff7c248` | `4bba234b` | no | |
| `gen-c27e2e51` | `fdc54ca0` | no | |
| `gen-462299c3` | `4e5d880d` | no | `variable-beyond-safe-integer`: `1e308` was stored and saved as is |
| `gen-c8ca2ce7` | `c2e55a03` | no | `transfer-to-unknown-map`: the transfer threw from the host |
| `gen-9570c570` | `08880fa4` | no | `route-through-marker`: a `blocks: false` marker stopped a walking event |

Every generation from `47cf3d8f` down is refused because compatibility
carries across generations and `0b9fff5b` changed how queued parallel
battles behave.
