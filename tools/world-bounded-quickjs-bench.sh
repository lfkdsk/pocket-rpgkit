#!/bin/bash
# Run the world-bounded fixture (W2 renderer + W3 cache driver) in the
# desktop host's real QuickJS runtime. The paired Rust test walks the player
# through all twelve maps and back, measures the worst guest frame time (boot, walks and prefetched map changes), and
# reports the residency counters.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dist="${1:-$root/dist}"
vendor="$root/vendor/pocketjs"
scratch="${WORLD_BOUNDED_BENCH_ROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/pocket-rpgkit-bench/world-bounded-quickjs}"
scratch_bench="$scratch/host-bench"
target_dir="$scratch/target"

if [ ! -f "$dist/world-bounded.js" ] || [ ! -f "$dist/world-bounded.pak" ]; then
  echo "world-bounded-quickjs-bench: missing $dist/world-bounded.{js,pak} -- run 'bun run build:example world-bounded' first" >&2
  exit 1
fi

if [ -z "$scratch_bench" ] || [ "$scratch_bench" = "/" ]; then
  echo "world-bounded-quickjs-bench: refusing unsafe scratch path" >&2
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

cp "$root/tools/world-bounded-quickjs-bench.rs" "$scratch_bench/src/world_bounded_quickjs_bench.rs"
if ! grep -q 'include!("world_bounded_quickjs_bench.rs");' "$scratch_bench/src/main.rs"; then
  echo 'include!("world_bounded_quickjs_bench.rs");' >> "$scratch_bench/src/main.rs"
fi

cd "$scratch_bench"
# Build first, checking cargo's own exit code (a grep on "error" lines would
# miss failures whose diagnostics do not start with that word). Capture the
# compiler artifacts as JSON so the binary run below is the one THIS build
# produced, not the newest file left in a persistent target dir.
build_log="$scratch/cargo-build.jsonl"
if ! CARGO_TARGET_DIR="$target_dir" cargo test --no-default-features --release --no-run --message-format=json >"$build_log" 2>&1; then
  echo "world-bounded-quickjs-bench: cargo build failed:" >&2
  cat "$build_log" >&2
  exit 1
fi
bin=$(python3 - "$build_log" <<'PYEOF'
import json, sys
candidates = []
for line in open(sys.argv[1]):
    line = line.strip()
    if not line.startswith("{"):
        continue
    try:
        msg = json.loads(line)
    except ValueError:
        continue
    if msg.get("reason") == "compiler-artifact" and msg.get("executable"):
        candidates.append(msg["executable"])
picks = [p for p in candidates if "pocket_desktop_host-" in p]
chosen = (picks or candidates)[-1] if (picks or candidates) else ""
print(chosen)
PYEOF
)
if [ -z "$bin" ] || [ ! -x "$bin" ]; then
  echo "world-bounded-quickjs-bench: build produced no test binary" >&2
  exit 1
fi

WORLD_BOUNDED_BENCH_SCRATCH="$scratch/runs" POCKETJS_DIST="$dist" \
  "$bin" world_bounded_quickjs_bench::world_bounded_crossings_and_residency \
  --ignored --exact --nocapture 2>&1 | grep -E "(WORLD_BOUNDED_QJS|WORLD_BOUNDED_RESIDENCY|test result)"
