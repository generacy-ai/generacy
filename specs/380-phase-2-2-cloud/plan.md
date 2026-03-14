# Implementation Plan: Orchestrator Relay Integration

**Feature**: Wire the cluster-relay client into the orchestrator's startup sequence so that a running cluster automatically connects to generacy-cloud
**Branch**: `380-phase-2-2-cloud`
**Status**: Complete

## Summary

Integrate the `@generacy-ai/cluster-relay` package (Phase 2.1) into the orchestrator so that in full mode, when `GENERACY_API_KEY` is configured, the orchestrator automatically establishes a relay connection to generacy-cloud. The integration covers four concerns:

1. **Startup integration** — Instantiate and connect the relay client during orchestrator startup (full mode only)
2. **API request routing** — Forward incoming `api_request` messages from the relay to the local Fastify server via `inject()`, returning responses through the relay
3. **Event forwarding** — Subscribe to the SSE event bus and forward all channel events (workflows, queue, agents) through the relay
4. **Metadata reporting** — Report cluster metadata on connect/reconnect and periodically refresh it

Since Phase 2.1 (the relay package) is not yet implemented, this issue defines the **integration interface/types contract** that the relay package must satisfy, then builds the orchestrator integration against that contract.

## Technical Context

- **Language**: TypeScript (ESM)
- **Framework**: Fastify (HTTP server), pino (logging)
- **Package manager**: pnpm workspaces
- **Build**: Turbo
- **Key dependencies**: `ioredis`, `zod`, `@fastify/jwt`, `@fastify/cors`
- **Existing pattern**: `SmeeWebhookReceiver` in `packages/orchestrator/src/services/smee-receiver.ts` — provides the reconnection/lifecycle model to follow

## Project Structure

```
packages/orchestrator/src/
├── types/
│   └── relay.ts                     # NEW — Relay client interface contract & message types
├── services/
│   └── relay-bridge.ts              # NEW — RelayBridge: orchestrator ↔ relay integration
├── config/
│   └── schema.ts                    # MODIFY — Add relay configuration schema
│   └── loader.ts                    # MODIFY — Map GENERACY_API_KEY env var
├── server.ts                        # MODIFY — Instantiate RelayBridge in full mode
├── utils/
│   └── shutdown.ts                  # No changes (existing shutdown hooks used)
└── index.ts                         # MODIFY — Re-export relay types
```

## Architecture

### Relay Client Interface Contract

Define a `ClusterRelayClient` interface that Phase 2.1 must implement. This decouples the orchestrator integration from the relay package implementation:

```typescript
interface ClusterRelayClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: RelayMessage): void;
  on(event: 'message', handler: (msg: RelayMessage) => void): void;
  on(event: 'connected', handler: () => void): void;
  on(event: 'disconnected', handler: (reason: string) => void): void;
  on(event: 'error', handler: (error: Error) => void): void;
  readonly isConnected: boolean;
}
```

### RelayBridge Service

A new `RelayBridge` class encapsulates all relay integration logic:

- **Constructor**: Takes a `ClusterRelayClient`, a Fastify server instance, the SSE subscription manager, and configuration
- **`start()`**: Connects relay, subscribes to SSE events, starts metadata reporting timer
- **`stop()`**: Disconnects relay, removes SSE subscriptions, stops metadata timer
- **API routing**: On `api_request` message → `server.inject()` → send `api_response` message
- **Event forwarding**: Hook into `SSESubscriptionManager.broadcast()` or create a dedicated relay subscriber that receives all events
- **Metadata reporting**: On connect + periodic timer, gather and send metadata

### Event Forwarding Strategy

Rather than modifying `SSESubscriptionManager`, the `RelayBridge` creates a synthetic "relay" subscriber that receives broadcasts from all channels. This avoids coupling the relay to SSE internals:

1. Create a `RelayEventForwarder` that listens to the subscription manager
2. On each broadcast event, the forwarder wraps it in a relay `event` message and sends via the relay client
3. The forwarder is registered/unregistered when the relay connects/disconnects

**Alternative considered**: Modifying `SSESubscriptionManager.broadcast()` to also emit to the relay — rejected because it would couple SSE to relay and require changes in the hot path of all broadcasts.

**Chosen approach**: Use a lightweight wrapper that intercepts broadcast calls by decorating the `broadcast` method of the subscription manager. This avoids creating fake HTTP SSE connections while keeping the relay forwarding transparent.

### Metadata Collection

Metadata is collected from available sources, with graceful fallback per Q5 clarification:

| Field | Source | Fallback |
|-------|--------|----------|
| `workerCount` | `.generacy/cluster.yaml` | Omitted if file missing |
| `channel` | `.generacy/cluster.yaml` | Omitted if file missing |
| `activeWorkflowCount` | WorkflowService | `0` |
| `version` | `package.json` version field | `"unknown"` |
| `gitRemotes` | `git remote -v` | Empty array |
| `uptime` | `process.uptime()` | Always available |

### Configuration

Add a `relay` section to `OrchestratorConfigSchema`:

```typescript
relay: {
  apiKey: string | undefined;         // from GENERACY_API_KEY env var
  cloudUrl: string;                   // default: 'wss://api.generacy.ai/relay'
  metadataIntervalMs: number;         // default: 60000
  clusterYamlPath: string;            // default: '.generacy/cluster.yaml'
}
```

### Startup Integration

In `server.ts`, after existing service initialization (full mode block):

1. Check if `config.relay.apiKey` is set
2. If yes, create a `ClusterRelayClient` instance (imported from `@generacy-ai/cluster-relay`)
3. Create a `RelayBridge` with the client, server, and SSE manager
4. Call `relayBridge.start()` — non-blocking, logs connection status
5. On failure, continue in local-only mode (per Q4 clarification)
6. Add `relayBridge.stop()` to the shutdown cleanup array

### Shutdown Integration

The existing `setupGracefulShutdown` cleanup array is extended with a relay disconnect step. This ensures the cloud receives a disconnect event before the process exits.

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Relay in which mode? | Full mode only | Workers are transient; one relay per cluster (Q2) |
| Event forwarding scope | All channels | Cloud needs full visibility for Phase 3 dashboards (Q3) |
| Connection failure behavior | Continue local-only | Relay is optional; must work on laptops over wifi (Q4) |
| Missing cluster.yaml | Connect with partial metadata | Report what's available; don't assume defaults (Q5) |
| Relay client contract | Interface + types only | Phase 2.1 implements; this issue defines the contract (Q1) |
| Event forwarding mechanism | Broadcast decorator pattern | Avoids fake SSE connections; keeps relay transparent |
| API routing | Fastify `inject()` | Zero HTTP overhead; all existing routes automatically available |

## Dependencies

- **Phase 2.1** (`@generacy-ai/cluster-relay`): Must implement the `ClusterRelayClient` interface defined here. Until 2.1 is complete, the relay bridge can be unit-tested with a mock client.
- **Phase 1.8** (cluster.yaml): Optional runtime dependency — metadata collection degrades gracefully without it.

## Testing Strategy

- **Unit tests**: Mock `ClusterRelayClient` to test `RelayBridge` in isolation — API routing, event forwarding, metadata collection, error handling
- **Integration tests**: Use Fastify `inject()` to verify end-to-end API request routing through the bridge
- **Graceful degradation tests**: Verify orchestrator starts normally when API key is missing, when relay connection fails, when cluster.yaml is absent
