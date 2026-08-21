# Quickstart: Red CI must not silently complete the workflow (#1157)

This fix closes a P0 where a `not-passed` CI verdict (red CI) on the head commit
silently granted `completed:validate` and completed the workflow — marking a red PR
ready for review as if CI had passed.

## Flags involved

The whole path is gated behind the existing #1133 flag — with the flag off, behavior
is byte-identical to today (FR-008).

| Flag | Env var | Default | Effect |
|---|---|---|---|
| `ciMergeGateEnabled` | `WORKER_CI_MERGE_GATE_ENABLED` | `false` | Enables CI merge-readiness evaluation on `validate` completion. The #1157 red-CI / missing-SHA pauses only exist on this path. |
| `ciWaitTimeoutMs` | `WORKER_CI_WAIT_TIMEOUT_MS` | `900000` (15 min) | Bounded wait for a `pending` verdict to resolve before pausing with a `timeout` reason. Zod min `30000`. Per-workflow overridable. |

Both are read in `packages/orchestrator/src/config/loader.ts` and are per-workflow
overridable (mirrors `phaseTimeoutMs`).

## What changes (behavioral)

With `ciMergeGateEnabled` on, when `validate` succeeds:

1. The worker resolves the PR head SHA. If unusable (throws / falsy / literal
   `'unknown'`), it **fast-fails** into a `waiting-for:ci` pause — `waitForCiGreen` /
   `getCiRunsForSha` are never called (FR-005).
2. Otherwise it evaluates CI readiness for the head SHA:
   - **green** → the relocated `implementation-review` gate opens (unchanged; grants
     `completed:validate` at the post-completion approval pause).
   - **not-passed** (red) → **NEW**: pause with `waiting-for:ci` + `agent:paused`,
     **without** granting `completed:validate` (FR-001 / FR-003).
   - **pending** → wait with bounded backoff up to `ciWaitTimeoutMs`, then pause with a
     `timeout` reason (existing behavior).
3. `startup_failure` and `stale` conclusions now aggregate to `not-passed` instead of
   `pending` (FR-006), so a hard CI failure pauses immediately with the correct reason
   instead of polling for the full timeout.

All three pause outcomes (**red-CI**, **timeout**, **missing-SHA**) share the same
`waiting-for:ci` label (Q2→A / Q4→A). Only the reason comment/log text differs.

## Reproducing the red-CI pause

1. Run a `speckit-feature` / `speckit-bugfix` workflow on a cluster with
   `WORKER_CI_MERGE_GATE_ENABLED=true`.
2. Ensure the PR's head commit has at least one failing (`failure` / `cancelled` /
   `timed_out` / `action_required` / `startup_failure` / `stale`) CI run.
3. On `validate` success, the issue lands with `waiting-for:ci` + `agent:paused`, no
   `completed:validate`, and a best-effort comment naming the red-CI reason.

The workflow does **not** complete: the loop returns `completed: false`, so the
completion flow (`claude-cli-worker.ts`) never runs — no `onWorkflowComplete`, no second
`markReadyForReview` (SC-002).

## Operator recovery

The pause is recoverable (never a terminal `blocked:*`):

1. Fix CI (push a commit to the PR branch that turns CI green).
2. Add a `completed:*` label to the issue (the same resume gesture as the existing
   timeout pause).
3. The label monitor issues a `continue`. `PhaseResolver.resolveFromProcess` returns the
   first uncompleted phase — `validate`, since `completed:validate` was never granted —
   so `validate` **re-runs** (Q3→A): re-marks ready, re-waits CI on the new head SHA,
   re-evaluates the merge gate.

No `GATE_MAPPING['ci']` entry and no resolver change are needed — this reuses the exact
fallback the existing timeout pause already relies on.

## FR-007: checks:read-lacking clusters

`getCiRunsForSha` uses a primary `check-runs` path and, when the token lacks
`checks:read` (the primary path throws `GhAuthError` on 401/403 or exits non-zero),
falls back to enumerating GitHub-Actions `workflow_runs` (`source: 'actions-runs'`). That
fallback is **blind to third-party required checks**, so a `green` aggregated from it may
be a false green.

Guard (Q5→C, in `evaluateCiReadiness`): when `source === 'actions-runs'` and the verdict
is `green`, it is downgraded to `not-passed` and logged — CI merge readiness **fails
closed** (never green) on a `checks:read`-lacking cluster. `pending` / `not-passed` from
the fallback are unchanged; `check-runs`-sourced verdicts are never downgraded (healthy
path unaffected — SC-004 verdict parity preserved).

**To restore full visibility:** grant the cluster token `checks:read`. The primary
`check-runs` path then returns `source: 'check-runs'` and the guard never fires.

## Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| Issue stuck at `waiting-for:ci` right after `validate` | Red CI on the head commit (`not-passed`) | Fix CI, push, add `completed:*` to resume. |
| `waiting-for:ci` with a comment about SHA resolution | Head SHA unusable (`'unknown'` / falsy / threw) — FR-005 fast-fail | Verify the PR head is resolvable; resume after fixing. |
| `waiting-for:ci` with a `timeout` comment | CI stayed `pending` past `ciWaitTimeoutMs` | Check why CI didn't complete; raise `WORKER_CI_WAIT_TIMEOUT_MS` if genuinely slow. |
| CI is actually green but readiness reports `not-passed` + a log about the fallback | Token lacks `checks:read`; fell back to `actions/runs` and failed closed (FR-007) | Grant `checks:read` to the cluster token. |
| Red PR still completing as ready-for-review | `ciMergeGateEnabled` off | Set `WORKER_CI_MERGE_GATE_ENABLED=true`. |
