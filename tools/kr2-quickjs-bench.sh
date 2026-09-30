#!/usr/bin/env bash
# Bundle the deterministic rewind workload and execute it in PocketJS's real
# desktop QuickJS guest. Scratch data defaults outside the repository.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
bench_root=${KR2_BENCH_ROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/pocket-rpgkit-bench/kr2-quickjs}
host="$bench_root/host"
target="$bench_root/target"
bundle="$bench_root/kr2-quickjs-entry.js"

mkdir -p "$bench_root"
bun build "$root/tools/kr2-quickjs-entry.ts" \
  --target=browser --format=iife --minify --outfile="$bundle" >/dev/null

rm -rf "$host"
mkdir -p "$host"
cp -a "$root/vendor/pocketjs/hosts/desktop/." "$host/"
cp "$root/tools/kr2-quickjs-bench.rs" "$host/src/kr2-quickjs-bench.rs"
sed -i "s#path = \"../../engine#path = \"$root/vendor/pocketjs/engine#g" "$host/Cargo.toml"
sed -i '$a include!("kr2-quickjs-bench.rs");' "$host/src/main.rs"

CARGO_TARGET_DIR="$target" cargo test \
  --manifest-path "$host/Cargo.toml" --release --no-run >/dev/null
binary=$(find "$target/release/deps" -maxdepth 1 -type f \
  -name 'pocket_desktop_host-*' -perm -111 -printf '%T@ %p\n' \
  | sort -nr | head -1 | cut -d' ' -f2-)
test -n "$binary"

KR2_BENCH_JS="$bundle" KR2_BENCH_ROUNDS="${KR2_BENCH_ROUNDS:-7}" \
  "$binary" kr2_quickjs_bench::rewind_keyframes --ignored --exact --nocapture 2>&1 \
  | grep -E '^(KR2_QJS|test result)'
