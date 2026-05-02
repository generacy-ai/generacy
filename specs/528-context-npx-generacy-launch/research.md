# Research: CLI launch-config schema fix for repos.dev/clone

**Feature**: #528 | **Date**: 2026-05-01

## Root Cause Analysis

### Cloud API Response Shape

The generacy-cloud API at `GET /api/clusters/launch-config?claim=<code>` returns:
```json
{
  "repos": {
    "primary": "generacy-ai/example-project",
    "dev": ["generacy-ai/lib-a", "generacy-ai/lib-b"],
    "clone": ["generacy-ai/docs"]
  }
}
```

Source: `services/api/src/services/launch-config.ts:16-20` returns `dev: project.devRepos` and `clone: project.cloneRepos`, where both are `string[]`.

### CLI Schema (Bug)

`packages/generacy/src/cli/commands/launch/types.ts:28-29`:
```ts
dev: z.string().optional(),    // Expects string, receives string[]
clone: z.string().optional(),  // Expects string, receives string[]
```

Zod's `z.string()` rejects arrays with `Expected string, received array`.

### Why This Affects All Projects with Repos

Even single-repo projects send `["repo-url"]` (array of length 1), not `"repo-url"`. Only projects with zero optional repos (where the fields are absent) bypass the validation failure.

## Downstream Consumer Audit

### Launch Flow (this fix)

| File | Uses `repos.dev`/`.clone`? | Action |
|------|---------------------------|--------|
| `launch/types.ts` | Defines schema | **FIX** |
| `launch/cloud-client.ts` | Validates via schema | No change (uses `LaunchConfigSchema.safeParse`) |
| `launch/index.ts` | No direct access | No change |
| `launch/scaffolder.ts` | No access | No change |
| `launch/compose.ts` | No access | No change |
| `launch/browser.ts` | No access | No change |
| `launch/registry.ts` | No access | No change |

### Deploy Flow (re-exports)

| File | Uses `repos.dev`/`.clone`? | Action |
|------|---------------------------|--------|
| `deploy/cloud-client.ts` | Re-exports from launch/types.ts | Gets fix automatically |
| `deploy/scaffolder.ts` | No access | No change |

### Other CLI Commands (different schema)

The `validate`, `init/prompts`, and `init/resolver` commands use `repos.dev`/`.clone` as arrays — but these consume the *project config schema* (`packages/generacy/src/config/`), not the `LaunchConfigSchema`. These are already correctly typed as arrays and are unaffected by this change.

## Decision: Schema Fix Only

The fix is limited to the `LaunchConfigSchema` type definition. No consumer code needs modification because:

1. The launch flow never reads `repos.dev` or `repos.clone` directly — these fields are informational
2. Actual repo cloning happens cluster-side after activation
3. The TypeScript compiler will catch any type incompatibility via `z.infer<typeof LaunchConfigSchema>`

## Sources

- Issue #528: `npx generacy launch` fails Zod validation
- Cloud API source: `services/api/src/services/launch-config.ts`
- CLI launch flow: `packages/generacy/src/cli/commands/launch/`
