# Research: Add optional role field to DefaultsConfigSchema

**Feature**: #459 — Phase 1 of credentials architecture
**Date**: 2026-04-13

## Technology Decisions

### Decision: Use `z.string().optional()` with no constraints

**Rationale**: The spec explicitly states the role value is a free-form string at this phase. Enum validation or pattern constraints are deferred to a future phase when role values are consumed by the AgentLauncher credentials interceptor (Phase 3).

**Alternative considered**: `z.enum(['developer', 'reviewer', ...]).optional()` — rejected because the set of valid roles is not yet defined and constraining it now would create a breaking change when Phase 3 lands.

### Decision: No default value for `role`

**Rationale**: Unlike `baseBranch` which has a natural default, `role` has no sensible default. An explicit `undefined` (field omitted) cleanly signals "no role specified" and avoids accidentally binding a credential role.

**Alternative considered**: `z.string().default('developer')` — rejected because auto-binding credentials without user intent would be a security concern.

## Implementation Patterns

### Zod optional field pattern (existing in codebase)

The `DefaultsConfigSchema` already uses this exact pattern for both `agent` and `baseBranch`:

```typescript
agent: z.string().regex(...).optional(),
baseBranch: z.string().min(1, ...).optional(),
```

Adding `role: z.string().optional()` follows the same convention.

### Test pattern (existing in codebase)

The `DefaultsConfigSchema` describe block in `schema.test.ts` tests:
- Valid values parse correctly
- Empty config is accepted (all fields optional)
- Boundary/edge cases

New role tests follow this same pattern.

## Key Sources

- [Credentials architecture plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/credentials-architecture-plan.md) — overall multi-phase plan
- Phase 0 (#457) — prerequisite, already merged
- Phase 3 (future) — where `role` is consumed by AgentLauncher credentials interceptor
