# Contract: `cluster.identity-split` Relay Event

## Channel
`cluster.identity-split`

## Direction
Cluster (orchestrator) → Cloud (relay → UI consumer)

## Emitter
Orchestrator process, in-process (calls `ClusterRelayClient.send` directly). Emitted at most once per orchestrator process lifetime.

## Trigger
At orchestrator startup, after the relay bridge has started, when:
- `process.env.GENERACY_CLUSTER_ID` is set AND
- `/var/lib/generacy/cluster.json` exists and validates against `ClusterJsonSchema` AND
- `process.env.GENERACY_CLUSTER_ID !== cluster.json.cluster_id`.

## Payload Schema (JSON Schema-style)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "IdentitySplitEvent",
  "description": "Emitted when an orchestrator detects that its env-sourced cluster id differs from the persisted cluster.json id.",
  "type": "object",
  "required": ["env_cluster_id", "cluster_json_cluster_id", "detected_at"],
  "additionalProperties": false,
  "properties": {
    "env_cluster_id": {
      "type": "string",
      "minLength": 1,
      "description": "Value of process.env.GENERACY_CLUSTER_ID at detection time."
    },
    "cluster_json_cluster_id": {
      "type": "string",
      "minLength": 1,
      "description": "Value of /var/lib/generacy/cluster.json's cluster_id field at detection time."
    },
    "detected_at": {
      "type": "string",
      "format": "date-time",
      "description": "ISO-8601 timestamp of when the detection occurred."
    }
  }
}
```

### Example
```json
{
  "env_cluster_id": "6c23c4c4-97d6-44ad-ac7a-b2302e9d7e9a",
  "cluster_json_cluster_id": "a356d8f5-cca3-4f4a-9070-4fd8084b0468",
  "detected_at": "2026-06-04T17:32:11.482Z"
}
```

## Wire envelope

Sent via the standard relay `EventMessage`:
```json
{
  "type": "event",
  "event": "cluster.identity-split",
  "data": { /* IdentitySplitEvent payload above */ },
  "timestamp": "2026-06-04T17:32:11.482Z"
}
```

## Emission contract

| Property | Value |
|----------|-------|
| **Frequency** | At most once per orchestrator process lifetime. |
| **Reliability** | Best-effort. If the relay client is disconnected at emission time, the event is dropped (no buffering). The next orchestrator restart will re-detect and re-attempt. |
| **Side effects** | NONE on local state. The detector MUST NOT write to `.env`, `cluster.json`, or mutate `process.env`. |
| **Failure handling** | If `sendRelayEvent` throws, the error is logged and swallowed. Detection does not block orchestrator startup. |

## Consumer expectations (out of scope for this issue — cloud companion)

- Cloud SHOULD surface a UI banner ("Cluster identity mismatch — destroy and re-launch") on receipt.
- Cloud MAY persist the event for diagnostics; not required.
- Cloud MUST NOT mutate cluster state on receipt — remediation is user-driven.

## Versioning

V1. Additive fields permitted in future versions (consumers MUST tolerate unknown fields). Breaking changes require a new channel name.

## Allowlist

The channel `cluster.identity-split` is added to the orchestrator's `ALLOWED_CHANNELS` tuple in `packages/orchestrator/src/routes/internal-relay-events.ts` even though the orchestrator emits in-process. This keeps the allowlist authoritative for any future cross-process emitter (e.g. control-plane forwarding the same channel via the IPC route added in #594).
