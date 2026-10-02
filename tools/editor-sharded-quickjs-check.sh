#!/bin/bash
# Run the PocketJS editor's sharded-project flow in the real desktop QuickJS
# guest: open a sharded project through the filesystem companion, paint two
# maps, save, and check the files on disk. Also compares the guest's global
# inventory with tests/fixtures/quickjs-guest-globals.json.
#
#   tools/editor-sharded-quickjs-check.sh                  # check
#   tools/editor-sharded-quickjs-check.sh --write-globals  # refresh the allowlist
#
# EDITOR_SHARDED_QJS_DIST=<dir with editor.js + editor.pak> checks a prebuilt
# bundle (for example a baseline build) and skips the build.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="$root/dist/editor-sharded-quickjs-check"
vendor="$root/vendor/pocketjs"
host=""

dist="${EDITOR_SHARDED_QJS_DIST:-$root/dist}"
if [ -z "${EDITOR_SHARDED_QJS_DIST:-}" ]; then
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
cp "$root/tools/editor-sharded-quickjs-check.rs" "$host/src/editor_sharded_quickjs_check.rs"
printf '\ninclude!("editor_sharded_quickjs_check.rs");\n' >> "$host/src/main.rs"

target="$scratch/target"
CARGO_TARGET_DIR="$target" cargo test --no-default-features --release --no-run --manifest-path "$host/Cargo.toml" >/dev/null
bin="$(find "$target/release/deps" -maxdepth 1 -type f -name 'pocket_desktop_host-*' ! -name '*.d' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
if [ -z "$bin" ]; then
  echo "editor-sharded-quickjs-check: desktop host test binary was not produced" >&2
  exit 1
fi

POCKETJS_DIST="$dist" SHARDED_QJS_ROOT="$scratch" bun "$root/tools/editor-sharded-quickjs-check.ts" "$bin" "$@"
