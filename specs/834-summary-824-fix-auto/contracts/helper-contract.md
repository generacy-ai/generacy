# Contract: `runPostActivationBranch` — shared post-activation dispatcher

**Feature**: `834-summary-824-fix-auto` | **Date**: 2026-07-07

Sole exported contract of the new `packages/orchestrator/src/services/post-activation-dispatch.ts` module. Consumed by both startup branches in `packages/orchestrator/src/server.ts`. No cross-package consumers.

## Module

```
packages/orchestrator/src/services/post-activation-dispatch.ts
```

## Exports

```ts
export type DispatchOutcome;
export interface DispatchOptions;
export function runPostActivationBranch(opts: DispatchOptions): Promise<DispatchOutcome>;
```

Internal (not exported): `defaultRetryFactory`, `defaultResumeFactory`.

## Signature

```ts
import type { FastifyBaseLogger } from 'fastify';
import type { PostActivationRetryService } from './post-activation-retry.js';
import type { BootResumeService } from './boot-resume-service.js';

export type DispatchOutcome = 'retry' | 'resume' | 'noop';

export interface DispatchOptions {
  logger: FastifyBaseLogger;
  sendRelayEvent?: (channel: string, payload: unknown) => void;

  // Test-only injection seams. Prod calls omit these.
  retryServiceFactory?: (deps: {
    logger: FastifyBaseLogger;
    sendRelayEvent?: (channel: string, payload: unknown) => void;
  }) => PostActivationRetryService;
  resumeServiceFactory?: (deps: {
    logger: FastifyBaseLogger;
    sendRelayEvent?: (channel: string, payload: unknown) => void;
  }) => BootResumeService;
}

export function runPostActivationBranch(opts: DispatchOptions): Promise<DispatchOutcome>;
```

## Behavior contract

### Preconditions

1. `opts.logger` is a Fastify logger (or a duck-typed equivalent with `.info` / `.error`) — MUST NOT be null/undefined.
2. `opts.sendRelayEvent` is either a function of shape `(channel: string, payload: unknown) => void` or undefined. If undefined, downstream services silently drop relay emits (matches existing tolerance).
3. Filesystem state at `/var/lib/generacy/cluster-api-key` and `/var/lib/generacy/post-activation-complete` reflects the current cluster's activation + post-activation status (or is stubbed by the injected `retryServiceFactory` in tests).
4. If `opts.sendRelayEvent` is defined, the underlying relay client has been initialized. (In `server.ts` this is guaranteed by calling the helper only after `initializeRelayBridge()` has returned.)

### Postconditions

The helper returns a `DispatchOutcome`:

| `DispatchOutcome` | Meaning | Side effect |
|-------------------|---------|-------------|
| `'retry'` | `checkPostActivationState()` returned `{ needsRetry: true, ... }` | `triggerPostActivationRetry()` was dispatched (fire-and-forget). Failures logged via `opts.logger.error`. |
| `'resume'` | `checkPostActivationState()` returned `{ activated: true, postActivationComplete: true, needsRetry: false }` | `triggerBootResume()` was dispatched (fire-and-forget). Failures logged via `opts.logger.error`. |
| `'noop'` | `checkPostActivationState()` returned `{ activated: false, ... }` (or any state not matching the two above) | No service dispatched. No log lines emitted. |

The returned Promise resolves as soon as dispatch has happened. It does NOT await the in-flight service Promises. On the retry / resume paths, the underlying service Promise runs concurrently with the helper's caller — behavior identical to today's inline `.catch(logger)` shape in `server.ts`.

### Invariants (load-bearing)

1. **Single source of truth for the decision.** `runPostActivationBranch` is the ONLY place in the codebase where the retry-vs-resume-vs-noop dispatch decision lives. Both `server.ts` call sites collapse to a single invocation; no branch-local `if/else` remains for a future contributor to skew.
2. **Fire-and-forget preservation.** The helper MUST NOT `await` `triggerPostActivationRetry()` or `triggerBootResume()`. The service Promise MUST be swallowed by a `.catch(err => opts.logger.error({ err }, ...))` handler inside the helper, exactly matching today's inline shape.
3. **Mutual exclusion of retry and resume.** Because `PostActivationState.needsRetry === (activated && !postActivationComplete)`, the two `if` conditions inside the helper are exclusive by construction. The helper MUST NOT dispatch both.
4. **Signature-parity between call sites.** Both `server.ts` branches MUST invoke the helper with identical `DispatchOptions` shape (`logger` + `sendRelayEvent` only). The two branches differ in the *source* of `sendRelayEvent` (`relayClientRef` in env-key branch, `localRelayClient` in wizard branch) but the *shape passed to the helper* is identical.
5. **No implicit factory paths in prod.** Prod code MUST NOT set `retryServiceFactory` or `resumeServiceFactory`. Both call sites in `server.ts` omit these fields; defaults construct the real services against default socket paths and flag paths.

### Error handling

- **`checkPostActivationState()` throws**: `PostActivationRetryService.checkPostActivationState()` is currently non-throwing (uses `existsSync`). If a future change makes it throw, the helper MUST let the exception propagate to the caller. The two `server.ts` call sites already `.catch()` at the boundary (the wizard branch has `activateInBackground(...).catch(warn)`; the env-key branch is inside `createServer()`'s awaited flow), so a throwing state check will surface as a warning log rather than a boot failure. **Do NOT add a `try/catch` in the helper around `checkPostActivationState()`** — that would mask a real bug.
- **`triggerPostActivationRetry()` rejects**: caught inside the helper by `.catch(err => opts.logger.error(...))`. Helper's return value is still `'retry'`.
- **`triggerBootResume()` rejects**: caught inside the helper by `.catch(err => opts.logger.error(...))`. Helper's return value is still `'resume'`.
- **`opts.logger` throws inside `.error()`**: not handled. Would indicate a broken Fastify logger, out of scope.

## Test contract

### Test injection seam

The `retryServiceFactory` and `resumeServiceFactory` fields exist so unit tests can pass fake services without stubbing `existsSync` or `http.request`. They MUST be optional; when undefined, the helper MUST construct the real services via:

```ts
const defaultRetryFactory = (deps) => new PostActivationRetryService(deps);
const defaultResumeFactory = (deps) => new BootResumeService(deps);
```

The factory-injected services MUST implement the same duck-typed subsets used by the helper:

- Retry service: `checkPostActivationState(): PostActivationState`, `triggerPostActivationRetry(): Promise<void>`.
- Resume service: `triggerBootResume(): Promise<void>`.

### Required test coverage (per FR-005 + SC-003)

**Load-bearing integration test** (`server-boot-resume-wizard-branch.test.ts`, per Q3→A):

- Drive `createServer()` with `config.relay.apiKey = undefined` so `activateInBackground()` runs.
- Stub the environment so `checkPostActivationState()` returns `{ activated: true, postActivationComplete: true, needsRetry: false }`.
- Assert that after `activate()` resolves, `BootResumeService.prototype.triggerBootResume` was called exactly once.
- **SC-003 falsifiability**: deleting the resume dispatch inside `runPostActivationBranch` (or from the wizard-branch call site) MUST make this test fail.

**Optional unit test** (`post-activation-dispatch.test.ts`, per Q3→C complement):

- Direct import + call. No `createServer`, no Fastify, no filesystem, no sockets.
- Cases: `'retry'`, `'resume'`, `'noop'`, rejection paths, nullable `sendRelayEvent`.

## Non-goals

- The helper does NOT own the relay-bridge lifecycle. Both branches MUST have called `initializeRelayBridge()` before invoking the helper. The helper is a decision dispatcher, not a boot orchestrator.
- The helper does NOT emit relay events on its own. Emission remains inside `PostActivationRetryService` / `BootResumeService`. `sendRelayEvent` is passed *through* the helper unchanged.
- The helper does NOT retry, back off, or retry-in-loop. `triggerPostActivationRetry` and `triggerBootResume` remain single-shot per their existing contracts.
- The helper does NOT persist state or read config beyond what its child services already do.
- The helper does NOT expose an outcome-based control-flow API to `server.ts` beyond the `DispatchOutcome` return (which is discarded in prod).

## Non-breaking changes forbidden by this contract

- Renaming `runPostActivationBranch` (would require the two `server.ts` call sites to update in lockstep — trivial but adds churn).
- Making the helper `await` the service Promise (would break fire-and-forget invariant #2 and cause `createServer()` to block on a 15-second control-plane socket probe).
- Adding a *second* location in the codebase that duplicates the retry/resume decision (would recreate exactly the #824 regression this feature exists to fix).
- Making `retryServiceFactory` / `resumeServiceFactory` required in `DispatchOptions` (would force both prod call sites to hand-wire the same defaults, defeating the purpose of the seam).
