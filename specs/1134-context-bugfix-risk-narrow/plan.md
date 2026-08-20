# Implementation Plan: Bugfix profiles — verification review charter + targeted validate with diff-classification guards

**Feature**: Verification review charter (four bugfix questions), engine-side targeted-validate diff classification, opt-in `failThenPass`, and composition with per-workflow agents keying.
**Branch**: `1134-context-bugfix-risk-narrow`
**Status**: Complete

## Summary

Feature #1134 supplies the *behavior* that the per-workflow config keys shipped in
#1122/#1124 switch on. Four deliverables:

1. **Verification charter (US1/FR-001/FR-002)** — extend the `verification` branch of
   `buildReviewCharter` to render four delineated bugfix questions (root cause vs
   symptom; regression test fails-without-fix; scope creep; regression risk in
   changed lines). The `standard` branch stays byte-identical.
2. **Targeted validate (US2/FR-003–FR-009)** — a new pure, deterministic
   diff-classification function that categorizes a changed-file set into
   `full-fallback | single-package-plain | docs-only-skip-tests | test-only |
   targeted`, plus wiring in the validate phase (speckit-bugfix only) that rewrites
   the **built-in default** validate command into the pnpm `...[origin/<base>]`
   filter form before execution and logs the decision.
3. **`failThenPass` (US3/FR-010/FR-011)** — opt-in check that runs new/changed test
   files against the base ref in a detached git worktree and against the branch,
   failing validate unless base-fails and branch-passes. Off by default; empty
   test-set is a non-blocking no-op.
4. **Per-workflow agents keying (US4/FR-012)** — no new code; the existing
   `resolveAgentForPhase` five-tier precedence already resolves bugfix
   review/remediate provider/model/effort. Exercised by a harness test only.

### What already exists (do not rebuild)

- `resolveWorkflowOverrides` two-tier merge → `review.{profile,blockingSeverity,failThenPass}`,
  `maxRemediations`, `validateCommand`, `preValidateCommand` (`worker/config.ts`).
- `DEFAULT_REVIEW` (`profile: standard`, `blockingSeverity: critical`,
  `failThenPass: false`) and `defaultMaxRemediations` (bugfix `2`, else `3`).
- `ReviewExecutor` reads `review.profile`/`blockingSeverity` → `buildReviewCharter`.
- `resolveAgentForPhase(config, workflowName, phase)` (`config.ts:362`) — five-tier
  precedence, delivered by #1095/#1122.
- `resolveBaseBranch` (`base-merge.ts`) / `resolveBaseRef` (`product-diff.ts`) return
  `origin/<name>`; `github.getFilesChangedBetween(baseRef, 'HEAD')` yields the
  changed-file set.
- Validate phase execution: `cli-spawner.runValidatePhase(checkoutPath, validateCommand, signal)`
  invoked from `phase-loop.ts:629`.

## Technical Context

- **Language / runtime**: TypeScript (ESM), Node >=22, vitest.
- **Packages touched**: `@generacy-ai/orchestrator` (primary), `@generacy-ai/config`
  (none — schema already shipped). No `workflow-engine` label vocabulary added, so
  the changeset is a **patch** (see Changeset).
- **New module**: `packages/orchestrator/src/worker/diff-classifier.ts` — pure, no I/O.
- **New module**: `packages/orchestrator/src/worker/fail-then-pass.ts` — worktree +
  test-run orchestration (I/O, invoked from the validate path).
- **Modified**: `worker/review-charter.ts` (verification branch),
  `worker/phase-loop.ts` (validate block wiring), `worker/config.ts` (export a
  `DEFAULT_VALIDATE_COMMAND` constant for Q1=B built-in-default detection),
  `worker/cli-spawner.ts` (no signature change expected; targeted command is still a
  shell string passed to `runValidatePhase`).

### Constraints (from clarifications)

- **Q1=B**: rewrite the **built-in default** `pnpm test && pnpm build` only. Detect
  by comparing `config.validateCommand === DEFAULT_VALIDATE_COMMAND`. An
  operator-set custom command is left untouched — classification still runs and logs,
  but the command is not rewritten (guards that *skip*/*scope* tests still do not
  apply to a custom command; only the default gets the filter treatment).
- **Q2=A**: standard guard globs (see data-model.md).
- **Q3=A**: detached worktree for base-ref run; empty new/changed-test set →
  non-blocking no-op.
- **Q4=B**: targeted validate + classification apply to `speckit-bugfix` only by
  default. Gate on `context.item.workflowName === 'speckit-bugfix'`.
- **Q5=A**: no new agent-resolution path.
- **FR-013/SC-005**: with defaults unchanged and a non-bugfix workflow, validate and
  charter behavior are byte-identical to pre-change.

## Project Structure

```
packages/orchestrator/src/worker/
  diff-classifier.ts              # NEW — pure classifier (FR-003–FR-008)
  fail-then-pass.ts               # NEW — worktree base-ref test run (FR-011)
  review-charter.ts               # MOD — verification 4-question branch (FR-001/FR-002)
  config.ts                       # MOD — export DEFAULT_VALIDATE_COMMAND (Q1=B)
  phase-loop.ts                   # MOD — classify + rewrite + failThenPass wiring (FR-009)
  __tests__/
    diff-classifier.test.ts       # NEW — SC-001 (every branch + guard)
    review-charter.test.ts        # MOD — SC-002 (verification 4Q, standard unchanged)
    fail-then-pass.test.ts        # NEW — SC-004 (on/off, base-fails/branch-passes)
    phase-loop.targeted-validate.test.ts  # NEW — SC-003 wiring + logging + scope gate
```

## Constitution Check

No `.specify/memory/constitution.md` in the repo → constitution check skipped.

## Key Technical Decisions

1. **Classifier is pure** (FR-003): input `{ changedFiles: string[]; isWorkspace: boolean; base: string }`,
   output a discriminated `Classification`. No git, no fs. Deterministic and
   trivially unit-testable (SC-001). Guard precedence is fixed and order-sensitive:
   root-config → single-package → docs-only → test-only → targeted.
2. **Built-in-default detection via exported constant** (Q1=B): add
   `export const DEFAULT_VALIDATE_COMMAND = 'pnpm test && pnpm build'` and reference it
   from the schema `.default(...)`. The validate wiring compares `config.validateCommand`
   against it to decide whether the command is rewritable.
3. **Workspace detection** reads `pnpm-workspace.yaml` presence at the checkout root
   (single fs stat). Absent → `isWorkspace: false` → single-package-plain guard.
4. **`failThenPass` worktree** mirrors `base-merge.ts` `execFileAsync` git patterns:
   `git worktree add --detach <tmp> <baseRef>` → run filtered test files there →
   `git worktree remove --force <tmp>`. Branch checkout untouched (Q3=A).
5. **Scope gate** (Q4=B): the entire targeted-validate + failThenPass block is gated
   on `workflowName === 'speckit-bugfix'`. Every other workflow reaches the existing
   `runValidatePhase(config.validateCommand)` call unchanged (SC-005).

## Next Step

`/speckit:tasks` to generate the task list.
