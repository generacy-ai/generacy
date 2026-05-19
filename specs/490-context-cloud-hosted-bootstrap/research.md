# Research: Control-Plane Service

## Technology Decisions

### 1. HTTP Framework: Native `node:http` (no framework)

**Decision**: Use Node.js built-in `http.createServer` with manual URL routing.

**Rationale**:
- Matches the established pattern in `packages/credhelper-daemon/src/control-server.ts`
- The route surface is small (6 endpoints) — no framework overhead needed
- Avoids adding Express/Fastify as dependencies for a thin service
- Unix socket binding is simpler with the native module

**Alternatives Considered**:
- **Fastify**: Used by the orchestrator's main API, but overkill for 6 stub endpoints
- **Express**: Would add dependency weight for no benefit at this scale

### 2. Schema Validation: Zod (re-exported from @generacy-ai/credhelper)

**Decision**: Re-export credential and role Zod schemas from `@generacy-ai/credhelper`. Define new schemas (state, lifecycle, error) locally.

**Rationale**:
- Clarification Q2 explicitly mandates alignment with credhelper schemas
- Prevents shape drift between control-plane stubs and credhelper's canonical types
- Zod is already a workspace dependency

### 3. Error Shape: `{ error: string, code: string, details?: unknown }`

**Decision**: Match the error response shape from credhelper-daemon's `CredhelperErrorResponse`.

**Rationale**:
- Clarification Q4 chose option B (structured errors)
- Credhelper-daemon already uses `{ error, code, details? }` via `CredhelperError.toResponse()`
- Ecosystem consistency — cloud-side callers handle one error shape

### 4. Lifecycle Response: Synchronous Acknowledgment

**Decision**: `POST /lifecycle/:action` returns `{ accepted: true, action }`.

**Rationale**:
- Clarification Q3 chose option A
- Long-running actions stream progress via the `cluster.bootstrap` event channel (Phase 4, generacy-cloud#440)
- Avoids baking job-polling into every lifecycle endpoint

### 5. Route Organization: Separate files per domain

**Decision**: Split route handlers into `src/routes/state.ts`, `credentials.ts`, `roles.ts`, `lifecycle.ts`.

**Rationale**:
- Each domain will be wired to different backends in later phases (credhelper, filesystem, orchestrator)
- Keeps each file focused and makes phase-by-phase wiring straightforward
- Credhelper-daemon inlines routes in `handleRequest` because it only has 2 routes; 6+ warrants separation

## Implementation Patterns

### Request Handling Pattern
```typescript
// Same pattern as credhelper-daemon: single handleRequest with try/catch error boundary
async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const actor = extractActorContext(req);
    await this.router.dispatch(req, res, actor);
  } catch (err) {
    if (err instanceof ControlPlaneError) {
      sendError(res, err);
    } else {
      sendError(res, new ControlPlaneError('INTERNAL_ERROR', 'Unexpected error'));
    }
  }
}
```

### Socket Binding Pattern
```typescript
// From credhelper-daemon — bind Unix socket with cleanup of stale socket files
async start(socketPath: string): Promise<void> {
  // Remove stale socket file if exists
  try { await fs.unlink(socketPath); } catch { /* ignore ENOENT */ }

  return new Promise((resolve, reject) => {
    this.server.on('error', reject);
    this.server.listen(socketPath, () => {
      // Set socket permissions to 0660
      await fs.chmod(socketPath, 0o660);
      resolve();
    });
  });
}
```

### Actor Context Extraction
```typescript
// Headers set by relay dispatcher
interface ActorContext {
  userId?: string;
  sessionId?: string;
}

function extractActorContext(req: IncomingMessage): ActorContext {
  return {
    userId: getHeader(req, 'x-generacy-actor-user-id'),
    sessionId: getHeader(req, 'x-generacy-actor-session-id'),
  };
}
```

### Integration Test Pattern
```typescript
// From credhelper-daemon: HTTP-over-Unix-socket test helper
function request(socketPath: string, method: string, path: string, body?: object) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request({ socketPath, method, path, headers: ... }, (res) => {
      // collect chunks, parse JSON, resolve { status, body }
    });
  });
}
```

## Key Sources

| Source | Relevance |
|--------|-----------|
| `packages/credhelper-daemon/src/control-server.ts` | HTTP server pattern, socket binding, request handling |
| `packages/credhelper-daemon/src/errors.ts` | Error class pattern, HTTP status mapping, `sendError` utility |
| `packages/credhelper-daemon/__tests__/integration/session-lifecycle.test.ts` | Integration test pattern with Unix socket |
| `packages/credhelper/src/schemas/credentials.ts` | Canonical credential Zod schemas for stub responses |
| `packages/credhelper/src/schemas/roles.ts` | Canonical role Zod schemas for stub responses |
| Clarifications batch 1 (Q1-Q4) | Enum values, schema alignment, response shapes, error format |
