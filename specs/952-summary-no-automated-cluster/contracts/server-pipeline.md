# Contract: `startSmeePipeline(url)` helper + server-side wiring

**File**: `packages/orchestrator/src/server.ts` (closure, not exported)
**Consumer**: two call sites inside `createServer()`, both within the `!isWorkerMode && config.labelMonitor && config.repositories.length > 0` gate.
**Feature**: #952

## Purpose

Factor out the previously-inline block that constructs `SmeeWebhookReceiver` and calls `WebhookSetupService.ensureWebhooks()` so both the pre-existing env/yaml URL path AND the new auto-provisioned URL path can use the same wiring.

## Signature

```ts
const startSmeePipeline = (channelUrl: string): void => {
  // 1. Build watchedRepos set from config.repositories.
  // 2. Construct SmeeWebhookReceiver and assign to the enclosing `smeeReceiver`
  //    variable so the graceful-shutdown block can stop it.
  // 3. Log info { channelUrl } — "Smee webhook receiver configured".
  // 4. Fire-and-forget receiver.start().catch(logError).
  // 5. If config.webhookSetup.enabled:
  //    Construct WebhookSetupService.
  //    Fire-and-forget ensureWebhooks(channelUrl, config.repositories).catch(logError).
};
```

Defined once inside `createServer()`. Not exported. Captures `labelMonitorService`, `config`, `server.log`, `githubTokenProvider`, `clusterGithubUsername` from enclosing scope.

## Invariants

1. **Gate**: MUST only be called from a code path that passed the `!isWorkerMode && config.labelMonitor && config.repositories.length > 0` predicate. `labelMonitorService` is non-null at this point (Fastify TypeScript type system enforces this via the `!` non-null assertion; runtime safety enforced by the surrounding block).
2. **Idempotent-ish**: If called twice with the same URL (theoretical bug), you'd get two `SmeeWebhookReceiver`s + two `ensureWebhooks` calls. The variable assignment (`smeeReceiver = receiver`) means only the last one is tracked by graceful shutdown; the first is leaked. In practice, the resolver ensures at most one call: env/yaml path is synchronous (called at construction), resolver path is `else`-branch (only fires when env/yaml is empty).
3. **Fire-and-forget**: `receiver.start()` and `ensureWebhooks(...)` both return promises; both are `.catch()`ed but never `await`ed. The helper itself is synchronous (returns `void`).

## Call sites

### Site A — synchronous (env/yaml URL path)

Inside the existing gate at `server.ts:464`:

```ts
if (config.smee.channelUrl) {
  startSmeePipeline(config.smee.channelUrl);
}
```

- Called at construction time, before `server.listen()`.
- `smeeReceiver` is non-null after this call.
- Preserves today's ordering exactly — the receiver is constructed before the `onReady` hook runs, same as before this feature.

### Site B — asynchronous (resolver path)

Inside a new `server.addHook('onReady', ...)` block, gated on `config.smee.channelUrl` being absent AND on the same predicate as the outer gate:

```ts
if (!config.smee.channelUrl) {
  server.addHook('onReady', async () => {
    if (isWorkerMode || !config.labelMonitor || config.repositories.length === 0) return;
    const resolver = new SmeeChannelResolver(server.log, {
      channelFilePath: config.smee.channelFilePath,
    });
    resolver.resolve()
      .then((result) => {
        if (result) {
          server.log.info({ channelUrl: result.channelUrl, source: result.source },
            'Resolved smee channel URL — starting pipeline');
          startSmeePipeline(result.channelUrl);
        } else {
          server.log.warn('No smee channel URL available — cluster is webhook-less, falling back to polling');
        }
      })
      .catch((error) => {
        server.log.error({ err: error }, 'Unexpected error resolving smee channel URL');
      });
  });
}
```

- Called from `onReady` — after Fastify plugin registration is complete, before `listen()` starts accepting connections. But the `.then(...)` callback runs on its own tick, after `listen()` has returned.
- The predicate is duplicated inline here (belt-and-braces) so that any future refactor to move this outside the outer gate doesn't accidentally invoke the resolver on worker-mode boot.
- `startSmeePipeline` is called from the `.then()` callback — so `smeeReceiver` may not exist yet when other `onReady` handlers run. Existing `onReady` code at `server.ts:814-818` (`if (smeeReceiver) { smeeReceiver.start().catch(...); }`) is now dead in the async path (because `startSmeePipeline` calls `receiver.start()` itself) but still fires in the sync path. Either the sync path's separate `receiver.start()` call in the `onReady` block is removed OR the `startSmeePipeline` call in the sync-path doesn't start the receiver directly. **Chosen resolution**: `startSmeePipeline` always calls `receiver.start()`; the block at `server.ts:814-818` is deleted. Both call sites now converge on the same pipeline invocation.

### Graceful shutdown block (unchanged)

`server.ts:866-868` — `if (smeeReceiver) { smeeReceiver.stop(); }` — still fires as today. If the resolver's `.then()` never assigned `smeeReceiver` (resolver returned null, or shutdown fired before resolver finished), the block is a no-op.

## Non-invariants (edge cases documented)

- **Shutdown during in-flight resolve**: if `docker compose down` fires while `resolver.resolve()` is mid-HTTP-request, the shutdown proceeds without waiting for the resolver. The resolver's `AbortSignal.timeout(5000)` still fires at the 5s mark; the fetch either aborts or completes. If it completes and calls `startSmeePipeline`, the receiver is constructed post-shutdown and immediately leaked (no code to stop it). This is a rare corner case — the shutdown path already tolerates async plugins finishing after `close()`; adding explicit resolver-abort integration is out of scope.
- **Resolver .then() throws**: `startSmeePipeline` is synchronous but constructs a `SmeeWebhookReceiver` which might throw (defensive constructor, or an OOM). The outer `.catch()` on the `.then()` chain catches it — logged as `Unexpected error resolving smee channel URL`. No crash.

## Test contract (integration)

Test file: `packages/orchestrator/src/__tests__/server-smee-provisioning.test.ts`. Must cover:

- **I1** (sync path unchanged): `config.smee.channelUrl` set → after `createServer()`, `smeeReceiver` is non-null before `onReady` fires. The resolver is NOT constructed (asserted by making `SmeeChannelResolver` throw and confirming no error is logged).
- **I2** (async path succeeds): `config.smee.channelUrl` unset, stub `fetch` returns 302 with valid Location → after `server.listen()` returns AND the resolver's `.then()` fires, `smeeReceiver` is non-null and `ensureWebhooks` was called with the provisioned URL. File at `channelFilePath` contains the URL with mode 0600.
- **I3** (worker-mode skip): `createServer({ config: workerModeConfig })` → resolver is never invoked (assert on injected `SmeeChannelResolver` sentinel).
- **I4** (wizard-mode skip): `config.repositories = []` → resolver is never invoked.
- **I5** (fire-and-forget invariant): stub `fetch` returns a promise that never resolves. `server.listen()` MUST return within 100ms. `smeeReceiver` remains null indefinitely. No test hang.
- **I6** (persisted-file reuse across simulated restarts): first `createServer()` provisions and writes the file. Second `createServer()` (fresh instance, same `channelFilePath`, no preset) → tier 2 hits, no `fetch` call, `smeeReceiver` constructed from the file's URL.

## Migration / rollback

- Deploying this feature: the sync-path behavior is byte-for-byte identical to today. The async-path adds new behavior only for clusters that previously had empty `config.smee.channelUrl`.
- Rolling back: reverting `server.ts` restores the inline block at lines 486-497 + 814-829. `startSmeePipeline` disappears. Sync-path clusters continue working. Async-path clusters revert to webhook-less. Persisted files become inert orphans (see `smee-channel-file.md` §Rollback).
