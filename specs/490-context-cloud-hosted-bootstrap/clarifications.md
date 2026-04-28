# Clarifications: Cloud-Hosted Bootstrap Control-Plane Service

## Batch 1 — 2026-04-28

### Q1: State Endpoint Enum Values
**Context**: FR-003 and FR-011 require typed Zod schemas for the `GET /state` response (`{ status, deploymentMode, variant, lastSeen }`), but the valid values for `status`, `deploymentMode`, and `variant` are not defined. Without these, the Zod enum/union types and stub return values cannot be implemented.
**Question**: What are the valid values for `status` (e.g., `ready | bootstrapping | degraded`), `deploymentMode` (e.g., `standalone | clustered`), and `variant` (e.g., `dev | staging | production`) in the cluster state response?

**Answer**: State endpoint enum values:**
- `status: 'bootstrapping' | 'ready' | 'degraded' | 'error'` — reflects the cluster's own perception (note: this is intentionally different from the cloud-side cluster-registry status enum, which has `provisioning | connected | offline | destroyed`).
- `deploymentMode: 'local' | 'cloud'` — matches the cluster registry schema in [docs/dev-cluster-architecture.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/dev-cluster-architecture.md).
- `variant: 'cluster-base' | 'cluster-microservices'` — only the two v1.5 variants exist; declare as a Zod enum that's easy to extend when `cluster-firebase`/`cluster-supabase` ship later.

### Q2: Credential and Role Stub Schemas
**Context**: FR-004 through FR-007 require stub responses with "realistic shapes" for credentials and roles, and FR-011 requires Zod schemas exported from the package. The spec defines no fields for these resources, which blocks both the Zod type definitions and the stub data that cloud-side developers will code against.
**Question**: What fields should the credential stub (`GET /credentials/:id`) and role stub (`GET /roles/:id`) responses contain? For credentials, something like `{ id, type, name, status, createdAt }`? For roles, something like `{ id, name, permissions, credentialRefs }`?
**Options**:
- A: Define minimal shapes (id, name, type/status only) — cloud-side iterates on shape later
- B: Align with existing credhelper types in `packages/credhelper` — derive shapes from current Zod schemas
- C: Provide explicit field lists now so cloud-side can develop in parallel

**Answer**: B — Align with existing credhelper Zod schemas.** Re-export shapes from `packages/credhelper/src/schemas/credentials.ts` and `packages/credhelper/src/schemas/roles.ts`. The control-plane is a thin proxy over the credhelper's own data; inventing parallel shapes would create drift. Stubs return realistic objects matching those schemas.

### Q3: Lifecycle Action Response Shape
**Context**: FR-008 defines the accepted lifecycle actions (`clone-peer-repos`, `code-server-start`, `code-server-stop`) but does not specify what the response should look like. Cloud-side callers need to know whether to expect a synchronous acknowledgment, an async job ID for polling, or a status object.
**Question**: What should `POST /lifecycle/:action` return? A simple acknowledgment (`{ accepted: true, action }`), or an async job model (`{ jobId, status, action }`) that cloud-side can poll?
**Options**:
- A: Simple sync acknowledgment (`{ accepted: true, action }`) — sufficient for stubs
- B: Async job model (`{ jobId, status, action }`) — better matches real-world lifecycle actions that take time

**Answer**: A — Simple sync acknowledgment `{ accepted: true, action }`.** Long-running actions like `clone-peer-repos` stream progress separately via the `cluster.bootstrap` `event` channel (already designed in Phase 4 issue generacy-cloud#440). Mixing sync ack + event-channel progress is cleaner than baking a job-polling model into every lifecycle endpoint.

### Q4: Standardized Error Response Format
**Context**: The spec defines a 400 for unknown lifecycle actions and 503 for service-down, but does not specify a standard error response body shape. Cloud-side callers need a consistent error contract to handle failures uniformly across all routes.
**Question**: Should all error responses follow a standard shape, and if so, what fields? For example: `{ error: string, code: string, details?: unknown }`.
**Options**:
- A: Minimal (`{ error: string }`) — keep it simple for stubs
- B: Structured (`{ error: string, code: string, details?: unknown }`) — better for cloud-side error handling
- C: Match an existing pattern from credhelper-daemon or orchestrator

**Answer**: B — Structured `{ error: string, code: string, details?: unknown }`.** Cloud-side error handling will eventually need codes; ship them now. Implementer should also check `packages/credhelper-daemon/src/errors.ts` and `services/api/src/lib/` for any existing error helper to align with — keep the shape consistent across the ecosystem.
