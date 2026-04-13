# Implementation Plan: Core Credential Type Plugins (7 plugins)

**Feature**: Implement 7 core credential type plugins for the credhelper system
**Branch**: `463-credentials-architecture`
**Status**: Complete

## Summary

Implement 7 core credential type plugins inside `packages/credhelper-daemon/src/plugins/core/`. Each plugin implements the `CredentialTypePlugin` interface, providing Zod schemas for validation, either `mint()` or `resolve()` for credential acquisition, and `renderExposure()` for credential-specific exposure data. The daemon's `ExposureRenderer` wraps plugin output with session-specific infrastructure (socket paths, file layout).

**Plugins**: github-app, github-pat, gcp-service-account, aws-sts, stripe-restricted-key, api-key, env-passthrough

## Technical Context

- **Language**: TypeScript (strict mode)
- **Runtime**: Node.js (built-in `http` module, no Express)
- **Test framework**: Vitest
- **Schema validation**: Zod ^3.23.0
- **Package manager**: pnpm (workspace monorepo)
- **Key packages**:
  - `@generacy-ai/credhelper` — Types and Zod schemas (types-only, no runtime deps)
  - `@generacy-ai/credhelper-daemon` — Runtime daemon, session management, plugins

## Key Design Decisions

### D1: Plugin location — `credhelper-daemon`, not `credhelper`

Despite the spec referencing `packages/credhelper/src/plugins/`, core plugins live in `packages/credhelper-daemon/src/plugins/core/`. Rationale:
- `packages/credhelper` is a types-only, Zod-only package
- Plugins have runtime behavior (HTTP calls to GitHub/AWS/GCP APIs, `process.env` reads)
- The daemon is the runtime host — plugins belong with their consumer
- Per clarification Q3: static registration via index file, no discovery pipeline

### D2: Context extension — `config` field on MintContext/ResolveContext

Per clarification Q1, both `MintContext` and `ResolveContext` gain a `config: Record<string, unknown>` field containing validated credential YAML fields (minus common structural fields already surfaced as dedicated context properties). This lets plugins access non-secret metadata (e.g., `appId`, `installationId`) without conflating config with secrets.

### D3: Split exposure rendering responsibility

Per clarification Q2, plugins render credential-specific data; the daemon wraps with session infrastructure:
- **`env`**: Plugin → `{ entries: [{ key, value }] }`. Daemon → writes env file.
- **`git-credential-helper`**: Plugin → `{ host, protocol, username, password }`. Daemon → generates shell script using data.sock.
- **`gcloud-external-account`**: Plugin → `{ audience, subjectTokenType, tokenUrl, ... }`. Daemon → generates external account JSON with data.sock URL.
- **`localhost-proxy`**: Plugin → `{ upstream, headers }`. Daemon → manages proxy lifecycle.

This requires a new `PluginExposureData` discriminated union type, distinct from the daemon's `ExposureOutput`.

### D4: AWS roleArn placement

Per clarification Q4, `roleArn` is only in `credentialSchema` (fixed trust config). `scopeSchema` contains only `sessionPolicy?` and `durationSeconds?` (per-role restrictions).

### D5: env-passthrough — no `envVar` field

Per clarification Q5, `backendKey` in credentials.yaml IS the env var name. The `env` backend's `fetchSecret("GITHUB_TOKEN")` reads `process.env["GITHUB_TOKEN"]`. No separate `envVar` field needed.

## Project Structure

### New Files

```
packages/credhelper/src/types/
  plugin-exposure.ts              # PluginExposureData discriminated union

packages/credhelper-daemon/src/plugins/core/
  index.ts                        # Static CORE_PLUGINS array
  github-app.ts                   # Mint-based, env + git-credential-helper
  github-pat.ts                   # Resolve-based, env + git-credential-helper
  gcp-service-account.ts          # Mint-based, env + gcloud-external-account
  aws-sts.ts                      # Mint-based, env only
  stripe-restricted-key.ts        # Resolve-based, env only
  api-key.ts                      # Resolve-based, env + localhost-proxy
  env-passthrough.ts              # Resolve-based, env only

packages/credhelper-daemon/__tests__/plugins/
  github-app.test.ts
  github-pat.test.ts
  gcp-service-account.test.ts
  aws-sts.test.ts
  stripe-restricted-key.test.ts
  api-key.test.ts
  env-passthrough.test.ts
  core-index.test.ts              # Registration + loader integration
```

### Modified Files

```
packages/credhelper/src/types/context.ts       # Add config field to MintContext, ResolveContext
packages/credhelper/src/types/plugin.ts        # Update renderExposure return type
packages/credhelper/src/index.ts               # Export PluginExposureData
packages/credhelper/src/loader/validate.ts     # Update validation if needed

packages/credhelper-daemon/src/session-manager.ts    # Pass config to mint/resolve context
packages/credhelper-daemon/src/exposure-renderer.ts  # Accept PluginExposureData input
packages/credhelper-daemon/src/types.ts              # Import new types
```

## Implementation Phases

### Phase A: Type Extensions (foundation)

Modify shared types before implementing plugins.

**A1. Add `config` field to context types**
- File: `packages/credhelper/src/types/context.ts`
- Add `config: Record<string, unknown>` to `MintContext` and `ResolveContext`

**A2. Define `PluginExposureData` type**
- File: `packages/credhelper/src/types/plugin-exposure.ts`
- Discriminated union with variants for env, git-credential-helper, gcloud-external-account, localhost-proxy

**A3. Update `CredentialTypePlugin` interface**
- File: `packages/credhelper/src/types/plugin.ts`
- Change `renderExposure()` return type from `ExposureOutput` to `PluginExposureData`

**A4. Export new types**
- File: `packages/credhelper/src/index.ts`
- Export `PluginExposureData` and related types

**A5. Update plugin validator**
- File: `packages/credhelper/src/loader/validate.ts`
- Ensure validation still works with new return type

### Phase B: Core Plugins (main work, parallelizable)

Each plugin follows the same structure. Plugins within this phase are independent and can be implemented in any order.

**Plugin template structure:**
```typescript
import { z } from 'zod';
import type { CredentialTypePlugin, PluginExposureData } from '@generacy-ai/credhelper';

export const fooPlugin: CredentialTypePlugin = {
  type: 'foo',
  credentialSchema: z.object({ /* ... */ }),
  scopeSchema: z.object({ /* ... */ }),           // if applicable
  supportedExposures: ['env'],
  async mint(ctx) { /* ... */ },                  // OR resolve(ctx)
  renderExposure(kind, secret, cfg) { /* ... */ },
};
```

**B1. github-app** (mint, env + git-credential-helper)
- `credentialSchema`: `{ appId: number, installationId: number }`
- `scopeSchema`: `{ repositories?: string[], permissions?: Record<string, string> }`
- `mint()`: Fetch privateKey via `ctx.backend.fetchSecret(ctx.backendKey)`, call GitHub API to create installation access token scoped to role's repos + permissions
- `renderExposure('env')`: `GITHUB_TOKEN=<token>`
- `renderExposure('git-credential-helper')`: `{ host: 'github.com', protocol: 'https', username: 'x-access-token', password: <token> }`
- Tests: valid/invalid schema, mint with mocked GitHub API, exposure rendering

**B2. github-pat** (resolve, env + git-credential-helper)
- `credentialSchema`: `{}` (minimal — all config in common fields)
- No `scopeSchema` (PATs are pre-scoped)
- `resolve()`: `ctx.backend.fetchSecret(ctx.backendKey)` → returns token
- `renderExposure('env')`: `GITHUB_TOKEN=<token>`
- `renderExposure('git-credential-helper')`: `{ host: 'github.com', protocol: 'https', username: 'x-access-token', password: <token> }`
- Tests: schema validation, resolve with mock backend, exposure rendering

**B3. gcp-service-account** (mint, env + gcloud-external-account)
- `credentialSchema`: `{ serviceAccountEmail: string, projectId?: string }`
- `scopeSchema`: `{ scopes: string[] }` (e.g., `['cloud-platform']`)
- `mint()`: Fetch SA key or impersonation token via backend, call GCP IAM `generateAccessToken` API
- `renderExposure('env')`: `GOOGLE_APPLICATION_CREDENTIALS=<path>` or `CLOUDSDK_AUTH_ACCESS_TOKEN=<token>`
- `renderExposure('gcloud-external-account')`: `{ audience, subjectTokenType, tokenUrl, serviceAccountImpersonationUrl }`
- Tests: schema, mint with mocked GCP IAM, exposure rendering

**B4. aws-sts** (mint, env)
- `credentialSchema`: `{ roleArn: string, externalId?: string, region?: string }` (per Q4)
- `scopeSchema`: `{ sessionPolicy?: object, durationSeconds?: number }` (per Q4)
- `mint()`: Fetch base credentials via backend, call STS AssumeRole with role ARN + session policy
- `renderExposure('env')`: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`
- Tests: schema, mint with mocked STS, exposure rendering

**B5. stripe-restricted-key** (resolve, env)
- `credentialSchema`: `{}` (minimal)
- No `scopeSchema`
- `resolve()`: `ctx.backend.fetchSecret(ctx.backendKey)` → returns key
- `renderExposure('env')`: `STRIPE_API_KEY=<key>` (or configurable via `cfg.name`)
- Tests: schema, resolve with mock, exposure rendering

**B6. api-key** (resolve, env + localhost-proxy)
- `credentialSchema`: `{}` (minimal)
- No `scopeSchema`
- `resolve()`: `ctx.backend.fetchSecret(ctx.backendKey)` → returns key
- `renderExposure('env')`: `{ key: cfg.name, value: <key> }`
- `renderExposure('localhost-proxy')`: `{ upstream: <from config>, headers: { Authorization: 'Bearer <key>' } }`
- Tests: schema, resolve with mock, both exposure kinds

**B7. env-passthrough** (resolve, env)
- `credentialSchema`: `{}` (minimal — per Q5, `backendKey` is the env var name)
- No `scopeSchema`
- `resolve()`: `ctx.backend.fetchSecret(ctx.backendKey)` — the `env` backend reads `process.env`
- `renderExposure('env')`: `{ key: cfg.name, value: <value> }`
- Tests: schema, resolve with mock env backend, exposure rendering

### Phase C: Integration

**C1. Create core plugin index**
- File: `packages/credhelper-daemon/src/plugins/core/index.ts`
- Static `CORE_PLUGINS` array importing all 7 plugins
- Export for daemon registration

**C2. Update session-manager to pass config**
- File: `packages/credhelper-daemon/src/session-manager.ts`
- When building `MintContext`/`ResolveContext`, include `config` field from credential entry
- Strip common fields (`id`, `type`, `backend`, `backendKey`, `mint`) before passing

**C3. Update exposure renderer**
- File: `packages/credhelper-daemon/src/exposure-renderer.ts`
- Accept `PluginExposureData` from plugins
- For `env`: write entries to env file (existing)
- For `git-credential-helper`: take plugin's `{ host, protocol, username, password }` and generate shell script using data.sock path
- For `gcloud-external-account`: take plugin's GCP fields and generate external account JSON with data.sock URL
- For `localhost-proxy`: take plugin's `{ upstream, headers }` and configure proxy

**C4. Update daemon plugin registration**
- Ensure daemon registers CORE_PLUGINS alongside any community plugins from #460 loader
- Core plugins registered directly; community plugins go through discovery pipeline

**C5. Integration tests**
- Test that all 7 core plugins register correctly
- Test end-to-end session creation with a core plugin (mock external APIs)
- Test exposure rendering pipeline: plugin → daemon renderer → session dir files

### Phase D: Validation & Cleanup

**D1. Run full test suite**
- `pnpm -F @generacy-ai/credhelper test`
- `pnpm -F @generacy-ai/credhelper-daemon test`

**D2. Type checking**
- `pnpm -F @generacy-ai/credhelper tsc --noEmit`
- `pnpm -F @generacy-ai/credhelper-daemon tsc --noEmit`

**D3. Verify all success criteria**
- SC-001: 7/7 plugins load and register
- SC-002: Schema validation tests pass (valid + invalid)
- SC-003: Mint/resolve tests pass with mocked backends
- SC-004: Exposure rendering tests pass for each (plugin, exposure) pair
- SC-005: All 7 discovered via core plugin registration

## Dependency Graph

```
Phase A (types) ──────────────────────┐
                                      │
Phase B1 (github-app) ───────────┐    │
Phase B2 (github-pat) ───────────┤    │
Phase B3 (gcp-service-account) ──┤    │
Phase B4 (aws-sts) ──────────────┤ depends on A
Phase B5 (stripe-restricted-key)─┤    │
Phase B6 (api-key) ──────────────┤    │
Phase B7 (env-passthrough) ──────┘    │
                                      │
Phase C (integration) ─── depends on A + all B
Phase D (validation) ──── depends on C
```

Phase B plugins are fully parallelizable — no dependencies between them.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| External API mocking complexity (GitHub, GCP, AWS) | Use simple HTTP response mocks; test contract, not API client |
| Type changes in `credhelper` break daemon compilation | Phase A completes before B/C; run tsc after each phase |
| renderExposure type change breaks existing plugin validator | Update validator in A5; mock plugin tests verify new contract |
| Session-manager config extraction logic is fragile | Define clear "common fields to strip" list; unit test extraction |

## External API Details

### GitHub Apps API (github-app mint)
- `POST /app/installations/{installation_id}/access_tokens`
- Headers: `Authorization: Bearer <JWT>`, `Accept: application/vnd.github+json`
- Body: `{ repositories: [...], permissions: {...} }`
- Response: `{ token: string, expires_at: string }`
- JWT signed with app private key (RS256), exp: 10min

### GCP IAM API (gcp-service-account mint)
- `POST https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/{email}:generateAccessToken`
- Headers: `Authorization: Bearer <base-token>`
- Body: `{ scope: [...], lifetime: "3600s" }`
- Response: `{ accessToken: string, expireTime: string }`

### AWS STS API (aws-sts mint)
- `POST https://sts.{region}.amazonaws.com/` (or global endpoint)
- Action: `AssumeRole`
- Params: `RoleArn`, `RoleSessionName`, `Policy` (optional JSON), `DurationSeconds`, `ExternalId` (optional)
- Response: `Credentials.AccessKeyId`, `SecretAccessKey`, `SessionToken`, `Expiration`

---

*Generated by speckit*
