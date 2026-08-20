# Feature Specification: Bugfix profiles — verification review charter + targeted validate with diff-classification guards

**Branch**: `1134-context-bugfix-risk-narrow` | **Date**: 2026-08-20 | **Status**: Draft
**Issue**: [generacy-ai/generacy#1134](https://github.com/generacy-ai/generacy/issues/1134) | **Epic**: [#1120](https://github.com/generacy-ai/generacy/issues/1120)

## Summary

Bugfix runs carry a *narrow* risk profile — the failure modes that matter are wrong
root cause, regression in adjacent behavior, and missing proof the bug is actually
fixed — so a full 10-minute build+test suite on every remediate round is wasted
effort. This feature delivers the **profiles that consume the per-workflow config
keys shipped in [#1122](https://github.com/generacy-ai/generacy/issues/1122)**:

1. A **verification review charter** (`profile: verification`) that asks four
   bugfix-shaped questions instead of the generic correctness sweep.
2. **Targeted validate** — engine-side diff classification, run *before* the
   validate command, that narrows the build/test scope to changed packages (and
   their dependents) on monorepos, with explicit guards that fall back to the full
   command when narrowing would be unsafe or meaningless.
3. An opt-in **`failThenPass`** check that proves a regression test fails on the
   base ref and passes on the branch — direct evidence the fix is real. Off by
   default.
4. Composition with **per-workflow agents keying** so bugfix review can run on a
   cheaper model/effort.

The config schema, `resolveWorkflowOverrides` precedence, and profile selection in
the review executor already exist (#1122, #1124). This issue supplies the
*behavior* those keys switch on. `speckit-bugfix` defaults remain
`blockingSeverity: critical`, `maxRemediations: 2`.

## Context

Per the epic design (`docs/engine-review-remediate-plan.md`, "Bugfix profiles"):

- **Review**: verification-shaped, four questions — root cause vs symptom;
  regression test that fails without the fix; scope creep; regression risk in
  changed lines. `blockingSeverity: critical`, `maxRemediations: 2`, runs at lower
  model/effort via agents config.
- **Validate**: targeted — e.g.
  `pnpm --filter "...[origin/develop]" build && pnpm --filter "...[origin/develop]" test`
  (changed packages + dependents). Guards: fall back to the full command when the
  diff touches root-level config (lockfile, base tsconfig, CI workflows);
  single-package repos keep the plain command; docs-only diffs may skip tests;
  test-only diffs run just those files. Opt-in `failThenPass`: run new/changed test
  files against base to prove they fail without the fix.

### What already exists (do not rebuild)

- `OrchestratorSettings.workflows.<name>.review.{profile,blockingSeverity,failThenPass}`
  and `maxRemediations`, merged with correct precedence by
  `resolveWorkflowOverrides` (`packages/orchestrator/src/worker/config.ts`).
- `defaultMaxRemediations` → `speckit-bugfix: 2`, others `3`; `DEFAULT_REVIEW`
  → `profile: standard`, `blockingSeverity: critical`, `failThenPass: false`.
- `ReviewExecutor` reads `review.profile`/`blockingSeverity` and passes them to
  `buildReviewCharter` (`review-executor.ts`, `review-charter.ts`).
- The charter's `verification` branch currently adds only a generic "needs
  verification" section — **not** the four bugfix questions.

## User Stories

### US1: Bugfix review asks the right four questions (P1)

**As a** maintainer relying on the engine to review a bugfix PR,
**I want** the `verification` review profile to interrogate root cause, regression
proof, scope creep, and regression risk,
**So that** the review catches the narrow failure modes that actually threaten a
bugfix instead of running a generic correctness sweep.

**Acceptance Criteria**:
- [ ] When `review.profile === 'verification'`, the charter contains four clearly
      delineated questions: (1) root cause vs symptom, (2) a regression test is
      present that fails without the fix, (3) scope beyond what the fix requires,
      (4) regression risk in the changed lines.
- [ ] The `standard` profile charter is unchanged (byte-identical to pre-change).
- [ ] The charter still forbids running tests/builds and still instructs the agent
      to write findings to the sidecar (existing #1124 invariants preserved).

### US2: Validate is targeted to the change on monorepos (P1)

**As a** maintainer running a one-package bugfix on a monorepo,
**I want** validate to build/test only the changed packages and their dependents,
**So that** each remediate round finishes in a fraction of the full-suite time
without losing coverage of anything the change can affect.

**Acceptance Criteria**:
- [ ] On a multi-package pnpm workspace, when the diff touches package source, the
      effective validate command is scoped to changed packages + dependents (pnpm
      `...[origin/<base>]` filter form).
- [ ] **Guard — root-level config touched**: if the diff touches the lockfile, the
      base/root tsconfig, the workspace file (`pnpm-workspace.yaml`), or CI
      workflow files, the engine falls back to the full (unfiltered) validate
      command.
- [ ] **Guard — single-package repo**: if the repo is not a multi-package
      workspace, the plain configured command runs unchanged (filter syntax is
      meaningless).
- [ ] **Guard — docs-only diff**: if every changed file is documentation, tests are
      skipped.
- [ ] **Guard — test-only diff**: if every changed file is a test file, only those
      test files are run.
- [ ] Classification and the chosen command are logged so an operator can see why a
      given scope was selected.

### US3: `failThenPass` proves the bug is fixed (P2)

**As a** maintainer who wants proof rather than a green suite,
**I want** an opt-in check that runs the new/changed test files against the base ref
and requires them to fail there and pass on the branch,
**So that** I have direct evidence the regression test actually exercises the bug.

**Acceptance Criteria**:
- [ ] `failThenPass` is **off by default**; when off, validate behaves exactly as
      it does today.
- [ ] When on, the engine runs the new/changed test files against the base ref and
      against the branch, and treats "passes on base" (no failure to prove) or
      "fails on branch" as a validate failure with actionable evidence.
- [ ] When there are no new/changed test files, the check is a non-blocking no-op
      (clarified: empty set does not block validate).
- [ ] The base-ref run executes in a detached git worktree at the base ref, leaving
      the branch checkout untouched (clarified).

### US4: Bugfix review runs on a cheaper model/effort (P3)

**As a** cluster operator,
**I want** bugfix review to key onto a cheaper model/effort via per-workflow agents
config,
**So that** the higher-frequency bugfix review rounds cost less.

**Acceptance Criteria**:
- [ ] The bugfix `review`/`remediate` phases resolve their provider/model/effort
      through the existing per-workflow agents keying (#1122/#1095), with no new
      agent-resolution code path introduced here.
- [ ] A harness run demonstrates a bugfix review picking up a workflow-scoped agent
      override.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The `verification` charter renders the four bugfix questions (root cause vs symptom; regression test fails-without-fix; scope creep; regression risk in changed lines). | P1 | Extends `buildReviewCharter` verification branch. |
| FR-002 | The `standard` charter output is unchanged. | P1 | Regression guard. |
| FR-003 | A pure, deterministic diff-classification function categorizes a changed-file set into one of: full-fallback, single-package-plain, docs-only-skip-tests, test-only, targeted. | P1 | New module; no I/O. |
| FR-004 | Root-level config touch (lockfile, base/root tsconfig, `pnpm-workspace.yaml`, CI workflow files) forces the full-fallback classification. | P1 | Guard. Globs (clarified): `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `pnpm-workspace.yaml`, root `tsconfig*.json`, `.github/workflows/**`. |
| FR-005 | Single-package (non-workspace) repos always use the plain configured command. | P1 | Guard. |
| FR-006 | Docs-only diffs skip tests. | P1 | Guard. Docs globs (clarified): `**/*.md` + `docs/**`. |
| FR-007 | Test-only diffs run only the changed test files. | P1 | Guard. Test globs (clarified): `**/*.{test,spec}.{ts,tsx,js,jsx}` + `**/__tests__/**`. |
| FR-008 | The targeted command uses the pnpm `...[origin/<base>]` filter form scoped to changed packages + dependents. | P1 | `<base>` from resolved base branch. Engine rewrites the **built-in default** validate command only; an operator-set custom `validateCommand` is left untouched (clarified). |
| FR-009 | Diff classification runs *before* the validate command executes and determines the effective command; the decision is logged. | P1 | Wired into the validate phase path. Targeted validate + classification apply to `speckit-bugfix` only by default (clarified); other workflows keep the plain resolved command unless explicitly configured. |
| FR-010 | `failThenPass` is off by default and, when off, leaves validate behavior byte-identical. | P1 | Preserves existing runs. |
| FR-011 | When `failThenPass` is on, the engine runs new/changed test files on the base ref and on the branch and fails validate unless base-fails and branch-passes. | P2 | Evidence surfaced on failure. Base-ref run uses a detached git worktree (branch checkout untouched); new/changed test files = diff set filtered to test globs; empty set → non-blocking no-op (clarified). |
| FR-012 | Bugfix review resolves provider/model/effort via the existing per-workflow agents keying without a new resolution path. | P3 | Composition, not new code. |
| FR-013 | Targeted validate + `failThenPass` are additive: with defaults unchanged, existing feature/bugfix runs behave as before. | P1 | Safety invariant. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Diff-classification unit coverage | Every classification branch + every guard has a dedicated unit test | Test suite enumerates full-fallback, single-package, docs-only, test-only, targeted. |
| SC-002 | Verification charter | `profile: verification` output contains all four questions; `standard` output unchanged | Charter unit tests. |
| SC-003 | Bugfix harness | A bugfix run uses the verification charter, a targeted validate command, and `maxRemediations` cap 2 | Integration/harness test. |
| SC-004 | `failThenPass` paths | Both on and off paths covered, including base-fails/branch-passes success and each failure mode | Harness/unit tests. |
| SC-005 | Default safety | With no new config, a feature run and a bugfix run produce byte-identical validate/charter behavior to pre-change | Regression assertions. |

## Assumptions

- The base branch used for `origin/<base>` in the filter comes from the worker's
  resolved base branch (same source the pre-validate base-merge already uses).
- pnpm is the workspace/package manager for the targeted-filter form; non-pnpm or
  non-workspace repos fall through to the plain configured command (FR-005).
- Diff classification operates on the same changed-file set the engine can already
  derive from the PR/branch diff, computed against the resolved base branch
  (`origin/<base>`) — the same base used by the `...[origin/<base>]` filter and the
  `failThenPass` base-ref worktree (clarified).
- `verification` charter question wording lives in the charter builder as static
  text (no per-run templating beyond existing fields).
- `speckit-bugfix` default `blockingSeverity: critical` is already the global
  `DEFAULT_REVIEW` default; no per-workflow default override is required by this
  issue.

## Open Questions (for /clarify) — RESOLVED

All clarifications answered in `clarifications.md` (Batch 1). Resolutions:

- **Q1 — Targeted validate mechanism** → **B**: The engine rewrites the *built-in
  default* validate command only, into the pnpm `...[origin/<base>]` filter form.
  An operator-set custom `validateCommand` is left fully untouched. Guards may
  override the result to full/plain/skip/test-scoped.
- **Q2 — Guard file globs** → **A** (standard set): root-config force-full =
  `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `pnpm-workspace.yaml`, root
  `tsconfig*.json`, `.github/workflows/**`; docs-only = `**/*.md` + `docs/**`;
  test-only = `**/*.{test,spec}.{ts,tsx,js,jsx}` + `**/__tests__/**`.
- **Q3 — `failThenPass` execution + empty-set** → **A**: base-ref run in a detached
  git worktree (branch checkout untouched); new/changed test files = diff set
  filtered to test globs; empty set → non-blocking no-op.
- **Q4 — Workflow scope** → **B**: `speckit-bugfix` only by default; other workflows
  keep the plain resolved command unless explicitly configured.
- **Q5 — Per-workflow agents keying** → **A**: fully delivered upstream by
  #1095/#1122 via `resolveAgentForPhase`; this issue only exercises it (no new
  resolution path), demonstrated by the SC-003/US4 harness run.

## Out of Scope

- The per-workflow config schema and `resolveWorkflowOverrides` precedence (shipped
  in #1122).
- The review executor, remediate executor, verdict computation, and gate/cap
  machinery (shipped in #1124/#1128).
- Merge-readiness / CI-vs-validate reconciliation (separate epic item).
- Changing default `maxRemediations`/`blockingSeverity` values.

---

*Generated by speckit*
