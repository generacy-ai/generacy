# Contract — `degraded` Cluster Status Transition on Webhook-Registration 403

## Endpoint

`POST /internal/status` on the control-plane control socket (`/run/generacy-control-plane/control.sock` by default; override via `CONTROL_PLANE_SOCKET_PATH`).

Existing endpoint; see `packages/orchestrator/src/services/status-reporter.ts` and CLAUDE.md `## Control-Plane Package` entry for `POST /internal/status` semantics (module-level state store, state machine `bootstrapping → ready ↔ degraded → error (terminal)`).

## Caller

`WebhookSetupService._ensureWebhookForRepo` via `StatusReporter.pushStatus('degraded', 'webhook-registration-forbidden')`.

## Trigger conditions

Fire when any of the three 403 rows (list-403, patch-403, create-403) from `ensure-webhooks-behavior.md` matches for **any** repo in `config.repositories`. A cluster with N repos in which K return 403 fires the transition once (the first 403 in the sequential per-repo loop) — subsequent 403s in the same boot re-post the same body (idempotent, safe, but not required for correctness because the control-plane keeps the latest).

## Request body

```json
{
  "status": "degraded",
  "statusReason": "webhook-registration-forbidden"
}
```

## Content-Type

`application/json`.

## Response

Existing behavior — `StatusReporter.pushStatus` is fire-and-forget:
- 2xx → success (`resolve()`).
- Any other response → `resolve()` after body consumption; error swallowed.
- Timeout after 5 s → `resolve()` after `req.destroy()`.
- Socket unreachable → `resolve()` after `req.on('error')`; error swallowed.

The emitter does not observe the response — the audit floor is the Pino warn log line.

## State machine placement

The control-plane's status state machine (per CLAUDE.md `## Control-Plane Package`):
```
bootstrapping → ready ↔ degraded → error (terminal)
```

This fix's transition is:
- From `bootstrapping` (first boot with 403 before `ready` was posted) → `degraded`. Valid direct transition.
- From `ready` (rare — 403 hit after some other subsystem posted `ready`) → `degraded`. Valid transition.
- From `degraded` (already degraded — e.g., prior boot posted degraded and the state persisted) → `degraded` (no-op). Idempotent.
- Never emits from `error` — the cluster halts before `ensureWebhooks()` gets called from `error`.

## Recovery

The transition is one-way within a boot. Recovery to `ready` on the same boot is NOT emitted by `WebhookSetupService` — recovery only occurs at the next boot after the App-manifest fix, when `ensureWebhooks()` returns 200 and the orchestrator's normal readiness path posts `ready`.

## Cloud-side expectations (informational)

- The cloud already renders `degraded` as a distinct dashboard state.
- `statusReason: 'webhook-registration-forbidden'` is a new value in that string field; consumers ignoring unknown reasons continue working. The dashboard banner render uses the paired `cluster.bootstrap` event (`webhook-registration-forbidden-event.md`) for detail; the status reason is the state-machine signal, the event is the presentation payload.

## Backwards compatibility

- `POST /internal/status` payload shape unchanged; new value in `statusReason` is additive.
- No changes to `ClusterStatus` type or its four allowed values.
- No changes to the state-machine transitions the control-plane accepts.
