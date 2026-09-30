#!/bin/bash
# tools/kb4-quickjs-bench.sh — run tools/kb4-quickjs-bench.rs against the
# real PocketJS desktop host's QuickJS runtime: the shipped structural-op
# zero-churn claim has to hold on the engine the desktop host actually
# runs, not just Bun/JSC's sim renderer.
#
# Builds a scratch copy of vendor/pocketjs/hosts/desktop outside the checkout
# (KB4_BENCH_ROOT, default under ~/.cache), rewrites its path dependencies
# to this checkout's own vendor/pocketjs, drops in kb4-quickjs-bench.rs as
# an `include!`, and runs it release-mode against dist/kb4-battle.{js,pak}.
# Nothing under vendor/ or in this repo's own Cargo state changes.
#
#   bun run build:example kb4-battle   # first: produces dist/kb4-battle.{js,pak}
#   tools/kb4-quickjs-bench.sh
#
# Needs a Rust toolchain (cargo/rustc) on PATH.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dist="${1:-$root/dist}"
vendor="$root/vendor/pocketjs"
scratch="${KB4_BENCH_ROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/pocket-rpgkit-bench/kb4-quickjs}"
scratch_bench="$scratch/host-bench"
target_dir="$scratch/target"

if [ ! -f "$dist/kb4-battle.js" ] || [ ! -f "$dist/kb4-battle.pak" ]; then
  echo "kb4-quickjs-bench: missing $dist/kb4-battle.{js,pak} — run \`bun run build:example kb4-battle\` first" >&2
  exit 1
fi

rm -rf "$scratch_bench"
mkdir -p "$scratch_bench"
cp -r "$vendor/hosts/desktop/src" "$scratch_bench/src"
cp "$vendor/hosts/desktop/Cargo.toml" "$scratch_bench/Cargo.toml"
[ -f "$vendor/hosts/desktop/Cargo.lock" ] && cp "$vendor/hosts/desktop/Cargo.lock" "$scratch_bench/Cargo.lock"

# The desktop host's Cargo.toml path-deps are relative ("../../engine/...");
# rewrite them to absolute paths into THIS checkout's vendor/pocketjs so the
# scratch copy (living outside vendor/) still resolves its sibling crates.
python3 - "$scratch_bench/Cargo.toml" "$vendor" <<'PYEOF'
import re
import sys
path, vendor = sys.argv[1], sys.argv[2]
text = open(path).read()
text = re.sub(
    r'path = "(\.\./\.\./[^"]+)"',
    lambda m: f'path = "{vendor}' + m.group(1).replace("../..", "", 1) + '"',
    text,
)
open(path, "w").write(text)
PYEOF

cp "$root/tools/kb4-quickjs-bench.rs" "$scratch_bench/src/kb4_quickjs_bench.rs"
if ! grep -q 'include!("kb4_quickjs_bench.rs");' "$scratch_bench/src/main.rs"; then
  echo 'include!("kb4_quickjs_bench.rs");' >> "$scratch_bench/src/main.rs"
fi

cd "$scratch_bench"
CARGO_TARGET_DIR="$target_dir" cargo test --release --no-run 2>&1 | grep -E "^error" && exit 1
bin=$(ls -t "$target_dir"/release/deps/pocket_desktop_host-* 2>/dev/null | grep -v '\.d$' | head -1)
if [ -z "$bin" ]; then
  echo "kb4-quickjs-bench: build produced no test binary" >&2
  exit 1
fi

KB4_BENCH_SCRATCH="$scratch/runs" POCKETJS_DIST="$dist" "$bin" kb4_quickjs_bench::battle_frame_and_node_churn --ignored --exact --nocapture \
  2>&1 | grep -E "^(KB4_QJS|KB4_CHURN|test result)"
