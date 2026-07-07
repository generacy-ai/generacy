# Data Model: Orchestrator boot-time service resume

**Feature**: `824-summary-after-cluster-stopped` | **Date**: 2026-07-07

This feature introduces no persisted types, no wire-schema changes, and no new database entities. It adds one runtime service class, one runtime call graph, and one relay-event payload variant. Sections below document each.

## Types introduced

### `BootResumeOptions` — `packages/orchestrator/src/services/boot-resume-service.ts` (NEW)

```ts
export interface BootResumeOptions {
  /** Path to control-plane control socket. Default: /run/generacy-control-plane/control.sock */
  controlPlaneSocket?: string;

  /** How many seconds to wait for the control-plane socket before giving up. Default: 15. */
  controlPlaneWaitTimeout?: number;

  logger: FastifyBaseLogger;

  /** Function to send relay events (e.g. via relay client or IPC). */
  sendRelayEvent?: (channel: string, payload: unknown) => void;
}
```

Mirrors `PostActivationRetryOptions` (`packages/orchestrator/src/services/post-activation-retry.ts:13-21`) minus `completionFlagPath` and `keyFilePath` — the resume path does NOT read those files, because the caller (`server.ts`) has already established `activated && postActivationComplete` before instantiating this service.

### `ResumeServiceKind` — `packages/orchestrator/src/services/boot-resume-service.ts` (NEW, internal)

```ts
type ResumeServiceKind = 'vscode-tunnel' | 'code-server';
```

Used as the `service` discriminator in the failure event payload. Local to the module; not exported.

### `BootResumeService` — `packages/orchestrator/src/services/boot-resume-service.ts` (NEW)

```ts
export class BootResumeService {
  constructor(options: BootResumeOptions);

  /**
   * Fire two independent lifecycle POSTs to the control-plane socket, one for
   * each of vscode-tunnel-start and code-server-start. Best-effort: a failure
   * in one does not block the other.
   *
   * Envelope per POST: 15 s socket-wait (once, shared across both POSTs) + 1
   * POST attempt with 10 s request timeout. No retry loop.
   *
   * On per-service failure emits cluster.bootstrap { status: 'failed',
   * reason: 'resume-failed', service, error } via the injected sendRelayEvent
   * callback.
   *
   * On socket-not-ready-within-15s: emits the same event twice (once per
   * service) with a distinct upstream reason and does NOT fire the POSTs.
   */
  triggerBootResume(): Promise<void>;

  // Private:
  //   private waitForControlPlane(): Promise<boolean>;
  //   private sendLifecycleAction(service: ResumeServiceKind): Promise<void>;
  //   private handleResumeFailure(service: ResumeServiceKind, error: string): void;
}
```

### Relay event payload — `cluster.bootstrap` channel, new discriminated payload

```ts
{
  status: 'failed';
  reason: 'resume-failed';
  service: 'vscode-tunnel' | 'code-server';
  error: string;
}
```

Sits alongside `PostActivationRetryService`'s existing payload shape on the same channel:

```ts
{ status: 'retrying'; reason: 'post-activation-incomplete'; attempt: 'restart' }
{ status: 'failed'; reason: 'post-activation-incomplete'; ... }  // sibling
```

Consumer-side (cloud): the `reason` field is the primary discriminator. `resume-failed` is new; `service` is a new field, only present when `reason === 'resume-failed'`. Cloud can treat unknown `reason` values as pass-through log lines without breaking.

## Call graph delta

### `server.ts` — before (existing API key branch, ~L446–488)

```text
createServer(config, options)
  ├─ initializeRelayBridge(...)
  ├─ detectIdentitySplit(...)
  └─ const retryService = new PostActivationRetryService({ logger, sendRelayEvent })
     const postActivationState = retryService.checkPostActivationState()
     if (postActivationState.needsRetry) {
       retryService.triggerPostActivationRetry().catch(logger.error)
     }
     // else: nothing happens on restart — tunnel/code-server stay dead.
```

### `server.ts` — after

```text
createServer(config, options)
  ├─ initializeRelayBridge(...)
  ├─ detectIdentitySplit(...)
  └─ const retryService = new PostActivationRetryService({ logger, sendRelayEvent })
     const postActivationState = retryService.checkPostActivationState()
     if (postActivationState.needsRetry) {
       retryService.triggerPostActivationRetry().catch(logger.error)
     } else if (postActivationState.activated && postActivationState.postActivationComplete) {
       const resumeService = new BootResumeService({ logger, sendRelayEvent })
       resumeService.triggerBootResume().catch((err) => logger.error({ err }, 'Boot resume failed'))
     }
```

### `BootResumeService.triggerBootResume()` — internal flow

```text
triggerBootResume()
  ├─ waitForControlPlane()  ← reuses probeControlPlaneSocket, 15 s ceiling
  │   ├─ ready === true → continue
  │   └─ ready === false →
  │        handleResumeFailure('vscode-tunnel', 'Control-plane socket did not become ready')
  │        handleResumeFailure('code-server',   'Control-plane socket did not become ready')
  │        return
  └─ Promise.allSettled([
       sendLifecycleAction('vscode-tunnel')
         ├─ POST /lifecycle/vscode-tunnel-start (10 s timeout)
         ├─ 2xx → resolve
         └─ non-2xx / timeout / socket error → handleResumeFailure('vscode-tunnel', errorMsg)
       sendLifecycleAction('code-server')
         ├─ POST /lifecycle/code-server-start (10 s timeout)
         ├─ 2xx → resolve
         └─ non-2xx / timeout / socket error → handleResumeFailure('code-server', errorMsg)
     ])
```

`handleResumeFailure(service, error)`:
- Emits `cluster.bootstrap { status: 'failed', reason: 'resume-failed', service, error }` via `sendRelayEvent`.
- Does NOT call `StatusReporter.pushStatus('degraded', ...)`. (Divergence from sibling — a failed tunnel restart is not a cluster-degraded condition; see Decision 3 in research.md.)
- Does NOT throw. Failure is a side-channel; the caller in `server.ts` treats the returned Promise as fire-and-forget.

### `PostActivationRetryService` — unchanged

The sibling retry path continues to fire `bootstrap-complete` (which includes tunnel + code-server start) when `needsRetry === true`. No overlap with resume: they are guarded by mutually-exclusive branches (`needsRetry === true` vs `needsRetry === false && activated && postActivationComplete`).

## Validation / invariants

- **Both services get a POST attempt** whenever the socket is reachable. A tunnel-side failure does not skip the code-server POST, and vice versa. (SC-002 and SC-003 correctness.)
- **No retry loop** anywhere. `triggerBootResume()` returns after both settle. (SC-001 implication: bounded latency, no runaway state.)
- **Idempotency of both `start()` methods** means a rare double-start (e.g. if a future path also triggers a start concurrently) is safe. See `VsCodeTunnelProcessManager.start()` and `CodeServerProcessManager.start()` — both check current state before spawning.
- **`sendRelayEvent` is nullable**. When the callback is `undefined` (relay client not ready), failure events are silently dropped. This matches the sibling service's convention (`post-activation-retry.ts:34`).
- **`cluster.bootstrap` events on success/no-op**: none. Success is signaled by per-service channels (`cluster.vscode-tunnel { status: 'starting' | 'connected' }` from the tunnel manager, `codeServerReady: true` in metadata from `probeCodeServerSocket`). No dedicated "resume succeeded" event.
- **Order of failure emits when socket-not-ready**: `vscode-tunnel` first, then `code-server`. Alphabetical is arbitrary but stable — cloud consumers should not depend on order.
- **Concurrent-resume prevention**: not required. The `else if` branch runs exactly once per orchestrator startup, guarded by `postActivationState` (a snapshot at boot). No re-entry.

## Backward compatibility / migration

- **Cloud-side `cluster.bootstrap` consumer**: new `reason === 'resume-failed'` and new `service` field. If the cloud pattern-matches on `reason`, unknown values should log-through as-is (existing pattern per `handleRetryFailure`'s `reason` freeform strings). No breaking change.
- **No new env vars, no new config keys**. `BootResumeOptions` defaults suffice for prod; tests inject fakes.
- **No filesystem changes**. No new sentinel files.
- **No relay bridge changes**. Existing `sendRelayEvent` wiring in `server.ts` (~L472–479 for `PostActivationRetryService`) is copied verbatim for the resume service.

## Test surface

New file: `packages/orchestrator/src/__tests__/boot-resume-service.test.ts`. Mirrors `post-activation-retry.test.ts` structure:

- **`checkPostActivationState` mirror**: no equivalent — the resume service does not own state-check, the caller does. Test suite skips this describe block.
- **`triggerBootResume — happy path`**: probe returns `true`, both POSTs succeed. Assert both HTTP requests made, no `cluster.bootstrap` events emitted.
- **`triggerBootResume — tunnel POST 5xx`**: probe returns `true`, tunnel POST returns 500, code-server POST returns 200. Assert code-server POST *was* made, and exactly one `cluster.bootstrap { service: 'vscode-tunnel' }` event emitted.
- **`triggerBootResume — code-server POST 5xx`**: symmetric to above.
- **`triggerBootResume — both POSTs 5xx`**: two independent events with distinct `service` values.
- **`triggerBootResume — socket-not-ready`**: probe returns `false` after 15 attempts. Assert NO POSTs made, and two `cluster.bootstrap` events emitted (one per service) with the socket-unreachable error.
- **`triggerBootResume — single-shot (no retry)`**: on tunnel 5xx, assert the number of tunnel HTTP requests seen === 1. Regression guard for Q4→A.
- **`triggerBootResume — nullable sendRelayEvent`**: instantiate without callback, both POSTs 5xx. Assert no throw.

Test scaffolding (`net.createServer` on a tmp unix socket, request-counter mock) is copy-paste-with-tweaks from `post-activation-retry.test.ts`. No new test fixtures needed.
