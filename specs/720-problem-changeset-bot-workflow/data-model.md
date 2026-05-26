# Data Model: Changeset Check

**Feature**: #720 — Make Changeset Bot a Required, Blocking Check
**Date**: 2026-05-26

This is a CI workflow, not an application — the "data model" here captures the script's inputs, classification states, and outputs.

## Inputs

| Name | Source | Type | Notes |
|---|---|---|---|
| `BASE` | `${{ github.event.pull_request.base.sha }}` | git SHA | Merge target's tip at PR creation/sync. Available from the `pull_request` event payload. |
| `HEAD` | `${{ github.event.pull_request.head.sha }}` | git SHA | PR branch tip. |
| Repository tree | `actions/checkout@v4` with `fetch-depth: 0` | git working dir | Full history required for `git diff $BASE $HEAD` to resolve both SHAs. |

## Derived Sets

| Name | Definition |
|---|---|
| `CHANGED_FILES` | `git diff --name-only $BASE $HEAD` |
| `IN_SCOPE_FILES` | `CHANGED_FILES` filtered by `^packages/[^/]+/src/` |
| `IN_SCOPE_NON_TEST_FILES` | `IN_SCOPE_FILES` minus any path matching `\.(test\|spec)\.(ts\|tsx)$` or containing `/__tests__/` |
| `ADDED_CHANGESETS` | `git diff --name-only --diff-filter=A $BASE $HEAD -- '.changeset/*.md'`, excluding `README.md` |

## Classification (Decision Table)

The script's classification is the cross-product of two booleans:

| `IN_SCOPE_NON_TEST_FILES` empty? | `ADDED_CHANGESETS` empty? | Classification | Exit | Reason |
|---|---|---|---|---|
| Yes (no in-scope OR test-only) | — (irrelevant) | **Skip** | 0 | No publishable source changed; or changes are test-only. |
| No | Yes | **Block** | 1 | Source changed; no changeset added in this PR. |
| No | No | **Pass** | 0 | Source changed; changeset present in PR diff. |

Sub-classifications of `Skip` (for log clarity):

| `IN_SCOPE_FILES` empty? | `IN_SCOPE_NON_TEST_FILES` empty? | Log line |
|---|---|---|
| Yes | Yes | `No publishable-package source files changed; skipping changeset check.` |
| No  | Yes | `Only test files changed under packages/*/src/; skipping changeset check.` |

## Outputs

| Channel | Content |
|---|---|
| `stdout` | Human-readable log lines (one per classification step + final outcome). |
| GitHub annotations | `::error::` on Block; no annotations on Skip/Pass (keep CI log clean). |
| Process exit code | 0 on Skip/Pass, 1 on Block. |

## Compatibility Cases

These are PR shapes that must be correctly classified by the table above. Verified against clarification Q3 analysis:

| PR shape | `IN_SCOPE_NON_TEST_FILES` | `ADDED_CHANGESETS` | Expected classification |
|---|---|---|---|
| `develop → main` sync PR (e.g. #718, #721, #724) | empty (only changesets + meta files) | non-empty | **Pass** |
| `changeset-release/main` bot PR (#722, #725) — deletes changesets, bumps `package.json` | empty (no `src/` touched) | empty (changesets deleted, not added) | **Skip** (path-scoped) |
| Feature PR with `packages/orchestrator/src/foo.ts` change, no changeset | non-empty | empty | **Block** |
| Feature PR with `packages/orchestrator/src/__tests__/foo.test.ts` change only | empty (test-only filter) | empty | **Skip** (test-only) |
| Docs-only PR (`specs/*`, `docs/*`, `.github/*`) | empty | empty | **Skip** (no in-scope) |
| Feature PR with `src/` change + empty changeset (`pnpm changeset --empty`) | non-empty | non-empty (empty changeset is still a file) | **Pass** |

## Validation Rules

| Rule | Enforcement |
|---|---|
| `BASE` and `HEAD` must be reachable in the local clone | Implicit — `actions/checkout@v4` with `fetch-depth: 0` is already configured; `git diff` will fail loudly otherwise. |
| `.changeset/README.md` is excluded | Path glob `'.changeset/*.md'` combined with `--diff-filter=A` already excludes README (it's never added in a PR). Belt-and-braces: `grep -v README.md` if needed. |
| Test-file regex is case-sensitive | Repo convention is lowercase; case-insensitive matching would risk false positives. |
| Workflow only runs on non-draft PRs | Job-level `if: github.event.pull_request.draft == false` (preserved from current). |
