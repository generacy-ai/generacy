# Research: Core Credential Type Plugins (#463)

## Technology Decisions

### TD1: No external HTTP clients for API calls

**Decision**: Use Node.js built-in `http`/`https` modules for GitHub, GCP, and AWS API calls.

**Rationale**: The `credhelper-daemon` package already uses only built-in `http` module (no Express, no Axios). Adding an HTTP client library for 3 API calls isn't justified. The API interactions are simple POST requests with JSON bodies.

**Alternatives considered**:
- `node-fetch` / `undici` — unnecessary for simple requests; Node 18+ has global `fetch`
- `@octokit/rest`, `@aws-sdk/client-sts`, `@google-cloud/iam-credentials` — heavy SDK dependencies for single API calls each; would balloon package size and introduce transitive dependency chains

**Implementation**: Use `globalThis.fetch` (Node 18+ built-in) or `https.request` for each API call. Wrap in thin helper functions per plugin, not shared across plugins (each API has different auth, headers, error handling).

### TD2: JWT signing for GitHub App authentication

**Decision**: Use the `jsonwebtoken` package (or equivalent) for RS256 JWT generation needed by the GitHub App plugin.

**Rationale**: GitHub App authentication requires signing a JWT with the app's private key (RS256). Node.js `crypto` module can do this, but JWT construction (header, payload, base64url encoding) is error-prone to implement manually.

**Alternatives considered**:
- Manual JWT with `crypto.sign()` — possible but fragile; JWT format has specific encoding requirements
- `jose` — modern, lighter alternative to `jsonwebtoken`; either works

**Note**: Only the `github-app` plugin needs this. If we use `crypto` directly, we avoid any new dependency at the cost of ~30 lines of JWT construction code.

### TD3: AWS Signature V4 for STS calls

**Decision**: Use `globalThis.fetch` with manual Signature V4 construction, OR use AWS STS query string API which is simpler.

**Rationale**: AWS STS supports a query string API (`Action=AssumeRole&RoleArn=...`) which doesn't require SigV4 if called with pre-existing session credentials. Since the base credentials come from the backend, we can use them directly with the STS endpoint.

**Alternatives considered**:
- `@aws-sdk/client-sts` — full SDK, heavy dependency
- Manual SigV4 — complex but well-documented; many reference implementations

**Implementation**: Start with the query string approach using basic HTTPS. If SigV4 is required (it is for STS), implement a minimal SigV4 signer (~80 lines) as a utility within the plugin file.

### TD4: Plugin test strategy — mock at HTTP boundary

**Decision**: Mock external API responses at the HTTP level, not at the plugin method level.

**Rationale**: Testing that `mint()` correctly constructs API requests and parses responses requires intercepting HTTP calls. Mocking at the plugin method level would test nothing meaningful.

**Alternatives considered**:
- `nock` — mature HTTP mocking library, works well with `http` module
- `msw` — modern, but heavier; better suited for browser/service worker patterns
- Manual mock using dependency injection — each plugin could accept an optional HTTP client, but this complicates the interface for testing convenience

**Implementation**: Use Vitest's `vi.fn()` for simple mocks. For HTTP calls, either inject a fetch function or use `vi.spyOn(globalThis, 'fetch')`. Keep it simple — these are unit tests, not integration tests.

## Implementation Patterns

### Pattern 1: Plugin file structure

Each plugin file exports a single named `CredentialTypePlugin` object:

```typescript
// packages/credhelper-daemon/src/plugins/core/github-pat.ts
import { z } from 'zod';
import type {
  CredentialTypePlugin,
  ExposureKind,
  Secret,
  ExposureConfig,
  PluginExposureData,
  ResolveContext,
} from '@generacy-ai/credhelper';

const credentialSchema = z.object({}).passthrough();

export const githubPatPlugin: CredentialTypePlugin = {
  type: 'github-pat',
  credentialSchema,
  supportedExposures: ['env', 'git-credential-helper'] as ExposureKind[],

  async resolve(ctx: ResolveContext): Promise<Secret> {
    const token = await ctx.backend.fetchSecret(ctx.backendKey);
    return { value: token, format: 'token' };
  },

  renderExposure(kind: ExposureKind, secret: Secret, cfg: ExposureConfig): PluginExposureData {
    switch (kind) {
      case 'env':
        return { kind: 'env', entries: [{ key: (cfg as any).name || 'GITHUB_TOKEN', value: secret.value }] };
      case 'git-credential-helper':
        return { kind: 'git-credential-helper', host: 'github.com', protocol: 'https', username: 'x-access-token', password: secret.value };
      default:
        throw new Error(`Unsupported exposure kind: ${kind}`);
    }
  },
};
```

### Pattern 2: Mint-based plugin with API call

```typescript
// Simplified github-app mint pattern
async mint(ctx: MintContext): Promise<{ value: Secret; expiresAt: Date }> {
  // 1. Get secret material from backend
  const privateKey = await ctx.backend.fetchSecret(ctx.backendKey);

  // 2. Build API request using config + scope
  const { appId, installationId } = ctx.config as { appId: number; installationId: number };
  const jwt = signJwt(appId, privateKey);

  // 3. Call external API
  const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json' },
    body: JSON.stringify({ repositories: ctx.scope.repositories, permissions: ctx.scope.permissions }),
  });

  // 4. Parse and return
  const data = await response.json();
  return {
    value: { value: data.token, format: 'token' },
    expiresAt: new Date(data.expires_at),
  };
}
```

### Pattern 3: Test structure

```typescript
// packages/credhelper-daemon/__tests__/plugins/github-pat.test.ts
import { describe, it, expect, vi } from 'vitest';
import { githubPatPlugin } from '../../src/plugins/core/github-pat';

describe('github-pat plugin', () => {
  describe('credentialSchema', () => {
    it('accepts valid config', () => { /* ... */ });
    it('rejects invalid config', () => { /* ... */ });
  });

  describe('resolve', () => {
    it('fetches secret from backend', async () => {
      const backend = { fetchSecret: vi.fn().mockResolvedValue('ghp_abc123') };
      const ctx = { credentialId: 'gh', backendKey: 'github-token', backend, config: {} };
      const secret = await githubPatPlugin.resolve!(ctx);
      expect(secret.value).toBe('ghp_abc123');
      expect(backend.fetchSecret).toHaveBeenCalledWith('github-token');
    });
  });

  describe('renderExposure', () => {
    it('renders env exposure', () => { /* ... */ });
    it('renders git-credential-helper exposure', () => { /* ... */ });
    it('throws for unsupported kind', () => { /* ... */ });
  });
});
```

## Key References

- GitHub Apps API: Installation access tokens — `POST /app/installations/{id}/access_tokens`
- GCP IAM Credentials: `generateAccessToken` — `POST /v1/projects/-/serviceAccounts/{email}:generateAccessToken`
- AWS STS: `AssumeRole` — `POST https://sts.amazonaws.com/?Action=AssumeRole`
- Existing plugin interface: `packages/credhelper/src/types/plugin.ts`
- Existing mock plugin pattern: `packages/credhelper-daemon/__tests__/mocks/mock-plugin.ts`
- Session manager flow: `packages/credhelper-daemon/src/session-manager.ts`

---

*Generated by speckit*
