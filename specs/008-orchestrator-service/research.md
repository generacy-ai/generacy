# Research: Orchestrator Service

## Technology Decisions

### Web Framework: Fastify v5

**Decision**: Use Fastify over Express

**Rationale**:
- Native TypeScript support with type providers
- Built-in JSON schema validation (integrates with Zod)
- 2x faster than Express in benchmarks (matters for high-throughput orchestrator)
- First-class plugin system for clean middleware composition
- WebSocket support via @fastify/websocket
- Active development and strong community

**Alternatives Considered**:
| Framework | Pros | Cons | Decision |
|-----------|------|------|----------|
| Express | Ubiquitous, huge ecosystem | Poor TS support, manual validation | Rejected |
| Hono | Very fast, edge-native | Newer, smaller ecosystem | Considered for future |
| tRPC | End-to-end type safety | Requires specific client, not REST-compatible | Rejected |

### Authentication Strategy

**Decision**: Multi-provider auth (API key + GitHub OAuth + JWT)

**Implementation**:
```typescript
// Auth flow by client type
CLI/CI      → API Key header (X-API-Key)
Humancy VSCode → GitHub OAuth2 → JWT session
Humancy Cloud  → GitHub OAuth2 → JWT session
```

**Rationale**:
- API keys: Simple for automation, no browser needed
- GitHub OAuth: Primary integration, developer-focused
- JWT: Stateless sessions for web clients

### Rate Limiting Strategy

**Decision**: Per-API-key limits (100 req/min default)

**Rationale**:
- Simple for MVP, no complex tiering
- Aligns with progressive adoption model
- Easy to evolve to tiered limits later
- Uses Redis for distributed counting

**Implementation**:
```typescript
// @fastify/rate-limit configuration
{
  max: 100,
  timeWindow: '1 minute',
  keyGenerator: (request) => request.apiKey || request.ip,
  redis: redisClient,
}
```

### Error Format: RFC 7807 Problem Details

**Decision**: Adopt RFC 7807 for all error responses

**Rationale**:
- Industry standard (used by GitHub, Stripe)
- TypeScript-friendly with clear interface
- Extensible via extensions field
- Machine-readable error codes via type URI

**Implementation**:
```typescript
interface ProblemDetails {
  type: string;       // URI: urn:generacy:error:workflow-not-found
  title: string;      // Human-readable: "Workflow Not Found"
  status: number;     // HTTP status: 404
  detail?: string;    // Specific occurrence details
  instance?: string;  // URI to this specific error
  extensions?: Record<string, unknown>;
}
```

### WebSocket Authentication

**Decision**: HTTP upgrade request with auth header

**Rationale**:
- Standard approach, secure
- No token in URL (avoids leakage in logs/referrer)
- Reuses existing HTTP auth middleware
- Compatible with browser WebSocket API via custom headers (using ws library workaround or SSE fallback)

**Implementation**:
```typescript
// Client sends auth in upgrade request
const ws = new WebSocket('wss://api.generacy.ai/ws', {
  headers: { 'Authorization': 'Bearer <token>' }
});

// Server validates during upgrade
fastify.get('/ws', { websocket: true, preHandler: authMiddleware }, handler);
```

## Implementation Patterns

### Service Layer Pattern

Routes delegate to service classes that encapsulate business logic:

```typescript
// routes/workflows.ts
fastify.post('/workflows', async (request, reply) => {
  const workflow = await workflowService.create(request.body);
  return reply.status(201).send(workflow);
});

// services/workflow-service.ts
class WorkflowService {
  constructor(private engine: WorkflowEngine) {}

  async create(input: CreateWorkflowInput) {
    // Validation, transformation, delegation
    return this.engine.startWorkflow(input.definition, input.context);
  }
}
```

### Plugin-Based Middleware

Fastify plugins encapsulate related functionality:

```typescript
// plugins/auth.ts
export default fp(async (fastify, opts) => {
  fastify.decorateRequest('user', null);
  fastify.addHook('preHandler', async (request) => {
    request.user = await validateAuth(request);
  });
});

// server.ts
await fastify.register(authPlugin);
```

### Graceful Shutdown

Handle SIGTERM/SIGINT for Kubernetes deployments:

```typescript
async function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down...`);

  // 1. Stop accepting new connections
  await fastify.close();

  // 2. Wait for in-flight requests (grace period)
  await sleep(5000);

  // 3. Close downstream connections
  await redis.quit();

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

## API Design

### REST Conventions

| Method | Path | Action | Success | Error |
|--------|------|--------|---------|-------|
| POST | /workflows | Create | 201 + Location | 400/422 |
| GET | /workflows | List | 200 | - |
| GET | /workflows/:id | Get | 200 | 404 |
| POST | /workflows/:id/pause | Pause | 200 | 404/409 |
| POST | /workflows/:id/resume | Resume | 200 | 404/409 |
| DELETE | /workflows/:id | Cancel | 204 | 404 |

### WebSocket Protocol

```typescript
// Subscription model
type ClientMessage =
  | { type: 'subscribe'; channels: Channel[] }
  | { type: 'unsubscribe'; channels: Channel[] };

type Channel = 'workflows' | 'queue' | 'agents';

type ServerMessage =
  | { type: 'workflow_event'; payload: WorkflowEvent }
  | { type: 'queue_update'; payload: DecisionQueueItem[] }
  | { type: 'agent_status'; payload: AgentStatus }
  | { type: 'error'; payload: ProblemDetails };
```

## Testing Strategy

### Unit Tests
- Auth validation logic
- Rate limit key generation
- Error formatting
- Service methods with mocked dependencies

### Integration Tests
- Full HTTP request/response cycle
- WebSocket connection and messaging
- Auth flow end-to-end
- Rate limiting enforcement

### Test Utilities
```typescript
// tests/fixtures/server.ts
export async function buildTestServer() {
  const server = createServer({ testing: true });
  await server.ready();
  return server;
}

// Usage
const server = await buildTestServer();
const response = await server.inject({
  method: 'GET',
  url: '/health',
});
expect(response.statusCode).toBe(200);
```

## Security Considerations

### Headers (via @fastify/helmet)
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Strict-Transport-Security: max-age=31536000`
- `Content-Security-Policy: default-src 'self'`

### Rate Limiting
- Per-API-key to prevent abuse
- Separate limits for authenticated vs anonymous
- Redis-backed for distributed enforcement

### Input Validation
- Zod schemas for all request bodies
- Path parameter validation
- Query string sanitization

### Secrets Management
- Environment variables for secrets
- No secrets in config files
- JWT secret rotation support

## References

- [Fastify Documentation](https://fastify.dev/docs/latest/)
- [RFC 7807 Problem Details](https://datatracker.ietf.org/doc/html/rfc7807)
- [GitHub OAuth2 Web Flow](https://docs.github.com/en/developers/apps/building-oauth-apps/authorizing-oauth-apps)
- [Prometheus Exposition Format](https://prometheus.io/docs/instrumenting/exposition_formats/)

---

*Generated by speckit*
