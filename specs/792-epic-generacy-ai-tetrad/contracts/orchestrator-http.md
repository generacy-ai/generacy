# Contract: Orchestrator HTTP Endpoints Consumed

Read-only consumption only. No new endpoints. Both endpoints already exist; cockpit must conform to their current shapes.

## Auth

`Authorization: Bearer <token>` on every request. Token sourced per `data-model.md §2` (env > config). If the resolved token is unset, the live client is never constructed — no HTTP traffic is generated.

## GET /queue

- **Defined in**: `packages/orchestrator/src/routes/queue.ts:21-43`.
- **Required for**: FR-001, FR-011 (jobs).
- **Request**: no path params; no query params used by cockpit (server accepts optional `priority`, `workflowId` filters but cockpit does not pass them).
- **Response (200)**: `QueueItem[]`. Cockpit treats the array length as "queue depth / jobs".
- **Response (non-2xx)**: mapped to `{ available: false, reason: 'http-error', statusCode }`.
- **Network error**: mapped to `{ available: false, reason: 'cloud-unreachable' }`.
- **Timeout (per call)**: 1500 ms; mapped to `{ available: false, reason: 'timeout' }` by the caller's `Promise.race`.

Item-level fields cockpit reads:
- `id: string`
- `status: string`
- `workflowId?: string` (kept for future surface; not rendered in the footer)

Other fields are tolerated and ignored. Items that lack `id` or `status` strings are dropped silently by `normalizeJobs`.

## GET /dispatch/queue/workers

- **Defined in**: `packages/orchestrator/src/routes/dispatch.ts:54-65`.
- **Required for**: FR-010, FR-011 (workers).
- **Request**: no path params, no query params.
- **Response (200)**: `{ count: number }`. The number is `queueManager.getActiveWorkerCount()` — workers currently holding ≥1 claimed queue item.
- **Cockpit handling**: `WorkersResult.count = body.count`. **No list normalization.** This fixes the latent always-`0` bug at `client.ts:144`.
- **Response (non-2xx / network error / timeout)**: same mapping as `/queue`.

## NOT consumed

- `/workflows` — referenced in the issue body but explicitly out of scope per spec Q1 → A.
- `/dispatch/queue/depth` and `/dispatch/queue/items` — would expose duplicate info or per-item detail (out of scope per spec).
- Write endpoints (`POST /queue`, etc.) — read-only tier.
