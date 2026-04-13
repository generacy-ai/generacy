# Quickstart: Credhelper Plugin Loader

## Prerequisites

- Node.js 20+
- pnpm installed
- Phase 1 (#458) skeleton merged (already complete)

## Installation

```bash
cd /workspaces/generacy
pnpm install
```

No additional dependencies required — the loader uses only `zod` (existing) and Node.js built-in `crypto`.

## Usage

### Loading plugins programmatically

```typescript
import { loadCredentialPlugins, type LoaderConfig } from '@generacy-ai/credhelper';

const config: LoaderConfig = {
  corePaths: ['/usr/local/lib/generacy-credhelper/'],
  communityPaths: ['.agency/secrets/plugins/node_modules/'],
  trustedPins: new Map([
    ['generacy-credhelper-plugin-vault', 'sha256hexdigest...'],
  ]),
};

const plugins = await loadCredentialPlugins(config);

// plugins is Map<string, CredentialTypePlugin>
for (const [type, plugin] of plugins) {
  console.log(`Loaded credential type: ${type}`);
}
```

### Creating a credhelper plugin

1. Create a package with the naming convention:
   - Core: `@generacy/credhelper-plugin-{name}`
   - Community: `generacy-credhelper-plugin-{name}`

2. Add manifest to `package.json`:
```json
{
  "name": "generacy-credhelper-plugin-vault",
  "credhelperPlugin": {
    "type": "vault",
    "version": "1.0.0",
    "main": "./dist/index.js"
  }
}
```

3. Implement `CredentialTypePlugin`:
```typescript
import { z } from 'zod';
import type { CredentialTypePlugin } from '@generacy-ai/credhelper';

const plugin: CredentialTypePlugin = {
  type: 'vault',
  credentialSchema: z.object({
    vaultPath: z.string(),
    vaultRole: z.string(),
  }),
  supportedExposures: ['env'],
  async resolve(ctx) {
    const secret = await ctx.backend.fetchSecret(ctx.backendKey);
    return { value: secret, sensitive: true };
  },
  renderExposure(kind, secret, cfg) {
    return { kind, name: cfg.name ?? 'VAULT_TOKEN', value: secret.value };
  },
};

export default plugin;
```

4. For community plugins, compute the SHA256 pin:
```bash
sha256sum dist/index.js
```

5. Add the pin to `.agency/secrets/trusted-plugins.yaml`:
```yaml
schemaVersion: '1'
plugins:
  generacy-credhelper-plugin-vault:
    sha256: 'your-sha256-hex-here'
```

## Development

### Build

```bash
cd packages/credhelper
pnpm build
```

### Test

```bash
cd packages/credhelper
pnpm test
```

### Run specific test files

```bash
pnpm vitest run src/__tests__/loader/verify.test.ts
```

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `Plugin 'X' from community path is not pinned` | Community plugin missing from trusted-plugins.yaml | Compute SHA256 and add pin entry |
| `Plugin 'X' SHA256 mismatch` | Plugin file changed after pinning | Re-compute SHA256 and update pin |
| `Plugin 'X' has invalid credentialSchema` | Plugin's schema is not a valid Zod schema | Ensure plugin exports a proper Zod schema as `credentialSchema` |
| `Duplicate credential type 'X'` | Two plugins claim the same type | Remove or rename one of the conflicting plugins |
| `Plugin 'X' manifest missing` | No `credhelperPlugin` field in package.json | Add the `credhelperPlugin` manifest field |
