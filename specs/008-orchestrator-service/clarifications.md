# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-01-19 22:11

### Q1: Web Framework
**Context**: The spec mentions 'Express.js or Fastify' but implementation requires a definite choice. Fastify offers better performance and TypeScript support; Express has a larger ecosystem.
**Question**: Which web framework should be used for the orchestrator service?
**Options**:
- A: Fastify - Better performance, native TypeScript, schema validation
- B: Express - Larger ecosystem, more middleware available, team familiarity

**Answer**: A - Fastify. Fastify is better suited for this project because of native TypeScript support with excellent type inference, built-in schema validation that integrates well with Zod (already used in contracts), better performance characteristics for a high-throughput orchestrator, and the orchestrator is greenfield with no legacy Express middleware to consider.

### Q2: Rate Limiting Strategy
**Context**: Rate limiting is shown in middleware but no configuration specified. This affects API abuse prevention and fair usage policies.
**Question**: What rate limiting strategy should be implemented?
**Options**:
- A: Per-API-key limits (e.g., 100 req/min per key)
- B: Per-endpoint limits (different limits for heavy vs light endpoints)
- C: Tiered limits based on subscription/plan level

**Answer**: A - Per-API-key limits (e.g., 100 req/min per key). Simplest to implement initially, aligns with the progressive adoption model (start simple, add complexity as needed), easy to evolve to tiered limits later when Humancy Cloud enterprise features are added. Per-key limits are standard for developer APIs and match the "API key authentication for CLI/CI" requirement.

### Q3: OAuth2 Provider Scope
**Context**: OAuth2 is listed for Humancy extension authentication, but the specific providers aren't defined. This affects integration requirements.
**Question**: Which OAuth2 provider(s) should be supported initially?
**Options**:
- A: GitHub OAuth only (matches developer workflow)
- B: GitHub + Google OAuth (broader reach)
- C: Custom OAuth2 provider (self-hosted identity)

**Answer**: A - GitHub OAuth only. GitHub is the primary integration (github-issues plugin, GitHub Actions), developer-focused workflow where users are already on GitHub, matches the CLI/CI authentication pattern, and simpler initial implementation with additional providers addable via plugins later.

### Q4: WebSocket Authentication
**Context**: HTTP endpoints use auth middleware, but WebSocket connection authentication isn't specified. This is a security concern.
**Question**: How should WebSocket connections be authenticated?
**Options**:
- A: Token in connection URL query parameter (simpler but less secure)
- B: Token in first message after connection (more secure)
- C: HTTP upgrade request with auth header (standard approach)

**Answer**: C - HTTP upgrade request with auth header. Standard approach used by most production WebSocket APIs, more secure than query parameters (tokens don't leak in logs/referrer headers), compatible with existing HTTP auth middleware, and works seamlessly with both API key and JWT authentication mentioned in the requirements.

### Q5: Error Response Format
**Context**: No error handling format is specified. Consistent error responses are essential for API consumers.
**Question**: What error response format should the API use?
**Options**:
- A: RFC 7807 Problem Details (standard JSON error format)
- B: Simple JSON { error: string, code: number, details?: any }
- C: GraphQL-style { errors: [{ message, path, extensions }] }

**Answer**: A - RFC 7807 Problem Details. Industry standard format (used by Microsoft, Stripe, etc.), works well with TypeScript with strict types for problem details, extensible via the extensions object for additional context, and aligns with the "Thin, Stable Contracts" and "Additive-Only Changes" principles from the architecture docs.

