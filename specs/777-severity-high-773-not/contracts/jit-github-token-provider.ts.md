# Contract: `createJitGithubTokenProvider`

**File**: `packages/orchestrator/src/services/jit-github-token-provider.ts`
**Change kind**: backwards-compatible signature widening + new exported constant.

## Exports

### `WIZARD_SENTINEL_KEY` (new)

```ts
export const WIZARD_SENTINEL_KEY = '__wizard__';
```

### `JitGithubTokenProviderOptions` (modified)

```ts
export interface JitGithubTokenProviderOptions {
  client: JitGitTokenClient;
  credentialId?: string;             // ← was `credentialId: string`
  authHealth?: AuthHealthSink;
  refreshWindowMs?: number;
  now?: () => Date;
  logger: Logger;
}
```

### `createJitGithubTokenProvider` (modified body, same signature shape)

```ts
export function createJitGithubTokenProvider(
  options: JitGithubTokenProviderOptions,
): JitGithubTokenProvider {
  const {
    client,
    credentialId,                              // may be undefined
    authHealth,
    refreshWindowMs = DEFAULT_REFRESH_WINDOW_MS,
    now = () => new Date(),
    logger,
  } = options;

  const effectiveKey = credentialId ?? WIZARD_SENTINEL_KEY;
  const cache = new Map<string, TokenCacheEntry>();

  return async () => {
    const currentTime = now();
    const cached = cache.get(effectiveKey);

    if (cached && cached.expiresAt.getTime() - currentTime.getTime() > refreshWindowMs) {
      return cached.token;
    }

    try {
      // Pass-through: undefined → client sends '{}'; defined → client sends { credentialId }.
      const response = await client.fetch(credentialId);
      const entry: TokenCacheEntry = {
        token: response.token,
        expiresAt: response.expiresAt,
        fetchedAt: now(),
      };
      cache.set(effectiveKey, entry);
      return entry.token;
    } catch (rawErr) {
      const err =
        rawErr instanceof JitTokenError
          ? rawErr
          : new JitTokenError(
              'CONTROL_SOCKET_UNREACHABLE',
              rawErr instanceof Error ? rawErr.message : String(rawErr),
            );

      cache.delete(effectiveKey);

      try {
        authHealth?.recordResult(effectiveKey, { ok: false, statusCode: 503 });
      } catch {
        /* sink errors must not mask the original failure */
      }

      logger.warn(
        { code: err.code, message: err.message, credentialId: effectiveKey },
        'JIT GitHub token refresh failed',
      );

      throw err;
    }
  };
}
```

## Invariants

1. **Sentinel substitution is internal**: the `effectiveKey` variable is the only place the sentinel is materialized; callers never pass `'__wizard__'` themselves.
2. **One key for cache + authHealth**: the same `effectiveKey` is used for `cache.get/set/delete` and for `authHealth.recordResult`. They cannot drift.
3. **`client.fetch(credentialId)` preserves undefined**: passing `undefined` reaches the control-plane as `'{}'` (existing branch in `JitGitTokenClient.fetch`). Do not wrap or default-collapse this argument inside the provider.
4. **Failure semantics unchanged**: cache eviction, authHealth recording, warn-logging, and `JitTokenError` propagation are identical to #773; only the key value differs in the credential-less branch.

## Backwards compatibility

Existing call sites that pass `credentialId: <string>` continue to work unchanged — the field is widened from required to optional, not narrowed. The `effectiveKey` derivation returns the original `credentialId` when present.

## Tests (added)

- `creates provider when credentialId omitted` — constructs successfully; provider is a function.
- `uses WIZARD_SENTINEL_KEY when credentialId omitted` — after one successful `fetch`, `cache.get(WIZARD_SENTINEL_KEY)` (probed indirectly via second `fetch` returning the cached token without re-calling the client).
- `calls client.fetch() with no argument when credentialId omitted` — verified via spy on the `JitGitTokenClient`.
- `records authHealth under WIZARD_SENTINEL_KEY on failure` — spy on `AuthHealthSink.recordResult`; first arg is the sentinel.
- `propagates JitTokenError unchanged in credential-less path` — error code, message preserved.
- `passes credentialId to client.fetch when defined` — no regression on the descriptor path.
- `uses descriptor credentialId as cache key when defined` — sentinel not used in the defined path.
