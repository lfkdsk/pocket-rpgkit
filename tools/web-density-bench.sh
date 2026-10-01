#!/bin/bash
# Reproducible 1x/2x browser-density cost measurement. Builds matching r2-ui
# artifacts, runs deterministic walking/transfer/battle updates in the real
# desktop-host QuickJS engine, then measures the web WASM incremental raster
# and framebuffer-copy paths. The 1/2/2/1 order reduces warm-machine bias.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="${WEB_DENSITY_BENCH_ROOT:-$root/dist/web-density-bench}"
vendor="$root/vendor/pocketjs"
entry="$root/tests/fixtures/r2-ui/r2-ui.tsx"
generator="$root/tests/fixtures/r2-ui/gen-assets.ts"
host=""

mkdir -p "$scratch"
bun "$generator"
for density in 1 2; do
  out="$scratch/density-$density"
  mkdir -p "$out"
  bun "$vendor/tools/build.ts" "$entry" \
    --project-root="$root" \
    --outdir="$out" \
    --density="$density"
done

for density in 1 2; do
  out="$scratch/density-$density"
  js_bytes="$(wc -c < "$out/r2-ui.js")"
  pak_bytes="$(wc -c < "$out/r2-ui.pak")"
  js_gzip="$(gzip -9 -c "$out/r2-ui.js" | wc -c)"
  pak_gzip="$(gzip -9 -c "$out/r2-ui.pak" | wc -c)"
  echo "WEBTXT_SIZE density=$density js=$js_bytes pak=$pak_bytes total=$((js_bytes + pak_bytes)) js_gzip=$js_gzip pak_gzip=$pak_gzip gzip_total=$((js_gzip + pak_gzip))"
done

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
cp "$root/tools/web-density-quickjs-bench.rs" "$host/src/web_density_quickjs_bench.rs"
printf '\ninclude!("web_density_quickjs_bench.rs");\n' >> "$host/src/main.rs"

target="$scratch/target"
CARGO_TARGET_DIR="$target" cargo test --release --no-run --manifest-path "$host/Cargo.toml" >/dev/null
bin="$(find "$target/release/deps" -maxdepth 1 -type f -name 'pocket_desktop_host-*' ! -name '*.d' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
if [ -z "$bin" ]; then
  echo "web-density-bench: desktop host test binary was not produced" >&2
  exit 1
fi

for item in 1:a 2:a 2:b 1:b; do
  density="${item%%:*}"
  pass="${item##*:}"
  WEB_DENSITY_BENCH_SCRATCH="$scratch/runs" \
    WEB_DENSITY="$density" \
    WEB_DENSITY_PASS="$pass" \
    POCKETJS_DIST="$scratch/density-$density" \
    "$bin" web_density_quickjs_bench::density_workloads --ignored --exact --nocapture \
      2>&1 | grep -E '^(WEBTXT_QJS|test result)'
done

bun "$root/tools/web-density-wasm-bench.ts" "$scratch"
