# Research: CLI scaffolder REPO_BRANCH hardcode

**Feature**: #651 | **Date**: 2026-05-19

## Problem Analysis

The `scaffoldEnvFile()` function in `packages/generacy/src/cli/commands/cluster/scaffolder.ts` line 279 applies a `?? 'main'` fallback to `input.repoBranch`. Both call sites (launch and deploy scaffolders) never pass `repoBranch`, so the fallback always fires.

The generated `.env` file always contains `REPO_BRANCH=main`, which is consumed by the cluster-base entrypoint script `entrypoint-post-activation.sh` as a `git clone --branch main` argument — failing for any repo whose default branch isn't `main`.

## Call-Site Analysis

| Caller | File | Passes `repoBranch`? |
|--------|------|---------------------|
| Launch scaffolder | `commands/launch/scaffolder.ts:93-105` | No |
| Deploy scaffolder | `commands/deploy/scaffolder.ts:59-68` | No |

Neither caller has access to a branch value — the cloud's `LaunchConfig` schema does not include a branch field.

## Git Default Branch Behavior

`git clone <url>` (without `--branch`) checks out the remote's `HEAD` ref, which points to the repository's configured default branch. This is the correct behavior when no explicit branch is desired.

By omitting `REPO_BRANCH` entirely from the `.env`, the cluster-base entrypoint can detect the empty/unset var and skip the `--branch` flag, letting git use HEAD.

## Alternative Approaches Considered

| Approach | Verdict | Reason |
|----------|---------|--------|
| Default to empty string `''` | Rejected | Entrypoint would need to handle `REPO_BRANCH=` (set but empty) vs unset — fragile |
| Query GitHub API for default branch | Rejected | Adds network dependency, auth complexity, and latency to scaffolding |
| Add `primaryBranch` to `LaunchConfig` | Deferred | Cloud-side change, tracked as separate issue |
| Omit the line when unset | **Chosen** | Cleanest: git uses HEAD, no entrypoint changes needed (companion PR handles unset check) |

## Test Strategy

Vitest with `fs` mocking (existing pattern in `scaffolder.test.ts`). The test file already uses `mkdtempSync` for temp directories and reads back generated files. Three new cases cover the branch matrix:
- undefined → line omitted
- `'develop'` → line present with value
- `'main'` → line present with value (explicit, not default)
