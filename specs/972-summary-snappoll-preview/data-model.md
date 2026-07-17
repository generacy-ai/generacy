# Data Model — #972 Snappoll Webhook-Registration 403 Fail-Loud

Scope: type definitions, payload shapes, and validation rules for the three new observable outputs of the fix. No new persistent storage — the only file read is the existing smee channel file at `config.smee.channelFilePath`.

## Entities

### 1. WebhookRegistrationForbiddenEvent

Emitted on the `cluster.bootstrap` relay channel when `WebhookSetupService.ensureWebhooks()` encounters an HTTP 403 (`Resource not accessible by integration`) from any of: list-repo-hooks, create-repo-hook, update-repo-hook.

```typescript
interface WebhookRegistrationForbiddenEvent {
  /** Discriminant: locked to 'failed' for this event. */
  status: 'failed';

  /** Discriminant: locked to 'webhook-registration-forbidden' for this event. */
  reason: 'webhook-registration-forbidden';

  /**
   * The repository the 403 was for, in `owner/name` form.
   * Non-empty; both segments must match GitHub's owner/repo naming rules.
   */
  repo: string;

  /**
   * The GitHub App installation id that owns the token used when the 403
   * was returned, or `null` if it could not be resolved at emit time.
   * Diagnostic only — the actionable fields are `reason` and `missingScope`.
   */
  installationId: number | null;

  /**
   * The GitHub App scope that is missing and must be granted (App-manifest
   * edit → operator re-consent). Locked to 'admin:repo_hook' for this event.
   */
  missingScope: 'admin:repo_hook';
}
```

**Validation:**
- `status` MUST equal `'failed'` (Zod: `z.literal('failed')`).
- `reason` MUST equal `'webhook-registration-forbidden'` (Zod: `z.literal(...)`).
- `repo` MUST match `/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/` (GitHub's owner/repo character set); non-empty.
- `installationId` MUST be a positive integer OR `null` (Zod: `z.number().int().positive().nullable()`).
- `missingScope` MUST equal `'admin:repo_hook'` (Zod: `z.literal(...)`).
- Emitted at most once per `(repo, orchestrator boot)` — do not re-fire on subsequent retries within the same boot; do fire again on the next boot if the 403 recurs.

**Wire wrapping:** the event is wrapped in the standard relay `EventMessage`:
```typescript
{
  type: 'event',
  event: 'cluster.bootstrap',
  data: WebhookRegistrationForbiddenEvent,
  timestamp: '<ISO-8601>'
}
```
(This wrap is done by `ClusterRelayClient.send()`; the emitter only produces the `data` payload.)

### 2. WebhookRegistrationForbiddenLogLine

Structured Pino log entry emitted alongside the relay event on the same 403. Correlates 1:1 with the relay event.

```typescript
interface WebhookRegistrationForbiddenLogLine {
  level: 'warn';
  msg: 'Webhook registration forbidden: missing admin:repo_hook scope';
  /** Repository in owner/name form. */
  owner: string;
  repo: string;
  /** Same value as the relay event's installationId. */
  installationId: number | null;
  /** Locked to 'admin:repo_hook'. */
  missingScope: 'admin:repo_hook';
  /** Locked to 'webhook-registration-forbidden' — pairs the log with the relay event by reason. */
  reason: 'webhook-registration-forbidden';
  /** Raw stderr from the failing gh call, for operator debugging. Redacted of tokens. */
  ghStderr: string;
}
```

**Validation:** Pino does not enforce field-level types; the contract is that the seven fields above are present on every emit and no additional fields carry secret material. Warn level, not error, because the cluster continues running (polling fallback). Distinguished from the pre-fix log line (`'Insufficient permissions to manage webhooks (admin:repo_hook required)'` at `webhook-setup-service.ts:384`) — the new line adds `reason` + `installationId` and pairs with the relay event.

### 3. DegradedStatusTransition

Payload of the `POST /internal/status` call fired against the control-plane control socket when the 403 hits.

```typescript
interface DegradedStatusTransition {
  status: 'degraded';
  statusReason: 'webhook-registration-forbidden';
}
```

**Validation:**
- `status` MUST equal `'degraded'`. Never `'error'` (would halt), never `'ready'` (would be silent).
- `statusReason` MUST equal `'webhook-registration-forbidden'`. Distinct string across all cluster.bootstrap reasons the orchestrator emits — the cloud UI banner keys off this string.
- Idempotent: multiple `POST /internal/status` calls with the same payload during one boot are safe (the control-plane keeps the latest); the emitter fires it once per `(orchestrator boot)`.

## Existing Types Referenced (Unchanged)

### `ClusterStatus`
Source: `packages/orchestrator/src/services/status-reporter.ts:3`
```typescript
type ClusterStatus = 'bootstrapping' | 'ready' | 'degraded' | 'error';
```
This fix uses `'degraded'`. Adds no new variants.

### `RepositoryConfig`
Source: `packages/orchestrator/src/services/webhook-setup-service.ts:39-44`
```typescript
interface RepositoryConfig {
  owner: string;
  repo: string;
}
```
Unchanged.

### `GitHubWebhook`
Source: `packages/orchestrator/src/services/webhook-setup-service.ts:52-64`
```typescript
interface GitHubWebhook {
  id: number;
  active: boolean;
  config: { url: string };
  events: string[];
}
```
Unchanged. The `config.url` field is the key input to the FR-004 exact-URL match.

### `WebhookSetupResult` — extended `action` domain
Source: `packages/orchestrator/src/services/webhook-setup-service.ts:71-88`

The union does not gain a new variant — the 403 → `action: 'failed'` mapping is preserved. The new `error` string on `'failed'` results MUST be either the raw gh stderr trimmed OR the exact string `'webhook-registration-forbidden'` when the 403 is scope-attributable. Existing `'created' | 'skipped' | 'reactivated' | 'failed'` domain unchanged.

### Persisted channel file
Source: `packages/orchestrator/src/services/smee-channel-resolver.ts:170-181`, `packages/orchestrator/src/config/schema.ts:245`

Default path: `/var/lib/generacy/smee-channel`, mode `0600`.
Format: single line, exactly one URL matching `SMEE_URL_PATTERN = /^https:\/\/smee\.io\/[A-Za-z0-9_-]+$/`.
Written only by `SmeeChannelResolver`; **`WebhookSetupService` reads it (read-only) but never writes to it.**

## Relationships

```
WebhookSetupService.ensureWebhooks()
  ├─(read)─▶ config.smee.channelFilePath  ─▶ prior Generacy channel URL (FR-004)
  ├─(read)─▶ .agency/credentials.yaml     ─▶ installationId for github-app credential (best-effort)
  └─on 403 emits, in order:
      1. WebhookRegistrationForbiddenLogLine  (Pino warn)
      2. WebhookRegistrationForbiddenEvent    (relay 'cluster.bootstrap')
      3. DegradedStatusTransition             (POST /internal/status)

All three MUST fire for the same 403; a partial emit (e.g., relay fails
but log + status succeed) is acceptable — the log line is the audit floor.
The status transition is fire-and-forget (StatusReporter swallows errors);
the relay send is fire-and-forget (sendRelayEvent has no return); the log
is synchronous and always succeeds.
```

## Field-Level Validation Rules Summary

| Field | Rule | Enforced Where |
|-------|------|----------------|
| `WebhookRegistrationForbiddenEvent.status` | `=== 'failed'` | Emit site (literal string) |
| `WebhookRegistrationForbiddenEvent.reason` | `=== 'webhook-registration-forbidden'` | Emit site |
| `WebhookRegistrationForbiddenEvent.repo` | `/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/`, non-empty | Emit site (built from owner + '/' + repo, both validated at RepositoryConfig level) |
| `WebhookRegistrationForbiddenEvent.installationId` | positive int or null | Emit site (installationIdProvider return type) |
| `WebhookRegistrationForbiddenEvent.missingScope` | `=== 'admin:repo_hook'` | Emit site |
| `DegradedStatusTransition.status` | `=== 'degraded'` | Emit site |
| `DegradedStatusTransition.statusReason` | `=== 'webhook-registration-forbidden'` | Emit site |
| Persisted-file URL match | exact string equality, case-insensitive | New `_selectExistingHookForUpdate` |
| Current channel URL match | exact string equality, case-insensitive | Existing `_findMatchingWebhook` (unchanged) |
| Locked events on create | `['issues', 'pull_request', 'check_run', 'check_suite']` | `_createRepoWebhook` args |

No JSON Schema / OpenAPI artifact is required beyond the wire contracts in `contracts/`; the relay `EventMessage` schema lives in `packages/cluster-relay/src/messages.ts` and its `data` field is `unknown`, so cluster-side type safety is enforced at the emit call site only.
