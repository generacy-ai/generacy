# Contract: `JitGitTokenClient`

**Package**: `@generacy-ai/control-plane`
**Module path**: `packages/control-plane/src/services/jit-git-token-client.ts`
**Re-export path**: `packages/control-plane/src/index.ts`
**Consumers**: `packages/control-plane/bin/git-credential-generacy.ts` AND `packages/orchestrator/src/services/jit-github-token-provider.ts`

## Purpose

Wire-level HTTP-over-Unix-socket client for `POST /git-token`. Single source of truth for the request shape, response shape, and error-code taxonomy of that endpoint. Owns no state (no cache, no retry loop). Both the long-lived orchestrator/worker process and the short-lived `git-credential-generacy` CLI bin import this client so that future evolution of `/git-token` does not silently fork across two implementations.

## TypeScript surface

```ts
export interface JitGitTokenClient {
  fetch(credentialId?: string): Promise<JitGitTokenResponse>;
}

export interface JitGitTokenClientOptions {
  socketPath: string;
  logger?: { warn(obj: Record<string, unknown>, msg: string): void };
}

export interface JitGitTokenResponse {
  token: string;
  expiresAt: Date;
}

export class JitTokenError extends Error {
  readonly code: JitTokenErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: JitTokenErrorCode, message: string, details?: Record<string, unknown>);
}

export type JitTokenErrorCode =
  | 'CLUSTER_API_KEY_MISSING'
  | 'CREDENTIAL_NOT_CONFIGURED'
  | 'CLOUD_UNREACHABLE'
  | 'CLOUD_AUTH_REJECTED'
  | 'CLOUD_REQUEST_INVALID'
  | 'CLOUD_UPSTREAM_ERROR'
  | 'CLOUD_RESPONSE_INVALID'
  | 'CONTROL_SOCKET_UNREACHABLE'
  | 'RESPONSE_PARSE_ERROR';

export function createJitGitTokenClient(options: JitGitTokenClientOptions): JitGitTokenClient;
```

## Wire format

### Request

- Method: `POST`
- Path: `/git-token`
- Transport: HTTP/1.1 over Unix socket at `options.socketPath`
- Headers:
  - `Content-Type: application/json`
  - `Content-Length: <body.length>`
- Body (when `credentialId` is provided): `{"credentialId":"<id>"}` — validated server-side by `GitTokenRequestSchema`
- Body (when `credentialId` is omitted): `{}` — route resolves the default credential

### Response — success (HTTP 200)

- Body: `{ "token": string, "expiresAt": string }` where `expiresAt` is ISO-8601
- Client returns `{ token, expiresAt: new Date(expiresAt) }`

### Response — failure (HTTP 4xx / 5xx)

- Body: `{ "error": string, "code": string, "details"?: object }`
- Client throws `JitTokenError` with:
  - `code` = body.code (if recognized in `JitTokenErrorCode`) else `'CLOUD_UPSTREAM_ERROR'`
  - `message` = body.error (if a string) else `'HTTP <status>'`
  - `details` = body.details (if present)

### Failure modes (no HTTP response)

| Failure | Thrown code |
|---|---|
| `ECONNREFUSED` / `ENOENT` / `EPIPE` / connect timeout | `CONTROL_SOCKET_UNREACHABLE` |
| HTTP 2xx body not JSON | `RESPONSE_PARSE_ERROR` |
| HTTP 2xx body missing `token` or `expiresAt` | `RESPONSE_PARSE_ERROR` |
| HTTP 2xx body `expiresAt` not ISO-8601 parseable | `RESPONSE_PARSE_ERROR` |

## Invariants

1. `fetch()` resolves only with a `JitGitTokenResponse` whose `token` is a non-empty string.
2. `fetch()` rejects only with `JitTokenError` — no other error type leaks. Unexpected runtime errors are caught and rewrapped as `JitTokenError('CONTROL_SOCKET_UNREACHABLE', err.message)`.
3. `fetch()` does no caching, no retry, no backoff. Exactly one socket round-trip per call.
4. `fetch()` does no logging at info-level. The optional logger is used only for `warn` on unexpected internal errors (e.g., parse failure on an otherwise-2xx response). Tokens are NEVER logged.
5. `createJitGitTokenClient` is pure construction — no socket open, no I/O. First I/O happens on `fetch()`.

## Tests

Located at `packages/control-plane/src/services/__tests__/jit-git-token-client.test.ts` (matching existing convention in that directory).

- Spin up `net.createServer` Unix socket fixture (see existing `__tests__/bin/git-credential-generacy/` helpers).
- Cases:
  - Happy path: 200 with valid body → returns `{ token, expiresAt: Date }`
  - 400 with body `{ code: 'CREDENTIAL_NOT_CONFIGURED', error: '...' }` → throws `JitTokenError` with that code
  - 502 with body `{ code: 'CLOUD_UNREACHABLE', error: '...' }` → throws with that code
  - 503 with body `{ code: 'CLUSTER_API_KEY_MISSING', error: '...' }` → throws with that code
  - 200 with non-JSON body → throws `RESPONSE_PARSE_ERROR`
  - 200 with missing `token` → throws `RESPONSE_PARSE_ERROR`
  - 200 with bogus `expiresAt` → throws `RESPONSE_PARSE_ERROR`
  - Unknown error code in body → falls back to `CLOUD_UPSTREAM_ERROR`
  - No body on error response → `CLOUD_UPSTREAM_ERROR` with message `'HTTP <status>'`
  - Socket does not exist → `CONTROL_SOCKET_UNREACHABLE`
  - Socket connects then EPIPE mid-stream → `CONTROL_SOCKET_UNREACHABLE`
  - `credentialId` provided → body is `{"credentialId":"<id>"}` (verify with stub that captures request body)
  - `credentialId` omitted → body is `{}`
