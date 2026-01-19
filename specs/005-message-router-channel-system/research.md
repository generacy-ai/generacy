# Research: Message Router and Channel System

## Technology Decisions

### Redis for Message Persistence

**Decision**: Use Redis for all message persistence and pub/sub needs.

**Rationale**:
- Already part of standard Generacy stack (per architecture docs)
- No additional infrastructure dependencies
- Native features align perfectly with requirements:
  - Pub/sub for real-time message routing
  - Streams for reliable message delivery with acknowledgment
  - TTL on keys for automatic message expiration
  - Persistence options for durability

**Alternatives Considered**:
| Option | Pros | Cons |
|--------|------|------|
| In-memory only | Simple, fast | Data loss on restart |
| SQLite | Local, no server | No pub/sub, polling needed |
| RabbitMQ | Purpose-built | Additional dependency |
| PostgreSQL | ACID, familiar | Overkill, no native pub/sub |

### ioredis vs node-redis

**Decision**: Use `ioredis` as the Redis client.

**Rationale**:
- Better TypeScript support
- Built-in connection pooling
- Cluster support out of the box
- More active maintenance
- Cleaner async/await API

### Exponential Backoff for Retries

**Decision**: Use exponential backoff with jitter for retry policy.

**Rationale**:
- Industry standard for distributed systems
- Prevents thundering herd during outages
- Allows transient failures to self-resolve
- Configurable per deployment needs

**Implementation Pattern**:
```typescript
function calculateDelay(attempt: number, config: RetryConfig): number {
  const delay = config.initialDelay * Math.pow(config.backoffFactor, attempt);
  const jitter = Math.random() * 0.1 * delay; // 10% jitter
  return Math.min(delay + jitter, config.maxDelay);
}
```

### Broadcast vs. Targeted Routing for Humancy

**Decision**: Broadcast to all connected Humancy instances.

**Rationale**:
- Ensures visibility from any interface (VSCode, cloud)
- Supports centralized decision queue view
- Correlation IDs handle response routing
- Aligns with "urgency triage" philosophy

**Consideration**: May need rate limiting if many Humancy instances connect.

## Implementation Patterns

### Message Envelope Pattern

All messages wrapped in standard envelope:
```typescript
interface MessageEnvelope {
  id: string;           // Unique message ID
  correlationId?: string; // For request/response pairing
  type: MessageType;    // Routing rule selector
  channel?: string;     // Plugin-defined channel
  source: {
    type: 'agency' | 'humancy';
    id: string;
  };
  destination?: {
    type: 'agency' | 'humancy';
    id: string;
  };
  payload: unknown;     // Message-specific data
  meta: {
    timestamp: number;
    ttl?: number;       // Override default TTL
    priority?: number;  // Future: priority queuing
  };
}
```

### Connection Lifecycle Pattern

```typescript
// Registration
registry.register(id, connection);

// Health checking
connection.onDisconnect(() => {
  registry.markOffline(id);
  queueMessagesForReconnect(id);
});

// Reconnection
connection.onReconnect(() => {
  registry.markOnline(id);
  deliverQueuedMessages(id);
});

// Cleanup
registry.unregister(id);
```

### Correlation Manager Pattern

```typescript
class CorrelationManager {
  private pending = new Map<string, PendingRequest>();

  async waitForCorrelation(
    correlationId: string,
    timeout: number
  ): Promise<MessageEnvelope> {
    const deferred = createDeferred<MessageEnvelope>();
    this.pending.set(correlationId, { deferred, timeout });

    setTimeout(() => {
      if (this.pending.has(correlationId)) {
        this.pending.delete(correlationId);
        deferred.reject(new TimeoutError(correlationId));
      }
    }, timeout);

    return deferred.promise;
  }

  correlate(correlationId: string, response: MessageEnvelope): boolean {
    const pending = this.pending.get(correlationId);
    if (pending) {
      this.pending.delete(correlationId);
      pending.deferred.resolve(response);
      return true;
    }
    return false;
  }
}
```

## Key Sources

1. **Redis Streams Documentation**: https://redis.io/docs/data-types/streams/
2. **ioredis GitHub**: https://github.com/redis/ioredis
3. **Enterprise Integration Patterns**: Message routing patterns
4. **AWS Best Practices**: Exponential backoff and jitter

## Open Questions (Resolved)

1. ✅ Storage mechanism → Redis (clarification Q1)
2. ✅ Retry policy → Exponential backoff (clarification Q2)
3. ✅ Default TTL → 1 hour (clarification Q3)
4. ✅ Channel routing → Dynamic registration (clarification Q4)
5. ✅ Multi-Humancy routing → Broadcast (clarification Q5)
