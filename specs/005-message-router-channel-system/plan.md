# Implementation Plan: Message Router and Channel System

**Feature**: Message routing system connecting Agency instances with Humancy
**Branch**: `005-message-router-channel-system`
**Status**: Complete

## Summary

Implement a message routing system that:
1. Connects multiple Agency instances to multiple Humancy interfaces (VSCode, cloud)
2. Routes messages bidirectionally with correlation tracking for request/response patterns
3. Persists messages for offline recipients using Redis
4. Provides dead letter queue with exponential backoff retry policy
5. Supports dynamic channel registration for plugin-defined communication

## Technical Context

- **Language**: TypeScript
- **Runtime**: Node.js
- **Storage**: Redis (message persistence, pub/sub)
- **Dependencies**:
  - `ioredis` - Redis client with TypeScript support
  - `uuid` - Correlation ID generation
  - External schemas from `generacy-ai/contracts` (#5, #6, #7)

## Project Structure

```
src/
├── router/
│   ├── index.ts                    # Public exports
│   ├── message-router.ts           # Core MessageRouter class
│   ├── correlation-manager.ts      # Request/response correlation
│   └── routing-rules.ts            # Message type routing logic
├── connections/
│   ├── index.ts                    # Public exports
│   ├── agency-connection.ts        # AgencyConnection interface/impl
│   ├── humancy-connection.ts       # HumancyConnection interface/impl
│   └── connection-registry.ts      # Connection lifecycle management
├── channels/
│   ├── index.ts                    # Public exports
│   ├── channel-registry.ts         # Dynamic channel registration
│   └── channel-handler.ts          # Channel message routing
├── persistence/
│   ├── index.ts                    # Public exports
│   ├── redis-store.ts              # Redis persistence adapter
│   ├── message-queue.ts            # Offline message queuing
│   └── dead-letter-queue.ts        # Failed message handling
├── types/
│   ├── index.ts                    # Public exports
│   ├── messages.ts                 # MessageEnvelope, MessageHandler
│   ├── connections.ts              # Connection interfaces
│   └── channels.ts                 # Channel types
└── utils/
    ├── retry.ts                    # Exponential backoff utility
    └── ttl.ts                      # TTL calculation helpers

tests/
├── router/
│   ├── message-router.test.ts
│   └── correlation-manager.test.ts
├── connections/
│   └── connection-registry.test.ts
├── channels/
│   └── channel-registry.test.ts
└── persistence/
    ├── message-queue.test.ts
    └── dead-letter-queue.test.ts
```

## Key Technical Decisions

### 1. Redis for Message Persistence
- Already part of standard Generacy stack (no new dependencies)
- Native pub/sub for real-time routing
- Built-in TTL support for message expiration
- Streams for reliable message delivery

### 2. Exponential Backoff Retry Policy
- Prevents thundering herd on transient failures
- Default: 1s, 2s, 4s, 8s, 16s (max 5 retries)
- Configurable max delay and retry count

### 3. Broadcast to All Humancy Instances
- Decision requests visible from any interface
- Correlation IDs route responses back to correct Agency
- Supports centralized decision queue view

### 4. Dynamic Channel Registration
- Plugins register channels via `registerChannel(name, handler)`
- Discovery via `findChannel(name)`
- Standard envelope with `channel` field for routing

### 5. 1-Hour Default TTL
- Handles temporary disconnections
- Prevents stale request accumulation
- Overridable via `meta.ttl` in envelope

## Implementation Phases

### Phase 1: Core Types and Interfaces
- Define MessageEnvelope, MessageHandler types
- Define AgencyConnection, HumancyConnection interfaces
- Set up project structure

### Phase 2: Connection Management
- Implement ConnectionRegistry
- Agency/Humancy connection lifecycle
- Registration and unregistration

### Phase 3: Basic Routing
- Implement MessageRouter core
- Route by message type (5 routing rules)
- Broadcast to multiple Humancy instances

### Phase 4: Correlation Tracking
- Implement CorrelationManager
- routeAndWait with timeout
- Request/response pairing

### Phase 5: Redis Persistence
- Implement RedisStore adapter
- Message queuing for offline recipients
- Deliver on reconnect

### Phase 6: Dead Letter Queue
- Failed message capture
- Exponential backoff retries
- Manual inspection API

### Phase 7: Channel System
- Dynamic channel registration
- Plugin-defined routing
- Channel discovery

## External Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| ioredis | ^5.x | Redis client |
| uuid | ^9.x | Correlation IDs |

## Configuration

```typescript
interface RouterConfig {
  redis: {
    host: string;
    port: number;
    password?: string;
  };
  defaultTtl: number;           // Default: 3600000 (1 hour)
  retry: {
    maxAttempts: number;        // Default: 5
    initialDelay: number;       // Default: 1000
    maxDelay: number;           // Default: 16000
    backoffFactor: number;      // Default: 2
  };
}
```

## Testing Strategy

- Unit tests for each module
- Integration tests with Redis (via testcontainers or mock)
- Test scenarios:
  - Online routing (Agency ↔ Humancy)
  - Offline queuing and delivery
  - Correlation timeout handling
  - Dead letter queue flow
  - Channel registration/routing
