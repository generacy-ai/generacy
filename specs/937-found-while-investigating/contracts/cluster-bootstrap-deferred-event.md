# Contract: `cluster.bootstrap` deferred event (FR-002)

## Channel
`cluster.bootstrap` (existing, routed IPC control-plane → orchestrator per #594/#598/#600).

## Payload shape (orchestrator-side, from `PostActivationRetryService`)

```json
{
  "status": "deferred",
  "reason": "github-token-not-sealed"
}
```

## Payload shape (control-plane-side, from `handlePostLifecycle` `bootstrap-complete` branch, FR-006)

```json
{
  "status": "awaiting-credentials",
  "reason": "github-token-not-sealed"
}
```

## Fields

| Field | Type | Values |
|-------|------|--------|
| `status` | string | `deferred` (orchestrator) OR `awaiting-credentials` (control-plane, matching the pre-existing `prepare-workspace` shape) |
| `reason` | string | `github-token-not-sealed` (shared across both emit sites) |

## Why two `status` values but one `reason`

- `reason` — operator-facing "what is missing?" answer. Unified so the cloud dashboard renders the same message regardless of which gate fired.
- `status` — machine-facing "which gate?" answer. Distinct so:
  - Debugging: operators can tell "the retry service saw stale state and deferred" from "the wizard called `prepare-workspace` before completing credential entry".
  - Observability: cloud can count each defer path independently without regex on log lines.

## Cardinality

- Per activation-cycle boot: at most one `deferred` event from the orchestrator retry service (one-shot).
- Per `bootstrap-complete` call: at most one `awaiting-credentials` event from the control-plane (emitted on the token-absent branch).

## Consumers

- Cloud dashboard reads `cluster.bootstrap` channel and displays status updates on the cluster overview. Both event shapes render as opaque strings today — specialized UI treatment is out of scope for this issue.

## Non-goals

- No new channel.
- No schema change to the channel's message envelope (still whatever `sendRelayEvent`/`getRelayPushEvent` emit today).
- No cardinality dedupe key — the caller pattern (one-shot at boot for orchestrator, one call per lifecycle POST for control-plane) makes dedupe unnecessary.
