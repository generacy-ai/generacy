# Quickstart: Config File Loading & Validation

## Prerequisites

- Node.js >= 20.0.0
- pnpm 9.15.9
- Monorepo already set up (`pnpm install` from repo root)
- Phase 1 (#458) complete — `@generacy-ai/credhelper` package exists with schemas

## Loading Config

```typescript
import { loadConfig } from '@generacy-ai/credhelper';

const result = await loadConfig({
  agencyDir: '/path/to/project/.agency',
});

// result.backends    — validated BackendsConfig
// result.credentials — merged CredentialsConfig (overlay applied)
// result.roles       — Map<string, RoleConfig> (extends resolved)
// result.trustedPlugins — TrustedPluginsConfig | null
// result.overlayIds  — string[] (ids from overlay file)
```

## With Plugin Registry (Full Validation)

```typescript
import { loadConfig } from '@generacy-ai/credhelper';
import type { ExposureKind } from '@generacy-ai/credhelper';

// Build registry from loaded plugins
const pluginRegistry = new Map<string, ExposureKind[]>([
  ['github-app', ['env', 'git-credential-helper']],
  ['gcp-service-account', ['env', 'gcloud-external-account']],
]);

const result = await loadConfig({
  agencyDir: '.agency',
  pluginRegistry,
  logger: console,  // logs overlay ids
});
```

## Handling Errors

```typescript
import { loadConfig, ConfigValidationError } from '@generacy-ai/credhelper';

try {
  const result = await loadConfig({ agencyDir: '.agency' });
} catch (err) {
  if (err instanceof ConfigValidationError) {
    // err.errors is ConfigError[] with file, field, message, source
    for (const e of err.errors) {
      console.error(`${e.file}${e.field ? `:${e.field}` : ''}: ${e.message}`);
    }
    // Example output:
    //   .agency/secrets/credentials.yaml:credentials[id=gh-token].backend: Backend "typo" not found in backends.yaml
    //   .agency/roles/reviewer.yaml:credentials[ref=missing].ref: Credential "missing" not found
  }
}
```

## Directory Structure

Set up the `.agency/` directory in your project:

```
.agency/
├── secrets/
│   ├── backends.yaml           # required — where secrets come from
│   ├── credentials.yaml        # required — credential declarations
│   ├── credentials.local.yaml  # optional, gitignored — personal overrides
│   └── trusted-plugins.yaml    # optional — SHA-pinned plugin allowlist
└── roles/                      # optional directory
    ├── reviewer.yaml
    ├── developer.yaml
    └── devops.yaml
```

## Building

```bash
# Build the package
cd packages/credhelper
pnpm build

# From monorepo root
pnpm --filter @generacy-ai/credhelper build
```

## Testing

```bash
# Run tests
cd packages/credhelper
pnpm test

# From monorepo root
pnpm --filter @generacy-ai/credhelper test
```

## Available Exports (New in Phase 2)

### Functions
- `loadConfig(options)` — main entry point, returns `ConfigResult` or throws `ConfigValidationError`

### Types
- `LoadConfigOptions` — input options for `loadConfig()`
- `ConfigResult` — successful load result with all validated config
- `ConfigError` — single validation error with file/field context
- `ConfigValidationError` — error class containing all accumulated errors

### Re-exported from Phase 1
- All schemas: `BackendsConfigSchema`, `CredentialsConfigSchema`, `RoleConfigSchema`, `TrustedPluginsSchema`
- All types: `BackendsConfig`, `CredentialsConfig`, `RoleConfig`, `TrustedPluginsConfig`, `ExposureKind`, etc.

## Troubleshooting

**"Required file not found" for backends.yaml or credentials.yaml**:
These files must exist in `.agency/secrets/`. Check the `agencyDir` path points to the `.agency/` directory (not the project root).

**Overlay errors say "committed" or "overlay"**:
The `source` field on `ConfigError` tells you whether the error is in `credentials.yaml` (committed) or `credentials.local.yaml` (overlay).

**"Circular extends chain detected"**:
Role A extends B which extends A (or longer cycles). Break the cycle by removing one `extends` reference.

**Exposure validation not running**:
Exposure-against-plugin validation only runs when `pluginRegistry` is provided. Without it, only schema-level validation applies (valid `as` enum values).

**No roles loaded but directory exists**:
Check that role files have `.yaml` extension. The loader globs `*.yaml` only.
