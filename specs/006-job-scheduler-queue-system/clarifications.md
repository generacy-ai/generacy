# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-01-19 20:44

### Q1: Backend Priority
**Context**: The spec lists Redis (default), In-memory, and PostgreSQL backends. Implementation order affects initial delivery scope.
**Question**: Which queue backends should be implemented in the initial release?
**Options**:
- A: All three (Redis, In-memory, PostgreSQL) with Redis as default
- B: Redis + In-memory only (PostgreSQL deferred)
- C: In-memory only for MVP, add Redis later

**Answer**: *Pending*

### Q2: Priority Values
**Context**: The spec mentions high/normal/low priority but doesn't define numeric ranges. This affects job ordering behavior.
**Question**: What numeric priority range should be used (e.g., 1-10, 1-100), and what are the thresholds for high/normal/low?
**Options**:
- A: 1-10 scale: High=1-3, Normal=4-7, Low=8-10
- B: 1-100 scale with configurable thresholds
- C: Named priority levels only (enum: high, normal, low)

**Answer**: *Pending*

### Q3: Retry Defaults
**Context**: RetryConfig interface is defined but no default values are specified. This affects out-of-box behavior.
**Question**: What should be the default retry configuration values?
**Options**:
- A: maxAttempts=3, backoff=exponential, initialDelay=1000ms, maxDelay=30000ms
- B: maxAttempts=5, backoff=exponential, initialDelay=500ms, maxDelay=60000ms
- C: No defaults - all must be explicitly configured

**Answer**: *Pending*

### Q4: Metrics Export
**Context**: The spec mentions queue depth, processing time, error rate metrics but doesn't specify how they're exposed.
**Question**: How should metrics be exposed for monitoring?
**Options**:
- A: Prometheus-compatible endpoint (/metrics)
- B: OpenTelemetry integration
- C: Simple event emitter for custom consumption
- D: All of the above with pluggable adapters

**Answer**: *Pending*

### Q5: Dead Letter Handling
**Context**: Dead letter queue is mentioned but the criteria for when a job becomes 'dead' vs just 'failed' is unclear.
**Question**: When should a job move to dead letter queue vs staying as 'failed'?
**Options**:
- A: After exhausting all retry attempts (maxAttempts reached)
- B: On specific error types (configurable) or after max retries
- C: Manual dead-letter only via API call

**Answer**: *Pending*

