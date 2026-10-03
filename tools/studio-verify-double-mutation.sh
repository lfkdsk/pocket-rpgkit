#!/usr/bin/env bash
# tools/studio-verify-double-mutation.sh — the --double gate's fault-injection
# self-test (positive direction).
#
# STUDIO_VERIFY_MUTATE_DOUBLE=1 makes studio-verify recolour the page between
# the two captures of every normal documentation shot() — and only that
# path — simulating a real instability. With the mutation active the gate
# MUST go red, and the red must be on the injected shots themselves:
#   - the run exits non-zero;
#   - every non-live shot in the report has a name-by-name double: comparison
#     (equal count, so "shot() captures only once" cannot hide behind the
#     studio/play-test paths, which double-capture on their own);
#   - every double: failure is one of the recoloured (mutated) shots, so a
#     failure from another path can no longer stand in for the target.
#
# Writes only under dist/studio-verify-mutation/ (report and screenshots),
# never docs/. Needs dist/web (bun run web) like studio-verify itself.
#
#   bun run web && tools/studio-verify-double-mutation.sh
#
# The reverse direction — the self-test must GO RED when the normal shot()
# is reverted to a single capture — is
# tools/studio-verify-double-mutation-reverse.sh.
#
# STUDIO_VERIFY_BIN overrides the verifier under test (used by the reverse
# script to point at a throwaway mutant).

set -u

cd "$(dirname "$0")/.."
OUT="dist/studio-verify-mutation"
SHOTS="$OUT/shots"
LOG="dist/studio-verify-mutation.log"
BIN="${STUDIO_VERIFY_BIN:-tools/studio-verify.ts}"
mkdir -p "$OUT" "$SHOTS"
rm -f "$OUT/report.json"
# Clear stale mutation screenshots so the directory holds only this run.
rm -f "$SHOTS"/*.png

set +e
STUDIO_VERIFY_MUTATE_DOUBLE=1 bun "$BIN" --double --out "$OUT" --shots "$SHOTS" >"$LOG" 2>&1
status=$?
set -e

if [ "$status" -eq 0 ]; then
  echo "FAIL: studio-verify --double PASSED with the capture mutation active" >&2
  echo "      (normal shots are not compared twice; see $LOG)" >&2
  exit 1
fi
if [ ! -f "$OUT/report.json" ]; then
  echo "FAIL: studio-verify failed before writing a report (see $LOG)" >&2
  exit 1
fi

bun -e '
  const fs = require("fs");
  const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const results = report.results ?? {};
  const failures = report.failures ?? [];
  const shotNames = Object.keys(results).filter((k) => k.startsWith("shot:")).map((k) => k.slice("shot:".length)).sort();
  const doubleEntries = Object.entries(results).filter(([k]) => k.startsWith("double:"));
  const doubleNames = doubleEntries.map(([k]) => k.slice("double:".length)).sort();
  // The one explicitly live (un-paused) play-test shot is the only shot
  // whose frame advances between captures by design, so it is the only one
  // without a double: comparison. Everything else must match name-by-name.
  const LIVE = "studio-playtest-running";
  const expected = shotNames.filter((n) => n !== LIVE).sort();
  const missing = expected.filter((n) => !doubleNames.includes(n));
  const extra = doubleNames.filter((n) => !expected.includes(n));
  if (missing.length || extra.length) {
    console.error(`FAIL: double: coverage is not name-by-name (${doubleNames.length} double vs ${shotNames.length} shot). missing=[${missing}] extra=[${extra}]`);
    process.exit(1);
  }
  const doubleFailures = failures.filter((f) => f.check.startsWith("double:"));
  if (doubleFailures.length === 0) {
    console.error("FAIL: the run went red, but not on any double: comparison");
    process.exit(1);
  }
  const mutated = new Set(
    doubleEntries.filter(([, v]) => v && v.mutated === true).map(([k]) => k.slice("double:".length)),
  );
  const notMutated = doubleFailures
    .map((f) => f.check.slice("double:".length))
    .filter((n) => !mutated.has(n));
  if (notMutated.length) {
    console.error(`FAIL: double: failures are not on the injected normal shot() screenshots: [${notMutated}]`);
    process.exit(1);
  }
  console.log(
    `PASS: ${doubleFailures.length} double: failures, all on the ${mutated.size} mutated normal shot() screenshots; ` +
    `coverage ${doubleNames.length}/${shotNames.length} (live ${LIVE} excluded)`,
  );
' "$OUT/report.json"
