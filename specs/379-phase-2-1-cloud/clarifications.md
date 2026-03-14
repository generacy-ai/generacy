# Clarifications: Create @generacy-ai/cluster-relay WebSocket Client Package

## Batch 1 — 2026-03-14

### Q1: Event Forwarding Mechanism
**Context**: The relay must forward SSE events from the local orchestrator to the cloud. The orchestrator exposes SSE endpoints (`/events`, `/workflows/:id/events`, `/queue/events`) that require JWT authentication and have connection limits (max 3 per user). The relay needs a clear strategy for subscribing to these event streams.
**Question**: How should the relay subscribe to the local orchestrator's SSE events for forwarding? Should it open its own SSE connection(s) to the orchestrator's `/events` endpoint, or should the orchestrator push events to the relay through a different mechanism (e.g., in-process event emitter when used as a library)?
**Options**:
- A: Relay opens SSE connection(s) to the orchestrator's HTTP SSE endpoints (works in both standalone and library mode)
- B: In library mode, the orchestrator passes events directly to the relay via an in-process API; in standalone CLI mode, the relay connects to SSE endpoints
- C: The relay only handles API request proxying; event forwarding is deferred to the orchestrator integration (issue 2.2)

**Answer**: *Pending*

### Q2: Local Orchestrator Authentication
**Context**: The orchestrator's HTTP API and SSE endpoints require JWT authentication. When the relay proxies `api_request` messages from the cloud to the local orchestrator, and when it subscribes to SSE events, it needs valid credentials. The authentication strategy affects both API proxying and event forwarding.
**Question**: How should the relay authenticate with the local orchestrator? Should it use a shared secret/JWT, connect unauthenticated (assuming localhost trust), or receive auth credentials as configuration?
**Options**:
- A: Relay receives a local orchestrator JWT/token as configuration (env var or constructor param)
- B: Local orchestrator trusts localhost connections without authentication (relay only runs locally)
- C: Relay uses the same `GENERACY_API_KEY` to authenticate with both the cloud and local orchestrator

**Answer**: *Pending*

### Q3: ClusterMetadata Collection in Standalone Mode
**Context**: The handshake requires sending `ClusterMetadata` (workerCount, activeWorkflows, orchestratorVersion, gitRemotes, uptime). When the relay is imported as a library by the orchestrator (issue 2.2), the caller can provide this data. But in standalone CLI mode (`npx @generacy-ai/cluster-relay`), the relay doesn't inherently know these values.
**Question**: In standalone CLI mode, how should the relay collect cluster metadata? Should it query the orchestrator's HTTP API (e.g., a `/health` or `/metrics` endpoint), accept partial metadata via CLI flags/env vars, or send a minimal/empty metadata payload?
**Options**:
- A: Query the orchestrator's health/metrics API endpoint to collect metadata automatically
- B: Accept metadata values via CLI flags or env vars, with sensible defaults for missing fields
- C: Send minimal metadata in standalone mode (just what's locally available like git remotes); full metadata only when used as a library

**Answer**: *Pending*

### Q4: Conversation Stream Definition
**Context**: The spec defines a `conversation` message type (`{ type: 'conversation'; conversationId: string; data: any }`) for forwarding "conversation streams." However, the orchestrator's current SSE event types don't include a specific "conversation" event — they cover workflow, queue, agent, and system events. It's unclear what data source backs this message type.
**Question**: What constitutes a "conversation stream" in this context? Is it a future concept that the relay should define the type for but not implement forwarding yet? Or does it map to an existing orchestrator event type (e.g., agent events)?

**Answer**: *Pending*

### Q5: Default Orchestrator Target Port
**Context**: The spec example uses `http://localhost:3020` as the orchestrator target, but the actual orchestrator configuration defaults to port 3000 (`ORCHESTRATOR_PORT` env var, default 3000 in `config/schema.ts`). The relay needs a correct default for the proxying target.
**Question**: What should the relay's default orchestrator target URL be? `http://localhost:3000` (matching current orchestrator default) or `http://localhost:3020` (as stated in the spec example)?
**Options**:
- A: `http://localhost:3000` (matches actual orchestrator default)
- B: `http://localhost:3020` (as specified in the issue)
- C: No default — require explicit configuration

**Answer**: *Pending*
