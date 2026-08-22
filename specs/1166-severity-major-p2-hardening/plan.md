# Implementation Plan: Bugfix targeted-validate and fail-then-pass hardening

**Feature**: Close seven post-merge-review defects in the `speckit-bugfix` targeted-validate classifier and the opt-in fail-then-pass regression prover so the bugfix validate signal is trustworthy.
**Branch**: `1166-severity-major-p2-hardening`
**Status**: Complete

## Summary

Two `speckit-bugfix` validate mechanisms shipped by epic #1120 produce wrong or
vacuous results in seven documented ways. This feature fixes all seven with
surgical, additive changes concentrated in two files plus a one-line doc edit:

- **Targeted-validate wiring** (`phase-loop.ts` `resolveTargetedValidate` /
  `computeEffectiveValidateCommand`): existence-filter the diff set before
  classification (FR-001/FR-002), guard against a zero-project `pnpm --filter`
  (FR-003), and add `<base>` substitution for custom commands (FR-010).
- **Fail-then-pass prover** (`fail-then-pass.ts` `runFailThenPass`): distinguish
  an infrastructure failure at the base ref from a genuine test outcome and turn
  it into a non-blocking `skip` (FR-004/FR-005), bound each test run by a
  dedicated wall-clock cap (FR-006), clean up the `mkdtemp` parent and reconcile
  orphaned worktrees on every path (FR-007/FR-008), and treat a `git worktree add`
  failure as a `skip` (FR-009).
- **Doc** (`bugfix-profile-config.md`): use `origin/<base>` instead of the
  hardcoded `origin/develop` (FR-010).

The pure classifier `classifyDiff` is **not modified** — all I/O (existence
probing, zero-project probing) lives in the wiring layer per clarification Q3=A.
Every decision emits a single observability log line (FR-011). Non-bugfix
workflows and non-triggering bugfix runs stay byte-identical (FR-012).

## Technical Context

- **Language/runtime**: TypeScript (ESM), Node >=22.
- **Package**: `@generacy-ai/orchestrator` (`packages/orchestrator`).
- **Test framework**: Vitest. Existing suites mock `node:child_process`
  (`execFile` router) and `node:fs/promises`.
- **Key dependencies (existing, no new deps)**: `node:child_process`,
  `node:fs`/`node:fs/promises`, `node:os`, `node:path`, `git`, `pnpm`.
- **Interacting components**: `classifyDiff` (pure, untouched),
  `resolveWorkflowOverrides` (workflow→repo→cluster precedence),
  `resolveBaseRef`, `getFilesChangedBetween`, `DEFAULT_VALIDATE_COMMAND`.
- **Clarifications resolved (all A)**: Q1 signature-detect infra, no base build
  step; Q2 conservative pre-collection-only infra signature; Q3 keep classifier
  pure, I/O in wiring; Q4 `<base>` placeholder substitution; Q5 dedicated per-run
  timeout constant.

## Project Structure

### Files modified

```
packages/orchestrator/src/worker/
  phase-loop.ts                 # FR-001/002/003 (resolveTargetedValidate),
                                # FR-010 (computeEffectiveValidateCommand <base> subst),
                                # FR-011 (one log line per fall-back decision)
  fail-then-pass.ts             # FR-004/005 (isInfraFailure → skip),
                                # FR-006 (BASE_TEST_TIMEOUT_MS per-run timeout),
                                # FR-007 (mkdtemp parent rm),
                                # FR-008 (signal-free cleanup + git worktree prune),
                                # FR-009 (worktree-add try/catch → skip)

packages/orchestrator/src/worker/__tests__/
  fail-then-pass.test.ts        # new: infra-skip, timeout-skip, mkdtemp-parent
                                # cleanup, prune, worktree-add-failure → skip
  phase-loop.*.test.ts          # new/extended: existence-filter, zero-project
                                # fallback, <base> substitution

docs/docs/reference/
  bugfix-profile-config.md      # FR-010: origin/develop → origin/<base>

packages/orchestrator/src/worker/  # diff-classifier.ts — UNCHANGED (Q3=A)
```

### Files NOT changed (guardrails)

- `diff-classifier.ts` — the classifier stays pure/no-I/O; the empty
  filtered-set path already yields `full-fallback('empty-diff')`, so FR-002 needs
  no classifier change.
- `config.ts` `DEFAULT_VALIDATE_COMMAND` — unchanged; the `isBuiltInDefault`
  identity check is the gate that keeps custom commands verbatim (except for the
  new `<base>` substitution).

### Contracts

```
specs/1166-severity-major-p2-hardening/contracts/
  targeted-validate-hardening.md        # FR-001/002/003 wiring behavior
  fail-then-pass-hardening.md           # FR-004..009 prover behavior
  validate-command-base-placeholder.md  # FR-010 <base> substitution + doc
```

## Constitution Check

No `.specify/memory/constitution.md` exists in this repository — constitution
check skipped.

## Key Decisions

1. **Existence filtering + zero-project guard live in the wiring layer**
   (`resolveTargetedValidate`), never inside `classifyDiff` (Q3=A). The classifier
   receives an already-existence-filtered path set; its documented "pure,
   deterministic, no I/O, never throws" contract from #1134 is preserved.
2. **Empty filtered set → full fallback for free.** After existence filtering, an
   empty `changedFiles` array makes `classifyDiff` return
   `full-fallback('empty-diff')`, which `computeEffectiveValidateCommand` maps to
   the verbatim default command. FR-002 requires no extra branch.
3. **Zero-project probe is fail-safe.** When the `pnpm --filter "...[origin/<base>]"`
   selection is empty (or the probe errors), fall back to the full built-in
   default — never run a targeted command that built/tested nothing.
4. **Conservative infra signature (Q2=A).** Only a *pre-collection* failure —
   vitest exiting having collected/run zero tests (e.g. "No test files found", a
   dist/module-resolution error before any test runs) — counts as infra. A
   collected-and-failed test is always a genuine outcome. Bias to "genuine" on
   ambiguity so a real base-ref failure is never masked.
5. **Dedicated per-run test timeout (Q5=A).** New `BASE_TEST_TIMEOUT_MS` mirrors
   `BASE_INSTALL_TIMEOUT_MS`, applied as a per-run `timeout` on each `runTests`
   call (base and branch), independent of the install cap and comfortably under
   the cli-spawner phase cap. A timeout is a non-blocking `skip`, not a failure.
6. **`<base>` substitution mirrors the merge-conflict precedent.** The existing
   `phase-loop.ts` merge-conflict remedy already substitutes `<base>`/`<branch>`
   by stripping the `origin/` prefix; the custom-`validateCommand` path reuses the
   same shape.
7. **Testability seam for the zero-project probe.** The `pnpm --filter … --json`
   selection probe is invoked through the same `execFile` path the existing tests
   already mock, so no new production DI surface is required; tests route the
   probe through the shared `execFile` handler.

## Changeset

`.changeset/1166-bugfix-validate-hardening.md` — `@generacy-ai/orchestrator`
**patch** (`workflow:speckit-bugfix` defect fix; no new public exports). The
`bugfix-profile-config.md` edit is under `docs/`, not `packages/*/src/`, so it
does not itself trigger the changeset gate; the `.ts` changes do.

## Next Step

Run `/speckit:tasks` to generate the task list from this plan.
