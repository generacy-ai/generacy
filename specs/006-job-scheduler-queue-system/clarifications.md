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

**Answer**: B - Redis + In-memory only (PostgreSQL deferred). The architecture overview explicitly states Generacy "runs locally via docker-compose (orchestrator + workers + redis)" - Redis is the expected production backend. In-memory is essential for testing and development. PostgreSQL adds complexity without clear immediate benefit given the adoption path assumes Redis.

### Q2: Priority Values
**Context**: The spec mentions high/normal/low priority but doesn't define numeric ranges. This affects job ordering behavior.
**Question**: What numeric priority range should be used (e.g., 1-10, 1-100), and what are the thresholds for high/normal/low?
**Options**:
- A: 1-10 scale: High=1-3, Normal=4-7, Low=8-10
- B: 1-100 scale with configurable thresholds
- C: Named priority levels only (enum: high, normal, low)

**Answer**: C - Named priority levels only (enum: high, normal, low). The architecture already defines urgency semantically: blocking_now → high priority, blocking_soon → normal priority, when_available → low priority. Using named levels maintains consistency with the urgency model and avoids arbitrary numeric semantics.

### Q3: Retry Defaults
**Context**: RetryConfig interface is defined but no default values are specified. This affects out-of-box behavior.
**Question**: What should be the default retry configuration values?
**Options**:
- A: maxAttempts=3, backoff=exponential, initialDelay=1000ms, maxDelay=30000ms
- B: maxAttempts=5, backoff=exponential, initialDelay=500ms, maxDelay=60000ms
- C: No defaults - all must be explicitly configured

**Answer**: A - maxAttempts=3, backoff=exponential, initialDelay=1000ms, maxDelay=30000ms. These are sensible conservative defaults. 3 attempts is standard practice - aggressive enough to handle transient failures, not so aggressive that it masks real problems. Exponential backoff with 1s initial and 30s max prevents thundering herd issues while keeping feedback loops reasonably fast.

### Q4: Metrics Export
**Context**: The spec mentions queue depth, processing time, error rate metrics but doesn't specify how they're exposed.
**Question**: How should metrics be exposed for monitoring?
**Options**:
- A: Prometheus-compatible endpoint (/metrics)
- B: OpenTelemetry integration
- C: Simple event emitter for custom consumption
- D: All of the above with pluggable adapters

**Answer**: C - Simple event emitter for custom consumption. The architecture emphasizes a plugin-based, extensible model. Starting with a simple event emitter follows the "additive-only changes" principle - it provides a foundation that Prometheus/OpenTelemetry adapters can be built on as plugins. This avoids baking specific monitoring choices into core while keeping the initial scope manageable.

### Q5: Dead Letter Handling
**Context**: Dead letter queue is mentioned but the criteria for when a job becomes 'dead' vs just 'failed' is unclear.
**Question**: When should a job move to dead letter queue vs staying as 'failed'?
**Options**:
- A: After exhausting all retry attempts (maxAttempts reached)
- B: On specific error types (configurable) or after max retries
- C: Manual dead-letter only via API call

**Answer**: A - After exhausting all retry attempts (maxAttempts reached). This is the standard, predictable behavior. A job becomes "dead" when the system has genuinely given up trying - which is when maxAttempts is exhausted. Configurable error types for immediate dead-lettering can be added later if needed.

