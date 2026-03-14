# Feature Specification: Create @generacy-ai/cluster-relay WebSocket Client Package

**Branch**: `379-phase-2-1-cloud` | **Date**: 2026-03-14 | **Status**: Draft

## Summary

New package in the generacy monorepo (`packages/cluster-relay/`) providing a WebSocket client that connects a running cluster to generacy-cloud for bidirectional communication. The relay is the foundational infrastructure enabling all paid cloud features — it allows the cloud UI to interact with a developer's local/remote cluster without requiring inbound port exposure.

## Context

A developer on a laptop over public wifi should be able to connect their local cluster to the cloud UI seamlessly. The relay establishes an outbound WebSocket connection from the cluster to the cloud relay service, enabling the cloud to proxy API requests to the cluster and the cluster to forward events (SSE, conversation streams, status updates) to the cloud. This is the first piece of the cloud platform buildout; the cloud relay service (issue 2.3) develops in parallel, and orchestrator integration (issue 2.2) consumes this package.

## Technical Design

### Package Setup
- New package: `packages/cluster-relay/`
- Package name: `@generacy-ai/cluster-relay`
- TypeScript, minimal dependencies

### WebSocket Client
- Connects to `wss://api.generacy.ai/relay` (configurable endpoint)
- Authenticates on handshake using the project's API key (from `GENERACY_API_KEY` env var or `.env.local`)
- Maintains persistent connection with ping/pong heartbeat
- Exponential backoff reconnection: 5s -> 10s -> 20s -> 40s -> 80s -> 160s -> 300s (max)
  - Follow the pattern established in `packages/orchestrator/src/services/smee-receiver.ts`

### Message Types
Messages are typed with a discriminated union:
```typescript
type RelayMessage =
  | { type: 'api_request'; id: string; method: string; path: string; headers?: Record<string,string>; body?: any }
  | { type: 'api_response'; id: string; status: number; headers?: Record<string,string>; body?: any }
  | { type: 'event'; channel: string; event: any }
  | { type: 'conversation'; conversationId: string; data: any }
  | { type: 'heartbeat' }
  | { type: 'handshake'; metadata: ClusterMetadata }
  | { type: 'error'; code: string; message: string }
```

### Cluster Metadata on Handshake
```typescript
interface ClusterMetadata {
  workerCount: number;
  activeWorkflows: number;
  channel: 'preview' | 'stable';
  orchestratorVersion: string;
  gitRemotes: { name: string; url: string }[];
  uptime: number;
}
```

### Multiplexing
- Single WebSocket connection carries all message types
- Request/response correlation via message `id` field
- Multiple simultaneous API requests supported
- Event and conversation streams are independent channels

### Lifecycle
- **Startup**: connect, authenticate, send handshake with metadata
- **Running**: process incoming messages, forward events
- **Shutdown**: graceful disconnect with close frame
- **Reconnection**: automatic with backoff, re-authenticate and re-send metadata

### API Request Proxying
- Receive `api_request` messages from cloud
- Forward to local orchestrator HTTP API (e.g., `http://localhost:3020`)
- Return `api_response` with status, headers, body
- Timeout handling for slow requests

### Technical Notes
- Use native `WebSocket` (Node.js 22+ has built-in WebSocket) or `ws` package
- Runnable as a standalone process or importable as a library
- Export a `ClusterRelay` class with `connect()`, `disconnect()`, `onMessage()` methods
- Include a CLI entry point: `npx @generacy-ai/cluster-relay` for standalone use

### Reference
See `docs/cloud-platform-buildout-reference.md` in tetrad-development for full architectural context.

## User Stories

### US1: Developer Connects Cluster to Cloud

**As a** developer running a generacy cluster locally,
**I want** the cluster to automatically connect to generacy-cloud via WebSocket,
**So that** I can manage and monitor my cluster from the cloud UI without exposing inbound ports.

**Acceptance Criteria**:
- [ ] Setting `GENERACY_API_KEY` and starting the relay establishes a persistent WebSocket connection to the cloud
- [ ] The relay sends cluster metadata (worker count, active workflows, version, git remotes, uptime) on handshake
- [ ] Connection works over restrictive networks (NAT, firewalls) since it's outbound-only
- [ ] The relay reconnects automatically with exponential backoff if the connection drops

### US2: Cloud UI Proxies API Requests to Cluster

**As a** cloud UI user,
**I want** to invoke orchestrator API endpoints through the cloud,
**So that** I can trigger workflows, view status, and interact with my cluster remotely.

**Acceptance Criteria**:
- [ ] Cloud sends `api_request` messages that the relay forwards to the local orchestrator HTTP API
- [ ] The relay returns `api_response` messages with status, headers, and body
- [ ] Multiple simultaneous API requests are supported via request/response ID correlation
- [ ] Timed-out requests return an appropriate error response

### US3: Cluster Streams Events to Cloud

**As a** cloud UI user,
**I want** to receive real-time SSE events and conversation streams from my cluster,
**So that** I can see live workflow progress and agent interactions in the cloud dashboard.

**Acceptance Criteria**:
- [ ] The relay forwards SSE events from the orchestrator to the cloud via `event` messages
- [ ] Conversation stream data is forwarded via `conversation` messages
- [ ] Event and conversation channels are independent and can stream concurrently
- [ ] The cloud receives events with minimal latency

### US4: Standalone CLI Usage

**As a** developer,
**I want** to run the relay as a standalone process via `npx @generacy-ai/cluster-relay`,
**So that** I can connect to the cloud without modifying my existing orchestrator setup.

**Acceptance Criteria**:
- [ ] `npx @generacy-ai/cluster-relay` starts the relay with configuration from env vars
- [ ] The relay can also be imported and used programmatically as a library
- [ ] Graceful shutdown on SIGINT/SIGTERM with proper WebSocket close frame

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | WebSocket connection to configurable cloud endpoint with API key auth | P1 | Default: `wss://api.generacy.ai/relay` |
| FR-002 | Exponential backoff reconnection (5s to 300s max) | P1 | Follow `smee-receiver.ts` pattern |
| FR-003 | Ping/pong heartbeat to maintain persistent connection | P1 | Detect stale connections |
| FR-004 | Handshake with ClusterMetadata on connect/reconnect | P1 | |
| FR-005 | Receive and proxy `api_request` to local orchestrator | P1 | Default target: `http://localhost:3020` |
| FR-006 | Return `api_response` with status, headers, body | P1 | Correlated by message `id` |
| FR-007 | Forward SSE events as `event` messages to cloud | P1 | |
| FR-008 | Forward conversation streams as `conversation` messages | P1 | |
| FR-009 | Typed discriminated union for all message types | P1 | TypeScript compile-time safety |
| FR-010 | Request timeout handling for slow API proxying | P2 | Return error response on timeout |
| FR-011 | `ClusterRelay` class with `connect()`, `disconnect()`, `onMessage()` | P1 | Library API |
| FR-012 | CLI entry point for standalone usage | P2 | `npx @generacy-ai/cluster-relay` |
| FR-013 | Graceful shutdown with WebSocket close frame | P1 | SIGINT/SIGTERM handling |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Connection establishment | < 2s on good network | Time from `connect()` to handshake complete |
| SC-002 | Reconnection reliability | Auto-reconnects within backoff schedule | Simulate disconnects in tests |
| SC-003 | API proxy round-trip latency | < 50ms overhead added | Measure relay overhead vs direct HTTP |
| SC-004 | Concurrent request support | 50+ simultaneous requests | Load test with parallel `api_request` messages |
| SC-005 | Package size | Minimal dependencies | Audit `node_modules` size |

## Assumptions

- Node.js 22+ is the target runtime (built-in WebSocket available)
- The cloud relay service (`wss://api.generacy.ai/relay`) will accept the same message protocol defined here
- The local orchestrator HTTP API is accessible at a configurable localhost endpoint
- API key authentication is sufficient for the initial release (no OAuth/JWT rotation needed yet)

## Out of Scope

- Cloud-side relay service implementation (issue 2.3)
- Orchestrator integration to auto-start the relay (issue 2.2)
- End-to-end encryption beyond TLS (WSS provides transport encryption)
- Multi-cluster management from a single cloud account
- Rate limiting or quota enforcement (cloud-side concern)
- Web UI for relay configuration

---

*Generated by speckit*
