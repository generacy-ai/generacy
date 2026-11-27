# Feature Specification: getStatus rename/copy entries break staging and silently lose phase work

**Branch**: `1239-summary-getstatus-generacy-ai` | **Date**: 2026-11-27 | **Status**: Draft
**Issue**: [#1239](https://github.com/generacy-ai/generacy/issues/1239) | **Workflow**: `workflow:speckit-bugfix`

## Summary

`GhCliClient.getStatus()` in `@generacy-ai/workflow-engine`
(`packages/workflow-engine/src/actions/github/client/gh-cli.ts:1315`) parses
`git status --porcelain` line-by-line, taking `line.substring(3)` as the changed
path. For a rename (`R`) or copy (`C`) entry the porcelain v1 text form of that
field is `old -> new`, not a path. The literal string `old -> new` then flows
into `GitStatus.staged` / `unstaged`, and `PrManager.commitAndPush`
(`packages/orchestrator/src/worker/pr-manager.ts:151`) passes it to
`stageFiles`, which runs `git add 'old -> new'`. Git exits 128
(`pathspec '…' did not match any files`).

`commitAndPush` wraps the whole body in a `try/catch` that logs
`Failed to commit/push after phase (non-fatal)` and returns
`{ kind: 'no-changes' }` (`pr-manager.ts:275-282`). The failure is swallowed, so
a phase whose agent used `git mv` loses all of its work:

- nothing is committed or pushed;
- for `implement`, the product-code guard then fails the phase as
  `no-product-code-changes` with `Own-commit files: []`;
- the next attempt starts from a fresh checkout and redoes the same tasks,
  reproducing the same failure.

## Reproduction

```sh
git init -q t && cd t && echo a > old.ts && git add . && git commit -qm init
git mv old.ts new.ts && echo x >> new.ts
git status --porcelain --untracked-files=all     # RM old.ts -> new.ts
git add "old.ts -> new.ts"                        # fatal: pathspec 'old.ts -> new.ts' did not match any files (exit 128)
```

## Observed

An `implement` run whose tasks moved several modules with `git mv` failed twice
in a row with `no-product-code-changes`, although the agent's session ended with
the changes in the working tree and all tests passing. The working tree held
` M`, `R ` and `RM` entries.

## User Stories

### US1: Renamed files are committed, not lost (Primary)

**As a** speckit implement phase running an agent that reorganizes files with
`git mv`,
**I want** `getStatus()` to report the real source and destination paths of
rename/copy entries,
**So that** `commitAndPush` stages and commits the work instead of failing
`git add` and discarding the whole phase.

**Acceptance Criteria**:
- [ ] A working tree containing `R`/`RM`/`C` entries yields `GitStatus` lists of
      real paths, never a literal `old -> new` string.
- [ ] For a rename/copy entry, both the source and the destination path are
      reported so staging captures the deletion of the source and the addition
      of the destination.
- [ ] After a phase that renames files, `commitAndPush` produces a commit that
      includes the renamed files, and `implement` no longer fails as
      `no-product-code-changes` for a rename-only phase.

### US2: Staging/commit failures are not silently swallowed

**As a** maintainer debugging a lost phase,
**I want** a genuine staging or commit error to surface as a visible phase
failure rather than a `no-changes` result,
**So that** silent work loss becomes an observable error instead of a redo loop.

**Acceptance Criteria**:
- [ ] A staging or commit error inside `commitAndPush` is distinguishable in the
      outcome from a legitimate empty working tree (not collapsed into
      `no-changes`).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `getStatus()` MUST parse porcelain output so rename/copy entries contribute real paths, not `old -> new`. Use `--porcelain -z` (NUL-separated; rename emits dest then source as two NUL fields) or `--porcelain=v2`. | P1 | `gh-cli.ts:1324-1350` |
| FR-002 | For an `R` or `C` entry, both the source (old) and destination (new) paths MUST be captured so `stageFiles` records both the removal and the addition. | P1 | Index side and working side (` R`, `R `, `RM`) all handled. |
| FR-003 | Existing status semantics MUST be preserved: `--untracked-files=all` behavior (#1162), the `staged`/`unstaged`/`untracked` split, `has_changes`, and unpushed-commit detection. | P1 | Do not regress #1162. |
| FR-004 | Paths with spaces or special characters MUST round-trip correctly through the chosen parse format. | P2 | `-z` / v2 avoid porcelain v1's quoting. |
| FR-005 | A genuine staging/commit error in `commitAndPush` SHOULD surface as a distinct, visible outcome rather than being swallowed as `no-changes`. | P2 | Issue "also consider"; scope to be confirmed in clarify. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Rename-only `implement` phase commits its work | 100% | Repro scenario: phase with `git mv` produces a commit containing the renamed paths; no `no-product-code-changes`. |
| SC-002 | `getStatus()` output for `R`/`RM`/`C` entries | No `->` substring; real paths present | Unit test over simulated porcelain output. |
| SC-003 | No regression in existing status parsing | All existing `gh-cli.get-status` tests pass | `pnpm --filter @generacy-ai/workflow-engine test` |

## Assumptions

- `git` is new enough to support `status --porcelain=v2` and `-z` (git ≥ 2.x; already relied on elsewhere).
- The fix is confined to `workflow-engine` parsing plus any error-surfacing change in `orchestrator`'s `pr-manager`; no change to the `GitStatus` interface shape is required (lists of path strings), though rename entries now contribute two paths.
- A changeset is required: non-test `src/` changes in `@generacy-ai/workflow-engine` (and possibly `@generacy-ai/orchestrator`) → `patch` (bugfix).

## Out of Scope

- Rewriting files inside commits the phase agent made directly (staging-time concern only; mirrors the #1218 limitation).
- Broader redesign of the `commitAndPush` outcome union beyond distinguishing error from `no-changes`.
- Changing how the product-code guard classifies changes.

---

*Generated by speckit*
