# Quickstart: Add optional role field to DefaultsConfigSchema

**Feature**: #459 — Phase 1 of credentials architecture

## What This Changes

Adds a single optional `role` field to the `DefaultsConfigSchema` in `.generacy/config.yaml`. This allows workflow authors to specify a default credential role.

## Usage

### Config with role

```yaml
# .generacy/config.yaml
defaults:
  agent: claude-code
  role: developer    # optional — default credential role for workflow runs
```

### Config without role (unchanged, still works)

```yaml
# .generacy/config.yaml
defaults:
  agent: claude-code
```

## Development

### Run tests

```bash
# From repo root
cd packages/generacy
pnpm test

# Or run just schema tests
pnpm vitest run src/config/__tests__/schema.test.ts
```

### Verify the change

```typescript
import { DefaultsConfigSchema } from '@generacy-ai/generacy/config/schema';

// With role
const withRole = DefaultsConfigSchema.parse({ role: 'developer' });
console.log(withRole.role); // 'developer'

// Without role
const withoutRole = DefaultsConfigSchema.parse({});
console.log(withoutRole.role); // undefined
```

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| `role` field not recognized in TypeScript | Using stale types | Re-run `pnpm build` to regenerate types |
| Existing config fails to parse | Unrelated issue — `role` is optional | Check other fields; `role` omission cannot cause failures |
