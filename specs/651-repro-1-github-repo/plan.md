# Implementation Plan: CLI scaffolder hardcodes REPO_BRANCH=main

**Feature**: Remove hardcoded `'main'` fallback for `repoBranch` in CLI scaffolder
**Branch**: `651-repro-1-github-repo`
**Status**: Complete

## Summary

The CLI scaffolder's `scaffoldEnvFile()` function defaults `repoBranch` to `'main'` when no value is provided. Since neither the cloud `LaunchConfig` nor the CLI launch/deploy flows pass a branch, every scaffolded cluster gets `REPO_BRANCH=main` — breaking repos whose default branch is `develop`, `master`, `trunk`, etc.

The fix removes the `?? 'main'` fallback and conditionally omits the `REPO_BRANCH=` line when no branch is specified. This allows `git clone` (in the cluster-base entrypoint) to use the repo's HEAD, which is the correct default branch.

## Technical Context

**Language/Version**: TypeScript, Node >=22, ESM
**Primary Dependencies**: `yaml` (for YAML serialization), `node:fs`, `node:path`
**Testing**: Vitest (existing test file at `__tests__/scaffolder.test.ts`)
**Target Platform**: CLI (`packages/generacy`)
**Scope**: Single file fix + test updates

## Project Structure

### Files to Modify

```text
packages/generacy/src/cli/commands/cluster/
├── scaffolder.ts                    # Core fix: line 279 + line 295
└── __tests__/
    └── scaffolder.test.ts           # Update 2 assertions, add 3 new test cases
```

### Files Unchanged (context only)

```text
packages/generacy/src/cli/commands/launch/scaffolder.ts   # Caller — no repoBranch passed (correct)
packages/generacy/src/cli/commands/deploy/scaffolder.ts   # Caller — no repoBranch passed (correct)
```

## Implementation Steps

### Step 1: Remove hardcoded fallback (scaffolder.ts)

**File**: `packages/generacy/src/cli/commands/cluster/scaffolder.ts`

- **Line 279**: Change `const repoBranch = input.repoBranch ?? 'main';` → `const repoBranch = input.repoBranch;`
- **Lines 294-295**: Make the `REPO_BRANCH=` line conditional:
  - When `repoBranch` is defined and non-empty, emit `REPO_BRANCH=<value>`
  - When `repoBranch` is `undefined` or `''`, omit the line entirely

Implementation approach — replace the static line with conditional insertion into the `lines` array:
```typescript
const repoBranch = input.repoBranch;
// ...
// In the lines array, replace the fixed `REPO_BRANCH=${repoBranch}` with:
...(repoBranch ? [`REPO_BRANCH=${repoBranch}`] : []),
```

### Step 2: Update existing tests (scaffolder.test.ts)

**File**: `packages/generacy/src/cli/commands/cluster/__tests__/scaffolder.test.ts`

- **Line 387**: Current assertion `expect(content).toContain('REPO_BRANCH=main')` must change. If the test provides an explicit `repoBranch`, keep the assertion with the new value. If not, assert `REPO_BRANCH` is absent.
- **Line 457**: Same — "uses defaults for optional fields" test currently expects `REPO_BRANCH=main`. Update to assert the line is omitted.

### Step 3: Add new test cases

Add 3 test cases to the `scaffoldEnvFile` describe block:

1. **No branch specified** → `REPO_BRANCH` line omitted from `.env`
2. **Explicit `develop` branch** → `REPO_BRANCH=develop` present in `.env`
3. **Explicit `main` branch** → `REPO_BRANCH=main` present in `.env` (opt-in, not default)

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Cluster-base entrypoint doesn't handle missing `REPO_BRANCH` | Low | High | Spec assumption: companion PR in cluster-base handles unset var |
| Existing clusters break on re-scaffold | None | None | `.env` is only written on initial scaffold, not updated |
| Deploy command regression | Low | Low | Deploy also omits `repoBranch` — same fix path |

## Verification

- [ ] `pnpm test` passes in `packages/generacy`
- [ ] SC-001: `grep -rn "'main'" packages/generacy/src/cli/commands/cluster/scaffolder.ts` returns 0 results for repoBranch context
- [ ] SC-004: 3 new test cases exist and pass
- [ ] Manual: scaffold output with no branch omits `REPO_BRANCH` line
- [ ] Manual: scaffold output with explicit branch includes `REPO_BRANCH=<value>`
