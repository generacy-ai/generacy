# Data Model: Cluster-side JIT git credential helper

All types are in-memory in the long-lived control-plane process. There is **no on-disk model** added by this feature (SC-002).

## Entities

### GitTokenCacheEntry

The single source of truth for an installation token in the control-plane process.

```ts
export interface GitTokenCacheEntry {
  /** The opaque GitHub installation token (treat as a secret — never log). */
  token: string;
  /** Absolute expiry time of `token` (UTC). */
  expiresAt: Date;
  /** Credential ID this token was minted for (from `.agency/credentials.yaml`). */
  credentialId: string;
  /** When this cache entry was populated. */
  fetchedAt: Date;
}
```

**Invariants**:
- `expiresAt > fetchedAt`.
- `token` is never `''` or `undefined`. A failed fetch never produces a `GitTokenCacheEntry`; it produces a `GitHelperError`.
- The struct is treated as immutable. Refresh replaces the cached entry; it does not mutate fields.

**Lifecycle**:
- Created by `GitTokenManager.fetchFromCloud(credentialId)` on cold start or pre-expiry refresh.
- Read by `GitTokenManager.getToken(credentialId)`.
- Discarded by being replaced. No explicit deletion; the prior entry is unreachable once `this.cache` is reassigned and any in-flight `Promise<GitTokenCacheEntry>` resolves.

### GitTokenManager (state holder)

Singleton per control-plane process.

```ts
export interface GitTokenManager {
  /**
   * Return a valid token for `credentialId`. Refreshes synchronously if
   * the cached token is within REFRESH_WINDOW_MS of expiry. Concurrent
   * callers share a single in-flight fetch.
   * Throws GitHelperError on cloud-pull failure or missing API key.
   */
  getToken(credentialId: string): Promise<GitTokenCacheEntry>;
}
```

**Internal state**:
- `cache: GitTokenCacheEntry | null` — most-recent successful fetch.
- `inFlight: Promise<GitTokenCacheEntry> | null` — in-progress fetch for concurrent-call collapsing (FR-009).

**Constants**:
- `REFRESH_WINDOW_MS = 5 * 60_000` — synchronous pre-expiry refresh trigger (FR-004).

**State machine** (informal):
```
              ┌────────────────────────────────┐
              │                                ▼
[empty] ──get──► [fetching] ──ok──► [cached(t, expiresAt)] ──get──► [cached]   (cache hit while expiresAt-now > 5m)
              │     │                  │
              │     │                  └─get──► [fetching]                     (refresh: within 5m of expiry)
              │     │
              │     └──error──► [empty]                                        (next get retries; no fallback)
              │
              └──get(concurrent)──► returns same in-flight Promise              (FR-009)
```

### GitHelperError

Single typed error returned to all callers (HTTP route, CLI wrapper). Each code maps to a distinct stderr message and exit code in the wrapper.

```ts
export type GitHelperErrorCode =
  | 'CLUSTER_API_KEY_MISSING'
  | 'CLOUD_UNREACHABLE'
  | 'CLOUD_AUTH_REJECTED'
  | 'CLOUD_REQUEST_INVALID'
  | 'CLOUD_UPSTREAM_ERROR'
  | 'CLOUD_RESPONSE_INVALID'
  | 'CREDENTIAL_NOT_CONFIGURED';

export class GitHelperError extends Error {
  constructor(
    public readonly code: GitHelperErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
```

**Mapping rules**:

| Trigger | Code |
|---------|------|
| `/var/lib/generacy/cluster-api-key` file missing or unreadable | `CLUSTER_API_KEY_MISSING` |
| `node:https` socket error / DNS failure / ECONNREFUSED | `CLOUD_UNREACHABLE` |
| Cloud responds 401 or 403 | `CLOUD_AUTH_REJECTED` |
| Cloud responds with any other 4xx | `CLOUD_REQUEST_INVALID` |
| Cloud responds 5xx | `CLOUD_UPSTREAM_ERROR` |
| Cloud responds 2xx but body fails `CloudPullResponseSchema` | `CLOUD_RESPONSE_INVALID` |
| `credentialId` not in `.agency/credentials.yaml` (or no `github-app` credential at all) | `CREDENTIAL_NOT_CONFIGURED` |

### CloudPullRequest / CloudPullResponse

Wire-shape against generacy-cloud#817. See also `contracts/cloud-pull-endpoint.schema.json` for the canonical JSON Schema.

```ts
export interface CloudPullRequest {
  /** ID from `.agency/credentials.yaml`. The cloud uses this to find the right installation. */
  credentialId: string;
}

export interface CloudPullResponse {
  /** Fresh GitHub installation token. */
  token: string;
  /** ISO-8601 UTC timestamp of token expiry (≤ now + 1h per GitHub policy). */
  expiresAt: string;
}
```

**Auth**: `Authorization: Bearer <cluster-api-key>` header. The key is read from `/var/lib/generacy/cluster-api-key`.

**Validation**: `CloudPullResponseSchema` (Zod):

```ts
const CloudPullResponseSchema = z.object({
  token: z.string().min(1),
  expiresAt: z.string().datetime({ offset: false }),
});
```

A non-empty token and a parseable RFC-3339 timestamp are the two correctness conditions. Anything else → `CLOUD_RESPONSE_INVALID`.

### GitTokenResponse (control-plane → CLI wrapper)

What `POST /git-token` returns over the control socket.

```ts
export interface GitTokenResponse {
  token: string;
  expiresAt: string; // ISO-8601 (mirrors cloud shape — saves parse/serialize)
}
```

Encoded as `application/json`. On error, the body is the existing control-plane error shape `{ error: string; code: string; details?: unknown }` (see `packages/control-plane/src/errors.ts`).

### GitCredentialResponse (CLI wrapper → git)

The line-protocol shape git expects on stdout for a successful `get` (FR-001, FR-012). Not a TypeScript value — git speaks plain text.

```text
protocol=https
host=github.com
username=x-access-token
password=ghs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
<blank line>
```

The wrapper echoes the input lines it received from git (`protocol`, `host`, optionally `path`) and appends `username=x-access-token` and `password=<token>`. Terminated by a blank line. This matches the standard custom-helper output shape documented at <https://git-scm.com/docs/git-credential#IOFMT>.

For `store` and `erase`, the wrapper reads stdin to EOF and exits 0 with no stdout.

### ClusterApiKey (file-backed value)

```ts
export interface ClusterApiKeyReader {
  /** Reads the key (cached, with mtime-based invalidation). Throws GitHelperError(CLUSTER_API_KEY_MISSING) when absent. */
  read(): Promise<string>;
}
```

**File path**: `/var/lib/generacy/cluster-api-key`.
**Permissions**: expected mode 0600, owned by the control-plane uid.
**Caching**: in-memory string + last-seen `mtime`. On each `read()`, `stat()` the file; if `mtime` changed, re-read.
**Created by**: `packages/orchestrator/src/activation/persistence.ts` (not by this feature). This feature only reads.

## Relationships

```
              ┌──────────────────────────────────────────────────────────┐
              │  control-plane process (long-lived)                       │
              │                                                            │
              │   ┌─────────────────┐    holds   ┌──────────────────────┐ │
              │   │ GitTokenManager │ ────────▶  │ GitTokenCacheEntry?  │ │
              │   └─────────────────┘            └──────────────────────┘ │
              │           │                                                │
              │           │ fetchFromCloud(credentialId)                   │
              │           ▼                                                │
              │   ┌─────────────────┐    auth      ┌────────────────────┐ │
              │   │ CloudPullClient │ ──────────▶  │ ClusterApiKey file │ │
              │   └─────────────────┘              └────────────────────┘ │
              │           │                                                │
              │           │ HTTPS POST                                     │
              │           ▼                                                │
              └────────── │ ───────────────────────────────────────────────┘
                          │
                          ▼
                  generacy-cloud (#817)
                          │
                          │ HTTPS                                          ┌────────────┐
                          ▼                                                │  git proc  │
                  CloudPullResponse                                        └─────┬──────┘
                          │                                                      │ exec
                          │                                                      ▼
                          │                                              ┌────────────────────────┐
                          │                                              │ git-credential-generacy│
                          │                                              │   (CLI wrapper)         │
                          │                                              └────────────┬───────────┘
                          │                                                           │ POST /git-token
                          │                                                           │ over Unix socket
                          ▼                                                           ▼
                  back to GitTokenManager                                  back to control-plane HTTP
```

## Validation rules

1. **Token never logged.** No code path in `GitTokenManager`, `CloudPullClient`, or the route handler may include `token` in a log line. Telemetry (FR-010) logs `credentialId`, `expiresAt`, `result`, and `durationMs` only.
2. **`expiresAt` always in the future on successful fetch.** If the cloud returns an already-past `expiresAt`, the manager treats this as `CLOUD_RESPONSE_INVALID` (defense against bad cloud responses).
3. **No silent fallback to `GH_TOKEN`.** When `GitTokenManager.getToken()` throws, the route returns 5xx and the wrapper exits non-zero. The wrapper does **not** read `wizard-credentials.env` or `process.env.GH_TOKEN` — that would re-introduce #762's failure mode (Q3 rationale).
4. **No on-disk cache.** `GitTokenCacheEntry` is purely in-memory. A control-plane restart drops the cache; the next `get` fetches afresh. This is correct because installation tokens are short-lived anyway.
5. **`x-access-token` username is constant.** The wrapper does not vary the username based on cloud response or credential metadata (FR-012, Q5).

## What is NOT modeled

- **No on-disk token store**: `GH_TOKEN` in `wizard-credentials.env` is unchanged by this feature (it remains for non-git uses per spec Out-of-Scope). The cluster-base companion PR (#61) is responsible for ensuring git's credential surface does not consume it.
- **Background refresh timer**: deferred per Q4.
- **Per-credential cache map**: deferred — v1 holds a single `GitTokenCacheEntry?`. Adding `Map<credentialId, …>` is a forward-compatible change because the public API already takes `credentialId`.
- **Relay-event propagation of telemetry events**: deferred. Logs only in v1 (R-9).
