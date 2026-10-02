#!/bin/bash
# Run the connected-world fixture in the desktop host's real QuickJS runtime.
# The paired Rust test measures Guest::frame + UiSurface::tick, verifies the
# warmed shared pools stay structurally stable, and reports residency at both
# supported viewport sizes.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dist="${1:-$root/dist}"
vendor="$root/vendor/pocketjs"
scratch="${WORLD_STREAM_BENCH_ROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/pocket-rpgkit-bench/world-streamed-quickjs}"
scratch_bench="$scratch/host-bench"
target_dir="$scratch/target"

if [ ! -f "$dist/world-streamed.js" ] || [ ! -f "$dist/world-streamed.pak" ]; then
  echo "world-streamed-quickjs-bench: missing $dist/world-streamed.{js,pak} -- run 'bun run build:example world-streamed' first" >&2
  exit 1
fi

if [ -z "$scratch_bench" ] || [ "$scratch_bench" = "/" ]; then
  echo "world-streamed-quickjs-bench: refusing unsafe scratch path" >&2
  exit 1
fi
rm -rf "$scratch_bench"
mkdir -p "$scratch_bench"
cp -r "$vendor/hosts/desktop/src" "$scratch_bench/src"
cp "$vendor/hosts/desktop/Cargo.toml" "$scratch_bench/Cargo.toml"
[ -f "$vendor/hosts/desktop/Cargo.lock" ] && cp "$vendor/hosts/desktop/Cargo.lock" "$scratch_bench/Cargo.lock"

# The copied desktop manifest uses paths relative to its original directory.
python3 - "$scratch_bench/Cargo.toml" "$vendor" <<'PYEOF'
import re
import sys

path, vendor = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as source:
    text = source.read()
text = re.sub(
    r'path = "(\.\./\.\./[^"]+)"',
    lambda match: f'path = "{vendor}' + match.group(1).replace("../..", "", 1) + '"',
    text,
)
with open(path, "w", encoding="utf-8") as output:
    output.write(text)
PYEOF

cp "$root/tools/world-streamed-quickjs-bench.rs" "$scratch_bench/src/world_streamed_quickjs_bench.rs"
if ! grep -q 'include!("world_streamed_quickjs_bench.rs");' "$scratch_bench/src/main.rs"; then
  echo 'include!("world_streamed_quickjs_bench.rs");' >> "$scratch_bench/src/main.rs"
fi

cd "$scratch_bench"
CARGO_TARGET_DIR="$target_dir" cargo test --no-default-features --release --no-run 2>&1 | grep -E "^error" && exit 1
bin=$(find "$target_dir/release/deps" -maxdepth 1 -type f -name 'pocket_desktop_host-*' ! -name '*.d' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)
if [ -z "$bin" ]; then
  echo "world-streamed-quickjs-bench: build produced no test binary" >&2
  exit 1
fi

WORLD_STREAM_BENCH_SCRATCH="$scratch/runs" POCKETJS_DIST="$dist" \
  "$bin" world_streamed_quickjs_bench::connected_world_frame_and_pool_stability \
  --ignored --exact --nocapture 2>&1 | grep -E "(WORLD_STREAM_QJS|WORLD_STREAM_RESIDENCY|test result)"
