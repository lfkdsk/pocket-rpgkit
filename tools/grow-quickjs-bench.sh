#!/usr/bin/env bash
# grow-quickjs-bench.sh — time the grow demo's simulation (examples/grow/grow.ts
# and grow-timeline.ts) inside PocketJS's shipping desktop QuickJS guest. The
# desktop host runs guests on QuickJS, roughly 10x slower than Bun/JSC, so this
# is where grow's per-frame budget has to hold.
#
# Usage:
#   tools/grow-quickjs-bench.sh [ROOT] [--rounds N] [--interleave BASE_ROOT]
#
#   ROOT          checkout whose examples/grow/ is measured (default: this
#                 repository). Labelled "branch".
#   --rounds N    rounds to run (default 3, or GROW_QJS_ROUNDS). The summary
#                 prints the median of every field across all samples.
#   --interleave BASE_ROOT
#                 also measure BASE_ROOT (labelled "base"), e.g. a worktree of
#                 main:  git worktree add --detach ../base main
#                 Each round runs base -> branch -> branch -> base so drift
#                 (thermal, other load) cannot consistently favour one side;
#                 every label gets 2 samples per round, and the summary adds a
#                 per-field base/branch delta.
#
# Every measured parameter set is one of STAMP_PARAMS / DEFAULT_PARAMS that the
# checkout's grow.ts exports. Measurements (one process per sample, each a
# fresh QuickJS runtime; times in ms):
#   fold      createGrow + stepGrowTick until done: total, mean/p95/max per tick
#   timeline  new GrowTimeline + prefillTo in 8-tick slices: total, max slice
#   seek      at(total) from 0, at(0), at(total/2), 20 LCG ticks: each, max/mean
#   heap      QuickJS JS_ComputeMemoryUsage after a full GC, bytes retained
#             above baseline by the done state / the materialized timeline
#
# Output: raw rows `GROW_QJS {json}` (also kept in $scratch/rows.log), then
# `GROW_QJS_MEDIAN {json}` per label/params/kind and, with --interleave,
# `GROW_QJS_DELTA` lines.
#
# Only the bundle comes from ROOT / BASE_ROOT; the QuickJS host is always
# built from this repository's vendor/pocketjs (a fresh worktree needs no
# submodule checkout and no node_modules: grow only imports relative files).
#
# Environment:
#   GROW_QJS_SCRATCH=DIR  bundles, host copy, rows (default
#                         ~/.cache/pocket-rpgkit-bench/grow-quickjs)
#   GROW_QJS_TARGET=DIR   cargo target dir (default $GROW_QJS_SCRATCH/target).
#                         The first build compiles wgpu and friends: minutes.
#   GROW_QJS_CPU=N        pin every timed process to CPU N with taskset(1).
set -euo pipefail

tools_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
root="$tools_root"
base_root=""
rounds="${GROW_QJS_ROUNDS:-3}"
while [ $# -gt 0 ]; do
  case "$1" in
    --rounds) rounds="$2"; shift 2 ;;
    --rounds=*) rounds="${1#*=}"; shift ;;
    --interleave) base_root="$2"; shift 2 ;;
    --interleave=*) base_root="${1#*=}"; shift ;;
    -h|--help) sed -n '2,45p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) echo "grow-quickjs-bench: unknown option $1" >&2; exit 2 ;;
    *) root="$1"; shift ;;
  esac
done
case "$rounds" in ''|*[!0-9]*|0) echo "grow-quickjs-bench: --rounds must be a positive integer" >&2; exit 2 ;; esac
root=$(cd "$root" && pwd)
if [ -n "$base_root" ]; then base_root=$(cd "$base_root" && pwd); fi

if ! command -v cargo >/dev/null 2>&1 && [ -x "$HOME/.cargo/bin/cargo" ]; then
  PATH="$HOME/.cargo/bin:$PATH"
fi

scratch=${GROW_QJS_SCRATCH:-${XDG_CACHE_HOME:-$HOME/.cache}/pocket-rpgkit-bench/grow-quickjs}
target=${GROW_QJS_TARGET:-$scratch/target}
host="$scratch/host"
rows="$scratch/rows.log"
mkdir -p "$scratch"
: > "$rows"

bundle() { # bundle LABEL CHECKOUT -> $scratch/grow-LABEL.js
  local label=$1 checkout=$2
  for file in grow.ts grow-timeline.ts; do
    if [ ! -f "$checkout/examples/grow/$file" ]; then
      echo "grow-quickjs-bench: $checkout/examples/grow/$file not found" >&2; exit 1
    fi
  done
  sed "s#\"\.\./examples/grow/#\"$checkout/examples/grow/#g" \
    "$tools_root/tools/grow-quickjs-entry.ts" > "$scratch/entry-$label.ts"
  bun build "$scratch/entry-$label.ts" \
    --target=browser --format=iife --minify --outfile="$scratch/grow-$label.js" >/dev/null
  echo "# $label: $checkout @ $(git -C "$checkout" rev-parse --short HEAD 2>/dev/null || echo '?')$(
    git -C "$checkout" diff --quiet HEAD -- examples/grow 2>/dev/null || echo ' (+uncommitted examples/grow changes)')"
}

bundle branch "$root"
if [ -n "$base_root" ]; then bundle base "$base_root"; fi

rm -rf "$host"
mkdir -p "$host"
cp -a "$tools_root/vendor/pocketjs/hosts/desktop/." "$host/"
cp "$tools_root/tools/grow-quickjs-bench.rs" "$host/src/grow-quickjs-bench.rs"
sed -i "s#path = \"../../engine#path = \"$tools_root/vendor/pocketjs/engine#g" "$host/Cargo.toml"
sed -i '$a include!("grow-quickjs-bench.rs");' "$host/src/main.rs"

CARGO_TARGET_DIR="$target" cargo test --quiet --no-default-features \
  --manifest-path "$host/Cargo.toml" --release --no-run >/dev/null
binary=$(find "$target/release/deps" -maxdepth 1 -type f \
  -name 'pocket_desktop_host-*' -perm -111 -printf '%T@ %p\n' \
  | sort -nr | head -1 | cut -d' ' -f2-)
test -n "$binary"

pin=()
if [ -n "${GROW_QJS_CPU:-}" ]; then pin=(taskset -c "$GROW_QJS_CPU"); fi

run() { # run LABEL
  local label=$1 log="$scratch/run.log"
  if ! GROW_QJS_JS="$scratch/grow-$label.js" GROW_QJS_LABEL="$label" \
    "${pin[@]}" "$binary" grow_quickjs_bench::grow --ignored --exact --nocapture > "$log" 2>&1; then
    tail -n 40 "$log" >&2
    echo "grow-quickjs-bench: $label sample failed" >&2
    exit 1
  fi
  # libtest may glue the first row onto its `test ...` line: match unanchored.
  grep -Eo 'GROW_QJS \{.*' "$log" | tee -a "$rows"
}

for ((round = 1; round <= rounds; round++)); do
  echo "# round $round/$rounds $(uptime | sed 's/.*load/load/')"
  if [ -n "$base_root" ]; then
    run base; run branch; run branch; run base
  else
    run branch
  fi
done

GROW_QJS_ROWS="$rows" bun -e '
const rows = (await Bun.file(process.env.GROW_QJS_ROWS).text()).trim().split("\n")
  .map((line) => JSON.parse(line.slice("GROW_QJS ".length)));
const groups = new Map();
for (const row of rows) {
  const key = `${row.label}\u0000${row.name}\u0000${row.kind}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const medians = new Map();
for (const [key, list] of groups) {
  const out = { label: list[0].label, name: list[0].name, kind: list[0].kind, samples: list.length };
  for (const field of Object.keys(list[0])) {
    if (typeof list[0][field] === "number") out[field] = Math.round(median(list.map((r) => r[field])) * 10000) / 10000;
  }
  medians.set(key, out);
  console.log(`GROW_QJS_MEDIAN ${JSON.stringify(out)}`);
}
for (const [key, branch] of medians) {
  if (branch.label !== "branch") continue;
  const base = medians.get(key.replace(/^branch/, "base"));
  if (!base) continue;
  for (const field of Object.keys(branch)) {
    if (typeof branch[field] !== "number" || field === "samples" || field === "slice_ticks" || field === "random_seeks" || !(field in base)) continue;
    const delta = base[field] === 0 ? "n/a" : `${((branch[field] / base[field] - 1) * 100).toFixed(1)}%`;
    console.log(`GROW_QJS_DELTA ${branch.name} ${branch.kind} ${field} base=${base[field]} branch=${branch[field]} delta=${delta}`);
  }
}
'
