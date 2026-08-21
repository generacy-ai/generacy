# Quickstart: Keep engine bookkeeping sidecars out of PR branches

## What changes

- The phase-completion commit stages product paths only — engine sidecars
  (`.generacy/review-findings-*`, `review-candidate-*`, `pause-context-*`) are never
  committed into a PR branch.
- The review-round product diff also excludes those sidecar patterns, so any *already
  committed* sidecar (on a pre-fix branch) is ignored at review time.
- `remediationCount` now survives a worker restart / re-clone via Redis (`PhaseTracker`),
  instead of relying on the sidecar being committed.

`.generacy/config.yaml` and `.generacy/epics/*` are unaffected — they are legitimately
tracked and continue to commit normally.

## Verifying the fix locally

Run the orchestrator worker tests for the three touched areas:

```bash
pnpm --filter @generacy-ai/orchestrator test product-diff
pnpm --filter @generacy-ai/orchestrator test pr-manager.staging-filter
pnpm --filter @generacy-ai/orchestrator test phase-loop.remediation-persist
```

Expected:
- No `.generacy/review-findings-*` / `review-candidate-*` / `pause-context-*` path in any
  staged/committed set after a review→remediate→review loop (SC-001).
- Genuine product edits still committed each phase (SC-004).
- `remediationCount` recovered after a simulated re-clone; cap fires correctly (SC-003).
- Raw validate stderr text never reaches the reviewed product diff (SC-002).

## One-time cleanup for already-shipped repos (FR-005)

Repos that ran the buggy engine may have `.generacy/` sidecars already committed on open PR
branches and/or default branches. The engine does **not** clean these up automatically. Run
the provided script once per affected branch:

```bash
specs/1162-severity-major-p1-engine/scripts/cleanup-committed-sidecars.sh
```

The script `git rm --cached`s only the three sidecar patterns (never `config.yaml` /
`epics/*`), commits the removal, and prints the branches it touched. Review the diff before
pushing. Note: the FR-004 product-diff exclusion already hides these files from the next
review round, so cleanup is a cleanliness step, not a correctness prerequisite.

## Rollback

Flip nothing — this is a straight bug fix with no feature flag. To revert, restore
`stageAll()` in `commitAndPush`, drop the sidecar prefixes from `EXCLUDED_PATH_PREFIXES`,
and remove the Redis mirror/reconcile in `phase-loop.ts`. Reverting reintroduces the bug.
