# Contract: CI merge-readiness pause behavior (#1157 FR-001..FR-005)

Governs the `not-passed`, `timeout`, and missing-head-SHA outcomes of the CI
merge-readiness step inside `phase-loop.ts` when `ciMergeGateEnabled` is on and
`phase === 'validate' && result.success`.

## Shared pause helper

`pauseForCiReadiness({ phase, reason, ...ctx })` performs, in order:

1. Emit `jobEventEmitter('job:paused', { …, currentStep: phase, gateLabel:
   'waiting-for:ci' })`.
2. `await labelManager.onGateHit(phase, 'waiting-for:ci')`
   — adds `waiting-for:ci` + `agent:paused`, removes `phase:<phase>`.
   — MUST NOT call `labelManager.onPhaseComplete(phase)`.
3. Best-effort reason comment (FR-004): `try { await
   context.github.addIssueComment(owner, repo, issueNumber, body) } catch { warn }`.
   The `body` names the outcome-specific reason. A failure here MUST NOT change any
   other step or the return value.
4. Set `result.gateHit = { gateLabel: 'waiting-for:ci', reason }` and record the phase
   `completedAt` timestamp.
5. `await stageCommentManager.updateStageComment({ status: 'in_progress', … })`.
6. `return { results, completed: false, lastPhase: phase, gateHit: true }`.

The helper returns **before** the gate-check loop and the step-6b `onPhaseComplete`
fall-through are reached (early `return` from the loop body), so the red path can never
grant `completed:validate` or reach `completed: true`.

## Call sites and reasons

| Trigger | Condition | Reason string (comment/log) |
|---|---|---|
| Red CI (FR-001/FR-002) | `waitForCiGreen` → `{ kind: 'not-passed' }` | names the red-CI verdict, e.g. "CI is red (not-passed) for the head commit; the merge gate will not open until CI is green." |
| Timeout (existing) | `waitForCiGreen` → `{ kind: 'timeout' }` | "CI did not turn green within the merge-readiness timeout" |
| Missing head SHA (FR-005) | head SHA unusable (throw / falsy / `'unknown'`) | names the SHA-resolution failure, e.g. "Could not resolve the PR head commit SHA; CI merge-readiness cannot be evaluated." |

The label is identical (`waiting-for:ci`) for all three (Q2→A / Q4→A). Only the
comment/log text differs.

## Ordering guarantees (FR-005)

The head-SHA usability check runs **before** `waitForCiGreen`. When the SHA is unusable
the helper is called immediately and `waitForCiGreen` / `getCiRunsForSha` are never
invoked — so `commits/unknown/check-runs` is not polled for `ciWaitTimeoutMs`.

## Invariants

- INV-1 (FR-001): a `not-passed` verdict never yields `completed: true`.
- INV-2 (FR-003): `completed:validate` is never granted on the `not-passed` / timeout /
  missing-SHA paths (`onPhaseComplete` is not called).
- INV-3 (FR-002): the pause is recoverable — `waiting-for:ci` + `agent:paused`, never a
  terminal `blocked:*` and never a `failed:validate`-class label.
- INV-4 (SC-002): because the loop returns `completed: false`, the completion flow
  (`claude-cli-worker.ts:915-953`) does not run → no `onWorkflowComplete`, no second
  `markReadyForReview` on the red path.
- INV-5 (FR-004): a comment failure is swallowed; the pause outcome is unchanged.
- INV-6 (Q3→A resume): operator adds `completed:*` → `validate` re-runs (first
  uncompleted phase; no `completed:validate` present). No resolver change.
- INV-7 (FR-008): with `ciMergeGateEnabled` off, none of this code path executes →
  behavior byte-identical to today.

## Test assertions (SC-001..SC-004, FR-009)

- `not-passed` verdict → `{ completed: false, gateHit: true }`, issue labels contain
  `waiting-for:ci` + `agent:paused` and NOT `completed:validate`,
  `addIssueComment` was attempted.
- No `onWorkflowComplete` call; `markReadyForReview` invoked at most once (the pre-wait
  ready-marking), never re-invoked via the completion flow.
- `getCurrentCommitSha` throws → pause with NO `getCiRunsForSha` call.
