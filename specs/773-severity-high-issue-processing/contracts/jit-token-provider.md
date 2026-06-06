# Contract: `JitGithubTokenProvider`

**Package**: `@generacy-ai/orchestrator`
**Module path**: `packages/orchestrator/src/services/jit-github-token-provider.ts`
**Consumers**: every `gh`-CLI callsite in the orchestrator + worker:
- `server.ts:207` — `LabelSyncService`
- `server.ts:298` — `ClaudeCliWorker` (worker process)
- `server.ts:335` — `LabelMonitorService`
- `server.ts:363` — `PrFeedbackMonitorService`
- `server.ts:616` — `WebhookSetupService`

Internally, each of these passes the provider to a `GhCliGitHubClient`, whose `tokenProvider` field is invoked by `executeGh` per `gh` subprocess to set `GH_TOKEN`.

## Purpose

Drop-in replacement for the deleted `createWizardCredsTokenProvider`. Provides per-process caching, pre-expiry refresh, automatic socket auto-resolution, and `AuthHealthSink` failure reporting around the wire-level `JitGitTokenClient`. Guarantees a fresh installation token per `gh` invocation without the 1-hour static-token cliff.

## TypeScript surface

```ts
import type { JitGitTokenClient } from '@generacy-ai/control-plane';
import type { AuthHealthSink } from './github-auth-health.js';

export type JitGithubTokenProvider = () => Promise<string>;

export interface JitGithubTokenProviderOptions {
  client: JitGitTokenClient;
  credentialId: string;
  authHealth?: AuthHealthSink;
  refreshWindowMs?: number;  // default: 5 * 60_000
  now?: () => Date;          // default: () => new Date()
  logger: { info(obj: Record<string, unknown>, msg: string): void; warn(obj: Record<string, unknown>, msg: string): void };
}

export function createJitGithubTokenProvider(
  options: JitGithubTokenProviderOptions,
): JitGithubTokenProvider;

export function resolveSocketPath(env?: NodeJS.ProcessEnv): string;
```

## Behavior

### Cache semantics

- Single in-memory cache entry keyed by `credentialId` (v1 — a `Map<credentialId, entry>` shape is forward-compatible for multi-credential but not exercised yet).
- Entry fields: `{ token: string, expiresAt: Date, fetchedAt: Date }`.
- Cache hit when `entry.expiresAt - now() > refreshWindowMs`. Returns `entry.token` synchronously (`Promise.resolve(token)` — no I/O).
- Cache miss OR entry within refresh window → call `client.fetch(credentialId)`, store result, return `token`.

### Concurrency

- No in-flight Promise coalescing in the provider. Two concurrent `provider()` calls during a cache miss may both call `client.fetch()` once. That's fine: the upstream `GitTokenManager` in the control-plane process already coalesces concurrent refreshes (it stores a single in-flight Promise per credentialId — see #766). The provider sits behind that, so any "thundering herd" amortizes to one cloud round-trip.

### Failure handling

When `client.fetch()` throws:

1. Call `options.authHealth?.recordResult(options.credentialId, { ok: false, statusCode: 503 })`. Wrapped in try/catch — sink errors must not mask the original failure.
2. Log `warn` with `{ code, message }` (NEVER log token or details that could contain a token).
3. Re-throw the same `JitTokenError` to the caller (typically `GhCliGitHubClient.executeGh`).

If `client.fetch()` throws a non-`JitTokenError` (unexpected), wrap it in `JitTokenError('CONTROL_SOCKET_UNREACHABLE', err.message)` before step 1.

### Cache invalidation on failure

If a refresh attempt fails AND there is a stale cached entry whose `expiresAt > now()` (still technically valid):
- Discard the cached entry (do NOT keep serving the stale token, which is the bug we're fixing — and the gh API will reject it anyway with a 401 once it's actually expired).
- Throw the `JitTokenError` to the caller.

Rationale: leaving a stale entry caches the bug. The whole point of switching to JIT is to never serve a token that the provider has reason to believe will fail.

### Socket auto-resolution (`resolveSocketPath`)

```ts
env.GIT_TOKEN_SOCKET_PATH        // worker  (proxy from #768)
  ?? env.CONTROL_PLANE_SOCKET_PATH // orchestrator (direct from #766)
  ?? '/run/generacy-control-plane/control.sock';
```

Same precedence chain `git-credential-generacy.ts` will use after this PR (it currently only honors `CONTROL_PLANE_SOCKET_PATH`; this PR adds the `GIT_TOKEN_SOCKET_PATH` branch for parity).

## Invariants

1. `provider()` resolves only with a non-empty string. NEVER `undefined`, `null`, or `''`.
2. `provider()` rejects only with `JitTokenError`. No other error type leaks.
3. Every `provider()` rejection has been paired with exactly one `authHealth.recordResult({ ok: false, statusCode: 503 })` call (when `authHealth` is provided).
4. On successful refresh after a previous failure, the next `provider()` call resolves successfully. The `#762` `AuthHealthService` observes the recovery via the next monitor poll calling `recordResult({ ok: true })` (NOT the provider — provider only reports failures; successes are observed by the monitor).
5. `createJitGithubTokenProvider` is pure construction — no I/O.

## Wiring in `server.ts`

```ts
// Replace the current line 30 import:
import { createJitGithubTokenProvider, resolveSocketPath } from './services/jit-github-token-provider.js';
import { createJitGitTokenClient } from '@generacy-ai/control-plane';

// Replace lines 160–162:
const githubTokenClient = createJitGitTokenClient({ socketPath: resolveSocketPath() });
const githubTokenProvider = githubAppCredentialId  // resolved at lines 195–203 (already exists)
  ? createJitGithubTokenProvider({
      client: githubTokenClient,
      credentialId: githubAppCredentialId,
      authHealth: githubAuthHealth ?? undefined,
      logger: server.log,
    })
  : undefined;
```

**Note on ordering**: `githubAppCredentialId` is currently resolved at server.ts:195–203 *after* line 160 (where `wizardCredsTokenProvider` is created). This PR moves the credentialId resolution earlier so the provider can take it as a constructor arg. Alternatively, the provider accepts a `credentialIdProvider: () => string | undefined` closure to avoid the ordering reshuffle — but the static closure adds API surface for one consumer, and the resolution is a single `readCredentialDescriptors` call, so just reorder.

If `githubAppCredentialId` is `undefined` (no github-app credential configured), `githubTokenProvider` is `undefined`. All five gh-CLI callsites pass it through unchanged — they already tolerate `undefined` (the existing code does in worker mode at line 160). When the provider is undefined, `gh-cli.ts` falls back to ambient `process.env.GH_TOKEN`, which is the existing behavior for unconfigured clusters.

**Important**: this means clusters with a configured github-app credential get the JIT path, and clusters without one keep ambient behavior — same as today. The JIT path activates only when there is something to refresh.

### Callsite swaps

Five `wizardCredsTokenProvider` references replaced with `githubTokenProvider`:

| Line | Service | Param position |
|---|---|---|
| 207 | `LabelSyncService` | 3rd constructor arg |
| 298 | `ClaudeCliWorker` | `deps.tokenProvider` |
| 335 | `LabelMonitorService` | 8th constructor arg |
| 363 | `PrFeedbackMonitorService` | 8th constructor arg |
| 616 | `WebhookSetupService` | 2nd constructor arg |

`!isWorkerMode` guard at line 160 is dropped — provider is constructed in both modes (workers need it for the `ClaudeCliWorker` callsite at line 298, which is inside `if (isWorkerMode)`).

## Tests

Located at `packages/orchestrator/tests/unit/services/jit-github-token-provider.test.ts`.

- Mock `JitGitTokenClient` directly (no socket I/O — that's the client's contract).
- Cases:
  - First call → calls `client.fetch(credentialId)`, returns token
  - Second call within cache window → returns cached token, does NOT call `client.fetch`
  - Call within 5 min of expiry → calls `client.fetch` again, returns new token
  - Call after expiry → calls `client.fetch`, returns new token
  - `client.fetch` throws `JitTokenError` → provider throws same error, calls `authHealth.recordResult(credentialId, { ok: false, statusCode: 503 })`
  - `client.fetch` throws non-`JitTokenError` → provider wraps in `JitTokenError('CONTROL_SOCKET_UNREACHABLE', …)`, calls `authHealth.recordResult`, throws wrapped
  - `client.fetch` throws when stale entry exists → entry is discarded; next call attempts fetch again
  - `authHealth` undefined → provider still throws on failure (no NPE)
  - `authHealth.recordResult` throws → provider still throws the original `JitTokenError` (sink errors masked)
  - Custom `refreshWindowMs` honored
  - `now()` injection — fast-forward past expiry between calls, verify refetch
  - Two concurrent calls during cache miss → both succeed (may both call fetch, that's fine)
  - `resolveSocketPath({ GIT_TOKEN_SOCKET_PATH: '/a' })` returns `'/a'`
  - `resolveSocketPath({ CONTROL_PLANE_SOCKET_PATH: '/b' })` returns `'/b'`
  - `resolveSocketPath({ GIT_TOKEN_SOCKET_PATH: '/a', CONTROL_PLANE_SOCKET_PATH: '/b' })` returns `'/a'` (worker wins)
  - `resolveSocketPath({})` returns `'/run/generacy-control-plane/control.sock'`
  - Provider NEVER returns `undefined` — assert across all happy paths (TS will enforce this statically; one runtime sanity check still useful)
