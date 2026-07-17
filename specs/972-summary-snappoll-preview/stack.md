# Stack — #972

## Technology / dependency additions

**None.** Every primitive the fix needs already exists in `packages/orchestrator/`:

| Need | Existing artifact | Path |
|------|-------------------|------|
| Emit `cluster.bootstrap` relay events | `sendRelayEvent(channel, payload)` callback pattern | `packages/orchestrator/src/services/post-activation-retry.ts:21` |
| Wire `sendRelayEvent` into a service | `relayClientRef` closure in `createServer()` | `packages/orchestrator/src/server.ts:723-727` |
| Transition cluster status to `degraded` | `StatusReporter.pushStatus('degraded', reason)` | `packages/orchestrator/src/services/status-reporter.ts` |
| Read the currently-persisted smee channel URL | `SmeeChannelResolver`'s file (`/var/lib/generacy/smee-channel`) | `packages/orchestrator/src/services/smee-channel-resolver.ts:105-131` |
| GitHub API calls | `executeCommand('gh', args, { env })` with `githubTokenProvider` | `packages/orchestrator/src/services/webhook-setup-service.ts` (existing usage) |
| `.agency/credentials.yaml` read for installation id | `yaml` (already a transitive dep of control-plane); or one-shot `readFile` + minimal parse | `packages/control-plane/src/services/wizard-env-writer.ts` (example consumer) |

No new `dependencies` / `devDependencies` in `packages/orchestrator/package.json`.

## Integration points touched

- `packages/orchestrator/src/services/webhook-setup-service.ts` — constructor gains three optional args (`sendRelayEvent`, `statusReporter`, `channelFilePath`); `_ensureWebhookForRepo` gains a 403-detection branch that emits log + relay event + status; `_createRepoWebhook` locks event set to four events; `_findMatchingWebhook` becomes `_selectExistingHookForUpdate` with three-branch decision.
- `packages/orchestrator/src/server.ts` (line 508 area) — `new WebhookSetupService(...)` call site gains the three new constructor args, sourced from the same `relayClientRef` closure that feeds `PostActivationRetryService` and `BootResumeService`.
- `.changeset/972-webhook-registration-fail-loud.md` (new) — `patch` bump for `@generacy-ai/orchestrator`.

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
