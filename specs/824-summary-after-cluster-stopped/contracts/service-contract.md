# Contract: BootResumeService

**Feature**: `824-summary-after-cluster-stopped` | **Date**: 2026-07-07

Defines the observable contract of the new `BootResumeService` — inputs, outputs, invariants, and side-channel emissions. Consumed by `packages/orchestrator/src/server.ts` at startup; not exposed on any HTTP surface.

## Class surface

```ts
// packages/orchestrator/src/services/boot-resume-service.ts

export interface BootResumeOptions {
  controlPlaneSocket?: string;            // default: /run/generacy-control-plane/control.sock
  controlPlaneWaitTimeout?: number;       // default: 15 (seconds)
  logger: FastifyBaseLogger;              // required
  sendRelayEvent?: (channel: string, payload: unknown) => void;   // optional
}

export class BootResumeService {
  constructor(options: BootResumeOptions);
  triggerBootResume(): Promise<void>;
}
```

## Invocation preconditions

- Caller MUST have already verified `activated === true && postActivationComplete === true`. Resume does NOT re-read `/var/lib/generacy/cluster-api-key` or `/var/lib/generacy/post-activation-complete`.
- Caller MUST invoke `triggerBootResume()` AFTER `initializeRelayBridge()` has resolved. Otherwise `cluster.vscode-tunnel { status: 'starting' }` events from the child tunnel process may be dropped by the still-unwired `getRelayPushEvent()` in control-plane.
- Caller SHOULD NOT `await` the returned promise. Log-on-reject: `.catch((err) => logger.error({ err }, 'Boot resume failed'))`. Server startup should not be blocked by device-code UX inside the tunnel manager.

## Behavior

### Nominal — control-plane socket ready, both services start cleanly

1. Probe control-plane socket, poll every 1 s up to 15 s ceiling (via `probeControlPlaneSocket`).
2. When socket becomes ready, fire two `POST` requests concurrently:
   - `POST /lifecycle/vscode-tunnel-start` (Content-Type: application/json, body `{"action":"vscode-tunnel-start"}`)
   - `POST /lifecycle/code-server-start`  (Content-Type: application/json, body `{"action":"code-server-start"}`)
3. Both requests carry `x-generacy-actor-user-id: system` and `x-generacy-actor-session-id: boot-resume` headers.
4. Both requests have a 10 s `req.setTimeout()`.
5. 2xx from both: `triggerBootResume()` resolves. No `cluster.bootstrap` event emitted.

### Partial failure — one POST fails, other succeeds

- Failing POST → emit `cluster.bootstrap { status: 'failed', reason: 'resume-failed', service: <'vscode-tunnel' | 'code-server'>, error: <message> }`.
- Succeeding POST → no `cluster.bootstrap` event.
- `triggerBootResume()` still resolves (does not throw).

### Total failure — both POSTs fail

- Two independent `cluster.bootstrap` events, one per service, with distinct `service` fields.
- Both HTTP requests DO fire (Promise.allSettled semantics, not Promise.all).
- `triggerBootResume()` resolves.

### Socket-unreachable — 15 s ceiling exceeded

- No POSTs fire.
- Two `cluster.bootstrap` events emitted, one per service, both with `error: 'Control-plane socket did not become ready'`.
- `triggerBootResume()` resolves.

## Failure event schema

Emitted on channel `cluster.bootstrap`:

```json
{
  "status": "failed",
  "reason": "resume-failed",
  "service": "vscode-tunnel",
  "error": "Lifecycle action returned 500: internal error"
}
```

Or:

```json
{
  "status": "failed",
  "reason": "resume-failed",
  "service": "code-server",
  "error": "Control-plane socket did not become ready"
}
```

Fields:
| Field | Type | Required | Values |
|-------|------|----------|--------|
| `status` | string | yes | Always `"failed"` for this reason variant. |
| `reason` | string | yes | Always `"resume-failed"`. Distinguishes from sibling `PostActivationRetryService` events on the same channel. |
| `service` | string | yes | `"vscode-tunnel"` or `"code-server"`. Present iff `reason === "resume-failed"`. |
| `error` | string | yes | Human-readable message. Freeform. |

## Invariants

- **I1: Independent POSTs.** `service: 'vscode-tunnel'` failure does not prevent the `service: 'code-server'` POST from firing (and vice versa). Verified via test.
- **I2: Single-shot per POST.** No retry loop, no exponential backoff. Verified via test (request-counter mock).
- **I3: No status transition.** `triggerBootResume` does NOT push cluster status updates via `StatusReporter`. Cluster state stays `ready` regardless of resume outcome. (Divergence from `PostActivationRetryService.handleRetryFailure`, which pushes `degraded`.)
- **I4: No throw.** `triggerBootResume()` NEVER throws or rejects. All failure modes emit relay events; caller uses `.catch()` only for defense-in-depth.
- **I5: Ordering.** When socket-unreachable, failure emits happen in order `vscode-tunnel` then `code-server`. When both POSTs fail, emit order is not guaranteed (depends on which POST returns 5xx first).

## Non-goals (explicit exclusions)

- **NOT called by any HTTP handler.** The service is startup-only. There is no `POST /internal/boot-resume` or similar. The UI Restart button remains the operator-facing recovery path.
- **NOT idempotency-tracked internally.** `triggerBootResume()` is called exactly once per orchestrator process lifetime; no dedup memoization inside the class.
- **NOT triggered when `needsRetry === true`.** The sibling `PostActivationRetryService.triggerPostActivationRetry()` already fires `bootstrap-complete`, which starts both services. Overlapping would be safe (managers are idempotent) but is skipped for clean separation of concerns.
- **NOT emitting success events.** Per-service success signals continue to flow through their existing channels (`cluster.vscode-tunnel { status: 'starting' | 'authorization_pending' | 'connected' }` from `VsCodeTunnelProcessManager`; `codeServerReady: true` in orchestrator health/metadata from `probeCodeServerSocket`).

## Wire-level: lifecycle POST examples

### `vscode-tunnel-start`

```http
POST /lifecycle/vscode-tunnel-start HTTP/1.1
Host: localhost
Content-Type: application/json
Content-Length: 40
x-generacy-actor-user-id: system
x-generacy-actor-session-id: boot-resume

{"action":"vscode-tunnel-start"}
```

Expected response (from `packages/control-plane/src/routes/lifecycle.ts:77–91`):

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"pid":12345,"tunnelName":"g-9e5c8a0d755e40b3b0","status":"starting"}
```

### `code-server-start`

```http
POST /lifecycle/code-server-start HTTP/1.1
Host: localhost
Content-Type: application/json
Content-Length: 36
x-generacy-actor-user-id: system
x-generacy-actor-session-id: boot-resume

{"action":"code-server-start"}
```

Expected response (from `packages/control-plane/src/routes/lifecycle.ts:31–45`):

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"pid":12346,"status":"running"}
```

Failure responses use control-plane's `CredhelperErrorResponse`-shaped body (`{ error, code, details? }`); the resume service extracts `error` for its `error` field.

## Change history

| Version | Date | Notes |
|---------|------|-------|
| 1.0 | 2026-07-07 | Initial contract for #824. |
