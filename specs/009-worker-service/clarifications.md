# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-01-19 22:12

### Q1: Retry Policy
**Context**: The acceptance criteria mentions 'Error handling and retry works' but no retry configuration is defined. This affects job reliability and queue behavior.
**Question**: What retry strategy should be used for failed jobs?
**Options**:
- A: Exponential backoff with configurable max retries (e.g., 3 retries with 1s, 2s, 4s delays)
- B: Fixed interval retries (e.g., retry every 5 seconds up to N times)
- C: No automatic retries - jobs fail immediately and require manual re-queue
- D: Job-type specific retry policies (different strategies per handler)

**Answer**: *Pending*

### Q2: Graceful Shutdown
**Context**: The stop() method exists but behavior for in-progress jobs during shutdown is undefined. This affects deployment reliability.
**Question**: When stop() is called, what should happen to the currently processing job?
**Options**:
- A: Wait for current job to complete (with configurable timeout), then stop
- B: Immediately abort current job and return it to queue
- C: Immediately abort and mark job as failed (no re-queue)

**Answer**: *Pending*

### Q3: Human Job Timeout
**Context**: handleHumanJob has a timeout parameter but the spec doesn't define what happens when a human doesn't respond in time. This affects workflow reliability.
**Question**: What should happen when a human job times out waiting for a response?
**Options**:
- A: Mark job as failed with timeout error, notify workflow
- B: Keep waiting indefinitely (no timeout for human decisions)
- C: Escalate to a different channel/assignee after timeout

**Answer**: *Pending*

### Q4: Container Cleanup
**Context**: Container management mentions cleanup but doesn't specify behavior on failures. Orphaned containers could consume resources.
**Question**: If a container job fails mid-execution, should the worker attempt to kill and remove the container before reporting failure?
**Options**:
- A: Yes, always clean up containers on failure (best effort)
- B: No, leave containers for debugging - separate cleanup process handles it
- C: Configurable per-job or global setting

**Answer**: *Pending*

### Q5: Health Check Protocol
**Context**: The spec mentions 'Health reporting to orchestrator' in acceptance criteria but doesn't specify the mechanism. This affects deployment and monitoring.
**Question**: How should the worker expose health status to the orchestrator?
**Options**:
- A: HTTP endpoint (e.g., /health) returning JSON status
- B: Periodic heartbeat messages to Redis pub/sub
- C: Both HTTP endpoint and heartbeat mechanism

**Answer**: *Pending*

