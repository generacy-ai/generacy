# Stack — #1005

## Technology / dependency additions

**None.** Every primitive the fix needs already exists in `packages/orchestrator/`:

| Need | Existing artifact | Path |
|------|-------------------|------|
| List repo webhooks via `gh api` | `WebhookSetupService._listRepoWebhooks(owner, repo)` | `packages/orchestrator/src/services/webhook-setup-service.ts:708-751` |
| JIT `GH_TOKEN` env for `gh` subprocess | `WebhookSetupService.resolveTokenEnv()` (`githubTokenProvider` closure) | `packages/orchestrator/src/services/webhook-setup-service.ts:205-209` |
| Persisted-file write with atomic tmp+rename | `SmeeChannelResolver.writePersistedFile(url)` | `packages/orchestrator/src/services/smee-channel-resolver.ts:181-197` |
| Bounded-retry loop with injectable sleep | `SmeeChannelResolver.provision()` retry envelope | `packages/orchestrator/src/services/smee-channel-resolver.ts:143-179` |
| Retry constants (`MAX_ATTEMPTS = 2`, `RETRY_DELAY_MS = 1000`) | module-level constants in resolver | `packages/orchestrator/src/services/smee-channel-resolver.ts:31-32` |
| smee URL validator | `SMEE_URL_PATTERN` regex | `packages/orchestrator/src/services/smee-channel-resolver.ts:27` |
| PATCH webhook `config.url` | `WebhookSetupService._updateRepoWebhookConfig(...)` | `packages/orchestrator/src/services/webhook-setup-service.ts:837-864` |
| 403 fail-loud path for take-over failures | `WebhookSetupService._handleGhFailure(...)` | `packages/orchestrator/src/services/webhook-setup-service.ts:539-584` |
| DI wiring pattern for resolver-consumer construction | `startSmeePipeline` closure | `packages/orchestrator/src/server.ts:597-680` |

No new `dependencies` / `devDependencies` in `packages/orchestrator/package.json`. No new npm-registry surface at all.

## Integration points touched

- `packages/orchestrator/src/services/smee-channel-resolver.ts` — `ChannelSource` gains `'adopted'`; `SmeeChannelResolverOptions` gains `discoverExistingChannel?` + `repos?`; `resolve()` gets a new tier-3 branch between persisted and provision; new private `runAdoptTier()`.
- `packages/orchestrator/src/services/webhook-setup-service.ts` — new public `findExistingSmeeChannel(repos)` method (thin wrapper over existing `_listRepoWebhooks` per repo, with first-hit-wins + divergence log); `_selectExistingHookForUpdate` decision matrix gains a "single Generacy smee hook, stale → update-url" branch between the persisted-URL branch and the foreign branch.
- `packages/orchestrator/src/server.ts` (onReady closure at `:641-679`) — `WebhookSetupService` construction hoisted above the `SmeeChannelResolver` construction so its `findExistingSmeeChannel` can be passed as the resolver's `discoverExistingChannel` callback. The pre-constructed instance is reused by `startSmeePipeline` for `ensureWebhooks()` — no duplicate instantiation.
- `.changeset/1005-adopt-existing-smee-channel.md` (new) — `patch` bump for `@generacy-ai/orchestrator`.

## Package-boundary summary

| Package | Change type |
|---------|------------|
| `packages/orchestrator/` | src + tests + changeset |
| `packages/control-plane/` | none |
| `packages/cluster-relay/` | none |
| `packages/workflow-engine/` | none |
| `packages/generacy/` (CLI) | none |
| `packages/credhelper*` | none |
| `packages/config/` | none |
| `packages/activation-client/` | none |
