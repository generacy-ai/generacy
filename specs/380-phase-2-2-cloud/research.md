# Research: Orchestrator Relay Integration

## Technology Decisions

### 1. Fastify `inject()` for API Request Routing

**Decision**: Use Fastify's built-in `inject()` method to route relay API requests to local handlers.

**Rationale**:
- Zero HTTP overhead — no TCP connection or socket allocation
- All existing orchestrator API endpoints are automatically available via relay with no code changes
- The relay becomes a transparent proxy; the orchestrator doesn't need to know if a request came from relay or direct HTTP
- Battle-tested in Fastify's own test suite; designed for exactly this use case

**Alternative considered**: Registering a separate set of relay-specific route handlers — rejected because it would duplicate route logic and require maintenance of two code paths.

**Reference**: https://fastify.dev/docs/latest/Guides/Testing/#inject

### 2. Event Forwarding via Broadcast Decoration

**Decision**: Decorate the `SSESubscriptionManager`'s `broadcast` method to also forward events through the relay, rather than creating a fake SSE connection or modifying the manager's internals.

**Rationale**:
- SSE streams require Node.js `ServerResponse` objects — creating a fake one for the relay would be fragile
- Modifying `SSESubscriptionManager.broadcast()` directly would couple SSE to relay permanently
- A decorator approach is non-invasive: wrap the original `broadcast` to add relay forwarding, and unwrap on disconnect

**Pattern**:
```typescript
// On relay connect:
const originalBroadcast = sseManager.broadcast.bind(sseManager);
sseManager.broadcast = (channel, event) => {
  const count = originalBroadcast(channel, event);
  relayClient.send({ type: 'event', channel, event });
  return count;
};
```

### 3. SmeeWebhookReceiver as Lifecycle Model

**Decision**: Follow the `SmeeWebhookReceiver` pattern for relay connection lifecycle.

**Rationale**:
- Already proven in the codebase for WebSocket-like persistent connections
- Implements the exact reconnection pattern specified in the reference doc (exponential backoff 5s→300s)
- Uses `AbortController` for clean shutdown — same pattern works for relay
- Consistent developer experience across similar services

**Key patterns borrowed**:
- `start()`/`stop()` lifecycle with `running` flag
- `AbortController`-based cancellation
- Exponential backoff with cap
- Non-blocking startup (fire-and-forget with error logging)

### 4. Partial Metadata on Missing cluster.yaml

**Decision**: Connect to relay with whatever metadata is available; omit fields that require cluster.yaml.

**Rationale** (from clarification Q5):
- Option A (sensible defaults) would assume values that may be wrong
- Option B (skip relay) would block cloud connectivity unnecessarily
- Option C (partial metadata) is honest — reports what's known, lets dashboard show incomplete state
- Aligns with progressive onboarding where `devcontainer_configured` comes before `cluster_connected`

### 5. Interface-Only Contract for Relay Client

**Decision**: Define a TypeScript interface (`ClusterRelayClient`) that Phase 2.1 must implement, rather than creating the full relay package.

**Rationale** (from clarification Q1):
- Phase dependency chart shows 2.1 is a prerequisite for 2.2
- Defining the interface here lets this spec proceed without merging two issues
- The relay package gets its own implementation spec (2.1)
- Integration tests can use a mock client against the interface

## Implementation Patterns

### Message Type System

Relay messages use a discriminated union pattern with `type` field:

```typescript
type RelayMessage =
  | { type: 'api_request'; id: string; method: string; url: string; headers?: Record<string, string>; body?: unknown }
  | { type: 'api_response'; id: string; statusCode: number; headers: Record<string, string>; body: unknown }
  | { type: 'event'; channel: SSEChannel; event: SSEEvent }
  | { type: 'metadata'; data: ClusterMetadata }
```

Each `api_request` carries a unique `id` that is echoed in the corresponding `api_response`, enabling request-response correlation over the single WebSocket connection.

### Metadata Collection Strategy

Metadata is gathered from multiple sources with independent error handling:

1. **Static metadata** (collected once at startup): version, git remotes
2. **Dynamic metadata** (refreshed periodically): active workflow count, uptime, worker count from cluster.yaml
3. Each source is wrapped in try/catch — individual failures don't prevent metadata reporting

### Error Isolation

The relay bridge must never crash the orchestrator:

- All relay operations wrapped in try/catch
- Connection failures logged, not thrown
- Event forwarding failures logged per-event, not per-batch
- Metadata collection failures result in partial metadata, not skipped reporting

## Key Sources

- Cloud Platform Buildout Reference: `/workspaces/tetrad-development/docs/cloud-platform-buildout-reference.md`
- SmeeWebhookReceiver (reconnection pattern): `packages/orchestrator/src/services/smee-receiver.ts`
- SSE Subscription Manager: `packages/orchestrator/src/sse/subscriptions.ts`
- Fastify inject() docs: https://fastify.dev/docs/latest/Guides/Testing/#inject
- Orchestrator config schema: `packages/orchestrator/src/config/schema.ts`
