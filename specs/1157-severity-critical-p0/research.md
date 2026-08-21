# Research: Red CI must not silently complete the workflow (#1157)

All line refs at `develop` `155b3464` unless noted; verified against the current
branch state.

## Decision 1 — Route `not-passed` through a pause branch symmetric with `timeout`

**Decision**: Extract a private `pauseForCiReadiness(...)` in `phase-loop.ts` and call
it from three sites — the existing `timeout` branch, a new `not-passed` branch, and a
new missing-head-SHA fast-fail branch. All three produce the identical operator-visible
state: `job:paused` emitted with `gateLabel: 'waiting-for:ci'`,
`labelManager.onGateHit(phase, 'waiting-for:ci')`, a best-effort reason comment, a
stage-comment update, and `return { results, completed: false, lastPhase: phase,
gateHit: true }`.

**Rationale**: The `timeout` branch (`phase-loop.ts:1300-1326`) is already the correct
recoverable, non-terminal state the spec asks for (FR-002). The bug is solely that
`not-passed` had no such branch and fell through to `onPhaseComplete`. Reusing the
exact shape guarantees FR-002's symmetry and avoids divergent label sets.

**Alternatives considered**:
- *A `failed:validate`-class escalation* — rejected by Q1→A: reads as terminal, and
  the spec mandates a recoverable pause with no terminal `blocked:*`.
- *A distinct `waiting-for:ci-failed` label* — rejected by Q2→A: adds a new label +
  `GATE_MAPPING` entry and a second resume path; the reason comment already
  disambiguates red-CI from timeout.
- *Bounded red-CI re-checks before escalating* — rejected by Q1→A: drifts into
  out-of-scope auto-remediation.

## Decision 2 — Never call `onPhaseComplete` on the red / missing-SHA paths

**Decision**: The shared pause helper calls only `labelManager.onGateHit(...)`, never
`labelManager.onPhaseComplete(phase)`.

**Rationale**: `onGateHit` (`label-manager.ts:215`) adds `waiting-for:ci` +
`agent:paused` and **removes `phase:validate`** — it does not grant `completed:validate`.
`onPhaseComplete` (`label-manager.ts:194`) is what grants `completed:validate`. The P0
bug is precisely the fall-through to `onPhaseComplete` at `phase-loop.ts:1564`. The
`on-ci-green` gate path deliberately calls `onPhaseComplete` at pause
(`phase-loop.ts:1527-1529`) because a *green* CI means `validate` genuinely
merge-completed; the `not-passed` path is the opposite and must leave the PR
non-merge-eligible (FR-003). End state on the red path: `waiting-for:ci` +
`agent:paused`, no `phase:validate`, no `completed:validate`.

## Decision 3 — Guard against a `not-passed` verdict silently re-passing the gate

**Decision**: Keep `ciMergeVerdict` unset (or explicitly non-`green`) on the
`not-passed` path, and `return` from the pause helper *before* the gate-check loop and
the `onPhaseComplete` fall-through are reached — mirroring the timeout branch's early
`return`.

**Rationale**: The `on-ci-green` gate (`phase-loop.ts:1435-1453`) only activates when
`ciMergeVerdict === 'green'`. A `not-passed` verdict would leave the gate inactive and
control would fall to `phase-loop.ts:1564` (`onPhaseComplete`). Returning early from the
pause helper is the same control-flow guard the timeout branch already uses, so the
red path can never reach either the gate loop or the fall-through.

## Decision 4 — No `phase-resolver.ts` change; resume re-runs `validate` via the existing fallback

**Decision**: Do not add a `GATE_MAPPING['ci']` entry. Rely on the existing
first-uncompleted-phase fallback.

**Rationale**: On the pause, labels are `waiting-for:ci` + `agent:paused` with no
`completed:validate`. When the operator adds `completed:*` and the label monitor issues
a `continue`, `PhaseResolver.resolveFromContinue` finds no matching gate for `ci`
(absent from `GATE_MAPPING`) and falls through to `resolveFromProcess`
(`phase-resolver.ts:169`), which returns the first phase in the sequence whose
`completed:` label is absent. `validate` is the last phase and its label is absent, so
`validate` re-runs (Q3→A) — re-marking ready, re-waiting CI on the new head SHA,
re-evaluating the merge gate. This is exactly how the existing `timeout` pause (which
also uses `waiting-for:ci` and never grants `completed:validate`) already resumes, so
no resolver change is needed and FR-008 (flag-off byte-identical) is preserved because
the resolver is untouched.

**Alternatives considered**:
- *Add `GATE_MAPPING['ci'] = { phase: 'validate', resumeFrom: 'validate' }`* — rejected
  as unnecessary new surface; the fallback already yields `validate`. Q2→A's phrase
  "single `GATE_MAPPING['ci']` resume path" describes the single resume *behavior*, not
  a required explicit map entry — the existing timeout pause demonstrates it works with
  no entry.

## Decision 5 — FR-007 fail-closed only when the `actions/runs` fallback was used (Q5→C)

**Decision**: In `evaluateCiReadiness` (`ci-merge-readiness.ts`), when the returned
`source === 'actions-runs'` **and** the aggregated verdict is `green`, downgrade to
`not-passed` and log the downgrade. `pending`/`not-passed` are returned unchanged, and
`check-runs`-sourced verdicts are never downgraded.

**Rationale**: `getCiRunsForSha` (`gh-cli.ts:1682`) returns `source: 'actions-runs'`
only when the primary `check-runs` path failed — the canonical symptom of a token
lacking `checks:read` (it throws `GhAuthError` on 401/403, `gh-cli.ts:1703-1707`). The
fallback enumerates only GitHub-Actions `workflow_runs` (`gh-cli.ts:1709-1739`) and is
blind to third-party required status contexts, so a `green` from it may be a false
green. `source` is already carried through `CiReadiness` (`ci-merge-readiness.ts:11,
47`), so the guard is a two-line addition keyed on data already in hand. A red path is
recoverable (pause + operator), so failing closed is safe; a false green is not
(silent red-ready PR — the exact P0).

**Alternatives considered**:
- *Blanket "fallback never green"* (Q5→A) — rejected: `source` is orthogonal to token
  health only in that a healthy `checks:read` cluster never reaches the fallback; the
  guard keyed on `source === 'actions-runs'` is already exactly "fallback was used",
  so a broader guard has no additional effect but the phrasing invited over-triggering
  concerns. The chosen guard is the precise Q5→C middle.
- *Documentation only* (Q5→B) — rejected by Q5→C: leaves the false-green live.
- *Key the guard on a caught `GhAuthError` rather than `source`* — rejected: `source`
  is the already-propagated, test-observable signal and covers every fallback trigger
  (non-zero exit as well as 401/403), not just auth throws. Documented here as the
  narrower rejected alternative.

## Decision 6 — FR-006 in the pure aggregator + the `CiConclusion` union

**Decision**: Add `'startup_failure'` and `'stale'` to `FAILING_CONCLUSIONS`
(`ci-verdict.ts:13-18`) and to the `CiConclusion` union (`types/github.ts:219-227`).

**Rationale**: Both are real terminal CI failures. Today they are unknown to the
aggregator, so they survive rule 1 (not in `FAILING_CONCLUSIONS`) and rule 3 (not
`success`) and land on rule 4 → `pending`. A `pending` verdict forces `waitForCiGreen`
to poll until the full `ciWaitTimeoutMs` (15 min) then pause with a *misleading*
timeout reason, when the PR is in fact red. Classifying them as failing yields an
immediate `not-passed` → the recoverable red-CI pause with the correct reason. This is
a behavior fix to already-passed-through values, not new public API — hence `patch`.
`skipped`/`neutral` remain in `IGNORED_CONCLUSIONS` (unchanged, US3 AC).

## Decision 7 — Best-effort reason comment (FR-004)

**Decision**: The pause helper posts `context.github.addIssueComment(owner, repo,
issueNumber, body)` inside a `try/catch`; a comment failure is logged at `warn` and
does not change the pause outcome. The comment body names the red-CI reason (or the
SHA-resolution failure / timeout reason, per branch), mirroring the
`remediation-limit` gate-body pattern (`phase-loop.ts:1414-1433`).

**Rationale**: FR-004 requires an operator-visible reason but mandates that a comment
failure must not alter the pause (SC-003 asserts the comment is *attempted*, not that
it succeeds). The three call sites pass distinct reason strings so red-CI, timeout, and
missing-SHA are disambiguated by comment/log content while sharing the `waiting-for:ci`
label (Q2→A / Q4→A).

## Testing notes

- The existing harness (`phase-loop.ci-merge-gate.test.ts`) already exercises the
  `timeout` pause with `ciWaitTimeoutMs: 0`. The `not-passed` test drives a
  `getCiRunsForSha`/`ciRuns` fixture that aggregates to `not-passed` (e.g. one
  `failure` run) with a non-zero timeout so the wait resolves on the first poll.
- SC-004 asserts the fast-fail by making `getCurrentCommitSha` throw and asserting the
  mock `getCiRunsForSha` is never called (the pause happens before `waitForCiGreen`).
- SC-002 asserts `onWorkflowComplete` and the second `markReadyForReview` are not
  invoked on the red path — the loop returns `completed: false`, so
  `claude-cli-worker.ts:915-953` never runs.
