# Clarifications: Orchestrator Relay Integration

## Batch 1 — 2026-03-14

### Q1: Relay Package Availability
**Context**: The spec assumes `@generacy-ai/cluster-relay` (Phase 2.1) is published and available, but no package or spec for Phase 2.1 exists in the codebase yet. Without a defined API contract, integration cannot proceed.
**Question**: Is the `@generacy-ai/cluster-relay` package implemented? If not, should we define the relay client API contract (constructor, methods, events, message types) as part of this issue, or block until Phase 2.1 is complete?
**Options**:
- A: Define the relay client API as part of this issue and implement both 2.1 and 2.2 together
- B: Block this issue until Phase 2.1 delivers the relay package with a defined API
- C: Define only the integration interface (types/contract) here; implement relay package separately

**Answer**: *Pending*

### Q2: Worker Mode Behavior
**Context**: The orchestrator runs in two modes — full mode (issue monitoring, webhooks, Smee) and worker mode (minimal, job execution only). The spec doesn't specify which mode(s) should establish a relay connection.
**Question**: Should the relay connection be established in both full mode and worker mode, or only in full mode?
**Options**:
- A: Full mode only — worker-mode instances don't need cloud connectivity
- B: Both modes — all orchestrator instances should be visible to the cloud
- C: Configurable per mode via environment variable

**Answer**: *Pending*

### Q3: Event Forwarding Scope
**Context**: The SSE event bus has three channels (workflows, queue, agents) with many event types (workflow lifecycle, step progress, queue updates, agent status, decisions). The spec mentions forwarding "workflow lifecycle, phase progress, errors" but doesn't clarify whether queue and agent events should also be forwarded.
**Question**: Which SSE event channels should be forwarded via the relay — only workflow-related events, or all channels (including queue updates and agent status)?
**Options**:
- A: All channels — forward everything so the cloud dashboard has full visibility
- B: Workflows only — queue and agent events are local concerns
- C: Workflows + queue — agent events are local only

**Answer**: *Pending*

### Q4: Connection Failure on Startup
**Context**: The spec mentions logging "connected, disconnected, reconnecting" statuses, implying retry behavior, but doesn't specify what happens if the initial relay connection fails on startup (e.g., cloud is unreachable).
**Question**: If `GENERACY_API_KEY` is set but the relay cannot connect on startup, should the orchestrator continue in local-only mode with background reconnection, or should it fail to start?
**Options**:
- A: Continue in local-only mode with background reconnection attempts (recommended for resilience)
- B: Fail to start — cloud connectivity is required when API key is configured
- C: Start with a warning and retry N times before falling back to local-only

**Answer**: *Pending*

### Q5: Missing cluster.yaml Fallback
**Context**: The spec assumes `.generacy/cluster.yaml` exists (from Phase 1.8) for metadata like worker count and channel. However, if `GENERACY_API_KEY` is set but `cluster.yaml` hasn't been created, the relay would lack metadata.
**Question**: If `GENERACY_API_KEY` is set but `.generacy/cluster.yaml` doesn't exist, should the relay connect with default/partial metadata, or skip the relay connection entirely?
**Options**:
- A: Connect with sensible defaults (e.g., channel: "stable", workers: 1) and log a warning
- B: Skip relay connection — cluster.yaml is a hard prerequisite
- C: Connect without metadata fields that require cluster.yaml; report only what's available (version, uptime, git remotes)

**Answer**: *Pending*
