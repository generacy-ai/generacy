# Feature Specification: Remediate phase executor — remediation counter + remediation-limit gate

**Branch**: `1128-context-remediate-single-code` | **Date**: 2026-08-20 | **Status**: Draft

## Summary

Replace the inert `remediate`-phase stub (`runStubPhase('remediate')` in `phase-loop.ts`, landed by #1121) with a real agent phase executor — the single code-change loop for review findings and validate failures. On each entry, the executor consumes the open blocking findings in the review artifact (and/or validate-failure evidence), makes code changes, and commits/pushes through the existing phase commit plumbing. It **never** resolves review threads itself — that bookkeeping belongs to the verification pass (the re-`review` round). After a remediate pass the loop backtracks to `review`, exactly as the #1121 seam already does.

The loop is bounded by an explicit **remediation counter**: one execution = one remediation, regardless of how many findings that execution addressed. The counter is persisted in the review sidecar and capped by the per-workflow `maxRemediations` (feature `3`, bugfix `2`). At the cap the workflow raises a proper human gate — `waiting-for:remediation-limit` + `agent:paused` — whose body surfaces the remaining open findings. An operator answer (`completed:remediation-limit`, following the gate-satisfaction convention at `phase-loop.ts:1163`) resumes into `remediate` and **resets the counter**. There is no terminal `blocked:*` label — the well-known failure mode of the legacy fixer (`blocked:stuck-feedback-loop` strands the loop until a human removes a label at `pr-feedback-handler.ts` / `pr-feedback-monitor-service.ts`) is deliberately avoided.

## Context

Part of epic generacy-ai/generacy#1120 (engine-native review & remediate phases). Full design: `docs/engine-review-remediate-plan.md` in generacy-ai/tetrad-development; a condensed design summary lives in the epic body.

Prerequisites already merged:

- **#1121** — phase machinery: `review` in `PHASE_SEQUENCE` (after `implement`, before `validate`), `remediate` as an off-sequence phase, the `runStubPhase()` inert executor, and the `PhaseLoopDeps.remediateTrigger?(context)` seam that runs `remediate` and re-enters `review` (`phase-loop.ts:1270-1284`).
- **#1124** — review executor + artifact: the engine writes a Zod-validated sidecar at `<checkoutPath>/.generacy/review-findings-<sanitized-workflowId>.json` (`review-artifact.ts`) carrying `findings[]` (with `severity`, `file`, `line?`, `title`, `detail`, `round`, `status: open|resolved`), an engine-computed `verdict` (`clean|changes-required`), `round`, and `lastReviewedCommitSha`. `remediateTrigger` reads the sidecar's verdict synchronously. The `on-remediation-limit` gate condition and the `waiting-for:remediation-limit` label already exist; the gate currently keys on the review `round` (`phase-loop.ts:1122-1147`).
- **#1125 / #1126** — PR review posting + draft/ready lifecycle + re-review convergence.

This issue supplies the `remediate` executor, the explicit remediation counter and its reset-on-resume semantics, the gate-body enrichment, and the `phase-resolver.ts` gate-mapping so an operator answer resumes into remediation. It does **not** change the `review` executor, the verdict computation, or the PR-posting path.

## Lessons carried from the legacy fixer (must not regress)

- `blocked:stuck-feedback-loop` strands the loop until an operator manually removes a label (`worker/pr-feedback-handler.ts`, monitor skip at `services/pr-feedback-monitor-service.ts`). The new gate is a *resumable* `waiting-for:*` gate, not a terminal `blocked:*` label.
- The 20-min CLI timeout leaves pushed-but-unresolved state. The remediate executor must be partial-work-safe: partial commits stay pushed, the artifact stays consistent, and the next entry continues rather than restarts.

## User Stories

### US1: Engine-driven code remediation of review findings (P1)

**As** the orchestrator worker driving a speckit workflow,
**I want** the `remediate` phase to run an agent that makes code changes addressing the open blocking findings (and/or validate-failure evidence) and commits/pushes them,
**So that** review-detected problems are fixed inside the engine loop without an operator, and the subsequent re-`review` round can verify and resolve threads.

**Acceptance Criteria**:
- [ ] When `remediate` executes, the CLI is spawned with an in-process prompt built from the open blocking findings in the review artifact. (Validate-failure evidence is deferred to #1129 per clarification Q2; the prompt is structured so it can be admitted later.)
- [ ] Code changes produced during `remediate` are committed and pushed via the existing phase commit plumbing (the path that `implement`/other phases use).
- [ ] The executor never resolves review threads and never marks the PR ready — that is the re-`review` round's job.
- [ ] After a `remediate` pass, the loop backtracks to `review` (the #1121 seam behavior is preserved).

### US2: Bounded loop via an explicit remediation counter and cap gate (P1)

**As** the phase loop,
**I want** a remediation counter that increments once per `remediate` execution and, on reaching the per-workflow `maxRemediations`, raises a human gate instead of looping forever,
**So that** an unfixable finding pauses for a human rather than burning cycles.

**Acceptance Criteria**:
- [ ] One `remediate` execution increments the remediation counter by exactly one, independent of how many findings it addressed.
- [ ] The counter is persisted in the review sidecar.
- [ ] The cap is the per-workflow `maxRemediations` (`speckit-feature` → 3, `speckit-bugfix` → 2), sourced from `resolveWorkflowOverrides`.
- [ ] At the cap, the workflow pauses with `waiting-for:remediation-limit` + `agent:paused`; no terminal `blocked:*` label is applied.
- [ ] The gate body surfaces the remaining open findings so an operator can triage.

### US3: Operator resume resets the counter and converges (P1)

**As** an operator,
**I want** to answer the remediation-limit gate and have the workflow resume into `remediate` with a fresh counter,
**So that** after I unblock the underlying issue the loop can make progress again from zero rather than immediately re-hitting the cap.

**Acceptance Criteria**:
- [ ] Adding `completed:remediation-limit` resumes the workflow into the remediate loop (via `phase-resolver.ts` gate mapping).
- [ ] On resume, the remediation counter is reset (a fresh cap budget).
- [ ] The gate-satisfaction convention at `phase-loop.ts:1163` (`waiting-for:X` satisfied by `completed:X`) is honored.

### US4: Partial-work-safe on timeout (P1)

**As** the phase loop,
**I want** a `remediate` execution that times out mid-work to leave a consistent, resumable state,
**So that** the next entry continues from pushed partial work rather than restarting or losing it.

**Acceptance Criteria**:
- [ ] If the CLI times out after producing partial changes, those changes are committed and pushed (not discarded).
- [ ] The review sidecar / counter remain in a valid, parseable state after a timeout.
- [ ] The next remediate entry continues the loop (re-review then remediate again) rather than restarting from scratch.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add a real `remediate` phase executor invoked from the off-sequence seam in `phase-loop.ts` in place of `runStubPhase('remediate')`. Spawn the CLI via `agentLauncher.launch()` directly (mirroring `review-executor.ts`, since `cli-spawner` type-excludes `remediate`). | P1 | |
| FR-002 | Build the remediation prompt in-process from the open blocking findings in the review artifact (`status: open` at/above the profile's `blockingSeverity`). No new slash command; `PHASE_TO_COMMAND` is not extended. **[Clarified Q2]** This issue is driven by review findings only; validate-failure evidence is out of scope (deferred to #1129). Build the prompt so validate-failure evidence can be admitted later without restructuring. | P1 | Mirrors #1124 FR-002 charter-prompt approach. |
| FR-003 | Commit and push any changes produced during `remediate` via the existing phase commit plumbing (`prManager.commitPushAndEnsurePr` or the equivalent path). | P1 | Off-sequence seam currently commits nothing. |
| FR-004 | The `remediate` executor must never resolve review threads and never mark the PR ready. | P1 | Verification/bookkeeping belongs to the re-`review` round. |
| FR-005 | Maintain an explicit remediation counter as a **distinct** sidecar field `remediationCount` (not `round`): one `remediate` execution increments it by exactly one, regardless of finding count. **[Clarified Q4]** Timed-out executions increment too. Persist it in the review sidecar; `round` stays monotonic. | P1 | Distinct from review `round` because it is reset on resume (FR-009); `round` monotonicity is required by #1126. |
| FR-006 | Cap the counter at the per-workflow `maxRemediations` (`speckit-feature` → 3, `speckit-bugfix` → 2) from `resolveWorkflowOverrides`. | P1 | Reuses the existing config surface. |
| FR-007 | At the cap, raise the gate `waiting-for:remediation-limit` + `agent:paused` and pause the workflow. No terminal `blocked:*` label anywhere in this path. **[Clarified Q5]** The gate-activation predicate is `remediationCount >= maxRemediations && verdict === 'changes-required'` — the verdict conjunct is retained so a `clean` review on the cap round proceeds to `validate` rather than pausing. | P1 | The `on-remediation-limit` gate condition already exists (`phase-loop.ts:1122`); this re-keys it to the remediation counter. |
| FR-008 | The remediation-limit gate body surfaces the remaining open findings (file/line/title of each `status: open` finding). | P1 | Enough for an operator to triage. |
| FR-009 | An operator answer of `completed:remediation-limit` resumes into the remediate loop and resets `remediationCount` to 0 (a fresh budget). **[Clarified Q3]** The reset happens in the sidecar at the gate-satisfaction check when `completed:remediation-limit` is detected, and the completed label is cleared there so the gate re-arms. | P1 | Honors the `waiting-for:X` → `completed:X` satisfaction convention. |
| FR-010 | **[Clarified Q3]** Keep `GATE_MAPPING['remediation-limit'] = { phase: review, resumeFrom: review }` — `remediate` is off-sequence (absent from `PHASE_SEQUENCE`) so `resumeFrom` must be a real sequence phase. On resume the loop re-enters `review`, which re-establishes findings state, and the existing seam drives `remediate` with the reset counter. | P1 | No "resume directly into remediate" option — the resolver requires a real sequence phase. |
| FR-011 | Partial-work safety on timeout: commit + push partial changes, keep the sidecar/counter consistent, and let the next entry continue rather than restart. | P1 | Carries the legacy-fixer lesson. |
| FR-012 | After each `remediate` pass, backtrack to `review` (preserve the #1121 seam's `i--; continue;` behavior). | P1 | Unchanged behavior, now with a real executor. |
| FR-013 | With `reviewPhaseEnabled=false`, behavior is byte-identical to today (both `review` and `remediate` absent from the effective path). | P1 | The `remediate` executor never runs when the phase is gated out. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Counter increments once per execution | A single `remediate` pass over N findings increments the counter by 1 | Unit test on the counter update. |
| SC-002 | Cap raises the gate | When the counter reaches `maxRemediations` with open blocking findings remaining, `waiting-for:remediation-limit` + `agent:paused` are applied and the loop pauses | Unit/integration test on the gate path. |
| SC-003 | Resume resets the counter | After `completed:remediation-limit`, the loop resumes into remediate with a reset counter (fresh cap budget) | Unit test on the reset semantics + integration resume test. |
| SC-004 | Loop converges | `review(changes-required) → remediate → re-review` reaches `clean` and proceeds toward `validate` within the cap when findings are fixable | Integration harness. |
| SC-005 | No terminal blocked label | No `blocked:*` label is applied anywhere in the remediate/cap path | Assertion in the gate-path test. |
| SC-006 | Partial work survives timeout | After a simulated timeout with partial changes, the changes are pushed and the next entry continues (not restarts) | Integration test with a timeout fixture. |
| SC-007 | Flag disabled = no-op | With `reviewPhaseEnabled=false`, observable output identical to pre-change | Existing byte-identity assertion (#1121). |

## Assumptions

- The review artifact schema and read/write helpers (`review-artifact.ts`: `readReviewArtifact`, `readReviewArtifactSync`, `writeReviewArtifact`, `computeVerdict`) already exist and are reused; the counter is added as a field on that same sidecar.
- The per-workflow `maxRemediations` surface (`resolveWorkflowOverrides` → `{ maxRemediations }`, `defaultMaxRemediations`) already exists and is not re-implemented.
- The `waiting-for:remediation-limit` label and the `on-remediation-limit` gate condition already exist (#1124); this issue re-keys the gate to the remediation counter and enriches the gate body.
- `completed:remediation-limit` follows the existing gate-satisfaction convention; if the label needs registration in `label-definitions.ts` for monitor/cockpit recognition, that is part of this work.
- The remediation prompt trusts the agent to make code changes; correctness is verified by the subsequent re-`review` round, not by `remediate` itself.
- **[Clarified Q1]** The resettable remediation counter is a **distinct** sidecar field (`remediationCount`), independent of the review `round`. `round` stays strictly monotonic for #1126 delta-scoped re-review; only `remediationCount` resets on resume. The two run on independent cadences.
- **[Clarified Q4]** Every `remediate` execution increments `remediationCount` by exactly one, including executions that time out mid-work. A timeout is a real partial-work-committing attempt, so a persistently stuck loop reaches the cap and pauses rather than looping forever.

## Out of Scope

- The `review` phase executor, verdict computation, and PR-review posting (#1124/#1125/#1126 — unchanged).
- Resolving review threads or marking the PR ready from within `remediate` (explicitly forbidden; done by the re-`review` round).
- Any use of GitHub review state (`APPROVE`/`REQUEST_CHANGES`/`COMMENT`) as a signal in the remediate path.
- Bugfix-specific charter/prompt content beyond selecting the workflow's `maxRemediations` cap (lands with the bugfix-profiles issue if separate).
- Cloud-side or cockpit-side surfacing of the remediation counter or gate body.

---

*Generated by speckit*
