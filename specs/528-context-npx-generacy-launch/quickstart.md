# Quickstart: CLI launch-config schema fix for repos.dev/clone

**Feature**: #528 | **Date**: 2026-05-01

## Prerequisites

- Node.js >=22
- pnpm installed

## Build

```bash
cd /workspaces/generacy
pnpm install
pnpm -C packages/generacy build
```

## Run Tests

```bash
# All generacy CLI tests
pnpm -C packages/generacy test

# Just the launch command tests
pnpm -C packages/generacy test -- --reporter=verbose src/cli/commands/launch/__tests__/cloud-client.test.ts
pnpm -C packages/generacy test -- --reporter=verbose src/cli/commands/launch/__tests__/integration.test.ts
pnpm -C packages/generacy test -- --reporter=verbose src/cli/commands/launch/__tests__/scaffolder.test.ts
```

## Verification

### 1. Type-check passes

```bash
pnpm -C packages/generacy tsc --noEmit
```

Zero errors expected.

### 2. Schema accepts array payloads

The `cloud-client.test.ts` test should validate a response with array-format dev/clone repos:
```json
{
  "repos": {
    "primary": "generacy-ai/example-project",
    "dev": ["generacy-ai/lib-a", "generacy-ai/lib-b"],
    "clone": ["generacy-ai/docs"]
  }
}
```

### 3. Schema still accepts absent fields

Existing tests with `repos: { primary: "..." }` (no dev/clone) should continue to pass — both fields are optional.

### 4. All existing tests pass

```bash
pnpm -C packages/generacy test
```

No regressions.

## Troubleshooting

### Zod validation still failing

Check that both `dev` and `clone` were changed to `z.array(z.string()).optional()`. A common mistake is changing only one field.

### Type errors in downstream code

Run `pnpm -C packages/generacy tsc --noEmit` to identify. If any code was treating `repos.dev` as a `string`, it needs to be updated to handle `string[] | undefined`. (Audit found no such code in the launch flow.)
