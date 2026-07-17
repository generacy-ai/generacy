# Contract — `cluster.bootstrap` `webhook-registration-forbidden` Event

## Channel

`cluster.bootstrap` (existing; allowlisted at `packages/orchestrator/src/routes/internal-relay-events.ts:9-15`).

## Emitter

`WebhookSetupService._ensureWebhookForRepo` in `packages/orchestrator/src/services/webhook-setup-service.ts`, on any HTTP 403 (`Resource not accessible by integration`) returned from `gh api` for one of:

- `GET /repos/{owner}/{repo}/hooks` (list)
- `POST /repos/{owner}/{repo}/hooks` (create)
- `PATCH /repos/{owner}/{repo}/hooks/{hook_id}` (update)

## Trigger conditions

Fire **when all of** the following hold:
1. The `gh api` call exit code is non-zero.
2. The stderr contains `HTTP 403` or `Resource not accessible by integration` (case-insensitive substring match — both patterns fire for the same failure mode; matching either is sufficient).
3. The failing endpoint is one of the three webhook endpoints above.

Do **not** fire on 404 (repo not found — different remediation), 500 (transient — logged as `warn` without loud-failure escalation), or any non-webhook `gh` failure surfaced through the same catch branch.

## Payload (`data` field of `EventMessage`)

```json
{
  "status": "failed",
  "reason": "webhook-registration-forbidden",
  "repo": "<owner>/<name>",
  "installationId": <positive-integer-or-null>,
  "missingScope": "admin:repo_hook"
}
```

## Wire wrapping

Sent via `ClusterRelayClient.send()`:
```json
{
  "type": "event",
  "event": "cluster.bootstrap",
  "data": { ...payload above... },
  "timestamp": "<ISO-8601 UTC>"
}
```

## Emission rate

At most **one per `(repo, orchestrator boot)`**. Re-fires only on the next orchestrator boot if the 403 recurs. This bounds cloud-side banner noise for multi-repo clusters with N repos → up to N events per boot.

## Ordering vs. sibling signals

For each 403, all three of the following MUST fire, in this order (best-effort):
1. Structured Pino `warn` log line (`msg: 'Webhook registration forbidden: missing admin:repo_hook scope'`, with `owner`, `repo`, `installationId`, `missingScope`, `reason: 'webhook-registration-forbidden'`, `ghStderr`).
2. This relay event (`cluster.bootstrap`).
3. `POST /internal/status` with `{ status: 'degraded', statusReason: 'webhook-registration-forbidden' }`.

The relay event is fire-and-forget (the `sendRelayEvent` callback signature has `void` return). The status transition is fire-and-forget (`StatusReporter.pushStatus` swallows transport errors). The log line is synchronous and always succeeds. A partial emit is acceptable — the log line is the audit floor.

## Cloud-side expectations (informational — not implemented in this repo)

- Dashboard renders a persistent banner keyed on `status === 'failed' && reason === 'webhook-registration-forbidden'` with copy naming the missing scope and the remediation ("Grant the Generacy GitHub App `admin:repo_hook` and restart the cluster").
- Multiple events for different `repo` values within the same cluster collapse into one banner listing all affected repos.
- Banner clears when the cluster next reports `status: 'ready'` (post-restart heal).

## Backwards compatibility

- The `cluster.bootstrap` channel accepts arbitrary `data` shapes today. Adding this shape is additive.
- Cloud consumers that ignore unknown `reason` values continue working (no schema break).
- No new relay channel, no new IPC endpoint, no changes to `ALLOWED_CHANNELS`.
