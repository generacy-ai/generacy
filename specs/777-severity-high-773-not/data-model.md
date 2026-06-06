# Data Model: #777

This is a behavioral fix, not a data-structure change. The "model" here is the shape of the in-memory types touched by the fix and the contract they expose.

## Constants

### `WIZARD_SENTINEL_KEY`

```ts
/**
 * Reserved-prefix sentinel used as the cache and AuthHealth key when the
 * JIT gh provider is built credential-less (no `github-app` descriptor in
 * `.agency/credentials.yaml`). Cannot collide with real descriptor ids,
 * which are GitHub installation/credential identifiers.
 *
 * Visible in:
 *   - structured logs from `createJitGithubTokenProvider` and `GitHubAuthHealthService`
 *   - `cluster.credentials` relay payloads (`refresh-requested` / `auth-failed` /
 *     `auth-recovered`) emitted on the credential-less path
 *
 * Cloud-side: no consumer today (per Q3). Future consumers should treat any
 * credentialId starting with `__` as synthetic.
 */
export const WIZARD_SENTINEL_KEY = '__wizard__';
```

Defined in `packages/orchestrator/src/services/jit-github-token-provider.ts`. Exported for test access and future cross-package use.

## Modified types

### `JitGithubTokenProviderOptions`

**Before** (`packages/orchestrator/src/services/jit-github-token-provider.ts:14–21`):

```ts
export interface JitGithubTokenProviderOptions {
  client: JitGitTokenClient;
  credentialId: string;          // ← required
  authHealth?: AuthHealthSink;
  refreshWindowMs?: number;
  now?: () => Date;
  logger: Logger;
}
```

**After**:

```ts
export interface JitGithubTokenProviderOptions {
  client: JitGitTokenClient;
  /**
   * GitHub-app credentialId from `.agency/credentials.yaml`. When omitted,
   * the provider operates credential-less: it calls `client.fetch()` (the
   * control-plane resolves the installation from cluster identity) and
   * uses the `WIZARD_SENTINEL_KEY` for cache + authHealth keying.
   */
  credentialId?: string;
  authHealth?: AuthHealthSink;
  refreshWindowMs?: number;
  now?: () => Date;
  logger: Logger;
}
```

### `JitGithubTokenProvider` (return type — unchanged shape, unchanged behavior)

```ts
export type JitGithubTokenProvider = () => Promise<string>;
```

Provider semantics:

| Provider state | Returns | On `client.fetch` failure |
|---|---|---|
| Cache hit (`expiresAt - now > refreshWindowMs`) | cached token | n/a — fetch not called |
| Cache miss or expiring | new token from `client.fetch(credentialId)` (or `client.fetch()` if `credentialId === undefined`) | throws `JitTokenError`; cache entry deleted; `authHealth.recordResult(effectiveKey, { ok: false, statusCode: 503 })` recorded; warn-logged |

Where `effectiveKey = credentialId ?? WIZARD_SENTINEL_KEY`.

## New types

### `ClusterApiKeyExistsFn` (informal — internal helper)

```ts
// packages/orchestrator/src/services/cluster-api-key-probe.ts
const DEFAULT_KEY_PATH = '/var/lib/generacy/cluster-api-key';

/**
 * Returns true iff `/var/lib/generacy/cluster-api-key` exists. Used at
 * orchestrator startup to gate JIT gh provider construction. Honors the
 * `CLUSTER_API_KEY_PATH` env var override for tests.
 *
 * Pure existsSync — does NOT read the file. The control-plane reads contents
 * on every `/git-token` request via its own `ClusterApiKeyReader`.
 */
export function clusterApiKeyExists(
  keyPath: string = process.env.CLUSTER_API_KEY_PATH ?? DEFAULT_KEY_PATH,
): boolean;
```

Standalone helper (not a class) because it has one job, no state, and a 1-LOC body. Located in `packages/orchestrator/src/services/` next to the provider it gates.

## Validation rules

- `WIZARD_SENTINEL_KEY` MUST be the literal string `'__wizard__'`. No template, no env-derived value, no runtime computation. Wire-compatibility with future cloud consumers depends on stability.
- `credentialId`, when provided, MUST be a non-empty string. (Existing behavior — `readCredentialDescriptors` skips entries with non-string ids.)
- The api-key path constant MUST be `/var/lib/generacy/cluster-api-key` to match `packages/control-plane/src/services/cluster-api-key.ts:4`. Drift between the two paths reintroduces the gating mismatch.

## Relationships

```text
.agency/credentials.yaml              /var/lib/generacy/cluster-api-key
        │                                         │
        ▼                                         ▼
readCredentialDescriptors()              clusterApiKeyExists()
        │                                         │
        │ (optional)                              │ (required for JIT)
        ▼                                         ▼
        ┌─────────────────────────────────────────┐
        │  server.ts provider-construction gate   │
        │                                         │
        │  if (!clusterApiKeyExists()) → undef    │
        │  else → createJitGithubTokenProvider({  │
        │           credentialId: ghapp?.credId,  │ ← may be undefined
        │           …                             │
        │         })                              │
        └─────────────────────────────────────────┘
                              │
                              ▼
                 JitGithubTokenProvider closure
                              │
              ┌───────────────┴───────────────┐
              │                               │
              ▼                               ▼
        cache: Map<string,        authHealth.recordResult(
          TokenCacheEntry>          credentialId ?? WIZARD_SENTINEL_KEY,
          keyed by                  …
          credentialId ??         )
          WIZARD_SENTINEL_KEY
```

## Unchanged types (referenced for completeness)

- `JitGitTokenClient.fetch(credentialId?: string): Promise<JitGitTokenResponse>` — already supports `undefined`; no change.
- `JitTokenError` (from `@generacy-ai/control-plane`) — thrown unchanged.
- `AuthHealthSink.recordResult(credentialId: string, result): void` — signature unchanged; receives sentinel string in the credential-less path.
- `GitHubAuthHealthService.maybeRequestRefresh(credentialId, reason)` — accepts any string; sentinel passes through.
- `GhCliGitHubClient` constructor — `tokenProvider` parameter unchanged.
