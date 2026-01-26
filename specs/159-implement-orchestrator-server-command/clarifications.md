# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-01-26 02:27

### Q1: Orchestrator Relationship
**Context**: The codebase already has `packages/orchestrator/` with a Fastify server for cloud workflow management (workflows, queue, auth, SSE). The issue describes a different worker orchestrator for job distribution. This creates potential confusion.
**Question**: Should the `generacy orchestrator` CLI command reuse/extend the existing `packages/orchestrator/` server, or create a completely new server implementation in `packages/generacy/src/orchestrator/server.ts`?
**Options**:
- A: Reuse `packages/orchestrator/` - Add worker routes to existing Fastify server and create CLI command that wraps it
- B: New implementation - Create separate server in `packages/generacy/` focused only on worker coordination (no cloud features)

**Answer**: *Pending*

### Q2: API Route Prefix
**Context**: The existing `OrchestratorClient` in `packages/generacy/src/orchestrator/client.ts` uses `/api/*` prefixed routes (e.g., `/api/workers/register`). The issue spec lists routes without prefix (e.g., `/workers/register`).
**Question**: Should the new orchestrator server use the `/api/*` prefix to match the existing client, or should both be updated?
**Options**:
- A: Use `/api/*` prefix - Match existing client implementation (e.g., `/api/workers/register`)
- B: No prefix - Update the OrchestratorClient to use non-prefixed routes

**Answer**: *Pending*

### Q3: Redis Requirement
**Context**: The spec mentions 'Manages job queue using Redis' but doesn't specify whether Redis is required or optional. In devcontainer environments, Redis may not always be available.
**Question**: Is Redis required for the orchestrator, or should there be an in-memory fallback for development/testing?
**Options**:
- A: Redis required - Orchestrator fails to start without Redis connection
- B: Optional with fallback - Use in-memory queue when Redis unavailable (with warning)

**Answer**: *Pending*

### Q4: Worker Authentication
**Context**: The existing cloud orchestrator uses API keys and JWT tokens for authentication. The `OrchestratorClient` supports an `authToken` option but the issue doesn't specify auth requirements for workers.
**Question**: Should worker registration and heartbeats require authentication, or is the worker orchestrator internal/trusted?
**Options**:
- A: Authenticated - Workers must provide a token (ORCHESTRATOR_TOKEN env var already supported)
- B: Unauthenticated - Trust workers on internal network (simpler for devcontainer setup)

**Answer**: *Pending*

