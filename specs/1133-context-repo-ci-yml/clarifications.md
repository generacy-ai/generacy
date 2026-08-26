# Clarifications: Merge readiness — CI skipped≠passed, validate/CI parallel semantics, post-validate approval gate

**Issue**: [generacy-ai/generacy#1133](https://github.com/generacy-ai/generacy/issues/1133)

## Batch 1 — 2026-08-20

### Q1: CI-wait timeout ceiling and on-timeout behavior
**Context**: FR-004 requires a bounded backoff wait when `validate` succeeds but CI is still pending, and the Assumptions say "on timeout the workflow pauses/escalates rather than declaring green." Neither the concrete ceiling nor the exact terminal state is specified, and this directly determines the wait loop's exit condition and which label a stalled PR lands on.
**Question**: What is the CI-wait timeout ceiling, and what terminal state should the worker enter when it is hit?
**Options**:
- A: Fixed default (e.g. 15 min) that reuses/derives from `phaseTimeoutMs`; on timeout pause with a new `waiting-for:ci` (or similar) gate + `agent:paused` so a human can inspect/re-arm.
- B: Fixed default, but on timeout apply a terminal `blocked:ci-timeout` label (no auto-resume, matches the legacy fixer-timeout escalation style).
- C: Configurable per-workflow key (e.g. `ciWaitTimeoutMs`) with a default; terminal state same as A (pause + resumable gate).

**Answer**: C — Configurable per-workflow `ciWaitTimeoutMs` with a sane default; on timeout pause with a resumable `waiting-for:ci`-style gate + `agent:paused`. Never declares green on pending.

### Q2: Identifying "the CI run" among workflow runs for the head SHA
**Context**: FR-002 uses `actions/runs?branch=<head>` filtered to the PR head SHA, but that endpoint returns *all* workflow runs (CI plus any other workflow) for the branch. The readiness verdict depends on which runs count and how multiple runs combine.
**Question**: When multiple workflow runs exist for the head SHA, which run(s) determine the green/pending/not-passed verdict?
**Options**:
- A: Aggregate ALL runs for the head SHA — green only if every run is `success`; any not-green run blocks (conservative).
- B: Only the run whose workflow name/path matches `ci.yml` (or a configured CI workflow name); ignore other workflows.
- C: Aggregate all runs, but ignore runs that are themselves `skipped`/`neutral` (treat skipped-of-an-unrelated-workflow as non-blocking) — green if every *non-skipped* run is `success` and at least one `success` exists.

**Answer**: C — Aggregate all workflow runs for the head SHA but ignore `skipped`/`neutral` runs; green only if every non-skipped run is `success` and at least one `success` exists (encodes skipped≠passed).

### Q3: Semantics when NO CI run exists for the head SHA
**Context**: The core footgun is unmigrated target repos (FR-008/US4) whose `ci.yml` never triggers on `ready_for_review`, so after the draft→ready flip there is simply no run for the head SHA. The wait loop must decide whether "no run found" is pending (wait then time out), an immediate block, or a distinguishable "CI not configured" state.
**Question**: How should readiness treat "no CI run found for the PR head SHA"?
**Options**:
- A: Treat as pending — wait with backoff; if still none at the timeout, fall into the Q1 timeout terminal state (never declares green).
- B: Treat as not-passed immediately (fail fast) — assume unmigrated repo, block the gate and surface a migration hint, no waiting.
- C: Distinguish: wait a short grace window for a run to appear; if none appears, enter a dedicated "CI not configured" escalation distinct from the pending-timeout path.

**Answer**: A — Treat "no CI run found" as pending: wait with backoff; if still none at the Q1 timeout, enter the Q1 resumable-pause terminal state. Never declares green.

### Q4: Gate placement mechanism and resume position
**Context**: FR-005/FR-006 require moving `implementation-review` (currently `{ phase: 'implement', resumeFrom: 'validate' }` at `phase-resolver.ts:15`, gate def at `config.ts:169`) to a post-validate position, and resuming must not re-run `validate` or `implement`. There is currently no phase after `validate`, so the mechanism (attach-to-validate vs. new phase/step) and the concrete `resumeFrom` target are undetermined.
**Question**: How should the post-validate gate be modeled in the phase machine?
**Options**:
- A: Keep the gate on the `validate` phase but make it fire only on `validate` completion once CI is confirmed green (CI wait folded into validate's completion); `GATE_MAPPING` resumes at a terminal/no-op position so neither validate nor implement re-runs.
- B: Introduce a new terminal phase (e.g. `merge-readiness`) after `validate` that owns the CI wait and the gate; `resumeFrom` targets that new phase.
- C: Reuse the existing `review`/`remediate` epic machinery (the CI check becomes part of the post-`validate` review-style step) rather than adding a distinct phase.

**Answer**: A — Keep the gate on the `validate` phase, firing on validate completion once CI is confirmed green; `GATE_MAPPING` resumes at a terminal/no-op position so neither validate nor implement re-runs.

### Q5: Feature-flag scope and disabled behavior
**Context**: FR-009 and SC-006 require byte-identical behavior when the path is disabled, and reference mirroring `reviewPhaseEnabled` threading. It is unclear whether CI-gating rides on the *same* `reviewPhaseEnabled` flag or a new independent flag, and what the gate position reverts to when disabled.
**Question**: What flag controls CI-aware merge readiness, and what is the disabled fallback?
**Options**:
- A: Reuse the existing `reviewPhaseEnabled` flag — when off, `implementation-review` stays `{ phase: 'implement', resumeFrom: 'validate' }` exactly as today (no CI check).
- B: Add a new independent flag (e.g. `ciMergeGateEnabled`) so CI-gating can be toggled separately from the review phase; disabled fallback = today's `implement`-phase gate.
- C: New independent flag, but default it ON (opt-out) since skipped≠passed is a safety fix; disabled fallback = today's behavior.

**Answer**: B — Add a new independent flag (`ciMergeGateEnabled`); when disabled, `implementation-review` stays `{ phase: 'implement', resumeFrom: 'validate' }` exactly as today.
