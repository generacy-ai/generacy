# Data Model: CLI launch-config schema fix for repos.dev/clone

**Feature**: #528 | **Date**: 2026-05-01

## Schema Changes

### `LaunchConfigSchema` (Zod)

**File**: `packages/generacy/src/cli/commands/launch/types.ts`

**Before** (bug):
```ts
export const LaunchConfigSchema = z.object({
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  variant: z.string().min(1),
  cloudUrl: z.string().url(),
  clusterId: z.string().min(1),
  imageTag: z.string().min(1),
  orgId: z.string().min(1),
  repos: z.object({
    primary: z.string().min(1),
    dev: z.string().optional(),          // BUG: expects string
    clone: z.string().optional(),        // BUG: expects string
  }),
});
```

**After** (fix):
```ts
export const LaunchConfigSchema = z.object({
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  variant: z.string().min(1),
  cloudUrl: z.string().url(),
  clusterId: z.string().min(1),
  imageTag: z.string().min(1),
  orgId: z.string().min(1),
  repos: z.object({
    primary: z.string().min(1),
    dev: z.array(z.string()).optional(),   // FIXED: accepts string[]
    clone: z.array(z.string()).optional(), // FIXED: accepts string[]
  }),
});
```

### Inferred TypeScript Type

**Before**:
```ts
type LaunchConfig = {
  // ...
  repos: {
    primary: string;
    dev?: string;      // wrong
    clone?: string;    // wrong
  };
};
```

**After**:
```ts
type LaunchConfig = {
  // ...
  repos: {
    primary: string;
    dev?: string[];    // correct
    clone?: string[];  // correct
  };
};
```

## Changes Summary

| Field | Before | After | Change |
|-------|--------|-------|--------|
| `repos.dev` | `z.string().optional()` | `z.array(z.string()).optional()` | Type fix |
| `repos.clone` | `z.string().optional()` | `z.array(z.string()).optional()` | Type fix |

## Validation Behavior

| Input | Before | After |
|-------|--------|-------|
| `dev: ["repo-a", "repo-b"]` | FAIL (Zod rejects) | PASS |
| `dev: ["repo-a"]` | FAIL (Zod rejects) | PASS |
| `dev: []` | FAIL (Zod rejects) | PASS |
| `dev: undefined` (absent) | PASS | PASS |
| `dev: "repo-a"` | PASS | FAIL (no longer accepted) |

The last row is acceptable: the cloud API never sends a plain string for these fields.
