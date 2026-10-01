#!/bin/bash
# Measure one 368-frame QOA credit refill in PocketJS's shipping desktop
# QuickJS guest. Control and streaming rounds alternate order to reduce drift.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="${QOA_QJS_SCRATCH:-${XDG_CACHE_HOME:-$HOME/.cache}/pocket-rpgkit-bench/qoa-quickjs}"
host="$scratch/host"
target="${QOA_QJS_TARGET:-${XDG_CACHE_HOME:-$HOME/.cache}/pocket-rpgkit-bench/pr1-quickjs/target}"

mkdir -p "$scratch"
bun build "$root/tools/qoa-quickjs-entry.ts" --target=browser --format=iife --minify --outfile="$scratch/qoa.js" >/dev/null

rm -rf "$host"
mkdir -p "$host"
cp -r "$root/vendor/pocketjs/hosts/desktop/src" "$host/src"
cp "$root/vendor/pocketjs/hosts/desktop/Cargo.toml" "$host/Cargo.toml"
if [ -f "$root/vendor/pocketjs/hosts/desktop/Cargo.lock" ]; then
  cp "$root/vendor/pocketjs/hosts/desktop/Cargo.lock" "$host/Cargo.lock"
fi
sed -i -E "s#path = \"\.\./\.\./([^\"]+)\"#path = \"$root/vendor/pocketjs/\1\"#g" "$host/Cargo.toml"
cp "$root/tools/qoa-quickjs-bench.rs" "$host/src/qoa_quickjs_bench.rs"
echo 'include!("qoa_quickjs_bench.rs");' >> "$host/src/main.rs"

CARGO_TARGET_DIR="$target" cargo test --no-default-features --release --no-run --manifest-path "$host/Cargo.toml" >/dev/null
bin="$(find "$target/release/deps" -maxdepth 1 -type f -name 'pocket_desktop_host-*' ! -name '*.d' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
if [ -z "$bin" ]; then
  echo "qoa-quickjs-bench: desktop host test binary was not produced" >&2
  exit 1
fi

QOA_BENCH_JS="$scratch/qoa.js" \
  QOA_BENCH_ITERS="${QOA_BENCH_ITERS:-2000}" \
  QOA_BENCH_ROUNDS="${QOA_BENCH_ROUNDS:-11}" \
  "$bin" qoa_quickjs_bench::stream_decode --ignored --exact --nocapture 2>&1 \
  | grep -E '^(QOA_QJS|test result)'
