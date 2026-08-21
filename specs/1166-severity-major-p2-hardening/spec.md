# Feature Specification: Bugfix targeted-validate and fail-then-pass hardening

**Branch**: `1166-severity-major-p2-hardening` | **Date**: 2026-08-21 | **Status**: Draft

## Summary

**Severity: major (P2).** A hardening batch for two `speckit-bugfix` validate-phase
mechanisms shipped by epic generacy-ai/generacy#1120:

- The **targeted-validate diff classifier** (`packages/orchestrator/src/worker/diff-classifier.ts`),
  which narrows the built-in default validate command to a diff-scoped `pnpm --filter`
  form so a bugfix only builds/tests the packages it touched.
- The **opt-in fail-then-pass regression prover** (`packages/orchestrator/src/worker/fail-then-pass.ts`),
  which proves a bugfix's changed test files fail on the base ref and pass on the branch.

A post-merge code review of #1120 (develop `155b3464`) found seven defects that make
these mechanisms produce **wrong or vacuous validate results** — a validate that passes
having run nothing, hard-fails with misleading evidence, or leaks worktrees. Each defect
is either a false-negative (validate blocks a correct fix) or a false-positive (validate
green-lights an unverified fix). This feature closes all seven so the bugfix validate
signal is trustworthy.

Filed from the post-merge review of epic generacy-ai/generacy#1120. Part of follow-up
epic generacy-ai/generacy#1153.

## User Stories

### US1: A deleted or renamed test file no longer breaks a targeted validate run

**As an** operator whose bugfix removes an obsolete test,
**I want** the targeted-validate classifier to ignore paths that no longer exist on the branch,
**So that** validate does not run `pnpm vitest run <nonexistent-file>` and hard-fail on a legitimate deletion.

**Acceptance Criteria**:
- [ ] A diff that only deletes test file(s) does not classify as `test-only` against the
      deleted paths; the resulting validate command never references a path absent from the
      branch checkout.
- [ ] A rename (old path deleted, new path added) does not cause validate to run against the
      old path.
- [ ] A test-only diff whose changed test files all still exist runs exactly those files
      (unchanged behavior).

### US2: A root-level non-config source change runs a real validate, not a vacuous one

**As an** operator who edits root `package.json`, `scripts/**`, or a root `vitest.config.ts`,
**I want** the classifier to fall back to a full validate when a targeted `pnpm --filter` would
select zero projects,
**So that** validate cannot report success having built and tested nothing.

**Acceptance Criteria**:
- [ ] A diff containing only root-level, non-package source changes (outside the closed
      root-config glob set) does not silently pass a targeted run that selected zero projects.
- [ ] When the targeted filter would select no projects, validate falls back to the full
      built-in default command.

### US3: The fail-then-pass proof is non-vacuous or is skipped with a logged reason

**As an** operator relying on the fail-then-pass proof,
**I want** an infrastructure failure at the base ref (dist not built, no root vitest, timeout)
to be reported as a non-blocking skip with a clear reason rather than as a base/branch test outcome,
**So that** the proof either genuinely proves the regression or transparently opts out — never
degenerating to "does the branch pass" or hard-failing validate on wrong evidence.

**Acceptance Criteria**:
- [ ] In a dist-resolving monorepo, the base-ref run is either made runnable (e.g. build step)
      or an infrastructure-failure signature at the base ref produces a non-blocking `skip` with
      a logged reason — never a spurious `base-passed`/`branch-failed` finding.
- [ ] A repo without a root vitest does not produce a false `branch-failed`; the proof skips
      with a logged reason.
- [ ] A hung base or branch test run is bounded by a wall-clock cap and does not stall validate
      past the cli-spawner cap.

### US4: Worktree lifecycle leaves no leaked state

**As an** operator whose cluster runs many bugfix validates,
**I want** the fail-then-pass worktree and its parent temp dir cleaned up on every path (success,
error, abort),
**So that** repeated runs do not accumulate leaked worktrees or temp directories.

**Acceptance Criteria**:
- [ ] The `mkdtemp` parent directory is removed, not just the inner worktree.
- [ ] Worktree cleanup is not skipped by an aborted `signal`; a prune reconciles any orphaned
      registration.
- [ ] A `git worktree add` failure is treated as a non-blocking skip (consistent with the
      documented infra-failure posture), not a hard phase failure.

### US5: The doc example works for main-based repos

**As an** operator of a `main`-based repo copy-pasting the bugfix profile doc,
**I want** the custom `validateCommand` example to work without a hardcoded `origin/develop`,
**So that** the targeted filter matches my repo's base branch instead of silently filtering
against a non-existent ref.

**Acceptance Criteria**:
- [ ] Either the custom `validateCommand` supports a `<base>` placeholder that is substituted
      with the resolved base branch, or the doc no longer hardcodes `origin/develop` and explains
      how to adapt it.
- [ ] The documented example produces a working targeted filter on both `develop`- and
      `main`-based repos.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The targeted-validate wiring layer MUST exclude changed-file paths that do not exist in the branch checkout before the classifier classifies `test-only` and before emitting a `pnpm vitest run` command. `classifyDiff` stays pure/no-I/O and receives already-existence-filtered paths (Q3→A). | P1 | Deleted/renamed-away paths. Mirrors fail-then-pass ENOENT overlay handling. `diff-classifier.ts:92-94`. |
| FR-002 | If, after existence filtering, a `test-only` diff has no remaining test files, validate MUST fall back to the full built-in default rather than run an empty/failing vitest command. | P1 | Deletion-only diff edge case. |
| FR-003 | When a targeted `pnpm --filter` classification would select zero projects, the wiring MUST fall back to the full built-in default validate command. The zero-project probe lives in the wiring layer, not inside pure `classifyDiff` (Q3→A). | P1 | Root `package.json`, `scripts/**`, root `vitest.config.ts` currently classify `targeted`. `diff-classifier.ts:42-50`. |
| FR-004 | The fail-then-pass base-ref run MUST NOT report an infrastructure failure (unbuilt dist, missing root vitest, install/setup failure) as a base or branch test outcome. It MUST instead signature-detect the infra failure and produce a non-blocking `skip` with a logged reason. No build step is added (Q1→A). The infra signature is conservative: only a pre-collection failure — vitest exiting having collected/run zero tests (e.g. "No test files found", dist/module resolution error before any test runs) — counts as infra; any collected-and-failed test is a genuine outcome (Q2→A). | P1 | Prevents vacuous `base-passed`/`branch-failed`. `fail-then-pass.ts:94-110, 211`. |
| FR-005 | A repo without a root-level vitest MUST NOT yield a false `branch-failed`; the proof MUST skip (non-blocking) with a logged reason. | P1 | `fail-then-pass.ts:211`. |
| FR-006 | Both the base-ref and branch test runs MUST be bounded by a wall-clock cap via a dedicated constant (mirroring `BASE_INSTALL_TIMEOUT_MS`) applied as a per-run timeout on each test run, independent of the install cap (Q5→A); a hang MUST NOT stall validate past the cli-spawner cap. | P1 | Install already has `BASE_INSTALL_TIMEOUT_MS`; tests do not. |
| FR-007 | The fail-then-pass worktree lifecycle MUST clean up the `mkdtemp` parent directory (not only the inner worktree) on every exit path (success, error, abort). | P2 | `fail-then-pass.ts:162-199`. |
| FR-008 | Worktree cleanup MUST NOT be silently skipped when the abort `signal` is already aborted; an orphaned registration MUST be reconciled (e.g. `git worktree prune`). | P2 | Cleanup `git worktree remove` currently shares the abort signal. |
| FR-009 | A `git worktree add` failure MUST be treated as a non-blocking skip with a logged reason, consistent with the documented infra-failure posture — not a hard phase failure. | P2 | `fail-then-pass.ts:167-170`. |
| FR-010 | A custom `validateCommand` MUST support a `<base>` placeholder substituted with the resolved base branch (mirroring the existing merge-conflict `<base>`/`<branch>` substitution), and the bugfix profile doc MUST be updated to use it instead of hardcoding `origin/develop` (Q4→A). | P2 | `bugfix-profile-config.md`; custom commands run verbatim with no substitution today (`phase-loop.ts` `computeEffectiveValidateCommand`). |
| FR-011 | All new fall-back / skip / infra-failure decisions MUST emit a single observability log line describing the decision and reason, consistent with the existing `targeted-validate` and `fail-then-pass` log lines. | P2 | Preserve one-line-per-decision logging. |
| FR-012 | Every workflow other than `speckit-bugfix`, and any `speckit-bugfix` run that does not exercise a defective code path, MUST remain byte-identical to pre-#1166 behavior. | P1 | No regression to non-bugfix validate. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Deletion-only / rename test diffs no longer break validate | 0 validate failures caused by `pnpm vitest run <nonexistent-file>` | Unit test on classifier + wiring with deleted/renamed test paths. |
| SC-002 | Vacuous zero-project targeted runs eliminated | 0 targeted validate runs that select zero projects and pass | Unit/integration test: root-level non-config diff falls back to full. |
| SC-003 | Fail-then-pass never vacuously satisfied by infra failure | Base-ref infra failures produce `skip` (logged), never `base-passed`/`branch-failed` | Test with dist-resolving monorepo + repo-without-root-vitest fixtures. |
| SC-004 | Base/branch test runs are time-bounded | A hung test run aborts within the configured cap | Test injecting a hanging run; assert cap enforced. |
| SC-005 | No leaked worktrees or temp dirs | 0 residual `mkdtemp` parents / worktree registrations after runs including aborted ones | Test asserts parent dir removed + prune reconciles; `git worktree list` clean. |
| SC-006 | Doc example works on both base branches | Documented example produces a valid targeted filter on `develop` and `main` repos | Doc review + placeholder-substitution test (if placeholder chosen). |
| SC-007 | No regression for unaffected paths | Non-bugfix and non-triggering bugfix validate behavior unchanged | Existing validate/classifier test suites remain green. |

## Assumptions

- The closed root-config and test glob sets defined in `contracts/diff-classifier.md` (from
  #1134) remain the baseline; this feature adds existence filtering and a zero-project guard on
  top rather than redesigning the classification taxonomy.
- Existence filtering is against the branch checkout working tree (the same tree fail-then-pass
  overlays from), consistent with FR-001's mirror of the ENOENT overlay handling.
- "Infrastructure-failure signature" detection is the chosen strategy (Q1→A); no base build step
  is added. Detection is conservative (Q2→A): only a pre-collection failure — vitest exiting
  having collected/run zero tests — counts as infra, so a genuine collected-and-failed test is
  never masked as infra.
- Existence-filtering (FR-001) and the zero-project fallback (FR-003) live in the targeted-validate
  wiring layer; `classifyDiff` stays pure/no-I/O and receives already-filtered paths (Q3→A).
- The wall-clock cap for test runs uses a dedicated constant mirroring the existing
  `BASE_INSTALL_TIMEOUT_MS` pattern, applied per-run independent of the install cap (Q5→A); exact
  value/derivation is a plan-phase decision.
- FR-010 is resolved via a `<base>` placeholder in the custom `validateCommand`, substituted with
  the resolved base branch, mirroring the existing merge-conflict `<base>` substitution already
  present in `phase-loop.ts` (Q4→A).

## Out of Scope

- Redesigning the targeted-validate classification taxonomy or the closed glob sets.
- Changing the opt-in default of fail-then-pass (it remains off by default).
- Making the fail-then-pass proof mandatory or wiring it into non-bugfix workflows.
- Any change to `speckit-feature` validate behavior.
- Broader worktree-management refactors beyond the fail-then-pass lifecycle.

---

*Generated by speckit*
