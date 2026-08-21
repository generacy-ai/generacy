# Feature Specification: Red CI must not silently complete the workflow

**Branch**: `1157-severity-critical-p0` | **Date**: 2026-08-21 | **Status**: Draft

## Summary

**Severity: critical (P0).** With `ciMergeGateEnabled` on, a successful `validate`
phase followed by **red CI** terminates the workflow indistinguishably from
success. The `not-passed` CI verdict merely *skips* the `on-ci-green` gate; control
then falls through to `labelManager.onPhaseComplete('validate')`
(`phase-loop.ts:1564`), which grants `completed:validate` — the label #1133's own
comment (`phase-loop.ts:1513-1526`) calls "merge-eligible" for cockpit. The loop
returns `completed: true`, and the non-epic completion flow
(`claude-cli-worker.ts:949-953`) runs `onWorkflowComplete()` and re-marks the PR
ready for review. **No pause, no `waiting-for:*`, no `failed:*`, no comment.**

Concrete failure: a bugfix passes its targeted `validate` (narrow test scope) but
CI fails on lint — the known validate-vs-CI gap that `ciMergeGateEnabled` exists to
close. The issue terminates green-looking with a **red, ready** PR, and the final
human approval gate simply vanishes. Existing tests cover the `skipped`-only and
`green` paths; the `not-passed` terminal path has **no coverage**. Confirmed by two
independent traces during a post-merge review of epic
[generacy-ai/generacy#1120](https://github.com/generacy-ai/generacy/issues/1120).

**Fix direction**: a `not-passed` verdict MUST produce an operator-visible,
recoverable state — a pause with a gate (e.g. `waiting-for:ci` plus a red-CI reason
comment) or a `failed:validate`-class escalation. It must **never** return
`completed: true`.

Related hardening the issue asks to fold in:

1. **`headSha='unknown'` sentinel** (`phase-loop.ts:1278-1295`) — when
   `getCurrentCommitSha()` throws, the code leaves the literal string `'unknown'`
   and polls `commits/unknown/check-runs` for the *entire* `ciWaitTimeoutMs`
   (default 15 min) before a misleading `timeout` pause. Fail fast instead.
2. **`startup_failure` / `stale` conclusions** (`ci-verdict.ts:13-18`) — these real
   CI failures are absent from `FAILING_CONCLUSIONS`, so they fall through to
   `pending` (rule 4) and force the slow 15-min timeout rather than a fast
   `not-passed`.
3. **`actions/runs` fallback blindness** (`gh-cli.ts:1709-1739`) — the
   token-limited fallback path only enumerates GitHub-Actions workflow runs, so
   third-party required checks (e.g. external status contexts) are invisible and can
   yield a false `green`. Document or guard.

Part of follow-up epic
[generacy-ai/generacy#1153](https://github.com/generacy-ai/generacy/issues/1153).
All line refs at `develop` `155b3464`.

## User Stories

### US1: Red CI blocks completion with a recoverable pause (P0)

**As an** operator running a `ciMergeGateEnabled` cluster,
**I want** a workflow whose CI is red after `validate` to pause visibly instead of
completing,
**So that** a broken PR is never marked merge-eligible and the final approval gate
is preserved.

**Acceptance Criteria**:
- [ ] When `validate` succeeds and the CI merge-readiness wait resolves to
      `not-passed`, the phase loop does **not** return `completed: true`.
- [ ] The issue lands in an operator-visible, recoverable state: paused with a
      `waiting-for:*` gate label + `agent:paused` (no terminal `blocked:*`).
- [ ] `completed:validate` is **not** granted on the `not-passed` path (the PR must
      not read as merge-eligible to cockpit).
- [ ] The PR is not left silently "ready" with red CI as a green-looking terminal
      state.
- [ ] A comment naming the red-CI reason is posted to the issue (best-effort; a
      comment failure must not change the pause outcome).

### US2: Missing head SHA fails fast (P1)

**As an** operator,
**I want** an unresolvable head SHA to short-circuit immediately,
**So that** I am not left waiting the full merge-readiness timeout for a misleading
pause.

**Acceptance Criteria**:
- [ ] When `getCurrentCommitSha()` fails (or otherwise yields no usable SHA), the CI
      merge-readiness wait does **not** poll `check-runs` for the literal `'unknown'`
      sentinel for the full window.
- [ ] The condition is surfaced promptly (distinct log + operator-visible pause)
      rather than after `ciWaitTimeoutMs`.

### US3: Hard CI failures resolve promptly (P2)

**As an** operator,
**I want** `startup_failure` and `stale` CI conclusions treated as failures,
**So that** they produce a fast `not-passed` verdict instead of a slow timeout.

**Acceptance Criteria**:
- [ ] `aggregateCiVerdict` classifies `startup_failure` and `stale` as failing
      terminal conclusions (→ `not-passed`), not `pending`.
- [ ] Existing `skipped` / `neutral` (ignored) and `green` behavior is unchanged.

### US4: Fallback-path blindness is guarded or documented (P3)

**As an** operator on a token-limited (`checks:read`-lacking) cluster,
**I want** to know that the `actions/runs` fallback only sees GitHub-Actions runs,
**So that** a false `green` from invisible third-party required checks is either
prevented or clearly understood.

**Acceptance Criteria**:
- [ ] The `actions-runs` fallback path either guards against declaring `green` when
      third-party required checks may be invisible, or the limitation is explicitly
      documented at the readout site and in operator-facing docs.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | A `not-passed` CI merge-readiness verdict on a successful `validate` MUST NOT result in `completed: true`. | P0 | Core P0 fix. |
| FR-002 | The `not-passed` path MUST enter a recoverable, operator-visible paused state (gate label + `agent:paused`), symmetric with the existing `timeout` → `waiting-for:ci` pause. | P0 | Reuses `waiting-for:ci` (Q2 → A); must not be terminal `blocked:*`. On resume, re-runs `validate` (Q3 → A). |
| FR-003 | `completed:validate` (and any other merge-eligible label) MUST NOT be granted on the `not-passed` path. | P0 | Prevents cockpit treating the red PR as merge-eligible. |
| FR-004 | On the `not-passed` pause, a comment naming the red-CI reason MUST be posted to the issue, best-effort (a comment failure MUST NOT alter the pause). | P1 | Mirrors the `remediation-limit` gate-body pattern. |
| FR-005 | When the head SHA cannot be resolved, the CI wait MUST fail fast rather than polling the `'unknown'` sentinel for the full `ciWaitTimeoutMs`. | P1 | `phase-loop.ts:1278-1295`. |
| FR-006 | `aggregateCiVerdict` MUST treat `startup_failure` and `stale` as failing terminal conclusions (→ `not-passed`). | P2 | `ci-verdict.ts` `FAILING_CONCLUSIONS`. |
| FR-007 | The `actions/runs` fallback readout MUST guard against declaring `green` when the token is known to lack `checks:read` (fallback actually used), and document the limitation at the readout site + operator docs otherwise (Q5 → C). | P3 | `gh-cli.ts:1709-1739`. |
| FR-008 | With `ciMergeGateEnabled` off, behavior MUST be byte-identical to today. | P0 | Flag-gated; no regression to non-gated clusters. |
| FR-009 | The `not-passed` terminal path MUST gain automated test coverage (the current gap). | P0 | Alongside existing `skipped`/`green` tests. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Red-CI-after-validate outcome | Paused (recoverable), never `completed: true` | New phase-loop test: `validate` success + `not-passed` verdict asserts `{ completed: false, gateHit: true }` and no `completed:validate` label. |
| SC-002 | Merge-eligibility on red CI | PR never marked merge-eligible / re-marked ready on `not-passed` | Test asserts no `onWorkflowComplete` / `markReadyForReview` on the red path. |
| SC-003 | Operator visibility | 100% of `not-passed` pauses carry a gate label + reason comment | Test asserts gate label applied and comment attempted. |
| SC-004 | Missing-SHA latency | Fast fail, not full-window wait | Test with failing `getCurrentCommitSha()` asserts the wait short-circuits well under `ciWaitTimeoutMs`. |
| SC-005 | Hard-failure verdict | `startup_failure` / `stale` → `not-passed` | Unit test on `aggregateCiVerdict`. |
| SC-006 | No regression when flag off | Byte-identical completion behavior | Existing `ciMergeGateEnabled=false` tests remain green. |

## Clarified Decisions (Batch 1 — 2026-08-21)

- **Recoverable state (Q1 → A)**: the `not-passed` path pauses with a `waiting-for:*`
  gate + `agent:paused` — recoverable, symmetric with the existing timeout pause. No
  terminal `blocked:*`, no `failed:validate`-class escalation, no bounded re-check
  escalation.
- **Gate label identity (Q2 → A)**: the `not-passed` pause reuses the existing
  `waiting-for:ci` label. Red-CI and timeout are disambiguated only by the reason
  comment, keeping a single `GATE_MAPPING['ci']` resume path.
- **Resume semantics (Q3 → A)**: when the gate is satisfied (operator adds the
  `completed:*` label), the workflow re-runs `validate` — re-marks ready, re-waits CI
  on the new head SHA, and re-evaluates the merge gate. Resume never skips straight to
  completion.
- **Head-SHA fast-fail landing (Q4 → A)**: the missing-head-SHA fast-fail lands in the
  same pause state as red CI (reuse the `waiting-for:ci` gate + label), differentiated
  only by the reason comment/log.
- **FR-007 fallback treatment (Q5 → C)**: conservative middle — the `actions/runs`
  fallback guards (never yields `green`) only when the token is known to lack
  `checks:read` (i.e. the fallback was actually used); otherwise the limitation is
  documented at the readout site and in operator docs.

## Assumptions

- `waitForCiGreen` remains the single readiness driver; the fix threads the
  `not-passed` outcome into a pause branch rather than into the `on-ci-green` gate.
- The head-SHA fast-fail surfaces as an operator-visible pause (same class as the
  red-CI pause), not a silent completion.
- Full third-party-check integration is out of scope (see Out of Scope); FR-007 ships
  as documentation + the conservative `checks:read`-gated guard per Q5.

## Out of Scope

- Full third-party / external required-check integration on the token-limited
  fallback path (beyond a guard or documentation).
- Any behavior change on clusters with `ciMergeGateEnabled` off.
- Changing the CI backoff schedule or the default `ciWaitTimeoutMs`.
- Auto-remediating red CI (re-running failed jobs, pushing fixes) — this feature
  only makes the red state visible and recoverable.
- Cockpit-side / cloud-side handling of the new paused state (consumed via the
  existing `waiting-for:*` surface).

---

*Generated by speckit*
