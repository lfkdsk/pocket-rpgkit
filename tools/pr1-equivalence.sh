#!/bin/bash
# Compare this checkout with the pre-PR main baseline. The temporary
# detached worktree and JSON evidence live outside the repository.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
baseline_ref="${1:-a0857e097c9a68880f28ace2c13e2253be886d1c}"
scratch="${PR1_EQUIV_SCRATCH:-/var/tmp/fleet/1946/equivalence}"
baseline="$scratch/main"
output="${2:-$scratch/result.json}"

mkdir -p "$scratch"
if git -C "$root" worktree list --porcelain | grep -Fqx "worktree $baseline"; then
  git -C "$root" worktree remove --force "$baseline"
fi
git -C "$root" worktree add --detach "$baseline" "$baseline_ref" >/dev/null
cleanup() {
  git -C "$root" worktree remove --force "$baseline" >/dev/null 2>&1 || true
}
trap cleanup EXIT

bun "$root/tools/pr1-equivalence.ts" "$baseline" "$root" "$output"
echo "PR1_EQUIV artifact=$output"
