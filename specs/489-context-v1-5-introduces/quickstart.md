# Quickstart: Cluster-relay protocol additions and path-prefix dispatcher

## Prerequisites

- Node.js >= 20
- pnpm
- Working `packages/cluster-relay/` checkout

## Setup

```bash
cd packages/cluster-relay
pnpm install
```

## Run Tests

```bash
pnpm test          # Run all tests once
pnpm test:watch    # Watch mode
```

## Configuration

### Basic (no routes — existing behavior)

```typescript
const relay = new ClusterRelay({
  apiKey: 'your-api-key',
  orchestratorUrl: 'http://localhost:3000',
});
```

### With path-prefix dispatcher

```typescript
const relay = new ClusterRelay({
  apiKey: 'your-api-key',
  orchestratorUrl: 'http://localhost:3000', // fallback for unmatched paths
  routes: [
    {
      prefix: '/control-plane',
      target: 'unix:///run/generacy-control-plane/control.sock',
    },
    {
      prefix: '/monitoring',
      target: 'http://localhost:9090',
    },
  ],
});
```

### With activation (first-launch)

```typescript
const relay = new ClusterRelay({
  apiKey: 'your-api-key',
  orchestratorUrl: 'http://localhost:3000',
  activationCode: 'abc123',
  clusterApiKeyId: 'key-id-456',
});
```

## Routing Behavior

| Request Path | Matched Route | Forwarded To |
|-------------|---------------|-------------|
| `/control-plane/api/setup` | `/control-plane` | Unix socket → `/api/setup` |
| `/control-plane/state` | `/control-plane` | Unix socket → `/state` |
| `/monitoring/metrics` | `/monitoring` | `http://localhost:9090/metrics` |
| `/api/conversations` | None (fallback) | `http://localhost:3000/api/conversations` |

## Actor Header Propagation

When a cloud-relayed API request includes `actor`:

```json
{
  "type": "api_request",
  "correlationId": "abc",
  "method": "POST",
  "path": "/control-plane/api/setup",
  "actor": { "userId": "user-123", "sessionId": "sess-456" }
}
```

The forwarded HTTP request includes:
```
x-generacy-actor-user-id: user-123
x-generacy-actor-session-id: sess-456
```

## Troubleshooting

**Unix socket connection refused**: Ensure the target service is running and the socket file exists at the configured path.

**Routes not matching**: Routes use longest-prefix-match. Verify your prefix starts with `/` and doesn't have a trailing slash mismatch.

**Existing tests failing**: All new fields are optional — existing message shapes must still parse. Run `pnpm test` to verify backward compatibility.
