# Feature Specification: Epic: generacy-ai/tetrad-development#85 | Phase: S3 | Tier: v1-simplification | Issue: G-S3

Collapse the CLI surface to the rev 3 catalog

**Branch**: `807-epic-generacy-ai-tetrad` | **Date**: 2026-07-06 | **Status**: Draft

## Summary

Epic: generacy-ai/tetrad-development#85 | Phase: S3 | Tier: v1-simplification | Issue: G-S3

Collapse the CLI surface to the rev 3 catalog. Merge state + clarify-context + review-context into one `context <issue>` verb: classify the issue's current gate, emit the bundle that gate needs (clarification comment + spec/plan + code refs for clarification; PR metadata + diff + checks for implementation-review/merge preflight; artifact paths for spec/plan/tasks review). Fold the CLI-local gh-ext.ts (CockpitGh, 306 LOC) into the engine's single gh wrapper; collapse the three ref/scope resolvers (shared/scoping.ts, shared/resolve-context.ts, issue-ref.ts) into one module. advance and merge behavior unchanged; exit-code convention kept (0 success / 1 gh-IO / 2 usage / 3 gate refusal).

Owns (isolation): packages/generacy/src/cli/commands/cockpit/{state.ts,clarify-context.ts,review-context.ts,gh-ext.ts,issue-ref.ts,shared/**,index.ts} ; packages/cockpit/src/gh/**

Acceptance: `generacy cockpit context` returns the correct bundle for each gate (unit-tested per gate); exactly one gh wrapper and one resolver module remain; advance/merge tests pass unchanged.

Depends on: G-S2 (resolver + registration files) (see the epic checklist for issue numbers)

---
Part of the Epic Cockpit. Plan: docs/epic-cockpit-plan.md in tetrad-development (S3 / G-S3).


## User Stories

### US1: Unified `context` verb

**As a** cockpit skill (or human operator invoking the CLI),
**I want** a single `generacy cockpit context <issue>` verb that classifies the issue's current `waiting-for:*` gate and emits the exact bundle that gate needs,
**So that** downstream skills stop branching on gate type and I stop having to remember which of `state` / `clarify-context` / `review-context` applies today.

**Acceptance Criteria**:
- [ ] `context <issue>` emits the clarification bundle (`{spec, plan, codeReferences}` with `{path, body}` objects) when the issue is at `waiting-for:clarification`.
- [ ] `context <issue>` emits the PR bundle (metadata + diff + checks) when the issue is at `waiting-for:implementation-review`.
- [ ] `context <issue>` emits the artifact-paths bundle (all three of `spec` / `plan` / `tasks` as `{path, body} | null`) when the issue is at `waiting-for:spec-review`, `waiting-for:plan-review`, or `waiting-for:tasks-review`.
- [ ] Exit codes follow the canonical convention: `0` success, `1` gh-IO failure, `2` usage error, `3` gate refusal (no more, no fewer — see Q4).
- [ ] Existing `advance` and `merge` command behavior is unchanged; their tests pass unmodified.

### US2: Single gh wrapper and single resolver module

**As a** cockpit maintainer,
**I want** exactly one gh wrapper (in `packages/cockpit/src/gh/**`) and one ref/scope resolver module,
**So that** future gh-shape or ref-grammar changes have one home instead of five.

**Acceptance Criteria**:
- [ ] The CLI-local `gh-ext.ts` (`CockpitGh`, ~306 LOC) is folded into the engine's gh wrapper; no CLI-side gh extension survives.
- [ ] `shared/scoping.ts`, `shared/resolve-context.ts`, and `issue-ref.ts` are collapsed into one resolver module.
- [ ] `grep -R` for the removed module names returns zero source-code hits.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `generacy cockpit context <issue>` command exists and replaces `state`, `clarify-context`, and `review-context`. | P1 | The three replaced verbs are removed from the CLI surface. |
| FR-002(a) | For `waiting-for:clarification`, `context` emits the clarification bundle: unresolved clarification comment plus `{spec, plan, codeReferences}` as `{path, body}` objects. | P1 | Matches today's `clarify-context` output. |
| FR-002(b) | For `waiting-for:implementation-review`, `context` emits the PR bundle: PR metadata + diff + checks. | P1 | **Q3 → C**: this is the only PR-scoped gate. `waiting-for:manual-validation` is out of scope; `merge` re-fetches at act-time so a preflight bundle would duplicate the state-drift-invariant check. `completed:validate` passed to `context` exits 3 with a message pointing at `cockpit merge`. |
| FR-002(c) | For `waiting-for:spec-review` / `waiting-for:plan-review` / `waiting-for:tasks-review`, `context` emits the artifact-paths bundle. Shape: `{issue, gate, artifacts: {spec, plan, tasks}}` where each of `spec` / `plan` / `tasks` is `{path, body} | null` (`null` when the file does not exist). All three artifacts are always emitted regardless of which review gate is active. | P1 | **Q1 → D**. Uniform shape across the three review gates parallels the clarification bundle; reviewing a plan legitimately needs the spec alongside it. |
| FR-003 | Gate classification reads only the **issue's** labels. If no `waiting-for:*` label is present on the issue (including the PR-scoped `waiting-for:implementation-review`), exit 3 with a diagnostic to stderr naming the observed labels. | P1 | **Q2 → A**. The label protocol is issue-scoped: the orchestrator writes `waiting-for:*` on issues (observed on #805/#806/tetrad#87). No PR-label fallback — one mechanism per job. |
| FR-004 | Exit codes are canonicalized as: `0` success, `1` gh-IO failure, `2` usage error, `3` gate refusal. When a PR-scoped gate (`waiting-for:implementation-review`) classifies successfully but the linked PR cannot be resolved, exit **3** with a diagnostic to stderr naming the gate label and the missing-PR condition. | P1 | **Q4 → A**. A missing PR under a PR-scoped label is a state-consistency refusal, not a gh-IO failure; don't grow the 4-code contract for one edge. |
| FR-005 | `context <issue>` takes only the `<issue>` positional argument. There is **no** `--repo` flag. The resolver infers the repo strictly from the `<issue>` argument (accepts `owner/repo#N` or full URL); cwd is used only when the ref is a bare number. | P1 | **Q5 → A**. One ref grammar on the CLI surface. The collapsed resolver module MAY expose an internal `repo` parameter for programmatic callers — CLI surface stays minimal. |
| FR-006 | `advance` and `merge` command behavior is preserved. No changes to their flags, exit codes, or side effects. | P1 | Explicitly guarded by keeping their existing tests unmodified. |
| FR-007 | The CLI-local `gh-ext.ts` (`CockpitGh`) is deleted; all CockpitGh call-sites migrate to the single engine gh wrapper at `packages/cockpit/src/gh/**`. | P1 | ~306 LOC removed from CLI. |
| FR-008 | The three ref/scope resolver modules (`shared/scoping.ts`, `shared/resolve-context.ts`, `issue-ref.ts`) collapse into one module; call-sites updated. | P1 | Exactly one resolver module remains. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Unit tests per gate for `context` bundle output | 100% pass; one test per gate branch (clarification, implementation-review, artifact-paths×3) | Test suite in `packages/generacy/src/cli/commands/cockpit/__tests__/context.*` |
| SC-002 | gh wrapper count | Exactly one under `packages/cockpit/src/gh/**`; zero under `packages/generacy/src/cli/commands/cockpit/` | `find` + code review |
| SC-003 | Resolver module count | Exactly one resolver module | `find` + code review |
| SC-004 | `advance` / `merge` regression | All existing `advance` and `merge` tests pass unchanged | CI green on unchanged test files |
| SC-005 | Exit-code contract | `context` returns `{0,1,2,3}` only; every branch covered by a test | Test suite + type-narrowed union at the exit point |

## Assumptions

- The orchestrator writes `waiting-for:*` labels to **issues**, not PRs, across the workflow (observed on #805/#806/tetrad#87). The unified `context` classifier depends on this invariant.
- The single engine gh wrapper at `packages/cockpit/src/gh/**` already exposes (or trivially can expose) every operation `CockpitGh` currently provides. Folding it in requires call-site rewrites only, not new gh-shape design.
- The clarification-bundle shape (`{spec, plan, codeReferences}` with `{path, body}` objects) and the PR-bundle shape (metadata + diff + checks) are preserved from today's `clarify-context` / `review-context` outputs. Only the artifact-paths bundle is a new shape defined by this spec (Q1 → D).
- `merge` performs its own PR + checks re-fetch immediately before acting (state-drift invariant), so `context` does **not** need to emit a merge-preflight bundle (Q3 → C).

## Out of Scope

- Any change to `advance` or `merge` command semantics (FR-006).
- A merge-preflight bundle for `waiting-for:manual-validation` or any pre-merge gate other than `waiting-for:implementation-review` (Q3 → C).
- A PR-label fallback for gate classification (Q2 → A).
- A `--repo` CLI flag on `context` (Q5 → A).
- A fifth exit code for "gate consistent but referent missing" (Q4 → A — reuse exit 3).
- Redesign of the engine gh wrapper's interface; FR-007 is a fold-in, not a redesign.

---

*Generated by speckit*
