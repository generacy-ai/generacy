---
"@generacy-ai/cockpit": minor
"@generacy-ai/generacy": minor
---

Add a `generacy cockpit merge --pr <number>` escape hatch for merging a PR by
explicit number when issue→PR resolution can't be trusted (#913). The `<ref>`
issue still supplies `completed:validate` authorization, but the operator names
the PR directly and the command verifies linkage from the PR side before
merging.

- `@generacy-ai/cockpit`: new `GhWrapper.getPullRequestGraphqlDetail(repo, pr)`
  that fetches PR `state`/`headRefName`/`isDraft`/`mergeStateStatus` and
  `closingIssuesReferences` via `gh api graphql`, plus the exported
  `PullRequestGraphqlDetail` type. Tier-1 issue→PR resolution now tolerates the
  gh 2.96.0 minimal `closedByPullRequestsReferences` shape (FR-004) so a gh
  upgrade no longer breaks the parse.
- `@generacy-ai/generacy`: `merge` grows the `--pr` flag (`parsePrFlag`,
  positive-integer validated). The `--pr` path refuses on missing/mismatched
  closing-issue linkage (`pr-flag-linkage-refused`, sub-kinds `empty-refs` /
  `mismatch`) and on a closed-unmerged PR (`pr-flag-closed-unmerged`), emitting
  the structured failing-check JSON with exit code 3 (usage errors exit 2). The
  sanctioned resolver path keeps its existing exit-0/1 behavior; it never merges
  on red.
