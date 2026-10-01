#!/bin/bash
# Build the same engine workloads from pre-PR main and this checkout, then
# execute both in the current pinned PocketJS desktop host's QuickJS guest.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
baseline_ref="${1:-a0857e097c9a68880f28ace2c13e2253be886d1c}"
scratch="${PR1_QJS_SCRATCH:-${XDG_CACHE_HOME:-$HOME/.cache}/pocket-rpgkit-bench/pr1-quickjs}"
baseline="$scratch/main"
host="$scratch/host"
target="$scratch/target"

mkdir -p "$scratch"
if git -C "$root" worktree list --porcelain | grep -Fqx "worktree $baseline"; then
  git -C "$root" worktree remove --force "$baseline"
fi
git -C "$root" worktree add --detach "$baseline" "$baseline_ref" >/dev/null
cleanup() {
  git -C "$root" worktree remove --force "$baseline" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cp "$root/tools/pr1-quickjs-entry.ts" "$baseline/tools/pr1-quickjs-entry.ts"
bun build "$baseline/tools/pr1-quickjs-entry.ts" --target=browser --format=iife --minify --outfile="$scratch/main.js" >/dev/null
bun build "$root/tools/pr1-quickjs-entry.ts" --target=browser --format=iife --minify --outfile="$scratch/candidate.js" >/dev/null

rm -rf "$host"
mkdir -p "$host"
cp -r "$root/vendor/pocketjs/hosts/desktop/src" "$host/src"
cp "$root/vendor/pocketjs/hosts/desktop/Cargo.toml" "$host/Cargo.toml"
if [ -f "$root/vendor/pocketjs/hosts/desktop/Cargo.lock" ]; then
  cp "$root/vendor/pocketjs/hosts/desktop/Cargo.lock" "$host/Cargo.lock"
fi
sed -i -E "s#path = \"\.\./\.\./([^\"]+)\"#path = \"$root/vendor/pocketjs/\1\"#g" "$host/Cargo.toml"
cp "$root/tools/pr1-quickjs-bench.rs" "$host/src/pr1_quickjs_bench.rs"
echo 'include!("pr1_quickjs_bench.rs");' >> "$host/src/main.rs"

CARGO_TARGET_DIR="$target" cargo test --no-default-features --release --no-run --manifest-path "$host/Cargo.toml" >/dev/null
bin="$(find "$target/release/deps" -maxdepth 1 -type f -name 'pocket_desktop_host-*' ! -name '*.d' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
if [ -z "$bin" ]; then
  echo "pr1-quickjs-bench: desktop host test binary was not produced" >&2
  exit 1
fi

for label in main candidate candidate main; do
  js="$scratch/$label.js"
  PR1_BENCH_JS="$js" PR1_BENCH_LABEL="$label" "$bin" \
    pr1_quickjs_bench::tick_fold --ignored --exact --nocapture 2>&1 \
    | grep -oE '(PR1_QJS|test result).*$'
done
