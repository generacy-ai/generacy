# Feature Specification: Cloud-Hosted Bootstrap Control-Plane Service

New in-cluster HTTP service package for the cloud-hosted bootstrap UI

**Branch**: `490-context-cloud-hosted-bootstrap` | **Date**: 2026-04-28 | **Status**: Draft

## Summary

Create `packages/control-plane/`, a lightweight HTTP-over-Unix-socket service that terminates control-plane requests forwarded by the cluster-relay from the generacy.ai cloud-hosted bootstrap UI. The service exposes stubbed routes for cluster state, credentials, roles, and lifecycle actions, with real wiring deferred to later phases. It runs as a sub-process of the orchestrator container and must never block orchestrator boot on failure.

## Context

The cloud-hosted bootstrap UI on generacy.ai drives cluster configuration via control-plane requests forwarded over the cluster-relay. The cluster needs a small in-process HTTP service that terminates these requests and delegates to the credhelper or orchestrator as appropriate. Architecture: [docs/dev-cluster-architecture.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/dev-cluster-architecture.md) — "Cluster-relay extension".

## Scope

Create a new package `packages/control-plane/` that exposes an HTTP service over a Unix socket at `/run/generacy-control-plane/control.sock` (path configurable). Initial route surface (stubs returning typed shapes; real wiring lands in later phases):

- `GET /state` — returns cluster status, deployment mode, variant, last-seen.
- `GET /credentials/:id` and `PUT /credentials/:id` — stub; will delegate to credhelper Unix socket in phase 3.
- `GET /roles/:id` and `PUT /roles/:id` — stub; reads/writes `.agency/roles/:id.yaml` in phase 4.
- `POST /lifecycle/:action` — stub; supported actions enumerated as `clone-peer-repos`, `code-server-start`, `code-server-stop` (real wiring in later phases).

The service starts as a sub-process from the orchestrator container's entrypoint. **Failures to start must not block orchestrator boot** — log the failure and serve 503 from the dispatcher socket if needed; the rest of the cluster must still function.

Reads `actor` headers (`x-generacy-actor-user-id`, `x-generacy-actor-session-id`) set by the relay dispatcher in the parallel protocol issue, exposes them on the request context.

## Acceptance Criteria

- New package builds and lints clean.
- Service binds the Unix socket with mode 0660 and runs under the `node` (orchestrator) uid.
- All routes return correctly typed JSON; integration test boots the service and curls every route over the socket.
- If the service crashes, the orchestrator container continues running; relay dispatcher returns 503 from the socket prefix.
- Routes parse and expose `actor` headers on the request context.
- Stubs return realistic shapes so cloud-side callers can be developed against them.

## User Stories

### US1: Cloud UI developer integrates against cluster APIs

**As a** cloud-side frontend developer,
**I want** stubbed control-plane routes that return realistic typed JSON shapes,
**So that** I can develop and test the bootstrap UI against a real cluster without waiting for full backend wiring.

**Acceptance Criteria**:
- [ ] All stub routes return valid JSON matching the declared TypeScript types
- [ ] Response shapes are realistic enough to drive UI development (non-empty, representative field values)

### US2: Orchestrator operator ensures cluster resilience

**As a** cluster operator,
**I want** the control-plane service to fail gracefully without blocking the orchestrator,
**So that** agent workloads continue running even if the bootstrap UI backend is unavailable.

**Acceptance Criteria**:
- [ ] Orchestrator boots successfully even when the control-plane service fails to start
- [ ] Relay dispatcher returns 503 on the control-plane socket prefix when the service is down
- [ ] Failure is logged with sufficient detail for debugging

### US3: Relay dispatcher forwards authenticated requests

**As a** relay dispatcher,
**I want** the control-plane service to parse `actor` headers from forwarded requests,
**So that** downstream handlers can enforce per-user authorization in later phases.

**Acceptance Criteria**:
- [ ] `x-generacy-actor-user-id` and `x-generacy-actor-session-id` headers are parsed and available on the request context
- [ ] Missing actor headers result in a well-defined context (e.g., anonymous/unauthenticated)

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Package `packages/control-plane/` builds and lints with zero errors | P1 | Uses Node.js built-in `http` module (no Express), consistent with credhelper-daemon |
| FR-002 | Service binds Unix socket at configurable path (default `/run/generacy-control-plane/control.sock`) with mode 0660 | P1 | Socket dir creation and cleanup on startup |
| FR-003 | `GET /state` returns cluster status object: `{ status, deploymentMode, variant, lastSeen }` | P1 | Stub with realistic defaults |
| FR-004 | `GET /credentials/:id` returns credential metadata stub | P2 | Real wiring in phase 3 |
| FR-005 | `PUT /credentials/:id` accepts and validates credential body stub | P2 | Real wiring in phase 3 |
| FR-006 | `GET /roles/:id` returns role configuration stub | P2 | Real wiring in phase 4 |
| FR-007 | `PUT /roles/:id` accepts and validates role body stub | P2 | Real wiring in phase 4 |
| FR-008 | `POST /lifecycle/:action` accepts enumerated actions (`clone-peer-repos`, `code-server-start`, `code-server-stop`) | P1 | Unknown actions return 400 |
| FR-009 | Actor headers (`x-generacy-actor-user-id`, `x-generacy-actor-session-id`) parsed and exposed on request context | P1 | |
| FR-010 | Service starts as orchestrator sub-process; crash must not block orchestrator boot | P1 | Log failure, serve 503 from socket prefix |
| FR-011 | All route responses are typed with Zod schemas exported from the package | P1 | Enables cloud-side type sharing |
| FR-012 | Integration test boots service and curls every route over Unix socket | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Build & lint | Zero errors, zero warnings | `pnpm build && pnpm lint` in package |
| SC-002 | Route coverage | 100% of declared routes return typed JSON | Integration test curls all endpoints |
| SC-003 | Crash isolation | Orchestrator stays running after control-plane crash | Kill control-plane process, verify orchestrator PID alive |
| SC-004 | Socket permissions | 0660 on created socket file | `stat` check in integration test |
| SC-005 | Actor header parsing | Headers available on request context for all routes | Unit test with/without actor headers |

## Assumptions

- The orchestrator container entrypoint is the integration point for spawning this service as a sub-process.
- The relay dispatcher (parallel issue) will forward requests to the Unix socket and set `x-generacy-actor-*` headers.
- Node.js built-in `http` module is used (no Express), consistent with the credhelper-daemon pattern.
- Zod is available as a dependency for schema validation and type export.
- The socket directory `/run/generacy-control-plane/` is writable by the `node` uid at runtime.

## Out of Scope

- Real credential delegation to credhelper (phase 3).
- Real role file I/O against `.agency/roles/` (phase 4).
- Real lifecycle action execution (later phases).
- Authentication/authorization enforcement (later phase; this phase only parses actor headers).
- TLS or network-bound listeners (Unix socket only).
- Cluster-relay dispatcher implementation (parallel issue).

---

*Generated by speckit*
