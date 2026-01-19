# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-01-19 16:29

### Q1: Message Persistence Storage
**Context**: The spec mentions queuing messages when recipients are offline but doesn't specify the storage mechanism. This affects implementation complexity and reliability guarantees.
**Question**: Where should offline messages be persisted?
**Options**:
- A: In-memory only (messages lost on restart)
- B: File-based storage (simple, local persistence)
- C: External database (SQLite, Redis, etc.)
- D: Pluggable storage adapter (allow any backend)

**Answer**: C - External database (Redis). Redis is already part of the standard Generacy stack per the architecture docs. Using it for message persistence requires no additional dependencies, provides proper pub/sub semantics for real-time routing, is battle-tested for message queuing, and supports persistence + TTL requirements natively.

### Q2: Dead Letter Queue Retry Policy
**Context**: The spec mentions retry policies for failed messages but doesn't specify the behavior. This affects error handling and message delivery guarantees.
**Question**: What retry policy should the Dead Letter Queue use?
**Options**:
- A: No retries - immediate DLQ on failure
- B: Fixed retries (e.g., 3 attempts) with no delay
- C: Exponential backoff (e.g., 1s, 2s, 4s up to max)
- D: Configurable policy per message type

**Answer**: C - Exponential backoff (e.g., 1s, 2s, 4s up to max). Exponential backoff is the industry standard that prevents thundering herd problems on transient failures, gives intermittent issues time to self-resolve, limits impact on system resources during outages, and aligns with the overall graceful degradation philosophy.

### Q3: Default Message TTL
**Context**: Messages have TTL expiration for persistence, but no default is specified. This affects how long messages are queued for offline recipients.
**Question**: What should the default TTL be for queued messages?
**Options**:
- A: No TTL - persist indefinitely until delivered
- B: Short TTL (e.g., 5 minutes) for real-time messages
- C: Medium TTL (e.g., 1 hour) for session-based delivery
- D: Long TTL (e.g., 24 hours) for guaranteed delivery

**Answer**: C - Medium TTL (1 hour) for session-based delivery. A 1-hour TTL handles temporary disconnections (network blips, IDE restarts), prevents stale decision requests from accumulating, aligns with typical development session lengths, and can be overridden per-message via the meta.ttl field in the envelope.

### Q4: Channel Message Routing
**Context**: Routing rule 5 says 'Plugin-defined routing' for Channel Messages, but there's no definition of how plugins register routing rules or what channels exist.
**Question**: How should channel message routing be implemented initially?
**Options**:
- A: Skip channels in initial implementation (add later)
- B: Define a fixed set of channels (e.g., 'debug', 'logs')
- C: Allow dynamic channel registration by plugins
- D: Route all channel messages to all connected Humancy instances

**Answer**: C - Allow dynamic channel registration by plugins. This is explicitly described in the extensibility docs. The router should support dynamic plugin-defined channels from the start, with agency.registerChannel() for registration, humancy.findChannel() for discovery, and standard envelope with channel field for routing.

### Q5: Multiple Humancy Connections
**Context**: The spec shows multiple Humancy connections can register (VSCode, cloud). When routing to Humancy, it's unclear which instance receives the message.
**Question**: When multiple Humancy instances are connected, how should messages be routed?
**Options**:
- A: Send to all connected Humancy instances (broadcast)
- B: Send to the most recently active Humancy instance
- C: Send to a specific type (prefer VSCode over cloud)
- D: Include explicit target in message, fail if not connected

**Answer**: A - Send to all connected Humancy instances (broadcast). Broadcasting to all instances ensures humans see pending decisions from any connected interface (VS Code or cloud), supports the centralized view model, aligns with urgency triage, and response correlation IDs handle routing replies back to the correct Agency.

