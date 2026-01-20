# Implementation Plan: Orchestrator Service

**Feature**: Main API server for Generacy - HTTP/WebSocket interface for workflow orchestration
**Branch**: `008-orchestrator-service`
**Status**: Complete

## Summary

Implement the orchestrator service - the main API server that exposes HTTP and WebSocket APIs for managing workflows, decision queues, connected agents, and integrations. The service acts as the central coordination point between Agency instances (AI agents) and Humancy interfaces (human operators via VSCode extension or cloud dashboard).

## Technical Context

| Aspect | Details |
|--------|---------|
| Language | TypeScript 5.x (ES2022 modules) |
| Runtime | Node.js 20+ |
| Web Framework | Fastify v5 (native TS, built-in schema validation, WebSocket support) |
| Authentication | API keys, GitHub OAuth2, JWT sessions |
| Real-time | @fastify/websocket for streaming |
| Validation | Zod schemas (integrated with Fastify type providers) |
| Storage | Redis for session/rate-limit state |
| Testing | Vitest + supertest |
| Build | tsup (ESM-first) |

## Project Structure

```text
packages/orchestrator/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                      # Public exports
│   ├── server.ts                     # Fastify server setup and lifecycle
│   ├── config/
│   │   ├── index.ts                  # Config exports
│   │   ├── schema.ts                 # Zod config schema
│   │   └── loader.ts                 # Environment/YAML config loading
│   ├── routes/
│   │   ├── index.ts                  # Route registration
│   │   ├── workflows.ts              # /workflows endpoints
│   │   ├── queue.ts                  # /queue endpoints
│   │   ├── agents.ts                 # /agents endpoints
│   │   ├── integrations.ts           # /integrations endpoints
│   │   ├── health.ts                 # /health endpoint
│   │   └── metrics.ts                # /metrics endpoint (Prometheus)
│   ├── websocket/
│   │   ├── index.ts                  # WebSocket exports
│   │   ├── handler.ts                # WebSocket connection handler
│   │   ├── subscriptions.ts          # Channel subscription manager
│   │   └── messages.ts               # Message type definitions
│   ├── auth/
│   │   ├── index.ts                  # Auth exports
│   │   ├── middleware.ts             # Fastify auth hook
│   │   ├── api-key.ts                # API key validation
│   │   ├── github-oauth.ts           # GitHub OAuth2 flow
│   │   └── jwt.ts                    # JWT token handling
│   ├── middleware/
│   │   ├── index.ts                  # Middleware exports
│   │   ├── rate-limit.ts             # Per-API-key rate limiting
│   │   ├── request-logger.ts         # Request logging with correlation
│   │   └── error-handler.ts          # RFC 7807 error formatting
│   ├── services/
│   │   ├── index.ts                  # Service exports
│   │   ├── workflow-service.ts       # Workflow operations facade
│   │   ├── queue-service.ts          # Decision queue operations
│   │   └── agent-registry.ts         # Connected agent tracking
│   ├── types/
│   │   ├── index.ts                  # Type exports
│   │   ├── api.ts                    # Request/response types
│   │   ├── websocket.ts              # WebSocket message types
│   │   └── problem-details.ts        # RFC 7807 error type
│   └── utils/
│       ├── index.ts                  # Utility exports
│       ├── shutdown.ts               # Graceful shutdown handler
│       └── correlation.ts            # Request correlation ID
├── tests/
│   ├── unit/
│   │   ├── auth/
│   │   │   ├── api-key.test.ts
│   │   │   └── jwt.test.ts
│   │   ├── middleware/
│   │   │   ├── rate-limit.test.ts
│   │   │   └── error-handler.test.ts
│   │   └── services/
│   │       └── workflow-service.test.ts
│   ├── integration/
│   │   ├── routes/
│   │   │   ├── workflows.test.ts
│   │   │   ├── queue.test.ts
│   │   │   └── health.test.ts
│   │   └── websocket/
│   │       └── subscriptions.test.ts
│   └── fixtures/
│       ├── workflows.ts
│       └── auth.ts
└── Dockerfile
```

## Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                       Orchestrator Service                       │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    Fastify Server                         │   │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────────────┐ │   │
│  │  │  CORS   │ │ Helmet  │ │  Rate   │ │  Auth Middleware │ │   │
│  │  └─────────┘ └─────────┘ │  Limit  │ │  (API key/OAuth) │ │   │
│  │                          └─────────┘ └─────────────────┘ │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│           ┌──────────────────┼──────────────────┐               │
│           ▼                  ▼                  ▼               │
│  ┌─────────────────┐ ┌─────────────┐ ┌─────────────────────┐   │
│  │   HTTP Routes   │ │  WebSocket  │ │     Services         │   │
│  │  /workflows     │ │  /ws        │ │  WorkflowService     │   │
│  │  /queue         │ │  subscribe  │ │  QueueService        │   │
│  │  /agents        │ │  broadcast  │ │  AgentRegistry       │   │
│  │  /health        │ │             │ │                      │   │
│  │  /metrics       │ │             │ │                      │   │
│  └────────┬────────┘ └──────┬──────┘ └──────────┬───────────┘   │
│           │                 │                    │               │
│           └─────────────────┼────────────────────┘               │
│                             ▼                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   Internal Dependencies                   │   │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐  │   │
│  │  │ WorkflowEngine│ │MessageRouter │ │  JobScheduler    │  │   │
│  │  │ (#3)         │ │ (#5)         │ │  (#6)            │  │   │
│  │  └──────────────┘ └──────────────┘ └──────────────────┘  │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │      Redis      │
                    │  (sessions,     │
                    │   rate limits)  │
                    └─────────────────┘
```

### Request Flow

```
Client Request
      │
      ▼
┌─────────────────┐
│  CORS/Helmet    │  Security headers
└────────┬────────┘
         ▼
┌─────────────────┐
│  Rate Limiter   │  Per-API-key: 100 req/min
└────────┬────────┘
         ▼
┌─────────────────┐
│  Auth Middleware │  Validate API key/OAuth token/JWT
└────────┬────────┘
         ▼
┌─────────────────┐
│  Request Logger │  Log with correlation ID
└────────┬────────┘
         ▼
┌─────────────────┐
│  Route Handler  │  Business logic
└────────┬────────┘
         ▼
┌─────────────────┐
│ Error Handler   │  RFC 7807 Problem Details on error
└────────┬────────┘
         ▼
   Response
```

## Implementation Phases

### Phase 1: Project Setup and Configuration

**Files**: `package.json`, `tsconfig.json`, `src/config/*`, `src/types/*`

- Initialize package with dependencies (Fastify, Zod, ioredis)
- Configuration schema and loader (env vars + YAML)
- Core type definitions (API types, Problem Details)

### Phase 2: Server Foundation

**Files**: `src/server.ts`, `src/utils/shutdown.ts`, `src/utils/correlation.ts`

- Fastify server setup with plugins (cors, helmet, websocket)
- Graceful shutdown handler (SIGTERM, SIGINT)
- Request correlation ID middleware

### Phase 3: Authentication

**Files**: `src/auth/*`, `tests/unit/auth/*`

- API key validation (header: `X-API-Key`)
- GitHub OAuth2 flow (for Humancy extension)
- JWT token creation and validation
- Fastify auth hook (preHandler)

### Phase 4: Middleware

**Files**: `src/middleware/*`, `tests/unit/middleware/*`

- Per-API-key rate limiting (using @fastify/rate-limit + Redis)
- Request logging with pino (structured JSON)
- RFC 7807 error handler (Problem Details format)

### Phase 5: HTTP Routes

**Files**: `src/routes/*`, `tests/integration/routes/*`

- `/workflows` - CRUD + pause/resume/cancel
- `/queue` - Decision queue operations
- `/agents` - Connected agent list
- `/integrations` - Integration status
- `/health` - Readiness/liveness checks
- `/metrics` - Prometheus exposition format

### Phase 6: Services Layer

**Files**: `src/services/*`, `tests/unit/services/*`

- WorkflowService - Facade over WorkflowEngine (#3)
- QueueService - Decision queue via MessageRouter (#5)
- AgentRegistry - Track connected agents

### Phase 7: WebSocket Support

**Files**: `src/websocket/*`, `tests/integration/websocket/*`

- WebSocket handler with auth via upgrade headers
- Channel subscription management (workflows, queue)
- Event broadcasting to subscribers

### Phase 8: Docker and Integration

**Files**: `Dockerfile`, integration tests

- Multi-stage Dockerfile (build + production)
- Full integration test suite
- Documentation

## Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| Fastify over Express | Better TS support, built-in schema validation, 2x faster benchmark |
| Per-API-key rate limits | Simpler than tiered plans for MVP, aligns with spec decision |
| Redis for rate limits | Distributed rate limiting for future multi-instance deployment |
| Facade services | Isolate internal dependencies, cleaner route handlers |
| Zod type provider | Compile-time type safety for request/response schemas |

## Dependencies

| Package | Purpose | Version |
|---------|---------|---------|
| fastify | Web framework | ^5.0.0 |
| @fastify/cors | CORS support | ^10.0.0 |
| @fastify/helmet | Security headers | ^12.0.0 |
| @fastify/rate-limit | Rate limiting | ^10.0.0 |
| @fastify/websocket | WebSocket support | ^11.0.0 |
| @fastify/jwt | JWT handling | ^9.0.0 |
| @fastify/oauth2 | OAuth2 client | ^8.0.0 |
| zod | Schema validation | ^3.23.0 |
| ioredis | Redis client | ^5.4.0 |
| prom-client | Prometheus metrics | ^15.0.0 |
| pino | Logging | ^9.0.0 |

## External Integrations

| Integration | Purpose | Protocol |
|-------------|---------|----------|
| WorkflowEngine (#3) | Workflow orchestration | Internal import |
| MessageRouter (#5) | Decision routing | Internal import |
| JobScheduler (#6) | Background jobs | Internal import |
| Redis | Sessions, rate limits | TCP |
| GitHub API | OAuth2 authentication | HTTPS |

## Configuration

```yaml
orchestrator:
  port: 3000
  host: 0.0.0.0

  redis:
    url: redis://localhost:6379

  auth:
    enabled: true
    providers:
      - apiKey
      - github-oauth2
    github:
      clientId: ${GITHUB_CLIENT_ID}
      clientSecret: ${GITHUB_CLIENT_SECRET}
    jwt:
      secret: ${JWT_SECRET}
      expiresIn: '24h'

  rateLimit:
    max: 100
    timeWindow: '1 minute'
    keyGenerator: 'apiKey'  # Rate limit per API key

  cors:
    origin: true  # Reflect request origin
    credentials: true
```

## Verification Checklist

- [ ] All HTTP endpoints respond with correct status codes
- [ ] WebSocket connections authenticate and receive events
- [ ] Rate limiting enforced per API key
- [ ] GitHub OAuth2 flow completes successfully
- [ ] JWT tokens validated on protected routes
- [ ] Errors formatted as RFC 7807 Problem Details
- [ ] Health check returns service status
- [ ] Prometheus metrics exposed at /metrics
- [ ] Graceful shutdown completes in-flight requests
- [ ] Docker image builds and runs

## Next Steps

Run `/speckit:tasks` to generate detailed task list from this plan.

---

*Generated by speckit*
