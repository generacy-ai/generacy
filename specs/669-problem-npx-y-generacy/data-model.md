# Data Model: Fix `workspace:^` leak

This is primarily a pipeline/tooling fix, not a data model change. The "data" involved is the `package.json` structure and the validation logic.

## Core Entities

### PackageJson (validated at publish time)

The validation script inspects the standard npm `package.json` schema:

```typescript
interface PackageJsonDeps {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}
```

### Validation Rule

```
For each (field, name, version) in [dependencies, peerDependencies, optionalDependencies]:
  REJECT if version.startsWith("workspace:")
```

### Violation Report

```typescript
interface Violation {
  field: 'dependencies' | 'peerDependencies' | 'optionalDependencies';
  packageName: string;
  version: string; // e.g., "workspace:^"
}
```

## Workspace Protocol Reference

| Protocol | pnpm rewrite behavior |
|----------|----------------------|
| `workspace:^` | Rewritten to `^X.Y.Z` (caret range of workspace version) |
| `workspace:~` | Rewritten to `~X.Y.Z` (tilde range) |
| `workspace:*` | Rewritten to `X.Y.Z` (exact version) |
| `workspace:^1.0.0` | Rewritten to `^1.0.0` (passthrough, ignores workspace version) |

All forms start with `workspace:` — the validation script catches all of them with a single `startsWith("workspace:")` check.

## Files Modified

No data model changes to application code. Only `package.json` files gain a `prepublishOnly` script field, and a new `scripts/check-workspace-deps.js` file is created.
