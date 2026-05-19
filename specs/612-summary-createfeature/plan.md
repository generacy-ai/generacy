# Implementation Plan: Remove hardcoded 999 cap in createFeature()

**Feature**: Remove hardcoded guard that rejects feature numbers > 999
**Branch**: `612-summary-createfeature`
**Status**: Complete

## Summary

`createFeature()` in `packages/workflow-engine/src/actions/builtin/speckit/lib/feature.ts` has a hardcoded `> 999` guard (line 300) that silently rejects any feature number >= 1000 without an error message. This blocks projects with 1000+ GitHub issues from using the speckit workflow.

The fix involves three changes:
1. Remove the `> 999` cap entirely (padding already handles 4+ digits)
2. Add `error` strings to all failure return paths that currently lack them
3. Update the `CreateFeatureInput.number` JSDoc comment to remove the `(1-999)` range restriction
4. Add test coverage for 4+ digit feature numbers

## Technical Context

**Language/Version**: TypeScript, ESM, Node >= 22
**Primary Dependencies**: `simple-git`, `yaml`, `vitest`
**Testing**: `vitest` (unit tests with mocked fs and git)
**Project Type**: Monorepo package (`packages/workflow-engine`)

## Constitution Check

No `.specify/memory/constitution.md` found. No governance gates to check.

## Project Structure

### Files to Modify

```text
packages/workflow-engine/src/actions/builtin/speckit/
├── lib/
│   ├── feature.ts                    # Remove cap, add error strings
│   └── __tests__/
│       └── feature.test.ts           # Add >= 1000 test cases
└── types.ts                          # Update JSDoc on number field
```

### Changes by File

#### 1. `feature.ts` (3 changes)

- **Remove lines 300-309**: Delete the `if (featureNumInt > 999)` block entirely
- **Add `error` to line 279-287 return**: `error: 'Could not find repository root'`
- **Add `error` to line 317-326 return**: `error: 'Invalid branch name: ...'` (already has `branch_name` in the return, use it)

#### 2. `types.ts` (1 change)

- **Line 38**: Change `/** Optional explicit branch number (1-999) */` to `/** Optional explicit feature/issue number */`

#### 3. `feature.test.ts` (1 new test block)

- Add a `describe('feature numbers >= 1000')` block with tests:
  - `succeeds for issue number 1000`
  - `succeeds for issue number 9999`
  - `generates correct branch name with 4+ digit padding`

## Complexity Tracking

No complexity violations. This is a targeted bugfix: remove ~10 lines, add ~3 error strings, add ~30 lines of tests.
