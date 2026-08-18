# Feature Specification: Implement-phase product-diff guard — exclude agent-context files and measure the phase's own diff

**Branch**: `1107-summary-implement-phase-s` | **Date**: 2026-08-18 | **Status**: Draft
**Issue**: [generacy-ai/generacy#1107](https://github.com/generacy-ai/generacy/issues/1107) | **Workflow**: `speckit-bugfix`

## Summary

The implement phase's "produced no product-code changes" guard (`packages/orchestrator/src/worker/product-diff.ts`, enforced in `phase-loop.ts:713-784`, shipped in spec #820) is structurally defeated on every speckit branch. Two independent defects compose:

1. **Incomplete exclusion list.** `EXCLUDED_PATH_PREFIXES = ['specs/']` treats the spec-kit `update_agent` targets (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`) as product code. Every speckit branch carries a `CLAUDE.md` edit written by an earlier phase, so `productFiles` is never empty.
2. **Wrong diff window.** `computeProductDiff` diffs `baseRef...HEAD` — the cumulative branch diff — not the diff the implement phase itself produced. Any product file touched by *any* earlier phase (or repo scaffolding merged into the branch) permanently satisfies the guard for every later phase on that branch.

Consequence: an implement phase that writes **zero code** is recorded `phase_complete`, the issue advances to `waiting-for:implementation-review`, and a spec-artifacts-only PR is opened. Field evidence (`Painworth/doc-intel`): PRs #56 (**merged**, 0 source files), #64, #65 — all passed the guard on the strength of a scaffolding-era `CLAUDE.md` plus files under `specs/`. #56's phantom completion is now the unmet dependency blocking issues #21 and #23.

Root-cause context worth preserving: in both field cases the implement agent hit a *real* blocker, correctly halted to ask the operator a question, and exited 0 — headless, nobody answers, and the orchestrator reads exit 0 as success. The guard is the designated safety net for exactly this failure mode, and it can never fire.

## User Stories

### US1: Zero-code implement phase fails instead of advancing (P1)

**As an** operator running speckit workflows headless,
**I want** an implement phase whose own work is empty (or entirely agent-context/spec artifacts) to fail the phase,
**So that** issues never reach `waiting-for:implementation-review` — and PRs never merge — with zero product code, silently creating phantom dependencies for downstream issues.

**Acceptance Criteria**:
- [ ] An implement phase whose own diff is empty fails with the existing `no-product-code-changes` failure surface (error evidence, stage comment, escalation, labels) instead of advancing.
- [ ] An implement phase whose own diff consists solely of files under `specs/` and/or agent-context files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`) fails the same way.
- [ ] The failure log/error message enumerates both the excluded prefixes and the excluded exact filenames so the operator can see why each changed file was discounted.

### US2: Guard is immune to earlier-phase and scaffolding contamination (P1)

**As an** operator,
**I want** the guard to measure only the diff the current phase produced,
**So that** a `CLAUDE.md` edit from the specify phase (or any product file touched by an earlier phase on the same branch) cannot satisfy the guard on behalf of a later phase that did nothing.

**Acceptance Criteria**:
- [ ] Regression test: a branch already carrying a `CLAUDE.md` edit **and** a product-code edit from earlier phases, followed by an implement phase that writes nothing (or only a conversation log under `specs/`) ⇒ phase fails.
- [ ] The diff window is the phase's own start point → post-commit `HEAD`, not `baseRef...HEAD`.

### US3: Legitimate product changes still pass (P2)

**As an** operator,
**I want** implement phases that produce real code to be unaffected,
**So that** the tightened guard introduces no false failures on healthy runs.

**Acceptance Criteria**:
- [ ] An implement phase touching at least one file that is neither under an excluded prefix nor an excluded exact filename passes the guard.
- [ ] A phase whose product legitimately *is* an agent-context file edit (e.g. a bugfix to `CLAUDE.md` itself) has explicitly defined behavior: either it passes, or the false failure is documented as accepted. *(Resolution deferred to /clarify.)*

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The product-diff exclusion mechanism gains an exact-filename exclusion set containing the spec-kit `update_agent` targets: `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`. | P1 | Exact match, not prefix — a bare `startsWith('CLAUDE.md')` entry would also swallow `CLAUDE.md.bak`. Prefix list (`specs/`) retained alongside. |
| FR-002 | The guard measures the diff the phase itself produced (phase start commit → `HEAD` after the phase's commit) instead of the cumulative `baseRef...HEAD` branch diff. | P1 | Phase start point must be captured before the CLI spawns (e.g. `git rev-parse HEAD`). Interaction with the existing `resolveBaseRef` path and detection-failure fallback to be settled at /plan. |
| FR-003 | When the phase-scoped product diff is empty, the phase fails via the existing `no-product-code-changes` synthetic-failure path (error evidence classifier reason, stage comment, `escalateAndAlert`, loop abort). | P1 | No new failure surface; reuse `phase-loop.ts:754-783` machinery. |
| FR-004 | Failure diagnostics include: the phase-scoped changed-file list, the base/start ref used, the excluded prefixes, and the excluded exact filenames. | P2 | Extends the existing structured log at `phase-loop.ts:755-758` and the error message at `:760-766`. |
| FR-005 | `isProductFile` / `computeProductDiff` public shapes remain consumable by existing callers and tests; diff-window change must not alter `resolveBaseRef` consumers (`base-merge.ts`). | P2 | `resolveBaseRef` is shared; the new window is additive. |
| FR-006 | Failing loudly when the implement phase checks off zero tasks in `tasks.md` — the operator-visible symptom, independent of file-path classification. | P3 | Issue suggests this as a third, independent net. Whether it ships in this fix or a follow-up is a /clarify question. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Field-scenario regression: branch with earlier-phase `CLAUDE.md` edit + implement phase writing only `specs/<slug>/conversation-log.jsonl` | Phase fails with `no-product-code-changes`; validate never runs; issue does not reach `waiting-for:implementation-review` | New regression test alongside `phase-loop.product-diff.test.ts` |
| SC-002 | Agent-context-only diff: implement phase's own diff = `CLAUDE.md` only | Phase fails | Unit test on the exclusion set + phase-loop integration test |
| SC-003 | Healthy path: implement phase's own diff includes ≥1 real product file | Phase passes; no behavior change vs. today | Existing `phase-loop.test.ts` / `claude-cli-worker.test.ts` defaults stay green (mocks updated for new window as needed) |
| SC-004 | Earlier-phase product edit cannot carry a later phase | Implement phase with empty own-diff fails even when `baseRef...HEAD` contains product files | Dedicated unit test on the new diff window |
| SC-005 | Existing detection-failure path preserved | `product-diff-error` classifier reason still raised when diff computation throws | Existing tests at `phase-loop.test.ts:1061` unchanged |

## Assumptions

- The guard's enforcement point stays in `phase-loop.ts` step 5b, after `commitPushAndEnsurePr` — the phase's commit is already on `HEAD` when the check runs, so "phase start commit → HEAD" captures exactly the phase's own work including its commit.
- `PHASES_REQUIRING_CHANGES` membership (currently implement-focused) is unchanged; this fix tightens *what counts as a change*, not *which phases are checked*.
- Exclusion entries remain module-level constants (per #820 Clarification Q1): no `WorkerConfig` field, no YAML key.
- The conversation-log file (`specs/<slug>/conversation-log.jsonl`) is already excluded via the `specs/` prefix; no new handling needed for it.
- Exit-0-on-operator-question (the upstream cause of the agent producing nothing) is a separate defect in CLI-exit interpretation and is not fixed here; this guard is the safety net for it.

## Out of Scope

- Repairing already-merged phantom PRs or re-opening affected downstream issues (`Painworth/doc-intel` cleanup is operational, not code).
- Changing how the orchestrator interprets CLI exit codes or detects "agent halted with a question" (upstream defect; candidate follow-up issue).
- Making the exclusion lists configurable per-workspace or per-workflow.
- Non-speckit workflows' phase semantics — though the fix applies wherever `PHASES_REQUIRING_CHANGES` fires, per existing behavior.

---

*Generated by speckit*
