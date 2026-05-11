# Research: Remove Role Selection from Bootstrap Wizard

**Feature**: #582 | **Date**: 2026-05-11

## Context

The bootstrap wizard originally had 5 steps, with step 3 being "Role Selection." This step attempted to set a "cluster default role" — a concept that doesn't exist in the agency model. Roles are per-workspace (`.agency/roles/`) and per-workflow, not per-cluster. The wizard step and its supporting code are dead weight.

Issue #580 reported a 404 on `GET /control-plane/roles`. Rather than fixing the missing endpoint, the correct action is removing all role-related code from the wizard flow (#582).

## Decision: Delete vs. Stub

**Chosen**: Delete entirely.

**Rationale**: The "cluster default role" concept is architecturally invalid. Keeping stub endpoints would create confusion about whether cluster-level roles are a real feature. Clean deletion eliminates the concept entirely.

**Alternative rejected**: Returning empty/default responses from `/roles/:id`. This would leave dead code paths and misleading API surface.

## Deletion Map

### Files to delete (4 total)

| File | Purpose | Lines |
|------|---------|-------|
| `src/routes/roles.ts` | GET/PUT `/roles/:id` handlers | ~35 |
| `src/services/default-role-writer.ts` | Writes `defaults.role` to `.generacy/config.yaml` | ~56 |
| `__tests__/routes/roles.test.ts` | Tests for role handlers | ~103 |
| `__tests__/services/default-role-writer.test.ts` | Tests for default-role-writer | ~87 |

### Files to edit (5 total)

| File | Changes |
|------|---------|
| `src/router.ts` | Remove import + 2 route entries (~13 lines) |
| `src/routes/lifecycle.ts` | Remove import + handler block (~23 lines) |
| `src/schemas.ts` | Remove enum entry + body schema (~5 lines) |
| `src/index.ts` | Remove 2 re-exports |
| `__tests__/routes/lifecycle.test.ts` | Remove mock + test cases (~66 lines) |
| `__tests__/router.test.ts` | Remove 2 route test cases (~22 lines) |
| `__tests__/integration/all-routes.test.ts` | Remove 3 role endpoint tests (~26 lines) |

### Total impact
- ~280 lines of source deleted
- ~200 lines of tests deleted
- 0 lines added

## Blast Radius Analysis

All references to role-related code are contained within `packages/control-plane/`. No other packages import `handleGetRole`, `handlePutRole`, `setDefaultRole`, `SetDefaultRoleBodySchema`, or `SetDefaultRoleBody`.

The `LifecycleActionSchema` is re-exported from `src/index.ts` and consumed by the cloud via relay API requests. Removing `'set-default-role'` from the enum is safe because:
1. The cloud wizard step sending this action is being removed in a companion PR
2. No existing cluster sends `set-default-role` outside the wizard flow

## What to preserve

- `credhelper-daemon` `loadRole()` from `.agency/roles/` — correct workspace-level path
- Org-level role catalog management (`/org/[orgId]/settings/roles/`)
- Role recipes (`role-recipes.ts`)
- All other lifecycle actions (`bootstrap-complete`, `clone-peer-repos`, `code-server-start`, `code-server-stop`, `stop`)

## Verification Strategy

1. **Build check**: `tsc --noEmit` in `packages/control-plane`
2. **Test suite**: Run existing Vitest suite — all remaining tests must pass
3. **Grep clean**: `grep -r 'set-default-role\|SetDefaultRole\|handleGetRole\|handlePutRole\|default-role-writer' packages/control-plane/src/` returns 0 hits
