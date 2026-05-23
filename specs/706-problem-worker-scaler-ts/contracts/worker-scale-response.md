# Contract: `POST /lifecycle/worker-scale` Response

**Issue**: [#706](https://github.com/generacy-ai/generacy/issues/706)

Defines the cross-process response shape for the `worker-scale` lifecycle action handled in `packages/control-plane/src/routes/lifecycle.ts`. The route's *request* shape is unchanged from the existing implementation (`WorkerScaleBodySchema`).

The Docker Engine API contract itself is upstream/external — not redocumented here. See [research.md](../research.md#docker-engine-api-client) for the endpoints we consume and the v1.41+ stability assumption.

---

## Request

`POST /lifecycle/worker-scale` (over Unix socket `/run/generacy-control-plane/control.sock`).

```json
{
  "count": 3
}
```

**Schema** (existing, unchanged):

```typescript
WorkerScaleBodySchema = z.object({
  count: z.number().int().min(1),
});
```

---

## Response: Success

`200 OK`

```json
{
  "accepted": true,
  "action": "worker-scale",
  "previousCount": 1,
  "requestedCount": 3,
  "actualCount": 3
}
```

**Schema** (extended):

```typescript
WorkerScaleSuccessResponseSchema = z.object({
  accepted: z.literal(true),
  action: z.literal('worker-scale'),
  previousCount: z.number().int().min(0),
  requestedCount: z.number().int().min(1),
  actualCount: z.number().int().min(1),     // NEW: equals requestedCount on success
});
```

**Backward compatibility**: The existing cloud-side consumer ignores unknown fields (Zod `.passthrough()` is the historical convention here). `actualCount` is additive; not a breaking change.

---

## Response: Partial Scale Failure

When ≥1 replica was created/removed successfully but the target was not reached. `cluster.yaml` reflects `actualCount`; metadata refresh fires; orchestrator log carries the cause.

`200 OK` with `partial: true` flag. (Rationale: best-effort succeeded *somewhat* — returning 5xx would mislead the cloud UI into showing a hard failure when the cluster did make progress.)

```json
{
  "accepted": true,
  "action": "worker-scale",
  "partial": true,
  "previousCount": 1,
  "requestedCount": 5,
  "actualCount": 3,
  "error": {
    "code": "PARTIAL_SCALE",
    "message": "Partial scale: requested 5, achieved 3 (POST /containers/create returned 500)"
  }
}
```

**Schema**:

```typescript
WorkerScalePartialResponseSchema = z.object({
  accepted: z.literal(true),
  action: z.literal('worker-scale'),
  partial: z.literal(true),
  previousCount: z.number().int().min(0),
  requestedCount: z.number().int().min(1),
  actualCount: z.number().int().min(1),
  error: z.object({
    code: z.literal('PARTIAL_SCALE'),
    message: z.string(),
  }),
});
```

---

## Response: Full Failure

When zero replicas were created/removed. `cluster.yaml` is NOT updated; metadata refresh is NOT fired.

Routes through the existing `ControlPlaneError` envelope (matches sibling lifecycle actions).

`503 Service Unavailable` for `DOCKER_DAEMON_UNAVAILABLE`:

```json
{
  "error": "Docker daemon is not reachable at /var/run/docker-host.sock",
  "code": "DOCKER_DAEMON_UNAVAILABLE",
  "details": { "socketPath": "/var/run/docker-host.sock" }
}
```

`500 Internal Server Error` for other full failures:

```json
{
  "error": "Worker scale failed: <message>",
  "code": "INTERNAL_ERROR"
}
```

`400 Bad Request` for request validation errors (existing behaviour, unchanged):

```json
{
  "error": "Invalid worker-scale body",
  "code": "INVALID_REQUEST",
  "details": { "errors": ["count must be >= 1"] }
}
```

---

## Error Code Reference

| Code | HTTP | Triggers | Action by cloud UI |
|------|------|----------|--------------------|
| `INVALID_REQUEST` | 400 | Bad JSON, missing/invalid `count` | Surface validation error to user. |
| `DOCKER_DAEMON_UNAVAILABLE` | 503 | `/var/run/docker-host.sock` not reachable (was `DOCKER_CLI_UNAVAILABLE` in pre-rewrite version) | Retry once after delay; surface "cluster not reachable" to user. |
| `PARTIAL_SCALE` (in `error.code`, response is 200 with `partial: true`) | 200 | ≥1 replica created/removed, but `< requested` | Render "requested 5, scaled to 3 — retry?" UI. A subsequent `PATCH /workers count: 5` against the cluster will reconcile the delta. |
| `INTERNAL_ERROR` | 500 | Any other scale failure with 0 replicas changed | Surface to user; suggest cluster log inspection. |
| `UNKNOWN_ACTION` | 400 | Action not in `LifecycleActionSchema` | Existing — unchanged. |

---

## Behaviour notes (not in the wire shape)

- **Concurrency**: Two simultaneous requests are serialized in-process (FR-014). The second request waits for the first to complete and then operates on the post-first state. Both requests receive their own `200 OK`; the second response's `previousCount` reflects the first response's `actualCount`.
- **No-op (`requestedCount == previousCount`)**: Returns `200 OK` with `actualCount === previousCount`. No Engine API mutations, no `cluster.yaml` write, no metadata refresh.
- **Metadata refresh**: Fires once on any non-no-op response (success or partial). Failure of the refresh call itself is non-fatal and not surfaced in the response (logged only).
