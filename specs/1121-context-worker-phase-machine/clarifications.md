# Clarifications: Add `review` and `remediate` to the workflow phase machinery

**Issue**: generacy-ai/generacy#1121

## Batch 1 — 2026-08-19

### Q1: Feature-flag vs no-op stub (behavior-identity)
**Context**: The spec says the stub "returns success **and/or** is feature-flagged off." These are materially different: a no-op success stub that still *executes* would emit a `phase:review` label + implementation-stage comment / journal `phase_start`/`phase_complete` entries, which is an observable difference and would violate SC-004 / FR-009 ("same labels, comments, PR state"). A feature flag defaulting OFF skips `review` entirely so nothing observable changes.
**Question**: How should the inert `review` phase behave in a live feature/bugfix run for this issue?
**Options**:
- A: Feature flag defaulting **OFF** — `review` is present in the type/sequence but skipped at execution, guaranteeing zero observable change (labels/comments/journal untouched).
- B: Always **execute as a no-op success stub** — accept the new `phase:review`/`completed:review` labels and stage/journal activity as the new (documented) baseline.
- C: Execute the stub but **suppress all side effects** (no labels, no stage comment, no journal entries) so it is observationally silent while still "running."

**Answer**: A — Feature flag defaulting **OFF**. `review` is present in the type/sequence but skipped at execution, guaranteeing zero observable change (labels/comments/journal untouched). SC-004/FR-009 require byte-identical labels/comments/PR-state; an executing no-op stub (B) would emit `phase:review`/`completed:review` labels + stage/journal entries (observable diff), and suppress-side-effects (C) is a fragile every-callsite carve-out. US1 Acceptance Scenario 4 blesses the "skipped when feature-flagged off" path.

### Q2: Existing implementation-review gate interaction
**Context**: For `speckit-feature`, `implement` currently always pauses at `waiting-for:implementation-review` (config.ts:92); `speckit-bugfix` pauses `on-request`. Inserting a linear `review` phase after `implement` raises the question of whether that human gate moves or is duplicated.
**Question**: For this plumbing-only issue, what happens to the existing `waiting-for:implementation-review` gate on `implement`?
**Options**:
- A: Leave the gate exactly where it is (on `implement`, unchanged); the new `review` phase ships with **no gate** of its own. Preserves behavior-identity; gate migration is a later epic issue.
- B: Move / re-key the implementation-review gate onto the new `review` phase now.
- C: Add a **new** gate for `review` alongside the existing `implement` gate.

**Answer**: A — Leave the gate exactly where it is (on `implement`, unchanged); the new `review` phase ships with **no gate** of its own. The implementation-review gate migration (post-implement → final post-validate approval) is deferred to a later epic phase; P1 is plumbing-only, and moving/duplicating the gate now (B/C) would change observable pause behavior and break behavior-identity.

### Q3: Label vocabulary scope for the new phases
**Context**: `WORKFLOW_LABELS` defines per-phase families: `phase:*`, `completed:*`, `failed:*`, and `failed:*-repeated`. FR-006 says "as needed by the phase→label machinery" without enumerating which families the new phases require.
**Question**: Which label families should be added for `review` and `remediate` in this issue?
**Options**:
- A: All phase-progress families for both phases: `phase:`, `completed:`, `failed:`, and `failed:-repeated` (parity with existing phases). No new `waiting-for:` gate labels.
- B: Phase-progress families **plus** a new `waiting-for:` gate label (e.g. `waiting-for:review`) in anticipation of the gate wiring.
- C: Minimal — only the labels the phase→label machinery actually references at runtime for an inert phase (likely `phase:review`/`phase:remediate` + `completed:*`), deferring `failed:*` until executors exist.

**Answer**: A — All phase-progress families for both phases: `phase:`, `completed:`, `failed:`, and `failed:-repeated` (parity with existing phases). No new `waiting-for:` gate labels. LabelManager derives these families uniformly per phase (purely additive), and the label-protocol-audit runtime probe iterates `PHASE_SEQUENCE` (which now contains `review`), so `phase:review`/`completed:review` must be registered anyway. Omitting `waiting-for:` gate labels is consistent with Q2=A (review ships gate-less).

### Q4: Remediate production reachability
**Context**: `remediate` is off-sequence and its real triggers (review verdict, validate-failure routing, PR-feedback) are explicitly out of scope. US2's independent test exercises the seam via a unit test.
**Question**: In this issue, is `remediate` reachable **only** structurally/in tests (never entered during a real feature/bugfix run), with no production code path firing the seam?
**Options**:
- A: Yes — the loop *supports* off-sequence `remediate` + return-to-`review`, but **no production trigger** fires it this issue; it is dead in real runs and only reachable via the unit test.
- B: No — wire a minimal always-off production trigger (e.g. behind the same feature flag as Q1) so the seam is exercised in a real run too.

**Answer**: A — Yes. The loop *supports* off-sequence `remediate` + return-to-`review`, but **no production trigger** fires it this issue; it is dead in real runs and only reachable via the unit test. The spec's Out of Scope excludes the concrete triggers that decide when to enter `remediate`; US2's independent test exercises the seam. With Q1's flag OFF, any wired trigger (B) would be dead anyway, adding surface for no benefit.

### Q5: Exhaustiveness audit codification (SC-003)
**Context**: SC-003 requires "no stale phase-literal duplication site … verified by a grep/exhaustiveness audit, codified as an automated test **where feasible**." "Where feasible" leaves the deliverable ambiguous.
**Question**: Is a committed automated test required, or is the bar "compile-time exhaustiveness + a documented grep" acceptable where a runtime test is impractical?
**Options**:
- A: Require a committed automated test that enumerates the duplication sites and fails when one drifts (best-effort coverage of the sites reachable at runtime).
- B: Rely primarily on TypeScript exhaustiveness (`Record<WorkflowPhase, …>` etc.) plus a documented grep in the PR; add a runtime test only for sites a compiler can't catch.

**Answer**: A — Require a committed automated test that enumerates the duplication sites and fails when one drifts (best-effort coverage of the sites reachable at runtime). SC-003's intent is a durable regression guard; a one-time grep-in-PR (B) cannot provide that, and TS `Record<WorkflowPhase, …>` exhaustiveness only catches the map sites, not the ~10 hand-maintained Zod-enum/literal-union sites. The codebase already establishes this pattern (`label-protocol-audit.test.ts` / `phase-tracker-audit.test.ts`).
