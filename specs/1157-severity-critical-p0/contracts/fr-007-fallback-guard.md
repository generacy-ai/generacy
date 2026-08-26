# Contract: `actions/runs` fallback fail-closed guard (#1157 FR-007, Q5→C)

The token-limited `actions/runs` fallback in `getCiRunsForSha`
(`packages/workflow-engine/src/actions/github/client/gh-cli.ts:1709-1739`) only
enumerates GitHub-Actions `workflow_runs` for the branch, filtered client-side to the
head SHA. It is **blind to third-party required checks** (external status contexts), so
a `green` aggregated from it may be a false green.

## Guard (conservative middle — Q5→C)

In `evaluateCiReadiness`
(`packages/orchestrator/src/worker/ci-merge-readiness.ts`), after computing the verdict:

```
verdict = aggregateCiVerdict(runs)
if (source === 'actions-runs' && verdict === 'green') {
  logger?.warn({ owner, repo, headSha, runCount },
    '#1157 FR-007: actions/runs fallback cannot see third-party required checks; ' +
    'downgrading would-be green to not-passed (checks:read likely missing)')
  verdict = 'not-passed'
}
```

- Fires **only** when `source === 'actions-runs'` — i.e. the primary `check-runs` path
  failed (non-zero exit or `GhAuthError` 401/403), the canonical symptom of a token
  lacking `checks:read`. On a healthy `checks:read` cluster the primary path returns
  `source: 'check-runs'` and the guard never fires (FR-008 preserved).
- Only a would-be `green` is downgraded. `pending` and `not-passed` from the fallback
  are returned unchanged.
- `check-runs`-sourced verdicts are never downgraded (SC-004 verdict parity preserved
  for the healthy path).

A downgraded `not-passed` routes into the recoverable red-CI pause (contract
`ci-pause-behavior.md`) — safe, because the pause is operator-recoverable. Leaving a
false `green` is not safe (it is the P0 outcome this epic closes).

## Documentation (FR-007 second clause)

- **Readout site** (`gh-cli.ts` fallback block): a comment stating the fallback only
  enumerates GitHub-Actions runs and is blind to third-party required checks, pointing
  at the `ci-merge-readiness.ts` guard.
- **Operator docs**: note that on a `checks:read`-lacking cluster, CI merge readiness
  fails closed (never green) via the `actions/runs` fallback, and that granting
  `checks:read` restores full third-party-check visibility.

## Rejected alternatives

- **Blanket "fallback never green"** (Q5→A): equivalent in effect to the chosen guard
  (the fallback is only used when `source === 'actions-runs'`), but framed as
  unconditional; rejected in favor of the precise `source`-keyed guard.
- **Documentation only** (Q5→B): leaves the false-green live; rejected by Q5→C.
- **Key on caught `GhAuthError`**: `source` is the already-propagated, test-observable
  signal and covers every fallback trigger (non-zero exit as well as 401/403).

## Test assertions

- `source === 'actions-runs'` + runs aggregating to `green` → `evaluateCiReadiness`
  returns `verdict: 'not-passed'`.
- `source === 'check-runs'` + runs aggregating to `green` → returns `verdict: 'green'`.
- `source === 'actions-runs'` + `pending` → returns `pending` (unchanged).
- `source === 'actions-runs'` + `not-passed` → returns `not-passed` (unchanged).
