#!/bin/bash
# tools/kb6-quickjs-bench.sh — run tools/kb6-quickjs-bench.rs against the
# real PocketJS desktop host's QuickJS runtime: battle entry/exit frame
# time, structural ops and the frame-profile segment timeline, on the
# engine the desktop host actually runs, not just Bun/JSC's sim renderer.
#
# Builds a scratch copy of vendor/pocketjs/hosts/desktop outside the checkout
# (KB6_BENCH_ROOT, default under ~/.cache), rewrites its path dependencies
# to this checkout's own vendor/pocketjs, drops in kb6-quickjs-bench.rs as
# an `include!`, and runs it release-mode against dist/r2-ui.{js,pak}.
# Nothing under vendor/ or in this repo's own Cargo state changes.
#
#   bun run build:example r2-ui   # first: produces dist/r2-ui.{js,pak}
#   tools/kb6-quickjs-bench.sh
#
# Needs a Rust toolchain (cargo/rustc) on PATH.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dist="${1:-$root/dist}"
vendor="$root/vendor/pocketjs"
scratch="${KB6_BENCH_ROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/pocket-rpgkit-bench/kb6-quickjs}"
scratch_bench="$scratch/host-bench"
target_dir="$scratch/target"

if [ ! -f "$dist/r2-ui.js" ] || [ ! -f "$dist/r2-ui.pak" ]; then
  echo "kb6-quickjs-bench: missing $dist/r2-ui.{js,pak} — run \`bun run build:example r2-ui\` first" >&2
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

cp "$root/tools/kb6-quickjs-bench.rs" "$scratch_bench/src/kb6_quickjs_bench.rs"
if ! grep -q 'include!("kb6_quickjs_bench.rs");' "$scratch_bench/src/main.rs"; then
  echo 'include!("kb6_quickjs_bench.rs");' >> "$scratch_bench/src/main.rs"
fi

cd "$scratch_bench"
CARGO_TARGET_DIR="$target_dir" cargo test --release --no-run 2>&1 | grep -E "^error" && exit 1
bin=$(ls -t "$target_dir"/release/deps/pocket_desktop_host-* 2>/dev/null | grep -v '\.d$' | head -1)
if [ -z "$bin" ]; then
  echo "kb6-quickjs-bench: build produced no test binary" >&2
  exit 1
fi

KB6_BENCH_SCRATCH="$scratch/runs" POCKETJS_DIST="$dist" "$bin" kb6_quickjs_bench::battle_entry_exit_frames --ignored --exact --nocapture \
  2>&1 | grep -E "^(KB6_X|KB6_S|test result)"
