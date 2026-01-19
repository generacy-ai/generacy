# Quickstart: Message Router and Channel System

## Prerequisites

- Node.js 18+
- Redis 6+ (running locally or accessible)
- TypeScript 5+

## Installation

```bash
# Install dependencies
npm install

# Ensure Redis is running
redis-cli ping
# Should return: PONG
```

## Basic Usage

### Initialize the Router

```typescript
import { MessageRouter, RouterConfig } from '@generacy/router';

const config: RouterConfig = {
  redis: {
    host: 'localhost',
    port: 6379,
  },
  defaultTtl: 3600000, // 1 hour
  retry: {
    maxAttempts: 5,
    initialDelay: 1000,
    maxDelay: 16000,
    backoffFactor: 2,
  },
};

const router = new MessageRouter(config);
await router.connect();
```

### Register Connections

```typescript
// Register an Agency
router.registerAgency('agency-1', agencyConnection);

// Register a Humancy (VSCode extension)
router.registerHumancy('vscode-1', {
  ...humancyConnection,
  type: 'vscode',
});

// Register a Humancy (Cloud interface)
router.registerHumancy('cloud-1', {
  ...humancyConnection,
  type: 'cloud',
});
```

### Route Messages

```typescript
import { MessageEnvelope } from '@generacy/router';

// Simple routing (fire and forget)
const message: MessageEnvelope = {
  id: crypto.randomUUID(),
  type: 'decision_request',
  source: { type: 'agency', id: 'agency-1' },
  payload: { question: 'Approve deployment?' },
  meta: { timestamp: Date.now() },
};

await router.route(message);

// Request/response with correlation
const response = await router.routeAndWait(message, 30000); // 30s timeout
```

### Broadcast Messages

```typescript
// Broadcast to all agencies
await router.broadcastToAgencies({
  id: crypto.randomUUID(),
  type: 'mode_command',
  source: { type: 'router', id: 'main' },
  payload: { mode: 'autonomous' },
  meta: { timestamp: Date.now() },
});

// Broadcast to all Humancy instances
await router.broadcastToHumancy({
  id: crypto.randomUUID(),
  type: 'workflow_event',
  source: { type: 'router', id: 'main' },
  payload: { event: 'task_completed', taskId: '123' },
  meta: { timestamp: Date.now() },
});
```

### Register Custom Channels

```typescript
// Agency registers a channel
router.registerChannel('debug', async (message, context) => {
  console.log('Debug message:', message.payload);
  await context.reply({ received: true });
});

// Send via channel
await router.route({
  id: crypto.randomUUID(),
  type: 'channel_message',
  channel: 'debug',
  source: { type: 'humancy', id: 'vscode-1' },
  payload: { debug: 'test data' },
  meta: { timestamp: Date.now() },
});
```

### Handle Offline Messages

Messages are automatically queued when recipients are offline:

```typescript
// Messages sent while agency-1 is offline are queued
router.unregister('agency-1');
await router.route(messageForAgency1); // Queued in Redis

// When agency reconnects, queued messages are delivered
router.registerAgency('agency-1', newAgencyConnection);
// Queued messages automatically delivered
```

## Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `redis.host` | `localhost` | Redis server hostname |
| `redis.port` | `6379` | Redis server port |
| `redis.password` | - | Redis password (optional) |
| `defaultTtl` | `3600000` | Default message TTL (ms) |
| `retry.maxAttempts` | `5` | Max retry attempts before DLQ |
| `retry.initialDelay` | `1000` | First retry delay (ms) |
| `retry.maxDelay` | `16000` | Maximum retry delay (ms) |
| `retry.backoffFactor` | `2` | Exponential backoff multiplier |

## Error Handling

```typescript
router.on('error', (error) => {
  console.error('Router error:', error);
});

router.on('dlq', (entry) => {
  console.warn('Message moved to DLQ:', entry.message.id);
});
```

## Cleanup

```typescript
// Unregister connections
router.unregister('agency-1');
router.unregister('vscode-1');

// Disconnect from Redis
await router.disconnect();
```

## Troubleshooting

### Messages not being delivered

1. Check Redis connection: `redis-cli ping`
2. Verify recipient is registered: `router.getConnections()`
3. Check dead letter queue for failures

### Correlation timeouts

1. Ensure response includes matching `correlationId`
2. Increase timeout if network is slow
3. Check if recipient is processing messages

### Redis connection issues

1. Verify Redis is running
2. Check network connectivity
3. Ensure correct host/port in config
4. Check password if authentication is enabled
