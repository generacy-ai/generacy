# Feature Specification: Review/remediate foundations wired end-to-end (stub executors)

**Branch**: `1123-context-phase-1-integration` | **Date**: 2026-08-19 | **Status**: Draft

## Summary

Phase-1 (P1) integration checkpoint for the epic *engine-native review & remediate phases* (generacy-ai/generacy#1120). The two foundation issues — the phase machinery change (#1121, adds `review` and `remediate` to `WorkflowPhase`) and the per-workflow config change (#1122, adds `maxRemediations` and a review profile keyed per workflow) — must be **proven wired together** before any real review/remediate executor logic lands in P2/P3.

This issue ships no product behavior of its own. It ships **integration tests** that drive a worker phase loop end-to-end with *stub* review/remediate executors, plus a **shipped contract note** that pins the `remediate → review` loop-control seam so Phases 2–3 build against a stable, documented boundary. Contracts live in shipped artifacts (test assertions + a `contracts/` doc or load-bearing code comment), not in a design doc.

## Context

- The `review` phase is linear, entered after `implement`, for both `speckit-feature` and `speckit-bugfix`.
- The `remediate` phase is off-sequence: it is entered via loop control (not by advancing the linear sequence) and **always backtracks to a delta-scoped re-`review`**. This is the seam P2/P3 depend on.
- Per-workflow config (`maxRemediations`: feature 3 / bugfix 2; a review profile) must be observable *inside* the phase loop so later executors can read caps and charter without re-plumbing.
- Cockpit pause/resume and the pause-context round-trip must tolerate the two new phases (label apply/clear, resume-phase resolution) with no stranding.

Depends on: #1121 (phase machinery), #1122 (per-workflow config). This issue integrates them; it does not re-implement either.

### Resolved decisions (clarifications Batch 1, 2026-08-19)

- **Dependency landing (Q1=B)**: #1121 and #1122 merge to `develop` first; this branch is **rebased** on them and ships **only** tests + the contract note. It does not co-land the union/config additions (that would collide with #1121/#1122's own PRs) and does not use test-only doubles (FR-006's audit must run on the real production union). The implement phase blocks until #1121/#1122 land.
- **Remediate entry seam (Q2=C)**: `remediate` is entered via a **direct loop-control return value** from the phase-loop step contract — a new discriminated outcome (e.g. `{ next: 'remediate' }`) independent of any review verdict. This general loop-control outcome is the seam-of-record; it is designed to serve all three future remediate entry points (review verdict, validate failure, external PR feedback), which P3 will converge onto it. No `waiting-for:remediation` gate/label drives entry.
- **Resume-after-pause target (Q3=A)**: pausing mid-`remediate` and resuming resolves back to **`remediate`** (re-enter the remediation step; the pause-context sidecar resumes the exact interrupted phase, per merge-conflict precedent). It does **not** resolve to `review`.
- **Per-workflow config surface (Q4=B)**: `maxRemediations` and the review profile live in `@generacy-ai/config` (OrchestratorSettings, per #1122 Q1) and are read inside the loop via the config object the worker already holds (resolved by a `worker/config.ts` resolver, per #1122 Q4). They are **not** a new `WorkerConfig` field and **not** a new injected loop dependency.
- **Stage + gate naming (Q5=C)**: stage/gate naming is **deferred to the plan phase**. Per #1121 FR-002, `review`/`remediate` map to the `implementation` stage (no new `StageType`). Review is autonomous — the only human gates in the design are remediation-limit and final approval — so no `waiting-for:review` gate is invented here. The P1 tests assert only *that* the companion enumerations have entries for the new phases and round-trip, not their specific stage/label names.

## User Stories

### US1: Engine developer proves the phase loop traverses review and remediate

**As a** developer building the review/remediate executors (P2/P3),
**I want** an integration test that runs the worker phase loop with stub executors through `implement → review`, then off-sequence into `remediate` and back to a re-`review`,
**So that** I can build real executor logic against a phase loop that is already proven to sequence, backtrack, and surface per-workflow config correctly.

**Acceptance Criteria**:
- [ ] For both `speckit-feature` and `speckit-bugfix`, the loop schedules `review` immediately after `implement`.
- [ ] `remediate` is reachable off the linear sequence and, on completion, control returns to a `review` pass (not to the next linear phase).
- [ ] `maxRemediations` and the review profile for the active workflow are readable inside the loop (feature=3, bugfix=2) and differ per workflow.

### US2: Operator's pause/resume survives the new phases

**As an** operator (or `/cockpit:auto`) pausing and resuming work on an issue that is in `review` or `remediate`,
**I want** cockpit resume + the pause-context round-trip to resolve back to the correct phase and to apply/clear the right labels,
**So that** an issue paused mid-review or mid-remediate is never stranded and never resumes at the wrong phase.

**Acceptance Criteria**:
- [ ] Pausing in `review` and resuming lands the loop back at `review` (gate/label round-trip intact).
- [ ] Pausing in `remediate` and resuming lands the loop back at `remediate` (re-enter the remediation step — resolved per Q3=A).
- [ ] `waiting-for:*` / `phase:*` / `agent:*` labels for the new phases apply and clear symmetrically — no residual label after resume.

### US3: The phase union cannot silently drift out of sync

**As a** maintainer,
**I want** a test that fails if the `WorkflowPhase` union and every structure that must enumerate all phases (sequence, stage map, gate mapping) fall out of sync,
**So that** adding `review`/`remediate` (or any future phase) forces every companion table to be updated, closing the class of bug where a phase exists in the union but is missing from a lookup.

**Acceptance Criteria**:
- [ ] A test asserts the phase-union is exhaustively covered by the phase sequence(s) and the phase→stage map (and any other total `Record<WorkflowPhase, …>`).
- [ ] Removing `review` or `remediate` from any one companion table makes the audit test fail.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | An integration test drives the worker phase loop end-to-end with **stub** review and remediate executors (no real review/remediation behavior). | P1 | Stubs return a controllable verdict/outcome so the harness can steer loop control. |
| FR-002 | For both `speckit-feature` and `speckit-bugfix`, the loop sequences `review` immediately after `implement`. | P1 | Asserted per workflow. |
| FR-003 | `remediate` is reachable off-sequence via a **direct loop-control return value** (a discriminated step outcome, e.g. `{ next: 'remediate' }`, independent of any review verdict — Q2=C) and, on completion, backtracks to a `review` pass rather than advancing the linear sequence. | P1 | This is the loop-control seam of record; designed to serve all three future remediate entry points. |
| FR-004 | Per-workflow config values (`maxRemediations`, review profile) are observable inside the phase loop — read via the `@generacy-ai/config` OrchestratorSettings object the worker already holds (Q4=B), not a new `WorkerConfig` field — and resolve to the correct per-workflow values (feature 3 / bugfix 2). | P1 | Proves #1122 is wired into the loop, not just parsed. |
| FR-005 | Cockpit resume + the pause-context round-trip correctly resolve `review` (back to `review`) and `remediate` (back to `remediate`, Q3=A) to their phases, with labels applied and cleared symmetrically. Stage/gate label names are deferred to plan (Q5=C); the test asserts entries exist and round-trip, not their specific names. | P1 | Covers gate mapping / resume-phase resolution for the new phases. |
| FR-006 | A phase-union sync audit is codified as a test (if not already present), failing on drift between the `WorkflowPhase` union and every companion enumeration. | P1 | Requirements say "if not already done" — confirm coverage; add only what is missing. |
| FR-007 | A shipped contract note (a `contracts/` doc and/or a load-bearing code comment at the seam) captures the `remediate → review` loop-control contract that P2/P3 build on. | P1 | The durable acceptance artifact. |
| FR-008 | No real review/remediate executor logic, PR posting, severity gating, or CI/validate orchestration is introduced. | P1 | Those are P2–P4; this issue is stubs + wiring proof only. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Integration tests for the review/remediate wiring pass in CI. | Green | CI run on the PR. |
| SC-002 | Both workflows sequence `review` after `implement` and reach `remediate → review` backtrack. | 2/2 workflows | Test assertions in the harness. |
| SC-003 | Per-workflow config caps are observed inside the loop. | feature=3, bugfix=2 | Assertion reading config within the loop. |
| SC-004 | Pause/resume of `review` and `remediate` round-trips with no residual labels. | 0 stranded labels | Label-state assertion before/after resume. |
| SC-005 | The phase-union audit test fails when any companion enumeration omits a phase. | Fails on drift | Mutation check during review (drop a phase from one table → red). |
| SC-006 | A `remediate → review` seam contract ships in the diff. | 1 artifact | `contracts/` doc or code comment present in the PR. |

## Assumptions

- #1121 and #1122 are merged to `develop` **first** and this branch is rebased on them (Q1=B); this issue ships only tests + the contract note and does not modify their public surface, co-land the union/config additions, or use test-only doubles. The implement phase blocks until #1121/#1122 land.
- Stub executors are test-only doubles injected through the existing phase-loop dependency seams — no production executor files ship here.
- "Review profile" is whatever per-workflow shape #1122 defines (e.g., a verification-vs-full charter selector); this issue only asserts it is *observable and per-workflow*, not its semantics.
- The pause-context round-trip reuses the existing pause/resume and gate-mapping machinery; the new phases slot into it without a new persistence mechanism.
- Where a phase-union audit already exists, this issue extends it to cover the new phases rather than adding a duplicate.
- `review`/`remediate` map to the `implementation` stage (#1121 FR-002); stage/gate label names are deferred to plan (Q5=C). Review is autonomous — no `waiting-for:review` gate is introduced; the only human gates in the broader design are remediation-limit and final approval.

## Out of Scope

- Real review executor: structured findings, engine-internal verdict, PR review posting, draft/ready lifecycle (P2 — #1124/#1125/#1126/#1127).
- Real remediate executor: remediation counter enforcement, `waiting-for:remediation-limit` gate, retiring the validate-fix handler, PR-feedback routing, merge-conflict re-arm (P3 — #1128–#1132).
- Merge readiness, validate/CI parallelism, post-validate approval gate, bugfix targeted-validate profiles (P4).
- Any `/cockpit:auto` playbook slimming (agency#500) or docs/rollout (#1136).
- Severity gating (`blockingSeverity`), re-review convergence rules, and delta-scoping semantics beyond the bare `remediate → review` backtrack.

---

*Generated by speckit*
