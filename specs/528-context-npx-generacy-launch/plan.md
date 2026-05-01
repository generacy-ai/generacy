# Implementation Plan: CLI launch-config schema: dev/clone repos should be string[], not single string

**Feature**: Fix Zod validation failure in `npx generacy launch` for projects with dev/clone repos
**Branch**: `528-context-npx-generacy-launch`
**Status**: Complete

## Summary

The CLI's `LaunchConfigSchema` in `packages/generacy/src/cli/commands/launch/types.ts` declares `repos.dev` and `repos.clone` as `z.string().optional()`, but the cloud API returns these fields as `string[]`. This causes Zod validation to reject every launch-config response for projects with dev or clone repos. The fix is a one-line schema change (per field) plus test fixture updates. No downstream consumers need modification — the launch flow never reads `repos.dev` or `repos.clone` directly.

## Technical Context

**Language/Version**: TypeScript (ESM), Node.js >=22
**Primary Dependencies**: `zod` (already present)
**Testing**: Vitest (`vitest run`)
**Target Platform**: CLI (`packages/generacy`)
**Project Type**: Monorepo package (`packages/generacy`)
**Constraints**: Zero new dependencies; schema must match cloud API response shape

## Project Structure

### Documentation (this feature)

```text
specs/528-context-npx-generacy-launch/
├── spec.md              # Feature specification
├── plan.md              # This file
├── research.md          # Analysis of cloud API and downstream consumers
├── data-model.md        # Schema before/after diff
└── quickstart.md        # Testing and verification guide
```

### Source Code (changes)

```text
packages/generacy/
├── src/cli/commands/launch/
│   └── types.ts                          # PRIMARY: Fix repos.dev/clone schema
│   └── cloud-client.ts                   # Verify STUB_LAUNCH_CONFIG is compatible
│   └── __tests__/
│       ├── cloud-client.test.ts          # Add array-format test fixtures
│       ├── integration.test.ts           # Add array-format test fixtures
│       └── scaffolder.test.ts            # Add array-format test fixtures
```

## Implementation Steps

### Step 1: Fix `LaunchConfigSchema` in `types.ts`

**File**: `packages/generacy/src/cli/commands/launch/types.ts`

Lines 28-29: Change from:
```ts
dev: z.string().optional(),
clone: z.string().optional(),
```
To:
```ts
dev: z.array(z.string()).optional(),
clone: z.array(z.string()).optional(),
```

This changes the inferred `LaunchConfig` type for `repos.dev` and `repos.clone` from `string | undefined` to `string[] | undefined`.

### Step 2: Verify downstream consumers

**Finding**: No changes needed. The launch flow never reads `repos.dev` or `repos.clone`:
- `launch/index.ts` — passes `config` to scaffolder; never accesses `repos.dev`/`repos.clone`
- `launch/scaffolder.ts` — reads only `clusterId`, `projectId`, `orgId`, `cloudUrl`, `imageTag`, `variant`
- `deploy/cloud-client.ts` — re-exports from `launch/types.ts`, gets the fix for free
- `deploy/scaffolder.ts` — same pattern as launch scaffolder, no repos.dev/clone access

**Note**: Other parts of the codebase (e.g., `validate.ts`, `init/prompts.ts`, `init/resolver.ts`) use `repos.dev`/`repos.clone` as arrays — they consume a *different* config schema (the project config, not the launch-config). Those are already correct.

### Step 3: Update test fixtures

Update test mock data to exercise array-format repos:

1. **`cloud-client.test.ts`** — Add `dev` and `clone` array fields to `VALID_LAUNCH_CONFIG`; add a test case for multi-repo response validation.
2. **`integration.test.ts`** — Add array fields to `VALID_CONFIG` fixture.
3. **`scaffolder.test.ts`** — Add array fields to `mockConfig` fixture.

The stub fixture in `cloud-client.ts` (`STUB_LAUNCH_CONFIG`) has `repos: { primary: '...' }` with no `dev`/`clone` — this is valid since both are optional. No change needed.

### Step 4: Type-check

```bash
pnpm -C packages/generacy tsc --noEmit
```

Must pass with zero errors.

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Other consumers of `LaunchConfig` type break | Type errors | Audit confirmed: no code reads `repos.dev`/`repos.clone` in launch flow |
| Deploy command breaks | Schema mismatch | Re-exports from launch/types.ts — gets fix automatically |
| Stub mode breaks | Test failures | Stub has no dev/clone (both optional) — valid for both old and new schema |

## Complexity Tracking

This is a minimal bug fix:
- 1 source file modified (`types.ts`, 2 lines changed)
- 3 test files updated (fixture data only)
- 0 new files
- 0 new dependencies
