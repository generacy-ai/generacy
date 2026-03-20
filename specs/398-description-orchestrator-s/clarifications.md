# Clarifications: Orchestrator Job Lifecycle Events via Relay WebSocket

## Batch 1 — 2026-03-20

### Q1: Relay Message Format Compatibility
**Context**: The existing relay protocol uses `RelayEvent { type: 'event', channel: SSEChannel, event: SSEEvent }` structure (see `packages/orchestrator/src/types/relay.ts`), but the spec shows a flat format `{ type: 'event', event: 'job:created', data: {...}, timestamp }`. If the format doesn't match what the cloud API's `MessageHandler.handleEvent()` expects, events will be silently dropped.
**Question**: Should job lifecycle events use the existing `RelayEvent` message structure (with `channel` and nested `event`), or should we introduce a new relay message type matching the flat format shown in the spec? What exactly does the cloud API's `handleEvent()` parse?
**Options**:
- A: Use existing `RelayEvent` structure — wrap job events as `{ type: 'event', channel: 'workflows', event: { type: 'job:created', data, timestamp } }`
- B: Introduce a new relay message type matching the flat format shown in the spec exactly
- C: The cloud API already handles both formats

**Answer**: Use whatever relay message structure maps to the cloud API's `EventMessage` type `{ type: 'event', event: string, data: Record<string, unknown>, timestamp: string }`. The key requirement is that `message.event` is a string like `'job:created'` and `message.data` contains the job payload. If the existing `RelayEvent` structure gets parsed into this shape by the relay server, use that; otherwise match the flat format.

### Q2: Job ID Source
**Context**: The spec shows `jobId: "uuid"` in the event payload, implying a UUID. However, the current codebase uses composite keys like `owner/repo#issueNumber` as workflow identifiers (see `ClaudeCliWorker.handle()`). There's no UUID generation for jobs currently. Using the wrong ID format would break cloud API Firestore document lookups.
**Question**: Should we generate a new UUID for each job when it starts processing, or use the existing composite `owner/repo#issueNumber` format as the jobId? If UUID, should it be stored/passed through the workflow context?

**Answer**: Generate a new UUID for each job when it is dequeued (at `job:created` time). Store it in the workflow context so subsequent events (`phase_changed`, `completed`, `failed`) reference the same ID. The composite `owner/repo#issueNumber` should be included in the `data` payload as metadata, not used as the jobId.

### Q3: Gate/Pause Event Emission
**Context**: The workflow engine supports "gates" where processing pauses (e.g., waiting for clarification answers). The existing SSE system already emits `workflow:paused` events at gates. The spec lists only 4 events (`job:created`, `job:phase_changed`, `job:completed`, `job:failed`) and doesn't mention paused states. A workflow could be paused for hours/days at a clarification gate — without a pause event, the dashboard would show it as "active" indefinitely.
**Question**: Should a `job:paused` event be emitted when a workflow hits a gate (e.g., waiting for clarification), or should gate pauses only be reflected through `job:phase_changed` with a status field?
**Options**:
- A: Add a `job:paused` event (5th event type) emitted at gates
- B: Use `job:phase_changed` with `status: "paused"` to indicate gate hits
- C: No pause events — keep to the 4 specified events only (dashboard shows as active until completed/failed)

**Answer**: A — Add a `job:paused` event (5th event type) emitted at gates. Workflows can be paused at clarification gates for hours/days, and without a pause event the dashboard would show a stale "active" state. The cloud API's `handleEvent()` already handles any `job:*` prefix, so no cloud-side changes needed. Emit `job:paused` when hitting a gate; when the gate is resolved, emit `job:phase_changed` to indicate the next phase starting.

### Q4: Phase Change Trigger Point
**Context**: The `PhaseLoop` executes phases sequentially (specify → clarify → plan → implement → verify). The spec says emit `job:phase_changed` "when the workflow transitions between phases" but doesn't specify whether this means at the START of each new phase or at the END/completion of each phase. This affects where the hook is placed and what `currentStep` value is sent.
**Question**: Should `job:phase_changed` fire when a phase STARTS (currentStep = new phase about to execute) or when a phase COMPLETES (currentStep = phase just finished)?
**Options**:
- A: Fire at phase START — `currentStep` is the phase about to begin
- B: Fire at phase COMPLETION — `currentStep` is the phase that just finished
- C: Fire at both START and COMPLETION with a status field distinguishing them

**Answer**: A — Fire at phase START. `currentStep` should be the phase about to begin. This is more useful for the dashboard — users want to see "currently running: clarify" not "just finished: specify". The natural hook point is the top of the phase loop iteration, right before the phase executor runs.

### Q5: Worker Count Acceptance Criterion Scope
**Context**: The acceptance criteria include "Worker count reflects actual connected workers" but the implementation tasks only cover job lifecycle events (`job:created/phase_changed/completed/failed`). Worker count is typically handled by the relay connection/disconnection itself (metadata events), not by job events. The `RelayBridge` already sends metadata on connect.
**Question**: Is the "worker count" acceptance criterion already satisfied by existing relay connection metadata, or does this feature need to add/fix worker count reporting as part of the implementation?
**Options**:
- A: Already handled — worker count comes from relay connection metadata (out of scope for this issue)
- B: Needs fixing — the existing metadata doesn't properly report worker count and should be addressed here

**Answer**: A — Already handled, out of scope. Worker count comes from the relay handshake metadata and the `/dispatch/queue/workers` relay proxy endpoint (addressed by generacy-cloud#227). Remove this from the acceptance criteria for this issue to avoid scope creep.
