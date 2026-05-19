# @generacy-ai/cluster-relay

WebSocket relay client connecting in-cluster orchestrators to Generacy cloud for bidirectional communication.

## Configuration

```typescript
import { loadConfig } from '@generacy-ai/cluster-relay';

const config = loadConfig({
  apiKey: 'your-api-key',
  routes: [
    { prefix: '/control-plane', target: 'unix:///run/generacy-control-plane/control.sock' },
    { prefix: '/monitoring', target: 'http://localhost:9090' },
  ],
  activationCode: 'claim-abc123',       // optional: first-launch claim code
  clusterApiKeyId: 'key-id',            // optional: reconnect API key ID
});
```

### Route Dispatcher

The relay uses a path-prefix dispatcher to route incoming API requests to different backends:

- **Routes** are matched using longest-prefix-match semantics (like nginx `location`).
- The matched prefix is **stripped** before forwarding (e.g., `/control-plane/api/setup` → `/api/setup`).
- Unmatched paths fall back to `orchestratorUrl`.
- Targets can be HTTP URLs (`http://...`) or Unix sockets (`unix:///path/to/sock`).

### Actor Header Propagation

When an `ApiRequestMessage` includes an `actor` field, the relay propagates it as HTTP headers on the forwarded request:

| Field | Header |
|-------|--------|
| `actor.userId` | `x-generacy-actor-user-id` |
| `actor.sessionId` | `x-generacy-actor-session-id` |

Headers are omitted when `actor` is absent.

### Activation

When `activationCode` is set in the config, the relay includes an `activation` field in the WebSocket handshake message:

```json
{
  "type": "handshake",
  "metadata": { ... },
  "activation": {
    "code": "claim-abc123",
    "clusterApiKeyId": "key-id"
  }
}
```

## Usage

```typescript
import { ClusterRelay, loadConfig } from '@generacy-ai/cluster-relay';

const config = loadConfig({ apiKey: process.env.GENERACY_API_KEY });
const relay = new ClusterRelay(config);

relay.on('connected', () => console.log('Connected to cloud'));
relay.on('error', (err) => console.error('Relay error:', err));

await relay.connect();
```
