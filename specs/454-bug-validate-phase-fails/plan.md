# Implementation Plan: Fix validate phase after worker restart

**Feature**: Validate phase fails with TS2307 after worker restart because workspace package `dist/` directories are missing
**Branch**: `454-bug-validate-phase-fails`
**Status**: Complete

## Summary

The `preValidateCommand` default in `WorkerConfigSchema` only runs `pnpm install`, which links workspace packages but doesn't build them. After a worker restart (fresh clone), the `dist/` directories are absent, so `tsc` can't resolve `@generacy-ai/orchestrator` type declarations.

**Fix**: Change the default `preValidateCommand` from `'pnpm install'` to `'pnpm install && pnpm -r --filter ./packages/* build'` so workspace packages are always compiled before validation runs.

## Technical Context

**Language/Version**: TypeScript 5.6+, Node.js ≥20
**Primary Dependencies**: Zod (schema validation), pnpm (workspace manager)
**Testing**: Vitest (`vitest run`)
**Project Type**: Monorepo with `packages/*` workspace packages

## Constitution Check

No `.specify/memory/constitution.md` found — no constraints to check.

## Project Structure

### Files to Modify

```text
packages/orchestrator/src/worker/config.ts                    # Change preValidateCommand default
packages/orchestrator/src/worker/__tests__/cli-spawner.test.ts # Update test expectation for new default
packages/orchestrator/src/worker/__tests__/config.test.ts      # Update/add test for new default
```

### Files to Read (no changes)

```text
packages/orchestrator/src/worker/cli-spawner.ts   # runPreValidateInstall — no changes needed
packages/orchestrator/src/worker/phase-loop.ts     # Consumes config.preValidateCommand — no changes needed
```

## Implementation Approach

### Step 1: Update the default value (config.ts:29)

Change line 29 in `packages/orchestrator/src/worker/config.ts`:

```typescript
// Before
preValidateCommand: z.string().default('pnpm install'),

// After
preValidateCommand: z.string().default('pnpm install && pnpm -r --filter ./packages/* build'),
```

No other production code changes needed. The `preValidateCommand` is consumed by `phase-loop.ts` (line 150) and executed by `cli-spawner.ts` (`runPreValidateInstall`), both of which treat it as an opaque string — no code changes required there.

### Step 2: Update tests

1. **`cli-spawner.test.ts`** — Update the `WorkerConfigSchema - preValidateCommand` test block (line 422-436):
   - Change the "defaults to pnpm install" assertion to match the new default

2. **`config.test.ts`** — No changes needed (tests `maxImplementRetries`, not `preValidateCommand`)

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `pnpm -r --filter ./packages/* build` fails on a package without `build` script | Low | Medium | pnpm skips packages without the matching script |
| Increased pre-validate time (~30-60s for package builds) | Certain | Low | Acceptable trade-off; builds are idempotent and fast when dist/ already exists |
| Custom `preValidateCommand` overrides break | None | N/A | Only the default changes; user-specified values pass through unchanged (FR-002) |

## Verification

1. Run existing tests: `cd packages/orchestrator && pnpm test`
2. Confirm the schema default matches the new value
3. Manual verification (optional): `docker restart tetrad-development-worker-3`, trigger validation, confirm exit code 0
