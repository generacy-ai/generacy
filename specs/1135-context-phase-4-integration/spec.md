# Feature Specification: Bugfix profile end-to-end with targeted validate (Phase-4 integration)

**Branch**: `1135-context-phase-4-integration` | **Date**: 2026-08-20 | **Status**: Draft

## Summary

Phase-4 (P4) integration checkpoint for the epic *engine-native review & remediate phases* (generacy-ai/generacy#1120). P4 lands the bugfix-specific behavior on top of the P3 review⇄remediate loop: the **verification review charter** and **targeted validate** with **diff-classification guards** and opt-in `failThenPass` (#1134), plus **merge-readiness/validate-CI orchestration** and the **post-validate `implementation-review` final gate** (#1133). This issue proves the **bugfix profile works end-to-end on a monorepo fixture** and — the whole point of the profile — asserts that **fewer suites run** than a full validate in every diff-classification variant.

This issue ships **no product behavior of its own**. It ships an **integration harness scenario suite** that drives a real worker phase loop through the bugfix happy path and each diff-classification/`failThenPass` variant, **asserting suite-execution counts** in every case, plus **per-repo bugfix-profile config examples in docs** and durable loop-contract cross-references. It mirrors the tests-and-contracts-only shape of P1/#1123, P2/#1127, and P3/#1132 (with the added docs-examples deliverable called for by this issue's acceptance).

## Context

- After P3, the full `implement → review ⇄ remediate → ready → validate → final gate` loop runs with **feature defaults** (`blockingSeverity: major`, `maxRemediations: 3`, full `validateCommand`). P4 adds the **bugfix profile** and merge-readiness orchestration; this issue proves them together on a realistic monorepo.
- **The point of the bugfix profile is fewer suite runs.** Bugfix risk is narrow (wrong root cause, adjacent regression, missing proof the bug is fixed), so a full 10-minute suite per round on a one-package fix is waste. Targeted validate runs **only the changed packages + their dependents** (`pnpm --filter "...[origin/<base>]" build && … test`). Every scenario in this suite therefore asserts the **suite-execution count**, not just a green/red outcome — a variant that "passes" while running the full suite is a failure of the profile.
- **Diff classification runs BEFORE validate, with guards.** This issue exercises the guard matrix end-to-end: (a) a diff touching **root-level config** (lockfile, base tsconfig, workspace file, CI workflows) → **fall back to the full command**; (b) a **docs-only** diff → **skip tests**; (c) opt-in **`failThenPass`** → run new/changed test files against the base ref, requiring **fail-on-base, pass-on-branch**. The single-package-repo guard (plain command; filter syntax is meaningless) is pinned/cross-referenced but ships no dedicated scenario (see Assumptions).
- **The verification review charter** (`profile: verification`) drives the bugfix happy path: the review flags a **missing regression test** as a blocking finding, `remediate` adds the test, and a clean re-review marks the PR ready. Bugfix defaults: `blockingSeverity: critical`, `maxRemediations: 2`, cheaper model/effort via per-workflow agents config.
- **Targeted validate runs in parallel with CI**; the final `implementation-review` gate fires only when **both validate and CI are green** (#1133). Merge readiness treats `skipped`/`neutral` CI as **NOT passed**. This issue drives that orchestration through the harness (CI status injected, since CI is external).

Depends on: #1134 (verification charter + targeted validate + diff-classification guards + `failThenPass`) and #1133 (merge readiness skipped≠passed, validate/CI parallel semantics, post-validate `implementation-review` gate), on top of the merged P1–P3 machinery. This issue integrates them; it does not re-implement any.

## User Stories

### US1: Engine developer proves the bugfix happy path end-to-end on a monorepo

**As a** developer building on the bugfix profile,
**I want** an integration scenario that drives `bugfix issue → implement → verification review flags a missing regression test as blocking → remediate adds the test → re-review clean → ready → targeted validate (only affected packages + dependents) in parallel with CI → final gate`,
**So that** the verification charter, targeted validate, cap-2 counter, validate/CI parallelism, and post-validate final gate are proven to work together — and the targeted validate demonstrably runs **fewer suites** than a full validate on the same monorepo.

**Acceptance Criteria**:
- [ ] The run uses the `verification` review charter (bugfix profile), not the feature charter.
- [ ] The review returns a blocking "missing regression test" finding that routes the loop into `remediate`; the remediation adds the test; a clean re-review marks the PR ready.
- [ ] Targeted validate runs only the changed packages **plus their dependents** (filter-derived), not the whole workspace.
- [ ] The suite-execution count for the run equals the affected-set count and is **strictly fewer** than the full-workspace suite count on the fixture.
- [ ] Validate runs in parallel with CI; the `implementation-review` final gate is raised only when both validate and CI are green (#1133).
- [ ] The remediation counter caps at the bugfix default (2) and the loop converges before the cap.

### US2: Diff-classification guards route validate correctly and each keeps the suite count honest

**As a** developer relying on the diff-classification guards,
**I want** variant scenarios proving that a root-config-touching diff falls back to the **full** validate, and a docs-only diff **skips tests**, each with its suite-execution count asserted,
**So that** the guards are proven to switch the validate command correctly and the suite-run savings (or the deliberate fallback) are measurable, not assumed.

**Acceptance Criteria**:
- [ ] A variant whose diff touches root-level config (lockfile / base tsconfig / workspace file / CI workflow) falls back to the **full** validate command; its suite-execution count equals the full-workspace count.
- [ ] A variant whose diff is docs-only **skips tests**; its suite-execution (test) count is zero.
- [ ] Each variant asserts its suite-execution count explicitly — a variant that produces the wrong count fails even if the run is otherwise green.

### US3: `failThenPass` proves the regression test actually fails without the fix

**As a** maintainer enabling `failThenPass` for a bugfix,
**I want** a scenario proving that new/changed test files are run against the **base** ref and required to **fail-on-base, pass-on-branch**, and a complementary scenario with `failThenPass` off that skips that check,
**So that** the profile's fail-on-base guarantee is proven end-to-end and its cost is only incurred when opted in.

**Acceptance Criteria**:
- [ ] With `failThenPass` enabled, the new/changed regression test is executed against the base ref and required to fail there and pass on the branch; a test that passes on base fails the gate.
- [ ] With `failThenPass` disabled (default), no base-ref test execution occurs.
- [ ] Both paths assert their suite-execution counts (the enabled path includes the extra base-ref run).

### US4: A repo owner adopts the bugfix profile from a worked config example

**As a** repo owner wanting fewer suite runs on bugfixes,
**I want** per-repo `.generacy/config.yaml` examples for the bugfix profile (verification charter, targeted `validateCommand`, cap 2, optional `failThenPass`, cheaper review model) shipped in docs,
**So that** I can enable the profile on my monorepo by copying a known-good example rather than reverse-engineering the schema.

**Acceptance Criteria**:
- [ ] Docs include a copy-pasteable per-repo bugfix-profile config example (matching the P4 config schema).
- [ ] The example covers targeted `validateCommand`, `profile: verification`, `blockingSeverity: critical`, `maxRemediations: 2`, and the opt-in `failThenPass` toggle.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | An integration scenario drives the bugfix happy path end-to-end on a **monorepo fixture**: `implement → verification review (blocking: missing regression test) → remediate (adds test) → clean re-review → ready → targeted validate (affected packages + dependents) in parallel with CI → final gate`, against the real #1133/#1134 behavior. | P1 | The P4 happy-path proof. |
| FR-002 | The happy-path scenario asserts the targeted-validate suite-execution count equals the affected-set (changed packages + dependents) and is **strictly fewer** than the full-workspace suite count on the fixture. | P1 | The core efficiency guarantee — the point of the profile. |
| FR-003 | A root-config variant asserts a diff touching root-level config (lockfile / base tsconfig / workspace file / CI workflow) **falls back to the full** validate command, with suite-execution count equal to the full-workspace count. | P1 | Guard: root-config fallback (#1134). |
| FR-004 | A docs-only variant asserts a docs-only diff **skips tests** (test suite-execution count = 0). | P1 | Guard: docs-only skip (#1134). |
| FR-005 | A `failThenPass`-enabled variant asserts new/changed test files are executed against the base ref and required to **fail-on-base, pass-on-branch**; a complementary default (`failThenPass` off) variant asserts no base-ref execution. | P1 | Opt-in fail-on-base proof (#1134). |
| FR-006 | **Every** scenario/variant asserts its suite-execution count explicitly; a variant that yields the wrong count fails even when otherwise green. | P1 | Cross-cutting assertion — makes the savings measurable. |
| FR-007 | The happy-path scenario asserts merge-readiness/final-gate behavior from #1133: validate runs in parallel with injected CI status, `skipped` CI is treated as NOT passed, and the `implementation-review` final gate is raised only when both validate and CI are green. | P1 | Validate/CI orchestration boundary (#1133). |
| FR-008 | Per-repo **bugfix-profile config examples** land in docs: targeted `validateCommand`, `profile: verification`, `blockingSeverity: critical`, `maxRemediations: 2`, opt-in `failThenPass`, cheaper review model. | P1 | This issue's docs deliverable (bugfix-profile examples only; full migration guide is #1136). |
| FR-009 | The bugfix-profile loop contracts (verification charter shape, diff-classification guard matrix incl. the pinned single-package guard, suite-count invariant, validate/CI final-gate sequencing) are documented in a shipped `contracts/` artifact cross-referencing #1133/#1134 as the authorship home. | P1 | Durable acceptance artifact; pinned, not re-authored here. |
| FR-010 | No new product behavior is introduced: no changes to the verification charter, targeted-validate command, diff-classification guards, `failThenPass`, merge-readiness evaluation, or the final gate beyond what #1133/#1134 shipped. This issue is P4 integration + docs examples + the loop-contract artifact only. | P1 | Integration-and-docs scope guard (mirrors #1123/#1127/#1132). |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Phase-4 bugfix-profile integration scenario suite passes in CI. | Green | CI run on the PR. |
| SC-002 | The happy-path scenario traverses the full bugfix flow to a raised final gate using the verification charter and targeted validate. | 1 end-to-end pass | Phase-sequence + charter + gate assertions in the harness. |
| SC-003 | Targeted validate on the happy path runs strictly fewer suites than a full validate on the same fixture. | affected-set count < full-workspace count | Suite-invocation count assertion. |
| SC-004 | Root-config variant falls back to full validate; docs-only variant skips tests. | full-count / zero-tests respectively | Per-variant suite-execution count assertions. |
| SC-005 | `failThenPass` enabled proves fail-on-base/pass-on-branch; disabled performs no base-ref run. | Both paths assert correctly | Base-ref execution + count assertions. |
| SC-006 | Every scenario/variant asserts an explicit suite-execution count. | 100% of variants | Presence of a count assertion in each scenario. |
| SC-007 | Per-repo bugfix-profile config examples are shipped in docs. | ≥1 worked example | Presence of docs example in the PR. |
| SC-008 | The bugfix loop-contract artifact is shipped in the diff, cross-referencing #1133/#1134. | 1 artifact | Presence of `contracts/` doc in the PR. |

## Assumptions

- #1133 and #1134 merge to `develop` **first** and this branch is rebased on them (mirrors #1123 Q1=B, #1127 Q1=A, #1132's rebase-on-P3 assumption); this issue ships only the integration scenario suite, the docs examples, and the loop-contract artifact — it does not re-implement the profiles. The implement phase dependency-blocks until #1133/#1134 land (skip→requeue-after-deps).
- The harness drives a **real** worker phase loop with the real #1133/#1134 behavior; only genuinely external seams (the CLI/agent invocation, GitHub calls, CI status, human gate answers) are mocked/injected through the established phase-loop dependency seams used in #1123/#1127/#1132 — no test-only doubles stand in for the profiles themselves.
- A **monorepo fixture** with multiple packages and a real dependency graph (so `pnpm --filter "...[origin/<base>]"` resolves a proper *changed-plus-dependents* set) is authored as part of the harness; the affected-set-vs-full-workspace suite-count comparison is meaningful only on such a fixture.
- **Suite-execution count** is the harness-observed number of test/build suite invocations the resolved validate command would run (measured via the established validate seam, not by executing real 10-minute suites). [NEEDS CLARIFICATION: exact measurement point — count of `--filter`-resolved package targets vs. count of validate-command invocations vs. an instrumented runner — bind at /plan against #1134's targeted-validate implementation.]
- CI is external and its status is **injected** into the merge-readiness evaluation (#1133); the harness does not run real GitHub Actions. Validate/CI "parallelism" is asserted as the engine's sequencing/readiness behavior, not wall-clock concurrency.
- Bugfix defaults (`profile: verification`, `blockingSeverity: critical`, `maxRemediations: 2`), the targeted `validateCommand` template, the guard matrix, and `failThenPass` semantics are **as shipped by #1134**; the final-gate/merge-readiness semantics are **as shipped by #1133**. This suite drives them; it does not define them.
- The **single-package-repo guard** (plain command; filter syntax meaningless) is unit-tested by #1134 and cross-referenced/pinned in this issue's contract artifact; it ships **no dedicated integration scenario** here (mirrors #1132's defer+pin precedent for the merge-conflict entry point).
- The docs examples deliverable here is scoped to **bugfix-profile config examples**; the full per-repo migration guide, `ready_for_review` CI-trigger note, rollout checklist, and dogfood pass are **#1136** (Phase-5).

## Out of Scope

- Any change to the verification review charter, targeted-validate command, diff-classification guards, `failThenPass`, merge-readiness evaluation, validate/CI orchestration, or the post-validate `implementation-review` gate — those are the P4 product issues (#1133/#1134); this integrates and documents them.
- Executing real, full-length CI or test suites; running real GitHub Actions.
- The single-package-repo guard scenario (pinned in the contract artifact; unit-tested by #1134).
- Full per-repo migration guide, `ready_for_review` CI-trigger migration note, rollout checklist, and dogfood pass (Phase-5 — #1136).
- `/cockpit:auto` playbook slimming (generacy-ai/agency#500).
- Re-authoring the engine-authored marker or findings-artifact wire contracts (owned by #1124/#1125, pinned by #1127).

---

*Generated by speckit*
