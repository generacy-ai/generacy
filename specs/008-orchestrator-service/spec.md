# Feature Specification: Orchestrator service

**Branch**: `008-orchestrator-service` | **Date**: 2026-01-19 | **Status**: Draft

## Summary

Implement the orchestrator service - the main API server for Generacy.

## Technical Decisions

The following decisions were made during the clarification phase:

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Web Framework | **Fastify** | Native TypeScript support, built-in schema validation (integrates with Zod), better performance for high-throughput orchestrator |
| Rate Limiting | **Per-API-key limits** | Start simple (100 req/min), align with progressive adoption model, can evolve to tiered limits later |
| OAuth2 Provider | **GitHub OAuth only** | GitHub is primary integration, developer-focused workflow, simpler initial implementation |
| WebSocket Auth | **HTTP upgrade with auth header** | Standard approach, secure (no token leakage), compatible with existing HTTP auth middleware |
| Error Format | **RFC 7807 Problem Details** | Industry standard, TypeScript-friendly, extensible, aligns with stable contracts principles |

## Parent Epic

#7 - Generacy Services

## Dependencies

- #2 - Generacy Core Package
- #3 - Workflow engine
- #5 - Message router
- #6 - Job scheduler

## Requirements

### HTTP API

```
POST   /workflows              Create and start workflow
GET    /workflows              List workflows
GET    /workflows/:id          Get workflow details
POST   /workflows/:id/pause    Pause workflow
POST   /workflows/:id/resume   Resume workflow
DELETE /workflows/:id          Cancel workflow

GET    /queue                  Get decision queue
POST   /queue/:id/respond      Submit decision response

GET    /agents                 List connected agents
GET    /integrations           Get integration status

GET    /health                 Health check
GET    /metrics                Prometheus metrics
```

### WebSocket API

```typescript
// Client → Server
{ type: 'subscribe', channels: ['workflows', 'queue'] }
{ type: 'unsubscribe', channels: ['workflows'] }

// Server → Client
{ type: 'workflow_event', payload: WorkflowEvent }
{ type: 'queue_update', payload: DecisionQueueItem[] }
{ type: 'agent_status', payload: AgentStatus }
```

### Authentication

- API key authentication for CLI/CI (with per-key rate limiting: 100 req/min default)
- GitHub OAuth2 for Humancy extension
- JWT tokens for sessions
- WebSocket connections authenticated via HTTP upgrade request with auth header

### Server Implementation

```typescript
// Fastify with TypeScript
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';

const app = Fastify({ logger: true });

// Middleware (Fastify plugins)
await app.register(cors, { origin: true });
await app.register(helmet);
await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
await app.register(websocket);

// Routes
app.register(workflowRoutes, { prefix: '/workflows' });
app.register(queueRoutes, { prefix: '/queue' });
app.register(agentRoutes, { prefix: '/agents' });
app.register(integrationRoutes, { prefix: '/integrations' });
app.register(healthRoutes, { prefix: '/health' });

// WebSocket with auth via upgrade headers
app.register(async (fastify) => {
  fastify.get('/ws', { websocket: true }, webSocketHandler);
});
```

### Error Response Format

RFC 7807 Problem Details format:
```typescript
interface ProblemDetails {
  type: string;       // URI reference identifying the problem type
  title: string;      // Short summary
  status: number;     // HTTP status code
  detail?: string;    // Explanation specific to this occurrence
  instance?: string;  // URI reference to the specific occurrence
  extensions?: Record<string, unknown>; // Additional context
}
```

### Configuration

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

  rateLimit:
    max: 100
    timeWindow: '1 minute'
      
  cors:
    origins:
      - http://localhost:*
```

### Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist ./dist
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

## Acceptance Criteria

- [ ] HTTP API endpoints work
- [ ] WebSocket streaming works
- [ ] Authentication enforced
- [ ] Health check endpoint
- [ ] Prometheus metrics exposed
- [ ] Graceful shutdown
- [ ] Docker image builds

## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
