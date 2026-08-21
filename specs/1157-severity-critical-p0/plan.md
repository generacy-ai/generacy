# Implementation Plan: Red CI must not silently complete the workflow

**Feature**: A `not-passed` CI merge-readiness verdict (and an unresolvable head SHA) must pause the workflow in a recoverable, operator-visible state — never return `completed: true`, never grant `completed:validate`, never re-mark the PR ready.
**Branch**: `1157-severity-critical-p0`
**Issue**: [generacy-ai/generacy#1157](https://github.com/generacy-ai/generacy/issues/1157) | **Epic**: [#1153](https://github.com/generacy-ai/generacy/issues/1153)
**Status**: Complete

## Summary

With `ciMergeGateEnabled` on (#1133), a successful `validate` followed by **red CI**
terminates the workflow indistinguishably from success. The `not-passed` verdict
merely *skips* the `on-ci-green` gate; control then falls through to
`labelManager.onPhaseComplete('validate')` (`phase-loop.ts:1564`), which grants
`completed:validate` (cockpit's merge-eligible surface), the loop returns
`completed: true`, and the non-epic completion flow (`claude-cli-worker.ts:915-953`)
runs `onWorkflowComplete()` and re-marks the PR ready. No pause, no `waiting-for:*`,
no comment.

This is a **P0 defect fix** (`workflow:speckit-bugfix`). The fix makes the `not-passed`
path symmetric with the already-correct `timeout` path: pause with `waiting-for:ci` +
`agent:paused`, post a best-effort reason comment, and return `{ completed: false,
gateHit: true }` **without** calling `onPhaseComplete`. The missing-head-SHA case
(FR-005) lands in the same pause state via a fast-fail before `waitForCiGreen`. Two
smaller hardening items ride along: `startup_failure`/`stale` become failing
conclusions (FR-006), and the `actions/runs` fallback fail-closes against a false
`green` when it was actually used (FR-007).

All five clarifications are load-bearing:
- **Q1→A** — the `not-passed` path pauses with a `waiting-for:*` gate + `agent:paused`
  (recoverable, symmetric with the timeout pause). No terminal `blocked:*`, no
  `failed:validate` escalation, no bounded re-check.
- **Q2→A** — the pause **reuses** the existing `waiting-for:ci` label. Red-CI vs
  timeout are disambiguated only by the reason comment/log; a single resume path.
- **Q3→A** — on resume (operator adds `completed:*`), the workflow **re-runs
  `validate`** (re-marks ready, re-waits CI on the new head SHA, re-evaluates the
  merge gate). Resume never skips to completion.
- **Q4→A** — the missing-head-SHA fast-fail lands in the **same** pause state as red
  CI (reuse `waiting-for:ci`), differentiated only by the reason comment/log.
- **Q5→C** — the `actions/runs` fallback guards (never yields `green`) **only** when
  the token is known to lack `checks:read` (i.e. the fallback was actually used);
  otherwise the limitation is documented at the readout site + operator docs.

## Technical Context

- **Language/runtime**: TypeScript, ESM, Node ≥22, pnpm workspaces.
- **Primary packages touched**:
  - `@generacy-ai/orchestrator` — `phase-loop.ts` (`not-passed` + missing-SHA pause
    branches, shared pause helper), `ci-merge-readiness.ts` (FR-007 fail-closed
    guard). **`patch`** (internal defect fix, no new public exports).
  - `@generacy-ai/workflow-engine` — `ci-verdict.ts` + `types/github.ts`
    (`startup_failure`/`stale` as failing, FR-006), `gh-cli.ts` (FR-007 doc at
    readout site). **`patch`** (defect fix; union-member widening is a semantic
    correction of already-passed-through values, not new API surface).
- **Client access model**: the worker resolves CI state through `context.github` =
  `GhCliGitHubClient`. The `not-passed` verdict is produced by the already-shipped
  `getCiRunsForSha` → `aggregateCiVerdict` path (#1133); this fix threads that
  existing outcome into a pause branch.
- **Resume mechanism**: the `not-passed`/timeout/missing-SHA pause leaves labels
  `waiting-for:ci` + `agent:paused` with **no** `phase:validate` (removed by
  `onGateHit`) and **no** `completed:validate` (`onPhaseComplete` never called). On
  the operator's `continue`, `PhaseResolver` resolves the first-uncompleted phase =
  `validate` (validate is last in sequence and its `completed:` label is absent), so
  `validate` re-runs. This is exactly how the existing `timeout` pause already
  resumes — **no `phase-resolver.ts` change is required** (see research.md Decision 4).
- **No `.specify/memory/constitution.md`** in the repo → constitution check skipped.

## Constitution Check

No constitution file present (`.specify/memory/constitution.md` absent). Skipped per
plan convention.

## Project Structure

### Modified files

```
packages/orchestrator/src/worker/phase-loop.ts
    CI merge-readiness block (lines 1266-1328), replaced/extended:
    - FR-005: after resolving headSha, if it is unusable (getCurrentCommitSha threw
      OR yielded a falsy/'unknown' sentinel), pause immediately via the shared helper
      with a distinct reason — do NOT call waitForCiGreen (no 15-min poll of
      commits/unknown/check-runs).
    - FR-001/FR-002/FR-004: when waitForCiGreen resolves to `not-passed`, pause via the
      shared helper with a red-CI reason. NEVER set ciMergeVerdict to a value that lets
      the on-ci-green gate fire, and NEVER fall through to onPhaseComplete.
    - Refactor: extract a private pauseForCiReadiness(...) that both the existing
      `timeout` branch and the two new branches call. It emits job:paused with
      gateLabel 'waiting-for:ci', calls labelManager.onGateHit(phase, 'waiting-for:ci')
      (removes phase:validate, adds waiting-for:ci + agent:paused; does NOT grant
      completed:validate), posts a best-effort reason comment (FR-004 — try/catch, a
      comment failure never changes the pause outcome), updates the stage comment, and
      returns { results, completed: false, lastPhase: phase, gateHit: true }.

packages/orchestrator/src/worker/ci-merge-readiness.ts
    FR-007 (Q5→C): in evaluateCiReadiness, when `source === 'actions-runs'` (the
    check-runs primary path failed → token likely lacks checks:read → third-party
    required checks are invisible) and the aggregated verdict would be `green`,
    fail-closed to `not-passed` and log the downgrade. `pending`/`not-passed` from the
    fallback are returned unchanged. check-runs-sourced verdicts are never downgraded.

packages/workflow-engine/src/actions/github/client/ci-verdict.ts
    FR-006: add 'startup_failure' and 'stale' to FAILING_CONCLUSIONS so a hard CI
    failure resolves promptly to `not-passed` instead of falling through rule 4 to
    `pending` (which forces the slow 15-min timeout).

packages/workflow-engine/src/types/github.ts
    FR-006: add 'startup_failure' | 'stale' to the CiConclusion union so the two
    values are first-class recognized conclusions (they were previously passed through
    as unknown → conservatively pending).

packages/workflow-engine/src/actions/github/client/gh-cli.ts
    FR-007: documentation comment at the actions/runs fallback readout site
    (lines 1709-1739) noting it only enumerates GitHub-Actions workflow runs and is
    blind to third-party required checks — hence the ci-merge-readiness.ts fail-closed
    guard when source === 'actions-runs'.

.changeset/1157-red-ci-pause.md
    @generacy-ai/orchestrator patch + @generacy-ai/workflow-engine patch.
```

### New test files

```
packages/orchestrator/src/worker/__tests__/phase-loop.ci-merge-gate.test.ts   (extend)
    - SC-001/SC-003/FR-009: validate success + `not-passed` verdict → asserts
      { completed: false, gateHit: true }, no completed:validate label granted, and a
      reason comment attempted.
    - SC-002: no onWorkflowComplete / no second markReadyForReview on the red path.
    - SC-004: getCurrentCommitSha throws → pause short-circuits with NO getCiRunsForSha
      call (fast-fail well under ciWaitTimeoutMs).
packages/orchestrator/src/worker/__tests__/ci-merge-readiness.test.ts           (extend)
    - SC-004 companion: unusable headSha never polls.
    - FR-007: source === 'actions-runs' + green → downgraded to not-passed;
      source === 'check-runs' + green → stays green.
packages/workflow-engine/.../ci-verdict.test.ts                                 (extend)
    - SC-005: startup_failure → not-passed; stale → not-passed; skipped/neutral still
      ignored; green path unchanged.
```

### Contracts

```
specs/1157-severity-critical-p0/contracts/ci-pause-behavior.md   — not-passed / missing-SHA pause state, labels, resume, comment (FR-001..FR-005)
specs/1157-severity-critical-p0/contracts/ci-verdict.md          — startup_failure/stale failing-conclusion addition (FR-006)
specs/1157-severity-critical-p0/contracts/fr-007-fallback-guard.md — actions-runs fail-closed guard + documentation (FR-007, Q5→C)
```

## Key Technical Decisions

1. **Mirror the `timeout` branch for `not-passed`.** The existing `timeout` pause is
   already the correct recoverable state (`waiting-for:ci` + `agent:paused`, no
   `completed:validate`, resumes by re-running `validate`). The fix routes `not-passed`
   and the missing-SHA fast-fail through the same shared helper, differentiated only by
   the reason comment/log (Q1→A, Q2→A, Q4→A). This is the minimal, symmetric change and
   keeps the single resume path intact.

2. **No `phase-resolver.ts` / `GATE_MAPPING` change.** Resume re-runs `validate` via
   the existing first-uncompleted-phase fallback in `resolveFromProcess` — the pause
   grants no `completed:validate`, so `validate` is the first uncompleted phase. Adding
   a `GATE_MAPPING['ci']` entry is unnecessary and would be new surface. Flag-off stays
   byte-identical (FR-008) because the resolver is untouched.

3. **`onPhaseComplete` is the bug; never call it on the red path.** The `on-ci-green`
   gate path deliberately grants `completed:validate` at pause (post-completion
   approval gate). The `not-passed` path must NOT — the phase did not merge-complete;
   CI is red. The shared helper calls only `onGateHit` (which removes `phase:validate`
   and adds the pause pair), never `onPhaseComplete`.

4. **FR-005 fast-fail before `waitForCiGreen`.** An unusable head SHA (throw, empty
   string, or the `'unknown'` sentinel) pauses immediately rather than polling
   `commits/unknown/check-runs` for the full `ciWaitTimeoutMs`. Same pause state as red
   CI (Q4→A), distinct reason (FR-004).

5. **FR-006 in the pure aggregator.** `startup_failure`/`stale` are real CI failures
   that today fall through to `pending` (rule 4) and force the slow timeout. Adding them
   to `FAILING_CONCLUSIONS` (and the `CiConclusion` union) resolves them promptly to
   `not-passed`, which now routes into the recoverable pause instead of a misleading
   15-min timeout pause.

6. **FR-007 conservative fail-closed (Q5→C).** A blanket "fallback never green" guard
   would over-trigger on healthy `checks:read` clusters (risking FR-008). Instead the
   guard fires only when `source === 'actions-runs'` — the fallback was actually used,
   i.e. the token lacked `checks:read` and third-party required checks are invisible.
   A would-be `green` downgrades to `not-passed`; the readout site + operator docs
   record the limitation. See research.md Decision 5 for the rejected GhAuthError-keyed
   alternative.

## Testing Strategy

- **Unit** `ci-verdict.test.ts` — `startup_failure` → `not-passed`, `stale` →
  `not-passed`; `skipped`/`neutral` still ignored; existing green/pending rows
  unchanged (SC-005).
- **Unit** `ci-merge-readiness.test.ts` — `source==='actions-runs'` + would-be green →
  `not-passed` (FR-007); `source==='check-runs'` + green → green; unusable headSha
  never triggers a readout (SC-004 companion).
- **Integration** `phase-loop.ci-merge-gate.test.ts` — `not-passed` verdict →
  `{ completed:false, gateHit:true }`, no `completed:validate`, reason comment
  attempted (SC-001/SC-003/FR-009); no `onWorkflowComplete`/`markReadyForReview` on the
  red path (SC-002); `getCurrentCommitSha` throw → fast-fail pause, no `getCiRunsForSha`
  call (SC-004); flag-off byte-identical (SC-006, existing tests remain green).

## Next Step

`/speckit:tasks` to generate the task list.
