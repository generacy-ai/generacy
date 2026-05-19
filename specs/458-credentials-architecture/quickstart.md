# Quickstart: @generacy-ai/credhelper Package

## Prerequisites

- Node.js >= 20.0.0
- pnpm 9.15.9
- Monorepo already set up (`pnpm install` from repo root)

## Creating the Package

```bash
# From repo root
mkdir -p packages/credhelper/src/{types,schemas,__tests__/fixtures/roles}

# Install after creating package.json
pnpm install
```

## Building

```bash
# Build the package
cd packages/credhelper
pnpm build

# Or build from monorepo root
pnpm --filter @generacy-ai/credhelper build
```

## Testing

```bash
# Run tests
cd packages/credhelper
pnpm test

# Watch mode
pnpm test:watch

# From monorepo root
pnpm --filter @generacy-ai/credhelper test
```

## Using Types from Other Packages

Add the workspace dependency:

```json
{
  "dependencies": {
    "@generacy-ai/credhelper": "workspace:*"
  }
}
```

Import types and schemas:

```typescript
import type {
  CredentialTypePlugin,
  Secret,
  ExposureKind,
  ExposureConfig,
  ExposureOutput,
  MintContext,
  ResolveContext,
  BackendClient,
  BeginSessionRequest,
  BeginSessionResponse,
  LaunchRequestCredentials,
} from '@generacy-ai/credhelper';

import {
  BackendsConfigSchema,
  CredentialsConfigSchema,
  RoleConfigSchema,
  TrustedPluginsSchema,
} from '@generacy-ai/credhelper';
```

## Validating Configuration Files

```typescript
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';
import { BackendsConfigSchema } from '@generacy-ai/credhelper';

const raw = parse(readFileSync('.agency/secrets/backends.yaml', 'utf-8'));
const config = BackendsConfigSchema.parse(raw);
// config is fully typed as BackendsConfig
```

## Available Exports

### Types (no runtime cost)
- `Secret` — credential value with optional format hint
- `BackendClient` — backend accessor interface
- `MintContext` / `ResolveContext` — plugin context types
- `CredentialTypePlugin` — the plugin contract
- `ExposureKind` — exposure mechanism identifiers
- `ExposureConfig` / `ExposureOutput` — discriminated unions for exposure rendering
- `BeginSessionRequest` / `BeginSessionResponse` / `EndSessionRequest` — session API types
- `LaunchRequestCredentials` — AgentLauncher integration type

### Schemas (runtime Zod validators)
- `BackendsConfigSchema` / `BackendsConfig` — validates backends.yaml
- `CredentialsConfigSchema` / `CredentialsConfig` — validates credentials.yaml
- `RoleConfigSchema` / `RoleConfig` — validates roles/*.yaml
- `TrustedPluginsSchema` / `TrustedPluginsConfig` — validates trusted-plugins.yaml
- Sub-schemas: `BackendEntrySchema`, `CredentialEntrySchema`, `MintConfigSchema`, `RoleCredentialRefSchema`, `RoleExposeSchema`, `ProxyConfigSchema`, `DockerConfigSchema`

## Troubleshooting

**Package not found after creation**:
Run `pnpm install` from the repo root to register the new workspace package.

**Type errors on import**:
Ensure `packages/credhelper` has been built (`pnpm build`) so `.d.ts` files exist in `dist/`.

**Schema validation fails on valid YAML**:
Check `schemaVersion` is the string `"1"` (not number `1`). All config schemas use `z.literal('1')`.

**Test fixtures not loading**:
Fixture paths in tests should be relative to the test file location. Use `import.meta.url` or `__dirname` equivalent for ESM path resolution.
