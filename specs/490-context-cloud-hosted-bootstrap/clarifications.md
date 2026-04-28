# Clarifications: Cloud-Hosted Bootstrap Control-Plane Service

## Batch 1 — 2026-04-28

### Q1: State Endpoint Enum Values
**Context**: FR-003 and FR-011 require typed Zod schemas for the `GET /state` response (`{ status, deploymentMode, variant, lastSeen }`), but the valid values for `status`, `deploymentMode`, and `variant` are not defined. Without these, the Zod enum/union types and stub return values cannot be implemented.
**Question**: What are the valid values for `status` (e.g., `ready | bootstrapping | degraded`), `deploymentMode` (e.g., `standalone | clustered`), and `variant` (e.g., `dev | staging | production`) in the cluster state response?

**Answer**: *Pending*

### Q2: Credential and Role Stub Schemas
**Context**: FR-004 through FR-007 require stub responses with "realistic shapes" for credentials and roles, and FR-011 requires Zod schemas exported from the package. The spec defines no fields for these resources, which blocks both the Zod type definitions and the stub data that cloud-side developers will code against.
**Question**: What fields should the credential stub (`GET /credentials/:id`) and role stub (`GET /roles/:id`) responses contain? For credentials, something like `{ id, type, name, status, createdAt }`? For roles, something like `{ id, name, permissions, credentialRefs }`?
**Options**:
- A: Define minimal shapes (id, name, type/status only) — cloud-side iterates on shape later
- B: Align with existing credhelper types in `packages/credhelper` — derive shapes from current Zod schemas
- C: Provide explicit field lists now so cloud-side can develop in parallel

**Answer**: *Pending*

### Q3: Lifecycle Action Response Shape
**Context**: FR-008 defines the accepted lifecycle actions (`clone-peer-repos`, `code-server-start`, `code-server-stop`) but does not specify what the response should look like. Cloud-side callers need to know whether to expect a synchronous acknowledgment, an async job ID for polling, or a status object.
**Question**: What should `POST /lifecycle/:action` return? A simple acknowledgment (`{ accepted: true, action }`), or an async job model (`{ jobId, status, action }`) that cloud-side can poll?
**Options**:
- A: Simple sync acknowledgment (`{ accepted: true, action }`) — sufficient for stubs
- B: Async job model (`{ jobId, status, action }`) — better matches real-world lifecycle actions that take time

**Answer**: *Pending*

### Q4: Standardized Error Response Format
**Context**: The spec defines a 400 for unknown lifecycle actions and 503 for service-down, but does not specify a standard error response body shape. Cloud-side callers need a consistent error contract to handle failures uniformly across all routes.
**Question**: Should all error responses follow a standard shape, and if so, what fields? For example: `{ error: string, code: string, details?: unknown }`.
**Options**:
- A: Minimal (`{ error: string }`) — keep it simple for stubs
- B: Structured (`{ error: string, code: string, details?: unknown }`) — better for cloud-side error handling
- C: Match an existing pattern from credhelper-daemon or orchestrator

**Answer**: *Pending*
