#!/usr/bin/env bash
# Compare canonical JSON with rpgkit-map/1 parsing and first repository access
# inside PocketJS's shipping desktop QuickJS guest.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
scratch=${SLIM_MAP_QJS_ROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/pocket-rpgkit-bench/slim-map-quickjs}
host="$scratch/host"
target="$scratch/target"
bundle="$scratch/slim-map-quickjs-entry.js"

mkdir -p "$scratch"
bun build "$root/tools/slim-map-quickjs-entry.ts" \
  --target=browser --format=iife --minify --outfile="$bundle" >/dev/null

rm -rf "$host"
mkdir -p "$host"
cp -a "$root/vendor/pocketjs/hosts/desktop/." "$host/"
cp "$root/tools/slim-map-quickjs-bench.rs" "$host/src/slim-map-quickjs-bench.rs"
sed -i "s#path = \"../../engine#path = \"$root/vendor/pocketjs/engine#g" "$host/Cargo.toml"
sed -i '$a include!("slim-map-quickjs-bench.rs");' "$host/src/main.rs"

CARGO_TARGET_DIR="$target" cargo test \
  --manifest-path "$host/Cargo.toml" --release --locked --no-run >/dev/null
binary=$(find "$target/release/deps" -maxdepth 1 -type f \
  -name 'pocket_desktop_host-*' -perm -111 -printf '%T@ %p\n' \
  | sort -nr | head -1 | cut -d' ' -f2-)
test -n "$binary"

SLIM_MAP_QJS_JS="$bundle" \
  SLIM_MAP_QJS_ITERS="${SLIM_MAP_QJS_ITERS:-30}" \
  SLIM_MAP_QJS_ROUNDS="${SLIM_MAP_QJS_ROUNDS:-9}" \
  "$binary" slim_map_quickjs_bench::first_visit --ignored --exact --nocapture 2>&1 \
  | grep -E '^(SLIM_MAP_QJS|test result)'
