# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-02-06 21:11

### Q1: Authentication Priority
**Context**: The config supports both ADC and service account key. Implementation needs to know which takes precedence and the fallback behavior.
**Question**: When both ADC (Application Default Credentials) and serviceAccountKey are available, which should take priority? Should the plugin fail fast if neither is configured, or attempt anonymous access?
**Options**:
- A: serviceAccountKey takes priority over ADC
- B: ADC takes priority, serviceAccountKey is fallback
- C: Require explicit choice, fail if both/neither present

**Answer**: *Pending*

### Q2: Error Handling Strategy
**Context**: Cloud Build operations can fail due to quotas, permissions, network issues, or build failures. The plugin needs a consistent error handling approach.
**Question**: How should the plugin handle transient errors (network timeouts, rate limits)? Should it implement automatic retries with backoff, or surface errors immediately to the caller?
**Options**:
- A: Automatic retry with exponential backoff (3 attempts)
- B: No automatic retry, surface errors immediately
- C: Configurable retry policy per operation

**Answer**: *Pending*

### Q3: Log Streaming Behavior
**Context**: streamLogs returns AsyncIterable<LogEntry>. Implementation needs to know buffering and backpressure behavior.
**Question**: For log streaming, should the plugin buffer logs if the consumer is slow, or apply backpressure? What should happen when the build completes - should the stream end automatically?
**Options**:
- A: Buffer up to 1000 entries, drop oldest if exceeded
- B: Apply backpressure, pause fetching if consumer is slow
- C: No buffering, real-time streaming with automatic stream end on build completion

**Answer**: *Pending*

### Q4: Artifact Size Limits
**Context**: getArtifact returns Buffer which loads entire artifact into memory. Large artifacts could cause memory issues.
**Question**: Should getArtifact support streaming for large artifacts, or is a size limit acceptable? If limited, what's the maximum artifact size to support?
**Options**:
- A: Return Buffer for artifacts up to 100MB, throw for larger
- B: Add streaming variant: getArtifactStream() for large files
- C: Always stream, remove Buffer-returning method

**Answer**: *Pending*

### Q5: Build Filter Scope
**Context**: listBuilds accepts a filter but the filter structure isn't defined. This affects query capabilities.
**Question**: What filter criteria should listBuilds support? Should it support filtering by status, trigger, time range, tags, or all of these?
**Options**:
- A: Basic: status and time range only
- B: Standard: status, trigger, time range, and pageSize
- C: Full: status, trigger, time range, tags, source repo, and pagination

**Answer**: *Pending*

