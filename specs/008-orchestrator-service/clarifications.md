# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-01-19 22:11

### Q1: Web Framework
**Context**: The spec mentions 'Express.js or Fastify' but implementation requires a definite choice. Fastify offers better performance and TypeScript support; Express has a larger ecosystem.
**Question**: Which web framework should be used for the orchestrator service?
**Options**:
- A: Fastify - Better performance, native TypeScript, schema validation
- B: Express - Larger ecosystem, more middleware available, team familiarity

**Answer**: *Pending*

### Q2: Rate Limiting Strategy
**Context**: Rate limiting is shown in middleware but no configuration specified. This affects API abuse prevention and fair usage policies.
**Question**: What rate limiting strategy should be implemented?
**Options**:
- A: Per-API-key limits (e.g., 100 req/min per key)
- B: Per-endpoint limits (different limits for heavy vs light endpoints)
- C: Tiered limits based on subscription/plan level

**Answer**: *Pending*

### Q3: OAuth2 Provider Scope
**Context**: OAuth2 is listed for Humancy extension authentication, but the specific providers aren't defined. This affects integration requirements.
**Question**: Which OAuth2 provider(s) should be supported initially?
**Options**:
- A: GitHub OAuth only (matches developer workflow)
- B: GitHub + Google OAuth (broader reach)
- C: Custom OAuth2 provider (self-hosted identity)

**Answer**: *Pending*

### Q4: WebSocket Authentication
**Context**: HTTP endpoints use auth middleware, but WebSocket connection authentication isn't specified. This is a security concern.
**Question**: How should WebSocket connections be authenticated?
**Options**:
- A: Token in connection URL query parameter (simpler but less secure)
- B: Token in first message after connection (more secure)
- C: HTTP upgrade request with auth header (standard approach)

**Answer**: *Pending*

### Q5: Error Response Format
**Context**: No error handling format is specified. Consistent error responses are essential for API consumers.
**Question**: What error response format should the API use?
**Options**:
- A: RFC 7807 Problem Details (standard JSON error format)
- B: Simple JSON { error: string, code: number, details?: any }
- C: GraphQL-style { errors: [{ message, path, extensions }] }

**Answer**: *Pending*

