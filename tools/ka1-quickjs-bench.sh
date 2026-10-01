#!/bin/bash
# Measure KA1's per-frame reducer cost for live map animations inside the
# current pinned PocketJS desktop host's QuickJS guest. The workload
# (tools/ka1-quickjs-entry.ts) runs stepSession with 0 vs 50 live looping
# mapAnim instances (isomorphic fibers) plus a UI hot-loop micro-benchmark;
# the reducer delta isolates the anims count (COW makes it ~0) and the UI
# delta is the per-instance QuickJS JS cost. Scratch lives under
# the user cache by default, never a hard-coded machine path.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="${KA1_QJS_SCRATCH:-${XDG_CACHE_HOME:-$HOME/.cache}/pocket-rpgkit-bench/ka1-quickjs}"
host="$scratch/host"
target="$scratch/target"

mkdir -p "$scratch"
bun build "$root/tools/ka1-quickjs-entry.ts" --target=browser --format=iife --minify --outfile="$scratch/ka1.js" >/dev/null

rm -rf "$host"
mkdir -p "$host"
cp -r "$root/vendor/pocketjs/hosts/desktop/src" "$host/src"
cp "$root/vendor/pocketjs/hosts/desktop/Cargo.toml" "$host/Cargo.toml"
if [ -f "$root/vendor/pocketjs/hosts/desktop/Cargo.lock" ]; then
  cp "$root/vendor/pocketjs/hosts/desktop/Cargo.lock" "$host/Cargo.lock"
fi
sed -i -E "s#path = \"\.\./\.\./([^\"]+)\"#path = \"$root/vendor/pocketjs/\1\"#g" "$host/Cargo.toml"
cp "$root/tools/ka1-quickjs-bench.rs" "$host/src/ka1_quickjs_bench.rs"
echo 'include!("ka1_quickjs_bench.rs");' >> "$host/src/main.rs"

CARGO_TARGET_DIR="$target" cargo test --no-default-features --release --no-run --manifest-path "$host/Cargo.toml" >/dev/null
bin="$(find "$target/release/deps" -maxdepth 1 -type f -name 'pocket_desktop_host-*' ! -name '*.d' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
if [ -z "$bin" ]; then
  echo "ka1-quickjs-bench: desktop host test binary was not produced" >&2
  exit 1
fi

for name in reducer0 reducer50 ui0 ui50; do
  PR1_BENCH_JS="$scratch/ka1.js" PR1_BENCH_LABEL="${KA1_BENCH_LABEL:-$name}" \
    PR1_BENCH_CASE="$name" "$bin" \
    pr1_quickjs_bench::tick_fold --ignored --exact --nocapture 2>&1 \
    | grep -Eo '(PR1_QJS|test result).*'
done
