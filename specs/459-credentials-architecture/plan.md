# Implementation Plan: Add optional role field to DefaultsConfigSchema

**Branch**: `459-credentials-architecture` | **Date**: 2026-04-13 | **Spec**: [spec.md](./spec.md)
**Status**: Complete

## Summary

Add an optional `role` field to `DefaultsConfigSchema` in `packages/generacy/src/config/schema.ts`. This is Phase 1 of the credentials architecture — a single Zod field addition (`z.string().optional()`) that enables `.generacy/config.yaml` to declare a default credential role. The field is not consumed at runtime yet (Phase 3). The change is fully backwards-compatible since Zod treats missing optional fields as `undefined`.

## Technical Context

**Language/Version**: TypeScript (Node.js)
**Primary Dependencies**: Zod (schema validation)
**Testing**: Vitest via `pnpm test` (config package)
**Target Platform**: Node.js
**Project Type**: Monorepo (`packages/generacy`)

## Constitution Check

No `constitution.md` exists in this project. No gates to check.

## Project Structure

### Files to Modify

```text
packages/generacy/src/config/schema.ts                          # Add role field to DefaultsConfigSchema (line ~94)
packages/generacy/src/config/__tests__/schema.test.ts           # Add test cases for role field
packages/generacy/src/config/__tests__/fixtures/valid-full.yaml # Add role to full fixture
```

### Files to Add

```text
packages/generacy/src/config/__tests__/fixtures/valid-with-role.yaml  # New fixture: config with role field
```

### Files to Audit (read-only)

```text
packages/generacy/src/config/__tests__/fixtures/valid-with-defaults.yaml  # Verify no-role still works
packages/generacy/src/config/__tests__/fixtures/valid-minimal.yaml        # Verify minimal still works
```

## Implementation Steps

### Step 1: Add `role` field to `DefaultsConfigSchema`

In `packages/generacy/src/config/schema.ts`, add to `DefaultsConfigSchema` (after the `baseBranch` field, ~line 94):

```typescript
/**
 * Default credential role for workflow runs
 * Free-form string, no validation at this phase
 */
role: z.string().optional(),
```

This is the only production code change.

### Step 2: Add test cases to `schema.test.ts`

Add to the `DefaultsConfigSchema` describe block:

1. **Config with role set parses correctly** — parse `{ role: 'developer' }`, expect `result.role` to equal `'developer'`
2. **Config without role parses correctly (undefined)** — parse `{}`, expect `result.role` to be `undefined`
3. **Config with role and other fields** — parse `{ agent: 'claude-code', baseBranch: 'main', role: 'developer' }`, expect all three fields present

### Step 3: Update `valid-full.yaml` fixture

Add `role: developer` to the `defaults:` section so the "full config" fixture exercises the new field.

### Step 4: Add `valid-with-role.yaml` fixture

Create a new fixture that specifically tests the role field in a defaults section:

```yaml
project:
  id: "proj_role12345"
  name: "Role Test Project"

repos:
  primary: "github.com/test/role-test"

defaults:
  agent: claude-code
  role: developer
```

### Step 5: Verify all tests pass

Run `pnpm test` in the generacy package to confirm:
- All existing tests still pass (backwards compatibility)
- New role tests pass

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Existing tests break | Very Low | `z.string().optional()` is additive; missing field → `undefined` |
| Type inference changes break consumers | None | No callers consume `role` yet; typed as `string \| undefined` |
| Fixture update breaks fixture-based tests | Very Low | Adding an optional field to fixtures cannot cause parse failures |
