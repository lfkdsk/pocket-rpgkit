#!/bin/bash
# Build and measure a 100x100 map in the real PocketJS desktop QuickJS guest.
# Each case warms for 120 frames and records at least 600 subsequent frames,
# separating guest and native-surface costs. Two fresh passes expose noise.
# EDITOR_LARGE_BENCH_DIST=<dir with editor.js + editor.pak> measures a
# prebuilt bundle instead (for example a baseline build) and skips the build.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="${EDITOR_LARGE_BENCH_ROOT:-$root/dist/editor-large-quickjs-bench}"
vendor="$root/vendor/pocketjs"
host=""

dist="${EDITOR_LARGE_BENCH_DIST:-$root/dist}"
if [ -z "${EDITOR_LARGE_BENCH_DIST:-}" ]; then
  bun run --cwd "$root" build:editor >/dev/null
fi
mkdir -p "$scratch"
host="$(mktemp -d "$scratch/host.XXXXXX")"
cleanup() {
  if [ -n "$host" ] && [ -d "$host" ]; then rm -rf "$host"; fi
}
trap cleanup EXIT

cp -r "$vendor/hosts/desktop/src" "$host/src"
cp "$vendor/hosts/desktop/Cargo.toml" "$host/Cargo.toml"
if [ -f "$vendor/hosts/desktop/Cargo.lock" ]; then
  cp "$vendor/hosts/desktop/Cargo.lock" "$host/Cargo.lock"
fi
sed -i -E "s#path = \"\.\./\.\./([^\"]+)\"#path = \"$vendor/\1\"#g" "$host/Cargo.toml"
cp "$root/tools/editor-large-quickjs-bench.rs" "$host/src/editor_large_quickjs_bench.rs"
printf '\ninclude!("editor_large_quickjs_bench.rs");\n' >> "$host/src/main.rs"

target="$scratch/target"
CARGO_TARGET_DIR="$target" cargo test --no-default-features --release --no-run --manifest-path "$host/Cargo.toml" >/dev/null
bin="$(find "$target/release/deps" -maxdepth 1 -type f -name 'pocket_desktop_host-*' ! -name '*.d' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
if [ -z "$bin" ]; then
  echo "editor-large-quickjs-bench: desktop host test binary was not produced" >&2
  exit 1
fi

for pass in a b; do
  EDITOR_LARGE_BENCH_SCRATCH="$scratch/runs" \
    EDITOR_LARGE_BENCH_PASS="$pass" \
    POCKETJS_DIST="$dist" \
    "$bin" editor_large_quickjs_bench::large_editor_interactions --ignored --exact --nocapture \
      2>&1 | grep -E '^(EDITOR_LARGE_QJS|test result)'
done
