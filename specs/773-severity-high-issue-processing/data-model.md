# Data Model: JIT GH-CLI Token Provider (#773)

**Branch**: `773-severity-high-issue-processing`
**Date**: 2026-06-05

## Overview

Two new modules, both small. The first is a wire-level client for `POST /git-token`; the second is a behavior wrapper that adds caching, sink reporting, and socket auto-resolution. Several existing types are reused unchanged.

## New types

### `JitGitTokenClient` (interface, `packages/control-plane/src/services/jit-git-token-client.ts`)

```ts
export interface JitGitTokenClient {
  /**
   * POST /git-token over the configured Unix socket. Returns a fresh installation
   * token + ISO-8601 expiry, or throws JitTokenError on any failure (transport,
   * non-2xx response, malformed JSON, missing fields).
   *
   * NEVER returns undefined. The contract is "give me a token or throw."
   */
  fetch(credentialId?: string): Promise<JitGitTokenResponse>;
}
```

### `JitGitTokenClientOptions` (interface, same file)

```ts
export interface JitGitTokenClientOptions {
  /** Path to the Unix socket on which POST /git-token is served. */
  socketPath: string;
  /** Optional logger; defaults to a no-op. */
  logger?: { warn(obj: Record<string, unknown>, msg: string): void };
}
```

### `JitGitTokenResponse` (interface, same file)

```ts
export interface JitGitTokenResponse {
  /** Opaque installation token to be exported as GH_TOKEN. */
  token: string;
  /** Expiry as a Date — parsed from the route's ISO-8601 string. */
  expiresAt: Date;
}
```

### `JitTokenError` (class, same file)

```ts
export class JitTokenError extends Error {
  readonly code: JitTokenErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: JitTokenErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'JitTokenError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export type JitTokenErrorCode =
  | GitHelperErrorCode           // imported from packages/control-plane/src/types/git-token.ts
  | 'CONTROL_SOCKET_UNREACHABLE' // ECONNREFUSED / ENOENT / EPIPE / timeout
  | 'RESPONSE_PARSE_ERROR';      // HTTP 200 but body is not JSON or missing fields
```

### `createJitGitTokenClient` (factory, same file)

```ts
export function createJitGitTokenClient(options: JitGitTokenClientOptions): JitGitTokenClient;
```

### `JitGithubTokenProvider` (type alias, `packages/orchestrator/src/services/jit-github-token-provider.ts`)

Existing `TokenProvider` signature is reused — the wrapper must be drop-in compatible at every `gh`-CLI callsite (`LabelMonitorService`, `LabelSyncService`, `PrFeedbackMonitorService`, `WebhookSetupService`, `ClaudeCliWorker`, plus the underlying `GhCliGitHubClient`).

```ts
/**
 * Same shape as the existing TokenProvider type (orchestrator/services/wizard-creds-token-provider.ts,
 * deleted in this PR) and gh-cli.ts's tokenProvider field. Drop-in replacement.
 *
 * IMPORTANT contract change: this implementation NEVER returns undefined.
 * It always either returns a non-empty token string or throws JitTokenError.
 */
export type JitGithubTokenProvider = () => Promise<string>;
```

### `JitGithubTokenProviderOptions` (interface, same file)

```ts
export interface JitGithubTokenProviderOptions {
  /** The wire-level client. Caller injects so tests can mock it. */
  client: JitGitTokenClient;

  /**
   * The credential ID to request. Resolved once at startup from .agency/credentials.yaml
   * via the same path used by server.ts:195–203 (first credential with type === 'github-app').
   */
  credentialId: string;

  /**
   * Optional auth-health sink. When provided, refresh failures call
   * sink.recordResult(credentialId, { ok: false, statusCode: 503 }) before re-throwing,
   * firing the #762 auth-failed / refresh-requested flow without waiting for a gh 401.
   */
  authHealth?: AuthHealthSink;

  /**
   * Pre-expiry refresh window in ms. Defaults to 5 * 60_000 (5 min), matching
   * GitTokenManager.REFRESH_WINDOW_MS upstream in the control-plane process.
   */
  refreshWindowMs?: number;

  /** Optional clock injection for tests. Defaults to () => new Date(). */
  now?: () => Date;

  /** Pino-like logger. Required (no default) — every callsite already has one. */
  logger: { info(obj: Record<string, unknown>, msg: string): void; warn(obj: Record<string, unknown>, msg: string): void };
}
```

### `createJitGithubTokenProvider` (factory, same file)

```ts
export function createJitGithubTokenProvider(
  options: JitGithubTokenProviderOptions,
): JitGithubTokenProvider;
```

Plus a sibling helper:

```ts
/**
 * Build a JitGitTokenClient with the right Unix socket for the current process.
 *
 * Resolution order:
 *   1. process.env.GIT_TOKEN_SOCKET_PATH        // worker (proxy from #768)
 *   2. process.env.CONTROL_PLANE_SOCKET_PATH    // orchestrator (direct from #766)
 *   3. '/run/generacy-control-plane/control.sock'
 *
 * Same precedence as git-credential-generacy.ts uses today (with the
 * GIT_TOKEN_SOCKET_PATH branch added for parity with this PR).
 */
export function resolveSocketPath(env?: NodeJS.ProcessEnv): string;
```

### `TokenCacheEntry` (internal, `jit-github-token-provider.ts`)

```ts
interface TokenCacheEntry {
  token: string;
  expiresAt: Date;
  fetchedAt: Date;
}
```

Not exported. Lives only inside the provider closure.

## Reused (unchanged) types

| Type | Defined in | Why this PR reuses it |
|---|---|---|
| `GitHelperError`, `GitHelperErrorCode` | `packages/control-plane/src/types/git-token.ts` | The route's existing error taxonomy. `JitTokenErrorCode` is a strict superset. |
| `GitTokenRequestSchema` | `packages/control-plane/src/schemas.ts` | Validates `{ credentialId? }` body. Client serializes to this shape. |
| `GitTokenResponse` | `packages/control-plane/src/types/git-token.ts` | Wire format of the success response. Client converts `expiresAt: string` → `Date`. |
| `AuthHealthSink` | `packages/orchestrator/src/services/label-monitor-service.ts` (or wherever it canonically lives — confirm during impl) | Existing interface from #762. Provider injects optionally. |
| `TokenProvider` (signature shape) | Caller side: `GhCliGitHubClient` constructor `tokenProvider?: () => Promise<string \| undefined>` | The new provider returns `Promise<string>` (strictly tighter — no `undefined`). Existing callsites typecheck because `Promise<string>` is assignable to `Promise<string \| undefined>`. |

## Validation rules

### `JitGitTokenClient.fetch()`

| Condition | Action |
|---|---|
| Socket connect fails (`ECONNREFUSED`, `ENOENT`, `EPIPE`, `ETIMEDOUT`) | Throw `JitTokenError('CONTROL_SOCKET_UNREACHABLE', …)` |
| HTTP status 2xx but body is not JSON | Throw `JitTokenError('RESPONSE_PARSE_ERROR', …)` |
| HTTP status 2xx but `token` field missing / empty / non-string | Throw `JitTokenError('RESPONSE_PARSE_ERROR', …)` |
| HTTP status 2xx but `expiresAt` not parseable as ISO-8601 | Throw `JitTokenError('RESPONSE_PARSE_ERROR', …)` |
| HTTP status non-2xx with parseable `{ code, error }` body | Throw `JitTokenError(<body.code>, <body.error>)` — preserves the route's error taxonomy |
| HTTP status non-2xx with unparseable body | Throw `JitTokenError('CLOUD_UPSTREAM_ERROR', 'HTTP <status>')` |

### `createJitGithubTokenProvider()` returned function

| Condition | Action |
|---|---|
| Cache hit and `entry.expiresAt - now > refreshWindowMs` | Return `entry.token` synchronously (Promise.resolve) |
| Cache miss OR `entry.expiresAt - now ≤ refreshWindowMs` | Call `client.fetch(credentialId)`; on success store entry, return `token` |
| `client.fetch` throws `JitTokenError` | Call `authHealth?.recordResult(credentialId, { ok: false, statusCode: 503 })`; log `warn`; re-throw the same error |
| `client.fetch` throws unexpected (non-`JitTokenError`) | Wrap in `JitTokenError('CONTROL_SOCKET_UNREACHABLE', err.message)`, call `authHealth.recordResult`, throw the wrapped error |

**Invariant**: returned `Promise<string>` resolves only with a non-empty string. There is no code path that produces `''`, `undefined`, or `null`.

## Relationships

```
                              ┌─────────────────────────────────────────┐
                              │  packages/orchestrator/src/server.ts    │
                              │   - resolveSocketPath()                 │
                              │   - createJitGitTokenClient(socketPath) │
                              │   - createJitGithubTokenProvider({…})   │
                              └────────────┬────────────────────────────┘
                                           │
                          ┌────────────────┴───────────────────┐
                          │  JitGithubTokenProvider (closure)  │
                          │   - Map<credentialId, entry>       │
                          │   - 5 min refresh window           │
                          │   - AuthHealthSink reporting       │
                          └────────────┬───────────────────────┘
                                       │ throws JitTokenError
                                       │ (forwarded to caller)
                                       │
                          ┌────────────▼────────────┐                      ┌──────────────────────┐
                          │  JitGitTokenClient      │  POST /git-token     │  control-plane route │
                          │  (packages/control-     │ ───────────────────▶ │  (existing, #766)    │
                          │   plane/src/services)   │  via Unix socket     │                      │
                          └─────────────────────────┘                      └──────────┬───────────┘
                                       ▲                                              │
                                       │ also consumed by                             │ calls
                                       │                                              ▼
                          ┌────────────┴────────────────────┐              ┌─────────────────────┐
                          │  packages/control-plane/        │              │   GitTokenManager   │
                          │  bin/git-credential-generacy.ts │              │   (existing, #766)  │
                          │  (refactored to use client)     │              └─────────────────────┘
                          └─────────────────────────────────┘

                          ┌─────────────────────────────────────────┐
                          │ Six consumers of JitGithubTokenProvider │
                          │ (`server.ts` callsites):                │
                          │   • LabelSyncService          line 207  │
                          │   • ClaudeCliWorker (worker)  line 298  │
                          │   • LabelMonitorService       line 335  │
                          │   • PrFeedbackMonitorService  line 363  │
                          │   • WebhookSetupService       line 616  │
                          │   • (creation site)           line 160  │
                          │                                         │
                          │ All call provider() inside their        │
                          │ GhCliGitHubClient tokenProvider field.  │
                          │ ClaudeCliWorker also threads it through │
                          │ deps.tokenProvider to its worker        │
                          │ subprocesses.                           │
                          └─────────────────────────────────────────┘
```

## Deletions

| File | Reason |
|---|---|
| `packages/orchestrator/src/services/wizard-creds-token-provider.ts` | After this PR, no callsite imports `createWizardCredsTokenProvider`. Per clarification Q1 option B. |
| `packages/orchestrator/tests/unit/services/wizard-creds-token-provider.test.ts` | Tests the deleted module. |

The `TokenProvider` type alias currently exported by the deleted file is replaced by the inline `JitGithubTokenProvider` type alias in the new module. Any consumer that imported `TokenProvider` from `wizard-creds-token-provider.js` updates its import path.

## Non-changes

- `packages/control-plane/src/services/git-token-manager.ts` — unchanged
- `packages/control-plane/src/services/cloud-pull-client.ts` — unchanged
- `packages/control-plane/src/routes/git-token.ts` — unchanged
- `packages/control-plane/src/services/wizard-env-writer.ts` — unchanged (Q1 option B explicitly defers `GH_TOKEN` env-line retirement)
- `packages/workflow-engine/src/actions/github/client/gh-cli.ts` — unchanged. Its `tokenProvider?: () => Promise<string | undefined>` field is structurally compatible with `() => Promise<string>`.
- `packages/orchestrator/src/services/github-auth-health.ts` — unchanged. Existing `AuthHealthSink` interface is consumed as-is.
- Cluster-base, generacy-cloud, CLI scaffolder — unchanged. No new env vars, no new sockets, no new tmpfs mounts.
