# Data Model: Wire boot-resume into the wizard startup path (#834)

**Feature**: `834-summary-824-fix-auto` | **Date**: 2026-07-07

This feature introduces no persisted types, no wire-schema changes, and no new database entities. It adds one runtime function (a shared dispatcher), a small discriminated-union return type, and rewires two call sites in `server.ts`. Sections below document each.

## Types introduced

### `DispatchOptions` — `packages/orchestrator/src/services/post-activation-dispatch.ts` (NEW)

```ts
import type { FastifyBaseLogger } from 'fastify';
import type { PostActivationRetryService } from './post-activation-retry.js';
import type { BootResumeService } from './boot-resume-service.js';

/**
 * Input to runPostActivationBranch. Prod callers pass only the first two fields.
 * The two factory options are test-only seams used by the helper unit test to
 * inject fake services without touching filesystem or network. Factories default
 * to constructing the real services against process defaults.
 */
export interface DispatchOptions {
  /** Bound to server.log by both callers. */
  logger: FastifyBaseLogger;

  /**
   * Nullable relay event emitter. Both callers wire this identically:
   *   - env-key branch: derived from relayClientRef
   *   - wizard branch: derived from localRelayClient
   * The helper does not know or care which underlying variable produced it.
   */
  sendRelayEvent?: (channel: string, payload: unknown) => void;

  /**
   * TEST-ONLY. Constructs a PostActivationRetryService for state check + retry
   * dispatch. Prod calls omit this; helper defaults to `new PostActivationRetryService(...)`.
   */
  retryServiceFactory?: (deps: {
    logger: FastifyBaseLogger;
    sendRelayEvent?: (channel: string, payload: unknown) => void;
  }) => PostActivationRetryService;

  /**
   * TEST-ONLY. Constructs a BootResumeService for resume dispatch. Prod calls
   * omit this; helper defaults to `new BootResumeService(...)`.
   */
  resumeServiceFactory?: (deps: {
    logger: FastifyBaseLogger;
    sendRelayEvent?: (channel: string, payload: unknown) => void;
  }) => BootResumeService;
}
```

### `DispatchOutcome` — `packages/orchestrator/src/services/post-activation-dispatch.ts` (NEW)

```ts
/**
 * Discriminated-union return of runPostActivationBranch. Prod code discards
 * this; tests and observability may inspect it.
 *
 *   'retry'  — needsRetry === true; triggerPostActivationRetry was dispatched.
 *   'resume' — activated && postActivationComplete; triggerBootResume was dispatched.
 *   'noop'   — !activated (first boot pre-activation) or an unreachable state.
 *              Neither service was dispatched.
 */
export type DispatchOutcome = 'retry' | 'resume' | 'noop';
```

### `runPostActivationBranch` — `packages/orchestrator/src/services/post-activation-dispatch.ts` (NEW)

```ts
/**
 * Single entry point for both startup branches' post-activation decision.
 *
 * Returns after *dispatching* the appropriate service (fire-and-forget), NOT
 * after the service completes. `triggerPostActivationRetry()` and
 * `triggerBootResume()` remain async in-flight; failures are logged via the
 * caller's logger, matching today's `.catch(logger)` shape.
 *
 * Decision matrix (mirrors the env-key branch that #824 wired correctly):
 *   1. state.needsRetry === true              → dispatch retry;  return 'retry'
 *   2. state.activated && postActivationComplete → dispatch resume; return 'resume'
 *   3. otherwise (!state.activated)           → return 'noop'
 */
export async function runPostActivationBranch(opts: DispatchOptions): Promise<DispatchOutcome>;
```

## Types NOT introduced

- No new persisted-state schemas — `PostActivationRetryService.checkPostActivationState()` continues to read the same files it always has (`/var/lib/generacy/cluster-api-key`, `/var/lib/generacy/post-activation-complete`), producing the same `PostActivationState` shape.
- No new relay-event payloads — retry emits its existing `cluster.bootstrap { status: 'retrying' | 'failed', reason: 'post-activation-incomplete' | ... }`, resume emits its existing `cluster.bootstrap { status: 'failed', reason: 'resume-failed', service, error }` (added by #824). The dispatcher does not emit anything on its own.
- No new HTTP surfaces, no new lifecycle actions, no new sockets.

## Call graph — before

### Env-key branch (`server.ts:447-504`, present since #824)

```text
createServer(config, options)
  ├─ initializeRelayBridge(...)
  ├─ detectIdentitySplit(...)
  └─ const retryService = new PostActivationRetryService({ logger, sendRelayEvent(relayClientRef) })
     const postActivationState = retryService.checkPostActivationState()
     if (postActivationState.needsRetry) {
       retryService.triggerPostActivationRetry().catch(logger.error)   // fires
     } else if (postActivationState.activated && postActivationState.postActivationComplete) {
       const resumeService = new BootResumeService({ logger, sendRelayEvent(relayClientRef) })
       resumeService.triggerBootResume().catch(logger.error)            // fires  ← the #824 fix
     }
     // else: noop
```

### Wizard branch (`server.ts:433-446` → `activateInBackground()` at `:799-897`, BROKEN)

```text
createServer(config, options)
  └─ activateInBackground(config, server, apiKeyStore, onInitialized, setRelayClient)
       ├─ activate(...)
       ├─ initializeRelayBridge(...)  (assigns localRelayClient)
       ├─ initializeConversationManager(...)
       ├─ relayBridge.start()
       ├─ detectIdentitySplit(...)
       └─ const retryService = new PostActivationRetryService({ logger, sendRelayEvent(localRelayClient) })
          const postActivationState = retryService.checkPostActivationState()
          if (postActivationState.needsRetry) {
            retryService.triggerPostActivationRetry().catch(logger.error)   // fires
          }
          //  ← NO else if. On activated && postActivationComplete: silent no-op.
          //     This is the wiring bug that #834 exists to fix.
```

## Call graph — after

### Env-key branch (`server.ts:447-504`)

```text
createServer(config, options)
  ├─ initializeRelayBridge(...)
  ├─ detectIdentitySplit(...)
  └─ await runPostActivationBranch({
       logger: server.log,
       sendRelayEvent: relayClientRef ? (channel, payload) => relayClientRef!.send({...}) : undefined,
     })
```

### Wizard branch (`activateInBackground()` at `:799-897`)

```text
activateInBackground(config, server, apiKeyStore, onInitialized, setRelayClient)
  ├─ activate(...)
  ├─ initializeRelayBridge(...)  (assigns localRelayClient)
  ├─ initializeConversationManager(...)
  ├─ relayBridge.start()
  ├─ detectIdentitySplit(...)
  └─ await runPostActivationBranch({
       logger: server.log,
       sendRelayEvent: localRelayClient ? (channel, payload) => localRelayClient!.send({...}) : undefined,
     })
```

### `runPostActivationBranch()` — internal flow

```text
runPostActivationBranch(opts)
  ├─ const retryService = (opts.retryServiceFactory ?? defaultRetryFactory)({
  │      logger: opts.logger,
  │      sendRelayEvent: opts.sendRelayEvent,
  │    })
  ├─ const state = retryService.checkPostActivationState()
  ├─ if (state.needsRetry) {
  │      opts.logger.info('Post-activation incomplete on restart — triggering retry')
  │      retryService.triggerPostActivationRetry().catch(err =>
  │        opts.logger.error({ err }, 'Post-activation retry failed'))
  │      return 'retry'
  │    }
  ├─ if (state.activated && state.postActivationComplete) {
  │      const resumeService = (opts.resumeServiceFactory ?? defaultResumeFactory)({
  │        logger: opts.logger,
  │        sendRelayEvent: opts.sendRelayEvent,
  │      })
  │      resumeService.triggerBootResume().catch(err =>
  │        opts.logger.error({ err }, 'Boot resume failed'))
  │      return 'resume'
  │    }
  └─ return 'noop'
```

`defaultRetryFactory`:
```ts
({ logger, sendRelayEvent }) => new PostActivationRetryService({ logger, sendRelayEvent })
```

`defaultResumeFactory`:
```ts
({ logger, sendRelayEvent }) => new BootResumeService({ logger, sendRelayEvent })
```

Both defaults delegate to the services' existing option defaults (`DEFAULT_SOCKET`, `DEFAULT_WAIT_TIMEOUT`, `DEFAULT_COMPLETION_FLAG`, etc.). Prod code never overrides.

### `PostActivationRetryService` — unchanged

`checkPostActivationState()`, `triggerPostActivationRetry()`, `handleRetryFailure()`, `sendLifecycleAction()` — all unchanged, no signature changes, no behavior changes.

### `BootResumeService` — unchanged

`triggerBootResume()`, `waitForControlPlane()`, `sendLifecycleAction()`, `handleResumeFailure()` — all unchanged, no signature changes, no behavior changes.

## Validation / invariants

- **Every restart with `activated && postActivationComplete` dispatches `triggerBootResume()`, regardless of startup branch.** (SC-002 correctness.) Enforced by the fact that both branches call the same helper, and the helper has one and only one place where the resume decision lives.
- **Restart with `needsRetry === true` still dispatches `triggerPostActivationRetry()`, regardless of startup branch.** (Sibling behavior, preserved from before this feature.) The wizard branch already had this; the env-key branch already had this; the helper preserves both.
- **Restart with `!activated` dispatches nothing.** First-boot pre-activation state; there is nothing to resume. Preserved from before.
- **The helper does not await service completion.** `.catch(logger)` fire-and-forget, exactly as before. `runPostActivationBranch()`'s own returned Promise resolves as soon as dispatch has happened. Server-startup blocking semantics are unchanged.
- **Both branches are guarded by identical predicates inside the helper.** There is no per-branch skew possible — every branch calls the same function, which owns the entire decision.
- **`sendRelayEvent` is nullable on both call sites.** Undefined-relay-client callers propagate `undefined` into the services (matching today's tolerance pattern in `PostActivationRetryService` and `BootResumeService`).
- **The retry / resume dispatches are mutually exclusive.** `needsRetry === true` iff `activated && !postActivationComplete`, so the two `if` conditions in the helper never both match. This is a property of `checkPostActivationState()`, not the helper — the helper just preserves it.

## Test surface

### `packages/orchestrator/src/__tests__/server-boot-resume-wizard-branch.test.ts` (NEW — load-bearing per Q3→A)

Mirrors `server-background-activation.test.ts` mock scaffolding:

- `vi.mock('../activation/index.js', () => ({ activate: vi.fn() }))`
- `vi.mock('@generacy-ai/cluster-relay', () => ({ ClusterRelayClient: vi.fn(...) }))`
- `vi.mock('@generacy-ai/control-plane', () => ({ TunnelHandler: vi.fn(...), getCodeServerManager: vi.fn().mockReturnValue(null) }))`
- `vi.mock('../services/boot-resume-service.js', ...)` — spy on the constructor and mock `triggerBootResume` to resolve immediately.
- `vi.mock('../services/post-activation-retry.js', ...)` — mock `checkPostActivationState()` to return `{ activated: true, postActivationComplete: true, needsRetry: false }`; `triggerPostActivationRetry` stubbed to resolve immediately (should not be called in this test).

Test cases:
- **`triggerBootResume fires on wizard branch when state is activated + complete`**: `activateMock.mockResolvedValue({...})`; drive `createServer()` + `server.listen()`; wait for activation to resolve; assert `BootResumeService.prototype.triggerBootResume` was called exactly once; assert `PostActivationRetryService.prototype.triggerPostActivationRetry` was NOT called.
- **`triggerBootResume does NOT fire when state is needsRetry`**: swap `checkPostActivationState()` mock to `{ activated: true, postActivationComplete: false, needsRetry: true }`; assert `triggerPostActivationRetry` was called and `triggerBootResume` was NOT.
- **`triggerBootResume does NOT fire on first-boot (!activated)`**: swap mock to `{ activated: false, postActivationComplete: false, needsRetry: false }`; assert neither fires.
- **SC-003 regression guard (comment-only or executed)**: comment in the test file explains that removing the resume dispatch from the helper (or from the wizard branch's call site) must make case 1 fail. This is the whole point of the load-bearing test.

### `packages/orchestrator/src/__tests__/post-activation-dispatch.test.ts` (NEW — optional Q3→C complement)

Pure-unit test on the helper. No mocks of module imports needed — the test constructs fake services and passes them via `retryServiceFactory` / `resumeServiceFactory`.

Test cases:
- **`retry outcome`**: `checkPostActivationState()` returns `needsRetry: true` → outcome === 'retry'; `triggerPostActivationRetry` called; `triggerBootResume` not called.
- **`resume outcome`**: state returns `activated: true, postActivationComplete: true, needsRetry: false` → outcome === 'resume'; `triggerBootResume` called; `triggerPostActivationRetry` not called.
- **`noop outcome (!activated)`**: state returns `activated: false` → outcome === 'noop'; neither service dispatched.
- **`retry rejection is caught + logged`**: `triggerPostActivationRetry` rejects; helper's Promise still resolves to `'retry'`; `logger.error` was called with the rejection.
- **`resume rejection is caught + logged`**: symmetric to above.
- **`nullable sendRelayEvent`**: `opts.sendRelayEvent === undefined`; helper still dispatches; no throw.

No filesystem, no network, no sockets. Runs in the low-millisecond range.

## Backward compatibility / migration

- **No cloud-side changes.** Emitted events are identical to today's; only the *set of scenarios in which each is emitted* changes (wizard-branch restarts now emit `cluster.bootstrap { resume-failed }` on failure and per-service success signals on success, matching env-key restarts).
- **No new env vars, no new config keys.**
- **No filesystem changes.**
- **No CLI changes.**
- **Package-internal export change**: `packages/orchestrator/src/services/post-activation-dispatch.ts` is new. No other packages import from it (orchestrator-internal only). `PostActivationRetryService` and `BootResumeService` remain exported unchanged.
