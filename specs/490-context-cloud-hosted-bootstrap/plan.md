# Implementation Plan: Cloud-Hosted Bootstrap Control-Plane Service

**Feature**: New `@generacy-ai/control-plane` package — in-cluster HTTP service over Unix socket for cloud-hosted bootstrap UI
**Branch**: `490-context-cloud-hosted-bootstrap`
**Status**: Complete

## Summary

Create `packages/control-plane/`, a lightweight HTTP service that binds a Unix socket at `/run/generacy-control-plane/control.sock` (configurable). It serves as the cluster-side terminus for control-plane requests forwarded by the cluster-relay from the cloud-hosted bootstrap UI on generacy.ai.

The service exposes stub routes for cluster state, credentials, roles, and lifecycle actions. Real wiring to the credhelper daemon and orchestrator lands in later phases. The service must be crash-tolerant — failures must not block orchestrator boot.

## Technical Context

- **Language**: TypeScript (ES2022, NodeNext modules)
- **Runtime**: Node.js >= 20
- **HTTP**: Native `node:http` module over Unix socket (no Express/Fastify — matches credhelper-daemon pattern)
- **Schema validation**: Zod (re-exports from `@generacy-ai/credhelper`)
- **Test framework**: Vitest
- **Build**: `tsc` (identical to credhelper-daemon)
- **Package manager**: pnpm workspace (`workspace:*` resolution)

## Architecture

The control-plane service follows the same architectural pattern as `credhelper-daemon`:
- Native `http.createServer` bound to a Unix socket
- URL-based routing via regex matching in a single `handleRequest` method
- Typed error class with HTTP status mapping and JSON serialization
- Zod schemas for request/response validation
- Actor context extracted from relay-injected headers

```
┌──────────────────────────────────────────────────┐
│ Cloud UI (generacy.ai)                           │
└──────────────┬───────────────────────────────────┘
               │ HTTPS
┌──────────────▼───────────────────────────────────┐
│ Cluster Relay Dispatcher                         │
│  - Sets x-generacy-actor-user-id                 │
│  - Sets x-generacy-actor-session-id              │
│  - Forwards to control.sock                      │
│  - Returns 503 if socket unavailable             │
└──────────────┬───────────────────────────────────┘
               │ Unix socket
┌──────────────▼───────────────────────────────────┐
│ Control-Plane Service (this package)             │
│  /run/generacy-control-plane/control.sock        │
│                                                  │
│  GET  /state                                     │
│  GET  /credentials/:id                           │
│  PUT  /credentials/:id                           │
│  GET  /roles/:id                                 │
│  PUT  /roles/:id                                 │
│  POST /lifecycle/:action                         │
└──────────────────────────────────────────────────┘
```

## Project Structure

```
packages/control-plane/
├── bin/
│   └── control-plane.ts            # Entry point (process setup, signal handlers, start)
├── src/
│   ├── index.ts                    # Public exports (types, schemas, server class)
│   ├── server.ts                   # ControlPlaneServer class (http.createServer, socket binding)
│   ├── router.ts                   # Route dispatch (handleRequest, URL matching)
│   ├── routes/
│   │   ├── state.ts                # GET /state handler
│   │   ├── credentials.ts          # GET/PUT /credentials/:id handlers
│   │   ├── roles.ts                # GET/PUT /roles/:id handlers
│   │   └── lifecycle.ts            # POST /lifecycle/:action handler
│   ├── context.ts                  # ActorContext extraction from headers
│   ├── errors.ts                   # ControlPlaneError class, error codes, sendError
│   ├── schemas.ts                  # Zod schemas for request/response types
│   ├── types.ts                    # ServerConfig, route handler types
│   └── util/
│       └── read-body.ts            # Request body reading utility
├── __tests__/
│   ├── server.test.ts              # Server lifecycle tests (bind, close, socket permissions)
│   ├── router.test.ts              # Route dispatch unit tests
│   ├── routes/
│   │   ├── state.test.ts           # State endpoint tests
│   │   ├── credentials.test.ts     # Credentials endpoint tests
│   │   ├── roles.test.ts           # Roles endpoint tests
│   │   └── lifecycle.test.ts       # Lifecycle endpoint tests
│   ├── context.test.ts             # Actor context extraction tests
│   ├── errors.test.ts              # Error class tests
│   └── integration/
│       └── all-routes.test.ts      # Integration test: boot service, curl all routes
├── package.json
├── tsconfig.json
└── README.md
```

## Implementation Phases

### Phase 1: Package Scaffold & Error Infrastructure
1. Create `packages/control-plane/package.json` (mirror credhelper-daemon structure)
2. Create `tsconfig.json` (ES2022, NodeNext, strict)
3. Implement `src/errors.ts` — `ControlPlaneError` class with error codes:
   - `INVALID_REQUEST`, `NOT_FOUND`, `UNKNOWN_ACTION`, `INTERNAL_ERROR`, `SERVICE_UNAVAILABLE`
   - HTTP status mapping and `sendError` utility (matches credhelper-daemon's `{ error, code, details? }` shape)
4. Implement `src/util/read-body.ts` — body reading utility (same pattern as credhelper-daemon)

### Phase 2: Schemas & Types
1. Implement `src/schemas.ts`:
   - `ClusterStateSchema` — Zod schema with status/deploymentMode/variant/lastSeen enums
   - `LifecycleActionSchema` — Zod enum for valid actions
   - `LifecycleResponseSchema` — `{ accepted: true, action }` shape
   - `ErrorResponseSchema` — `{ error, code, details? }`
   - Re-export credential/role schemas from `@generacy-ai/credhelper`
2. Implement `src/types.ts` — `ServerConfig`, `RouteHandler` types
3. Implement `src/context.ts` — `ActorContext` type and header extraction

### Phase 3: Route Handlers (Stubs)
1. `src/routes/state.ts` — Returns realistic stub: `{ status: 'ready', deploymentMode: 'local', variant: 'cluster-base', lastSeen: ISO timestamp }`
2. `src/routes/credentials.ts` — GET returns stub credential from credhelper schemas; PUT accepts body, returns acknowledgment
3. `src/routes/roles.ts` — GET returns stub role from credhelper schemas; PUT accepts body, returns acknowledgment
4. `src/routes/lifecycle.ts` — Validates action enum, returns `{ accepted: true, action }`; 400 for unknown actions

### Phase 4: Server & Router
1. `src/router.ts` — URL pattern matching and dispatch to route handlers; injects ActorContext
2. `src/server.ts` — `ControlPlaneServer` class:
   - `start(socketPath)` — bind Unix socket with mode 0660
   - `close()` — graceful shutdown
   - Error boundary wrapping all requests (unhandled → 500)

### Phase 5: Entry Point
1. `bin/control-plane.ts`:
   - Parse env vars for config (`CONTROL_PLANE_SOCKET_PATH`, default `/run/generacy-control-plane/control.sock`)
   - Install signal handlers (SIGTERM → graceful shutdown)
   - Uncaught exception / unhandled rejection → log + exit(1)
   - Start server, log readiness

### Phase 6: Tests
1. Unit tests for each route handler, error class, context extraction
2. Integration test (`__tests__/integration/all-routes.test.ts`):
   - Boot server on temp Unix socket
   - HTTP requests to every route, verify response shapes and status codes
   - Verify actor headers are parsed and available
   - Verify 400 for unknown lifecycle actions
   - Verify 404 for unknown routes
3. Build verification (`pnpm build` succeeds, `pnpm lint` clean)

### Phase 7: Orchestrator Integration Point (Stub)
1. Document (in README) how the orchestrator entrypoint will spawn this service as a sub-process
2. No code changes to orchestrator in this phase — real wiring is a follow-up issue

## Key Design Decisions

1. **Native `node:http` over frameworks** — Matches credhelper-daemon pattern; minimal dependencies; the service is intentionally thin
2. **Separate route files** — Each route domain (state, credentials, roles, lifecycle) in its own file for maintainability as real wiring lands
3. **Re-export credhelper schemas** — Avoids shape drift; credential/role stubs match the canonical Zod definitions
4. **Crash-tolerant design** — Service runs as sub-process; orchestrator spawns it but continues if it fails; relay dispatcher returns 503 from socket prefix
5. **Actor context on every request** — Extracted from relay-injected headers; available to all route handlers even though stubs don't use it yet
6. **Socket mode 0660** — Readable/writable by owner (node/orchestrator uid) and group; matches credhelper-daemon's security model

## Dependencies

### Runtime
- `@generacy-ai/credhelper` (`workspace:*`) — Zod schemas for credential/role types
- `zod` (`^3.23.0`) — Schema validation

### Dev
- `@types/node` (`^20.14.0`)
- `typescript` (`^5.4.5`)
- `vitest` (`^4.0.18`)

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Schema drift between control-plane stubs and credhelper types | Re-export from `@generacy-ai/credhelper`; single source of truth |
| Socket path conflicts with credhelper daemon | Different path prefix (`/run/generacy-control-plane/` vs `/run/generacy-credhelper/`) |
| Orchestrator integration complexity | Deferred to follow-up; this phase is standalone |
| Actor header spoofing | Headers are set by the relay dispatcher, which is trusted; validation deferred to protocol issue |

## Constitution Check

No `.specify/memory/constitution.md` exists in this project. No governance constraints to verify against.
