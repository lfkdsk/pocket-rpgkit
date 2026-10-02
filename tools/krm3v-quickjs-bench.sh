#!/bin/bash
# Run the imported RPG Maker visual fixture in the real desktop QuickJS host
# and report worst visual-feature frame times at the two supported viewports.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dist="${1:-$root/dist}"
vendor="$root/vendor/pocketjs"
scratch="${KRM3V_BENCH_ROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/pocket-rpgkit-bench/krm3v-quickjs}"
scratch_bench="$scratch/host-bench"
target_dir="$scratch/target"

if [ ! -f "$dist/rmi-play.js" ] || [ ! -f "$dist/rmi-play.pak" ]; then
  echo "krm3v-quickjs-bench: missing $dist/rmi-play.{js,pak}; run 'bun run build:example rmi-play' first" >&2
  exit 1
fi

rm -rf "$scratch_bench"
mkdir -p "$scratch_bench"
cp -r "$vendor/hosts/desktop/src" "$scratch_bench/src"
cp "$vendor/hosts/desktop/Cargo.toml" "$scratch_bench/Cargo.toml"
[ -f "$vendor/hosts/desktop/Cargo.lock" ] && cp "$vendor/hosts/desktop/Cargo.lock" "$scratch_bench/Cargo.lock"

python3 - "$scratch_bench/Cargo.toml" "$vendor" <<'PYEOF'
import re
import sys

path, vendor = sys.argv[1], sys.argv[2]
text = open(path).read()
text = re.sub(
    r'path = "(\.\./\.\./[^"]+)"',
    lambda match: f'path = "{vendor}' + match.group(1).replace("../..", "", 1) + '"',
    text,
)
open(path, "w").write(text)
PYEOF

cp "$root/tools/krm3v-quickjs-bench.rs" "$scratch_bench/src/krm3v_quickjs_bench.rs"
if ! grep -q 'include!("krm3v_quickjs_bench.rs");' "$scratch_bench/src/main.rs"; then
  echo 'include!("krm3v_quickjs_bench.rs");' >> "$scratch_bench/src/main.rs"
fi

cd "$scratch_bench"
CARGO_TARGET_DIR="$target_dir" cargo test --no-default-features --release --no-run 2>&1 | grep -E "^error" && exit 1
bin=$(find "$target_dir/release/deps" -maxdepth 1 -type f -name 'pocket_desktop_host-*' ! -name '*.d' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)
if [ -z "$bin" ]; then
  echo "krm3v-quickjs-bench: build produced no test binary" >&2
  exit 1
fi

KRM3V_BENCH_SCRATCH="$scratch/runs" POCKETJS_DIST="$dist" \
  "$bin" krm3v_quickjs_bench::imported_visual_frames --ignored --exact --nocapture \
  2>&1 | grep -Eo "(KRM3V_QJS|test result).*"
