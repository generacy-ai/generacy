# Data Model: GH_TOKEN Expiry Detection and Refresh Backstop

**Issue**: [generacy-ai/generacy#762](https://github.com/generacy-ai/generacy/issues/762)
**Branch**: `762-summary-when-cluster-s`
**Status**: Complete

All net-new types live in `packages/orchestrator/src/types/github-auth.ts` unless noted. No new persistent storage is introduced — all state is in-memory on the orchestrator process.

---

## Core entities

### `GitHubAuthStatus` (enum)

```ts
export type GitHubAuthStatus = 'ok' | 'failing' | 'unknown';
```

- `unknown` — no monitor call has yet been recorded for this credential. Initial state when the credential map is first populated and no `recordResult()` has been called.
- `ok` — at least one successful call has been recorded AND the credential is not currently in a failing run.
- `failing` — at least one 401 has been observed since the last success.

Transitions:

| From      | Event                                | To        | Side effects                                                  |
|-----------|--------------------------------------|-----------|---------------------------------------------------------------|
| unknown   | `recordResult(id, ok=true)`          | ok        | set `lastSuccessAt`; emit nothing                             |
| unknown   | `recordResult(id, ok=false, 401)`    | failing   | increment `consecutiveFailures`; emit `auth-failed`           |
| ok        | `recordResult(id, ok=true)`          | ok        | update `lastSuccessAt`; emit nothing                          |
| ok        | `recordResult(id, ok=false, 401)`    | failing   | `consecutiveFailures = 1`; emit `auth-failed`                 |
| failing   | `recordResult(id, ok=true)`          | ok        | reset `consecutiveFailures`; update `lastSuccessAt`; emit `auth-recovered` |
| failing   | `recordResult(id, ok=false, 401)`    | failing   | increment `consecutiveFailures`; emit nothing (state-stable)  |
| any       | `recordResult(id, ok=false, non-401)`| unchanged | emit nothing                                                  |

### `GitHubAuthSnapshot`

Returned by `GitHubAuthHealthService.snapshot()` and rendered on `/health` as the `githubAuth` field.

```ts
export interface GitHubAuthSnapshot {
  status: GitHubAuthStatus;
  consecutiveFailures: number;
  lastSuccessAt?: string;          // ISO 8601, present when status !== 'unknown' and a success has ever been recorded
  credentialId?: string;           // present when at least one credential is known; omit when status === 'unknown' with no map
  expiresAt?: string;              // ISO 8601, mirrored from credentials.yaml when known
}
```

Validation rules:
- `consecutiveFailures >= 0`.
- `lastSuccessAt` must be a valid ISO-8601 string when present.
- `credentialId`, when present, must match `^[A-Za-z0-9_-]+$` (same charset rules as elsewhere in the codebase).
- When `status === 'unknown'`, `lastSuccessAt` is omitted; `consecutiveFailures` is `0`.
- When `status === 'ok'`, `lastSuccessAt` should be present (unless the bootstrap path provided a credential map but no monitor has executed yet — still `unknown`).
- When `status === 'failing'`, `consecutiveFailures >= 1`.

### `PerCredentialState` (internal)

The service's internal `Map<credentialId, PerCredentialState>` entry.

```ts
interface PerCredentialState {
  credentialId: string;
  status: GitHubAuthStatus;       // starts 'unknown'
  consecutiveFailures: number;     // starts 0
  lastSuccessAt?: number;          // epoch ms; converted to ISO on snapshot
  expiresAtMs?: number;            // epoch ms, populated by ExpiryWatcher
  lastRefreshRequestAtMs?: number; // epoch ms, for 60s rate limit
}
```

### `CredentialDescriptor` (read from `<agencyDir>/credentials.yaml`)

```ts
interface CredentialDescriptor {
  credentialId: string;
  type: 'github-app' | 'github-pat' | 'anthropic' | 'api-key' | string; // open
  expiresAt?: string;              // ISO 8601 when known
}
```

Source: parsed from `parsed.credentials[id]` in the YAML; the `expiresAt` field may or may not be present depending on the credential type.

Validation rules (Zod):
- Top-level YAML object must have a `credentials` field of type `Record<string, { type: string; expiresAt?: string }>`.
- Unknown `type` values are accepted (forward compat) but only `'github-app'` and `'github-pat'` participate in this feature.
- A missing `expiresAt` is valid; the watcher logs `debug` once and treats the credential as never-expiring for proactive checks (the 401 path still applies).

---

## Relay event payload

### `CredentialsEventPayload` (discriminated union, per Q1)

```ts
export type CredentialsEventPayload =
  | {
      action: 'refresh-requested';
      credentialId: string;
      type: 'github-app';
      expiresAt?: string;
      reason?: 'near-expiry' | 'auth-401' | string;
    }
  | {
      action: 'auth-failed';
      credentialId: string;
      type: 'github-app';
      reason?: string;
      consecutiveFailures: number;
    }
  | {
      action: 'auth-recovered';
      credentialId: string;
      type: 'github-app';
      recoveredAfterFailures: number;
    };
```

Validation rules:
- `action` is the discriminator.
- `credentialId` always present and non-empty.
- `type` always `'github-app'` for the events this feature emits (existing channel can carry other actions / types in the future without breaking this contract).
- `expiresAt` (when present) must be a valid ISO-8601 string.
- `consecutiveFailures >= 1` for `auth-failed`.
- `recoveredAfterFailures >= 1` for `auth-recovered`.

The Zod schema for these payloads lives in `packages/orchestrator/src/types/github-auth.ts` so unit tests and the contract JSON Schema (`contracts/cluster-credentials-event.schema.json`) stay in lockstep.

### Relay envelope

The orchestrator sends:

```ts
relayClient.send({
  type: 'event',
  event: 'cluster.credentials',
  data: payload,                          // CredentialsEventPayload
  timestamp: new Date().toISOString(),
});
```

This is exactly the shape `setupInternalRelayEventsRoute` (`packages/orchestrator/src/routes/internal-relay-events.ts:44-49`) emits today and matches `EventMessage` in `@generacy-ai/cluster-relay`. `'cluster.credentials'` is already in the relay's `ALLOWED_CHANNELS` allowlist.

---

## Service contracts (Typescript signatures)

### `GitHubAuthHealthService`

```ts
export interface GitHubAuthHealthServiceOptions {
  emitEvent: (payload: CredentialsEventPayload) => void;
  logger: Logger;
  now?: () => number;              // injectable for tests; default Date.now
  minRefreshIntervalMs?: number;   // default 60_000
}

export class GitHubAuthHealthService {
  constructor(options: GitHubAuthHealthServiceOptions);

  /** Register or refresh known credentials (called by ExpiryWatcher on YAML mtime change). */
  setCredentials(credentials: CredentialDescriptor[]): void;

  /** Called from monitor services after each gh call (success or failure). */
  recordResult(credentialId: string, result:
    | { ok: true }
    | { ok: false; statusCode?: number; error?: unknown }
  ): void;

  /** Called by ExpiryWatcher's 60s tick when a credential is at <5 min remaining. */
  maybeRequestRefresh(credentialId: string, reason: 'near-expiry'): boolean;

  /** Read state for /health. */
  snapshot(): GitHubAuthSnapshot;
}
```

Behaviour notes:
- `recordResult` with `ok: false, statusCode: 401` triggers state transition + may call `maybeRequestRefresh(credentialId, 'auth-401')` (different `reason`, same rate-limit map entry).
- `setCredentials` is idempotent and additive: removing a credential clears its entry (the cluster shouldn't keep reporting `failing` for a credential the cloud rescinded).
- `snapshot` selects a single credential to surface on `/health`:
  - if any `failing`, return that one (deterministic by lexicographic `credentialId` if multiple).
  - else if any `ok`, return that one.
  - else `unknown`.

### `CredentialExpiryWatcher`

```ts
export interface CredentialExpiryWatcherOptions {
  agencyDir: string;                            // default: derived from env / cwd
  health: GitHubAuthHealthService;
  logger: Logger;
  tickIntervalMs?: number;                      // default 60_000
  nearExpiryWindowMs?: number;                  // default 5 * 60_000
  now?: () => number;
}

export class CredentialExpiryWatcher {
  constructor(options: CredentialExpiryWatcherOptions);
  start(): void;
  stop(): Promise<void>;
}
```

Behaviour notes:
- On each tick: stat `<agencyDir>/credentials.yaml`; on `ENOENT`, no-op. On mtime change, re-parse and call `health.setCredentials(...)`. Then iterate credentials, compute `secondsRemaining = (expiresAtMs - now) / 1000`, and call `health.maybeRequestRefresh(credentialId, 'near-expiry')` for each at-or-below-threshold credential.
- All errors caught and logged at `warn` (never throw out of the timer).

### `GhAuthError`

```ts
export class GhAuthError extends Error {
  constructor(
    public readonly statusCode: 401,
    public readonly stderr: string,
    message?: string,
  );
}
```

Thrown from `executeGh()` in `packages/workflow-engine/src/actions/github/client/gh-cli.ts` when `parseGhStatusCode(stderr) === 401`. Other status codes can be added in a follow-up but are out of scope for this feature.

### `parseGhStatusCode` (pure helper)

```ts
export function parseGhStatusCode(stderr: string): number | undefined;
```

- Returns the first HTTP status code found in stderr matching `/HTTP\s+(\d{3})/` (case-insensitive).
- Returns `undefined` when the stderr does not include an HTTP status line.
- Test fixture coverage: `HTTP 401: Bad credentials`, `gh: ... (HTTP 401)`, multi-line stderr with the line not first, empty stderr.

---

## Relationships

```
CredentialExpiryWatcher  ──reads──>  <agencyDir>/credentials.yaml
        │
        ├──calls──> GitHubAuthHealthService.setCredentials(...)
        └──calls──> GitHubAuthHealthService.maybeRequestRefresh(id, 'near-expiry')

LabelMonitorService.pollRepo()       ──calls──> GhCliGitHubClient.executeGh(...)
PrFeedbackMonitorService.pollRepo()  ──calls──> GhCliGitHubClient.executeGh(...)
        │                                              │
        │                                              └── throws GhAuthError on 401
        ├──on success──> GitHubAuthHealthService.recordResult(id, { ok: true })
        └──on GhAuthError──> GitHubAuthHealthService.recordResult(id, { ok: false, statusCode: 401 })

GitHubAuthHealthService ──invokes──> emitEvent(CredentialsEventPayload)
                                            │
                                            └── server.ts wires: payload => relayClientRef.send({ type:'event', event:'cluster.credentials', data: payload, timestamp })

/health route ──calls──> GitHubAuthHealthService.snapshot() ──renders──> response.githubAuth
```

---

## Backwards compatibility & defaults

- If `<agencyDir>/credentials.yaml` is missing or has no `github-app` entries, `GitHubAuthHealthService` reports `status: 'unknown'` and emits zero events. Monitors continue to function as today.
- If the relay is not yet connected when `emitEvent` is invoked, the in-memory event is dropped (same behaviour as the existing `relayClientRef!.send` callsites in `server.ts`). The state transition and log still happen.
- The new `githubAuth` field on `/health` is additive; existing consumers that ignore unknown fields are unaffected.
