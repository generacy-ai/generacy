# Feature Specification: Add `review` and `remediate` to the workflow phase machinery

**Branch**: `1121-context-worker-phase-machine` | **Date**: 2026-08-19 | **Status**: Draft
**Issue**: generacy-ai/generacy#1121 | **Epic**: generacy-ai/generacy#1120 (engine-native review & remediate phases)

## Summary

The worker phase machine is a serial sequence of `WorkflowPhase` literals (`specify → clarify → plan → tasks → implement → validate`) defined in `packages/orchestrator/src/worker/types.ts` and duplicated as string-literal unions/enums across ~10 sites in five packages. This feature adds two new phases to that machinery:

- **`review`** — a *linear* phase inserted after `implement` in the `speckit-feature` and `speckit-bugfix` sequences (speckit-epic unchanged).
- **`remediate`** — a *first-class but off-sequence* phase, never present in any linear `WORKFLOW_PHASE_SEQUENCES` entry. It is entered only via loop control (a `review` verdict with blocking findings, a `validate` failure, or external PR feedback) and control returns to `review` after each `remediate`.

This issue delivers **type / config / label plumbing plus stub execution wiring** only. Real executors for the two phases land in later epic issues. After this change everything compiles, existing feature/bugfix/epic runs behave identically, and the two new phases are inert (stub returns success and/or is feature-flagged off).

## Context

Because the phase name is duplicated as a hand-maintained literal union or Zod enum across many files, adding a phase requires a coordinated edit at every site or the build/tests break (or worse, a site silently drifts). The enumerated duplication sites from the issue:

- `packages/orchestrator/src/worker/types.ts` — `WorkflowPhase` union (:9), `PHASE_SEQUENCE` / `WORKFLOW_PHASE_SEQUENCES` (:50–52), `PHASE_TO_STAGE` (:80).
- `packages/orchestrator/src/worker/config.ts` — `GateDefinitionSchema` phase enum (:18) and agents `phases` keys (:225).
- `packages/orchestrator/src/worker/pause-context.ts` — `WorkflowPhaseSchema` (:28–35).
- `packages/orchestrator/src/config/loader.ts` — overridable phases (:243).
- `packages/config/src/template-schema.ts` — strict phase keys (:40–47).
- `packages/generacy/src/cli/commands/cockpit/resume.ts` — phase handling (:54–61).
- `packages/orchestrator/src/launcher/types.ts` — phase literals (:35).
- `generacy-plugin-claude-code/src/launch/types.ts` — phase literals (:30).
- `packages/workflow-engine/src/types/github.ts` — `CorePhase` (:190–193).
- `packages/workflow-engine/src/actions/github/label-definitions.ts` — label vocabulary.

## Clarifications

### Session 2026-08-19

- Q: How should the inert `review` phase behave in a live feature/bugfix run? → A: **Feature flag defaulting OFF** — `review` is present in the type/sequence but skipped at execution, guaranteeing zero observable change (labels/comments/journal untouched). (No-op-that-executes and suppress-side-effects rejected as observable diffs / fragile carve-outs.)
- Q: What happens to the existing `waiting-for:implementation-review` gate on `implement`? → A: **Leave it unchanged on `implement`**; the new `review` phase ships with **no gate** of its own. Gate migration is a later epic issue.
- Q: Which label families for `review` and `remediate`? → A: **All phase-progress families** (`phase:`, `completed:`, `failed:`, `failed:-repeated`) for both, parity with existing phases. **No** new `waiting-for:` gate labels.
- Q: Is `remediate` reachable only structurally/in tests this issue? → A: **Yes** — the loop supports the off-sequence seam + return-to-`review`, but **no production trigger** fires it; it is dead in real runs and only reachable via the unit test.
- Q: What is the SC-003 exhaustiveness-audit deliverable? → A: **A committed automated test** that enumerates the duplication sites and fails when one drifts (following the existing `label-protocol-audit.test.ts` / `phase-tracker-audit.test.ts` pattern).

## User Scenarios & Testing

### User Story 1 - New phases exist end-to-end without behavior change (Priority: P1)

As a platform engineer building the engine-native review/remediate epic, I want `review` and `remediate` present in every phase-machinery site with `review` linear (after `implement`) and `remediate` off-sequence, so that later issues can wire real executors against a compiling, type-safe machine while every existing workflow runs identically.

**Why this priority**: This is the foundational plumbing for the entire #1120 epic. Nothing downstream can land until the phase vocabulary exists consistently across all packages.

**Independent Test**: Run `pnpm -r build` and the full test suite across orchestrator, config, cockpit, launcher, and workflow-engine — all green. Run an existing `speckit-feature` and `speckit-bugfix` workflow and confirm behavior is identical to before (new phases inert).

**Acceptance Scenarios**:

1. **Given** the `WorkflowPhase` union, **When** the code is type-checked, **Then** `review` and `remediate` are valid members and every `Record<WorkflowPhase, …>` (e.g. `PHASE_TO_STAGE`) is exhaustive without a compile error.
2. **Given** `WORKFLOW_PHASE_SEQUENCES`, **When** `getPhaseSequence('speckit-feature')` and `getPhaseSequence('speckit-bugfix')` are called, **Then** the returned sequence contains `review` immediately after `implement`, and `remediate` appears in no sequence.
3. **Given** `getPhaseSequence('speckit-epic')`, **When** called, **Then** the returned sequence is unchanged (`specify, clarify, plan, tasks`).
4. **Given** an existing feature/bugfix run reaching the end of `implement`, **When** the loop advances, **Then** the `review` stub executes, returns success (or is skipped when feature-flagged off), and the run completes with no observable difference from prior behavior.

### User Story 2 - Off-sequence remediate loop-control seam (Priority: P2)

As an engine developer, I want the phase loop to support entering `remediate` off-sequence and backtracking to `review` afterward, so that a later issue's real executor can drive the review↔remediate cycle without re-architecting the loop.

**Why this priority**: The loop seam must exist for the epic to progress, but the trigger conditions and real executors are out of scope here — only the mechanical seam and stub wiring ship now.

**Independent Test**: Exercise the loop seam via the existing `startPhase` resume and `i--` backtrack precedent so a stubbed `remediate` can be entered and control returns to `review`, with a unit test asserting the seam is reachable and terminates.

**Acceptance Scenarios**:

1. **Given** the phase loop, **When** a stub remediate entry is triggered, **Then** the loop enters `remediate` even though it is absent from the linear sequence, and after it returns, control resumes at `review`.
2. **Given** `remediate` completes as a stub, **When** the loop re-evaluates, **Then** it does not fall into an infinite loop and eventually advances past `review` (stub returns success).

### User Story 3 - Config and labels accept the new phases (Priority: P2)

As an operator configuring per-phase timeouts, agents (model/effort), and labels, I want the new phase keys accepted by config schemas and label definitions, so that the new phases are configurable and observable on the same footing as existing phases.

**Why this priority**: Needed for the phases to be usable and observable, but non-blocking for the core type plumbing.

**Acceptance Scenarios**:

1. **Given** a config that overrides the `review` (or `remediate`) phase timeout or agent model/effort, **When** the config is parsed by the relevant Zod schema, **Then** it validates without a strict-mode key error.
2. **Given** the label definitions, **When** a phase-derived label for `review`/`remediate` is required, **Then** a definition exists.
3. **Given** `packages/config/src/template-schema.ts` strict phase keys and `resume.ts` phase handling, **When** the new phases are referenced, **Then** they are accepted.

### Edge Cases

- What happens when a config file (from an existing cluster) omits the new phase overrides? → New phases fall back to the flat `phaseTimeoutMs` / default agent exactly like any non-overridden phase; no migration required.
- What happens when a workflow other than feature/bugfix is run? → Its sequence is unchanged; `review`/`remediate` never appear.
- What happens if a duplication site is missed? → A grep/exhaustiveness audit (codified as a test where feasible) fails, surfacing the stale site.
- What happens on `PHASE_TO_STAGE` lookups for the new phases? → Both map to the `implementation` stage.

## Requirements

### Functional Requirements

- **FR-001**: The `WorkflowPhase` union (and every duplicated literal-union / Zod-enum / strict-key site listed in Context) MUST include `review` and `remediate`.
- **FR-002**: `PHASE_TO_STAGE` MUST map both `review` and `remediate` to the `implementation` stage, keeping the `Record<WorkflowPhase, StageType>` exhaustive.
- **FR-003**: `WORKFLOW_PHASE_SEQUENCES` MUST insert `review` immediately after `implement` for `speckit-feature` and `speckit-bugfix`; `speckit-epic` MUST remain unchanged.
- **FR-004**: `remediate` MUST NOT appear in any linear phase sequence.
- **FR-005**: Per-phase timeout config and per-phase agent (model/effort) config MUST accept `review` and `remediate` keys without strict-schema errors.
- **FR-006**: Label definitions MUST include the full phase-progress families (`phase:`, `completed:`, `failed:`, `failed:-repeated`) for both `review` and `remediate`, at parity with existing phases. No new `waiting-for:` gate labels are added for the new phases.
- **FR-007**: The phase loop MUST support entering `remediate` off-sequence and backtracking to `review` afterward, reusing the existing `i--` backtrack + `startPhase` resume precedent. In this issue the seam is reachable **only** via the unit test — no production code path fires it during a real feature/bugfix run.
- **FR-008**: Stub execution wiring for `review` and `remediate` MUST be provided so the codebase compiles and existing workflows behave identically. `review` MUST be gated behind a feature flag defaulting **OFF** so it is skipped at execution and emits no labels/comments/journal entries in a live run (guaranteeing zero observable change). Real executors are out of scope.
- **FR-010**: The existing `waiting-for:implementation-review` gate MUST remain on `implement`, unchanged; the new linear `review` phase ships with no gate of its own.
- **FR-011**: SC-003's audit MUST be delivered as a committed automated test that enumerates the phase-literal duplication sites and fails when one drifts (following the existing `label-protocol-audit.test.ts` / `phase-tracker-audit.test.ts` pattern).
- **FR-009**: Existing `speckit-feature`, `speckit-bugfix`, and `speckit-epic` runs MUST be behavior-identical after this change.

### Key Entities

- **WorkflowPhase**: The canonical phase vocabulary; gains `review` and `remediate`.
- **WORKFLOW_PHASE_SEQUENCES**: Per-workflow ordered phase lists; only feature/bugfix change (add linear `review`).
- **Loop-control seam**: The phase-loop mechanism (backtrack/resume) that admits off-sequence `remediate` entry and return-to-`review`.

## Success Criteria

### Measurable Outcomes

- **SC-001**: `pnpm -r build` and the test suites for orchestrator, config, cockpit, launcher, and workflow-engine all pass.
- **SC-002**: `getPhaseSequence('speckit-feature')` and `getPhaseSequence('speckit-bugfix')` return sequences with `review` directly after `implement`; `getPhaseSequence('speckit-epic')` is byte-identical to before; no sequence contains `remediate`.
- **SC-003**: No stale phase-literal duplication site remains — verified by a grep/exhaustiveness audit over the enumerated sites, codified as an automated test where feasible.
- **SC-004**: An end-to-end existing feature/bugfix run produces the same observable outcome (labels, comments, PR state) as before the change.

## Assumptions

- The `review` phase is feature-flagged **OFF** by default and skipped at execution (per Clarifications Q1=A), so a feature/bugfix run that now includes a linear `review` phase still completes with no observable difference (no `phase:review`/`completed:review` labels, no stage comment, no journal entries).
- The existing `i--` backtrack and `startPhase` resume mechanics in the phase loop are sufficient precedent for the off-sequence `remediate` seam; no new persistence layer is required.
- New phase keys are optional in every config schema; absence falls back to existing defaults, so no config migration is needed for deployed clusters.

## Out of Scope

- Real `review` and `remediate` executors, prompts, and verdict/finding logic (later epic issues).
- The concrete triggers that decide *when* to enter `remediate` (review verdict parsing, validate-failure routing, PR-feedback ingestion) — only the mechanical loop seam ships here.
- Any change to `speckit-epic`'s sequence.
- Cloud-side (generacy-cloud) or cluster-base companion changes.

---

*Generated by speckit*
