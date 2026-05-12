# Clarifications

## Batch 1 — 2026-05-12

### Q1: Orchestrator Dual Type System
**Context**: The spec targets `EventMessage` in `packages/cluster-relay/src/messages.ts`, but the orchestrator maintains its own completely separate `RelayMessage` union in `packages/orchestrator/src/types/relay.ts` with two distinct event types: `RelayEvent` (SSE forwarding shape: `{channel, event}`) and `RelayJobEvent` (cloud-compatible shape: `{event, data, timestamp}`). These share the same `type: 'event'` discriminant. The spec does not mention this file.
**Question**: After unifying the canonical schema in cluster-relay, should we (a) replace the orchestrator's local relay types with imports from `@generacy-ai/cluster-relay`, eliminating the duplicate type system, or (b) update the local types independently to match the canonical shape while keeping them as a separate file?
**Options**:
- A: Replace local types with cluster-relay imports (cleaner, larger refactor touching imports across orchestrator)
- B: Update local types to match canonical shape (smaller change, preserves existing import structure)

**Answer**: *Pending*

### Q2: IPC Field Mapping Location (FR-006)
**Context**: Control-plane services call `pushEvent(channel, payload)` which POSTs `{channel, payload}` to the orchestrator's `/internal/relay-events` handler, which then sends `{type: 'event', channel, event: payload}` over WebSocket. FR-006 ("Update `setRelayPushEvent` callback signature in control-plane") is P1, but the IPC chain touches ~10 call sites across control-plane.
**Question**: Should the canonical field mapping (`channel`→`event`, `payload`→`data`, add `timestamp`) happen in the orchestrator's handler alone (minimal change, control-plane untouched), or should FR-006 rename the `PushEventFn` signature and update all control-plane callers?
**Options**:
- A: Map in orchestrator handler only (minimal scope — just fix the `client.send()` call in `internal-relay-events.ts`)
- B: Rename PushEventFn to `(event, data)` and update all ~10 control-plane call sites plus HTTP body format

**Answer**: *Pending*

### Q3: EventMessageSchema Export for Cloud Prep
**Context**: `EventMessageSchema` in `cluster-relay/src/messages.ts` is currently a non-exported `const`. Steps 3-4 (cloud imports and validates against this schema) are explicitly out of scope for this PR, but the schema needs to be importable for the companion cloud PR.
**Question**: Should we export `EventMessageSchema` as a named export now to prepare for the cloud companion PR, or defer the export to that PR?
**Options**:
- A: Export now (one-line change, unblocks cloud PR)
- B: Defer export to cloud companion PR

**Answer**: *Pending*
