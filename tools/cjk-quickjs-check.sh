#!/bin/bash
# cjk-quickjs-check.sh — render the Chinese text fixture in the pinned
# PocketJS desktop host's QuickJS guest and compare its frames with the wasm
# goldens of tests/cjk-text-sim.test.ts (480x272). Needs a built
# dist/cjk-text.{js,pak} (`bun tools/build-example.ts cjk-text`).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
vendor="$root/vendor/pocketjs"
scratch="${CJK_QJS_SCRATCH:-$root/dist/cjk-quickjs-check}"
mkdir -p "$scratch"
host="$(mktemp -d "$scratch/host.XXXXXX")"
cleanup() { rm -rf "$host"; }
trap cleanup EXIT
cp -r "$vendor/hosts/desktop/src" "$host/src"
cp "$vendor/hosts/desktop/Cargo.toml" "$host/Cargo.toml"
if [ -f "$vendor/hosts/desktop/Cargo.lock" ]; then cp "$vendor/hosts/desktop/Cargo.lock" "$host/Cargo.lock"; fi
sed -i -E "s#path = \"\.\./\.\./([^\"]+)\"#path = \"$vendor/\1\"#g" "$host/Cargo.toml"
cp "$root/tools/cjk-quickjs-check.rs" "$host/src/cjk_quickjs_check.rs"
printf '\ninclude!("cjk_quickjs_check.rs");\n' >> "$host/src/main.rs"

target="$scratch/target"
CARGO_TARGET_DIR="$target" cargo test --no-default-features --release --no-run --manifest-path "$host/Cargo.toml" >/dev/null
bin="$(find "$target/release/deps" -maxdepth 1 -type f -name 'pocket_desktop_host-*' ! -name '*.d' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
POCKETJS_DIST="$root/dist" CJK_QJS_OUT="$scratch/frames" \
  "$bin" cjk_quickjs_check::cjk_frames --ignored --exact --nocapture 2>&1 | grep -E '^(CJK_QJS|test result)|panicked'

bun -e '
import { decodePng } from "'"$vendor"'/framework/compiler/pak.ts";
let failed = 0;
for (const name of ["kinsoku", "reflow", "long-1", "long-2", "choices", "shop"]) {
  const qjs = new Uint8Array(await Bun.file("'"$scratch"'/frames/" + name + ".rgba").arrayBuffer());
  const golden = decodePng(new Uint8Array(await Bun.file("'"$root"'/tests/goldens/cjk-text." + name + ".480x272.png").arrayBuffer())).rgba;
  let diff = 0;
  for (let i = 0; i < golden.length; i += 4) if (qjs[i] !== golden[i] || qjs[i + 1] !== golden[i + 1] || qjs[i + 2] !== golden[i + 2]) diff++;
  console.log(`CJK_QJS compare=${name} differing_pixels=${diff}`);
  if (diff) failed++;
}
console.log(failed ? "CJK_QJS FAIL" : "CJK_QJS PASS");
process.exit(failed ? 1 : 0);
'
