#!/bin/bash
# Time save-code encoding and decoding (compressed and plain) in PocketJS's
# shipping desktop QuickJS guest. KS2_BENCH_ENVELOPE=<file> adds one more
# input: a save envelope's JSON text, for example from a large game.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="${KS2_QJS_SCRATCH:-${XDG_CACHE_HOME:-$HOME/.cache}/pocket-rpgkit-bench/ks2-quickjs}"
host="$scratch/host"
target="${KS2_QJS_TARGET:-${XDG_CACHE_HOME:-$HOME/.cache}/pocket-rpgkit-bench/pr1-quickjs/target}"

mkdir -p "$scratch"
bun build "$root/tools/ks2-save-code-quickjs-entry.ts" --target=browser --format=iife --minify --outfile="$scratch/ks2.js" >/dev/null

rm -rf "$host"
mkdir -p "$host"
cp -r "$root/vendor/pocketjs/hosts/desktop/src" "$host/src"
cp "$root/vendor/pocketjs/hosts/desktop/Cargo.toml" "$host/Cargo.toml"
if [ -f "$root/vendor/pocketjs/hosts/desktop/Cargo.lock" ]; then
  cp "$root/vendor/pocketjs/hosts/desktop/Cargo.lock" "$host/Cargo.lock"
fi
sed -i -E "s#path = \"\.\./\.\./([^\"]+)\"#path = \"$root/vendor/pocketjs/\1\"#g" "$host/Cargo.toml"
cp "$root/tools/ks2-save-code-quickjs-bench.rs" "$host/src/ks2_save_code_quickjs_bench.rs"
echo 'include!("ks2_save_code_quickjs_bench.rs");' >> "$host/src/main.rs"

CARGO_TARGET_DIR="$target" cargo test --no-default-features --release --no-run --manifest-path "$host/Cargo.toml" >/dev/null
bin="$(find "$target/release/deps" -maxdepth 1 -type f -name 'pocket_desktop_host-*' ! -name '*.d' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
if [ -z "$bin" ]; then
  echo "ks2-save-code-quickjs-bench: desktop host test binary was not produced" >&2
  exit 1
fi

KS2_BENCH_JS="$scratch/ks2.js" \
  KS2_BENCH_ITERS="${KS2_BENCH_ITERS:-20}" \
  KS2_BENCH_ROUNDS="${KS2_BENCH_ROUNDS:-9}" \
  "$bin" ks2_save_code_quickjs_bench::save_codes --ignored --exact --nocapture 2>&1 \
  | grep -E 'KS2_QJS|test result'
