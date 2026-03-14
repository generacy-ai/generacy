# Clarifications: Orchestrator Relay Integration

## Batch 1 — 2026-03-14

### Q1: Relay Package Availability
**Context**: The spec assumes `@generacy-ai/cluster-relay` (Phase 2.1) is published and available, but no package or spec for Phase 2.1 exists in the codebase yet. Without a defined API contract, integration cannot proceed.
**Question**: Is the `@generacy-ai/cluster-relay` package implemented? If not, should we define the relay client API contract (constructor, methods, events, message types) as part of this issue, or block until Phase 2.1 is complete?
**Options**:
- A: Define the relay client API as part of this issue and implement both 2.1 and 2.2 together
- B: Block this issue until Phase 2.1 delivers the relay package with a defined API
- C: Define only the integration interface (types/contract) here; implement relay package separately

**Answer**: C** — Define only the integration interface (types/contract) here; implement relay package separately.
The phase dependency chart explicitly shows "2.1 + 2.3 parallel, then 2.2 + 2.4" — 2.1 is a prerequisite for 2.2. Defining the integration interface/types here lets the 2.2 spec proceed without merging two issues into one. The relay package gets implemented separately as 2.1.

### Q2: Worker Mode Behavior
**Context**: The orchestrator runs in two modes — full mode (issue monitoring, webhooks, Smee) and worker mode (minimal, job execution only). The spec doesn't specify which mode(s) should establish a relay connection.
**Question**: Should the relay connection be established in both full mode and worker mode, or only in full mode?
**Options**:
- A: Full mode only — worker-mode instances don't need cloud connectivity
- B: Both modes — all orchestrator instances should be visible to the cloud
- C: Configurable per mode via environment variable

**Answer**: A** — Full mode only — worker-mode instances don't need cloud connectivity.
Worker-mode instances are transient containers executing jobs. The relay is the orchestrator-to-cloud bridge — one connection per cluster, not per worker. The full-mode orchestrator manages cloud connectivity on behalf of the cluster.

### Q3: Event Forwarding Scope
**Context**: The SSE event bus has three channels (workflows, queue, agents) with many event types (workflow lifecycle, step progress, queue updates, agent status, decisions). The spec mentions forwarding "workflow lifecycle, phase progress, errors" but doesn't clarify whether queue and agent events should also be forwarded.
**Question**: Which SSE event channels should be forwarded via the relay — only workflow-related events, or all channels (including queue updates and agent status)?
**Options**:
- A: All channels — forward everything so the cloud dashboard has full visibility
- B: Workflows only — queue and agent events are local concerns
- C: Workflows + queue — agent events are local only

**Answer**: A** — All channels — forward everything so the cloud dashboard has full visibility.
The reference doc states "Cloud subscribers receive the same events they would get from direct SSE connection." Phase 3 explicitly includes both a "Realtime workflow monitoring dashboard" (3.1) and a "Queue management UI" (3.2), confirming the cloud needs queue events. Forwarding everything keeps the relay a transparent proxy consistent with the principle that "the relay proxies requests to the orchestrator's existing Fastify API routes — it does not duplicate route logic."

### Q4: Connection Failure on Startup
**Context**: The spec mentions logging "connected, disconnected, reconnecting" statuses, implying retry behavior, but doesn't specify what happens if the initial relay connection fails on startup (e.g., cloud is unreachable).
**Question**: If `GENERACY_API_KEY` is set but the relay cannot connect on startup, should the orchestrator continue in local-only mode with background reconnection, or should it fail to start?
**Options**:
- A: Continue in local-only mode with background reconnection attempts (recommended for resilience)
- B: Fail to start — cloud connectivity is required when API key is configured
- C: Start with a warning and retry N times before falling back to local-only

**Answer**: A** — Continue in local-only mode with background reconnection attempts.
The reference doc explicitly states: "Relay connection is optional — orchestrator works fully without it (local-only mode)" and "Must work on laptops over public wifi." The reconnection pattern is already defined: "Exponential backoff reconnection (5s → 10s → 20s → ... → 300s max)." Failing to start would violate the local-only resilience requirement.

### Q5: Missing cluster.yaml Fallback
**Context**: The spec assumes `.generacy/cluster.yaml` exists (from Phase 1.8) for metadata like worker count and channel. However, if `GENERACY_API_KEY` is set but `cluster.yaml` hasn't been created, the relay would lack metadata.
**Question**: If `GENERACY_API_KEY` is set but `.generacy/cluster.yaml` doesn't exist, should the relay connect with default/partial metadata, or skip the relay connection entirely?
**Options**:
- A: Connect with sensible defaults (e.g., channel: "stable", workers: 1) and log a warning
- B: Skip relay connection — cluster.yaml is a hard prerequisite
- C: Connect without metadata fields that require cluster.yaml; report only what's available (version, uptime, git remotes)

**Answer**: C** — Connect without metadata fields that require cluster.yaml; report only what's available (version, uptime, git remotes).
Option A would assume defaults that may be wrong (e.g., guessing "stable" channel when the user might intend "preview"). Option C is more honest — it reports what it knows and lets the cloud dashboard show incomplete metadata with a prompt to configure cluster.yaml. This aligns with the progressive onboarding stages where `devcontainer_configured` comes before `cluster_connected`.
