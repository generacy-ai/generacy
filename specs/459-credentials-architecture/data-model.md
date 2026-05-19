# Data Model: Add optional role field to DefaultsConfigSchema

**Feature**: #459 — Phase 1 of credentials architecture
**Date**: 2026-04-13

## Core Entity: DefaultsConfig

### Current Schema (before change)

```typescript
export const DefaultsConfigSchema = z.object({
  agent: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, '...').optional(),
  baseBranch: z.string().min(1, '...').optional(),
});

type DefaultsConfig = {
  agent?: string;
  baseBranch?: string;
};
```

### Updated Schema (after change)

```typescript
export const DefaultsConfigSchema = z.object({
  agent: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, '...').optional(),
  baseBranch: z.string().min(1, '...').optional(),
  role: z.string().optional(),  // NEW — credential role for workflow runs
});

type DefaultsConfig = {
  agent?: string;
  baseBranch?: string;
  role?: string;         // NEW
};
```

### Field Details

| Field | Type | Required | Default | Validation | Notes |
|-------|------|----------|---------|------------|-------|
| `agent` | `string` | No | `undefined` | kebab-case regex | Existing |
| `baseBranch` | `string` | No | `undefined` | min length 1 | Existing |
| `role` | `string` | No | `undefined` | none (free-form) | **New in Phase 1** |

### YAML Representation

```yaml
defaults:
  agent: claude-code
  baseBranch: main
  role: developer    # New optional field
```

## Relationships

- `DefaultsConfig` is an optional section of `GeneracyConfig` (root config)
- `role` is not consumed by any runtime code until Phase 3
- `role` will be read by `AgentLauncher` credentials interceptor (Phase 3) to bind credential roles at spawn time

## Validation Rules

| Rule | Description |
|------|-------------|
| Optional | Field can be omitted entirely; Zod returns `undefined` |
| String type | Must be a string if present (Zod enforces) |
| No constraints | Free-form string — no regex, min/max, or enum at this phase |
