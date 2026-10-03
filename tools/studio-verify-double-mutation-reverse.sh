#!/usr/bin/env bash
# tools/studio-verify-double-mutation-reverse.sh — the --double gate's
# fault-injection self-test (negative / reverse direction).
#
# Proves the positive self-test (tools/studio-verify-double-mutation.sh) has
# bite: build a throwaway mutant of studio-verify.ts where the normal
# documentation shot() is reverted to the reviewed regression —
# captureStable(name, options.playtestState !== undefined), i.e. only the
# play-test-state shots are frozen and every other normal shot is captured
# once — run the positive self-test against the mutant, and assert the
# self-test GOES RED. If it still passes, it cannot kill the target
# regression and this script fails.
#
# The mutant is a copy in tools/ (so relative imports resolve) and is removed
# on exit. Needs dist/web (bun run web) like studio-verify itself.
#
#   bun run web && tools/studio-verify-double-mutation-reverse.sh

set -u

cd "$(dirname "$0")/.."
MUTANT="tools/.studio-verify-reverse-mutant.ts"
cleanup() { rm -f "$MUTANT"; }
trap cleanup EXIT
cleanup

cp tools/studio-verify.ts "$MUTANT"
# Revert shot() to the reviewed regression. Assert the source still has the
# exact double-capture call, so a silent refactor cannot make this check a
# no-op.
count=$(grep -c "captureStable(name, true, true)" "$MUTANT" || true)
if [ "$count" != "1" ]; then
  echo "FAIL: expected exactly one shot() double-capture call in the verifier, found $count" >&2
  echo "      (update this script to match the new shot() implementation)" >&2
  exit 1
fi
sed -i 's|captureStable(name, true, true)|captureStable(name, options.playtestState !== undefined)|' "$MUTANT"

set +e
STUDIO_VERIFY_BIN="$MUTANT" tools/studio-verify-double-mutation.sh
status=$?
set -e

if [ "$status" -eq 0 ]; then
  echo "FAIL: the self-test PASSED on a single-capture shot() mutant" >&2
  echo "      (it cannot kill the target regression; see dist/studio-verify-mutation.log)" >&2
  exit 1
fi
echo "PASS: the self-test went red on the single-capture shot() mutant (as required)"
