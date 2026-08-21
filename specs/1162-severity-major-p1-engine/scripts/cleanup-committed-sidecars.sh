#!/usr/bin/env bash
# One-time manual cleanup for #1162 (FR-005).
#
# Removes engine bookkeeping sidecars that a pre-fix engine committed into a
# branch. Removes ONLY the three sidecar patterns — never .generacy/config.yaml
# or .generacy/epics/*, which are legitimately tracked.
#
# No automated engine action does this; run it by hand on each affected branch,
# review the diff, then push. The #1162 product-diff exclusion already hides
# these files from the next review round, so this is a cleanliness step only.
#
# Usage:
#   specs/1162-severity-major-p1-engine/scripts/cleanup-committed-sidecars.sh
set -euo pipefail

patterns=(
  '.generacy/review-findings-*.json'
  '.generacy/review-candidate-*.json'
  '.generacy/pause-context-*.json'
)

tracked=()
for pat in "${patterns[@]}"; do
  while IFS= read -r f; do
    [ -n "$f" ] && tracked+=("$f")
  done < <(git ls-files -- "$pat")
done

if [ "${#tracked[@]}" -eq 0 ]; then
  echo "No committed engine sidecars found on $(git rev-parse --abbrev-ref HEAD). Nothing to do."
  exit 0
fi

echo "The following committed engine sidecars will be removed from git tracking:"
printf '  %s\n' "${tracked[@]}"
echo

git rm --cached -- "${tracked[@]}"
git commit -m "chore: remove committed engine bookkeeping sidecars (#1162)"

echo
echo "Removed and committed. Review the diff, then push:"
echo "  git show --stat HEAD"
echo "  git push"
