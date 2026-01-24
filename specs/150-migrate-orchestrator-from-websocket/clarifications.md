# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-01-24 20:44

### Q1: SSE Authentication
**Context**: The spec doesn't mention how SSE endpoints will authenticate clients. WebSocket typically uses token-based auth at connection time.
**Question**: How should SSE endpoints authenticate clients?
**Options**:
- A: Bearer token in Authorization header (standard HTTP auth)
- B: Token as query parameter (e.g., /events?token=xxx) for browser EventSource compatibility
- C: Session cookie-based authentication

**Answer**: *Pending*

### Q2: Heartbeat Interval
**Context**: The acceptance criteria mention heartbeat comments but don't specify timing. Too frequent wastes bandwidth; too sparse may cause proxy timeouts.
**Question**: What interval should heartbeats be sent at to keep SSE connections alive?
**Options**:
- A: 15 seconds (conservative, works with most proxies)
- B: 30 seconds (balanced)
- C: 60 seconds (minimal overhead)

**Answer**: *Pending*

### Q3: Connection Limits
**Context**: SSE connections are long-lived and consume server resources. Without limits, a single client could exhaust server capacity.
**Question**: Should we implement connection limits per client, and if so, what limits?
**Options**:
- A: No limits (rely on infrastructure scaling)
- B: Max 3 concurrent SSE connections per client
- C: Max 5 concurrent SSE connections per client

**Answer**: *Pending*

### Q4: Error Event Format
**Context**: The spec defines success event formats but not how errors should be communicated to clients over the SSE stream.
**Question**: How should errors be communicated to connected SSE clients?
**Options**:
- A: Dedicated error event type (event: error) with error details in data
- B: Close the connection and let client reconnect (standard HTTP error on reconnect)
- C: Include error field in regular event data when applicable

**Answer**: *Pending*

### Q5: Breaking Change Strategy
**Context**: Existing clients may be using WebSocket. A breaking change requires coordination, while parallel support adds complexity.
**Question**: Is this a breaking change, or should we support both WebSocket and SSE during a transition period?
**Options**:
- A: Breaking change - remove WebSocket immediately (simpler, but requires client updates)
- B: Transition period - support both for 1-2 releases, then deprecate WebSocket
- C: Feature flag - configurable per deployment

**Answer**: *Pending*

