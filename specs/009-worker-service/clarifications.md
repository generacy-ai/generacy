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

**Answer**: D - Job-type specific retry policies. The worker handles 3 distinct job types (AgentJob, HumanJob, IntegrationJob) with very different failure modes: Agent jobs use exponential backoff for transient failures (API limits, network issues); Human jobs don't retry - these wait for decisions, not retry on failure; Integration jobs use service-specific retry behavior based on external service characteristics.

### Q2: Graceful Shutdown
**Context**: The stop() method exists but behavior for in-progress jobs during shutdown is undefined. This affects deployment reliability.
**Question**: When stop() is called, what should happen to the currently processing job?
**Options**:
- A: Wait for current job to complete (with configurable timeout), then stop
- B: Immediately abort current job and return it to queue
- C: Immediately abort and mark job as failed (no re-queue)

**Answer**: A - Wait for current job to complete (with configurable timeout). Agent work involves accumulated context that's hard to resume mid-execution. Human jobs in progress represent active decision flows. Configurable timeout provides a safety valve for stuck jobs. Aligns with production reliability requirements.

### Q3: Human Job Timeout
**Context**: handleHumanJob has a timeout parameter but the spec doesn't define what happens when a human doesn't respond in time. This affects workflow reliability.
**Question**: What should happen when a human job times out waiting for a response?
**Options**:
- A: Mark job as failed with timeout error, notify workflow
- B: Keep waiting indefinitely (no timeout for human decisions)
- C: Escalate to a different channel/assignee after timeout

**Answer**: C - Escalate to a different channel/assignee after timeout. Per the Humancy vision, the urgency system (blocking_now, blocking_soon, when_available) already models time-sensitivity. Human decisions are precious - escalation preserves the decision rather than failing it. Aligns with "human-in-the-loop at scale" philosophy - route to available human rather than fail.

### Q4: Container Cleanup
**Context**: Container management mentions cleanup but doesn't specify behavior on failures. Orphaned containers could consume resources.
**Question**: If a container job fails mid-execution, should the worker attempt to kill and remove the container before reporting failure?
**Options**:
- A: Yes, always clean up containers on failure (best effort)
- B: No, leave containers for debugging - separate cleanup process handles it
- C: Configurable per-job or global setting

**Answer**: C - Configurable per-job or global setting. Container management is already optional in the spec. Development needs differ from production (debugging vs resource efficiency). Global default with per-job override provides flexibility. Suggested default: best-effort cleanup in prod, preserve-for-debugging in dev.

### Q5: Health Check Protocol
**Context**: The spec mentions 'Health reporting to orchestrator' in acceptance criteria but doesn't specify the mechanism. This affects deployment and monitoring.
**Question**: How should the worker expose health status to the orchestrator?
**Options**:
- A: HTTP endpoint (e.g., /health) returning JSON status
- B: Periodic heartbeat messages to Redis pub/sub
- C: Both HTTP endpoint and heartbeat mechanism

**Answer**: C - Both HTTP endpoint and heartbeat mechanism. HTTP endpoint for container orchestration (Kubernetes probes, Docker healthcheck). Redis heartbeat for fine-grained worker tracking by orchestrator. External systems (load balancers, deployment tools) use HTTP endpoint. Fits existing Redis-based architecture.

