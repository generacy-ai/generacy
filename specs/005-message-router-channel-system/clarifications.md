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

**Answer**: *Pending*

### Q2: Dead Letter Queue Retry Policy
**Context**: The spec mentions retry policies for failed messages but doesn't specify the behavior. This affects error handling and message delivery guarantees.
**Question**: What retry policy should the Dead Letter Queue use?
**Options**:
- A: No retries - immediate DLQ on failure
- B: Fixed retries (e.g., 3 attempts) with no delay
- C: Exponential backoff (e.g., 1s, 2s, 4s up to max)
- D: Configurable policy per message type

**Answer**: *Pending*

### Q3: Default Message TTL
**Context**: Messages have TTL expiration for persistence, but no default is specified. This affects how long messages are queued for offline recipients.
**Question**: What should the default TTL be for queued messages?
**Options**:
- A: No TTL - persist indefinitely until delivered
- B: Short TTL (e.g., 5 minutes) for real-time messages
- C: Medium TTL (e.g., 1 hour) for session-based delivery
- D: Long TTL (e.g., 24 hours) for guaranteed delivery

**Answer**: *Pending*

### Q4: Channel Message Routing
**Context**: Routing rule 5 says 'Plugin-defined routing' for Channel Messages, but there's no definition of how plugins register routing rules or what channels exist.
**Question**: How should channel message routing be implemented initially?
**Options**:
- A: Skip channels in initial implementation (add later)
- B: Define a fixed set of channels (e.g., 'debug', 'logs')
- C: Allow dynamic channel registration by plugins
- D: Route all channel messages to all connected Humancy instances

**Answer**: *Pending*

### Q5: Multiple Humancy Connections
**Context**: The spec shows multiple Humancy connections can register (VSCode, cloud). When routing to Humancy, it's unclear which instance receives the message.
**Question**: When multiple Humancy instances are connected, how should messages be routed?
**Options**:
- A: Send to all connected Humancy instances (broadcast)
- B: Send to the most recently active Humancy instance
- C: Send to a specific type (prefer VSCode over cloud)
- D: Include explicit target in message, fail if not connected

**Answer**: *Pending*

