# Clarifications

## Batch 1 — 2026-05-12

### Q1: Orchestrator Dual Type System
**Context**: The spec targets `EventMessage` in `packages/cluster-relay/src/messages.ts`, but the orchestrator maintains its own completely separate `RelayMessage` union in `packages/orchestrator/src/types/relay.ts` with two distinct event types: `RelayEvent` (SSE forwarding shape: `{channel, event}`) and `RelayJobEvent` (cloud-compatible shape: `{event, data, timestamp}`). These share the same `type: 'event'` discriminant. The spec does not mention this file.
**Question**: After unifying the canonical schema in cluster-relay, should we (a) replace the orchestrator's local relay types with imports from `@generacy-ai/cluster-relay`, eliminating the duplicate type system, or (b) update the local types independently to match the canonical shape while keeping them as a separate file?
**Options**:
- A: Replace local types with cluster-relay imports (cleaner, larger refactor touching imports across orchestrator)
- B: Update local types to match canonical shape (smaller change, preserves existing import structure)

**Answer**: **A — Replace local types with cluster-relay imports.** The orchestrator's `packages/orchestrator/src/types/relay.ts` has both `RelayEvent` (line 235, shape `{type: 'event', channel, event}`) and `RelayJobEvent` (line 128, shape `{type: 'event', event, data, timestamp}`) — same `type: 'event'` discriminant on two structurally different members of `RelayMessage`. TypeScript's discriminated-union narrowing can't distinguish them, which is how the orchestrator emits both shapes without compile errors. Option B keeps this trap in place. Eliminate the orchestrator's parallel type system entirely. Minimum-viable split: replace `EventMessage` only (delete `RelayEvent` and `RelayJobEvent`), leave other types for follow-up. Also export `RelayMessageSchema` alongside `EventMessageSchema` since cloud needs the full union for WebSocket validation.

### Q2: IPC Field Mapping Location (FR-006)
**Context**: Control-plane services call `pushEvent(channel, payload)` which POSTs `{channel, payload}` to the orchestrator's `/internal/relay-events` handler, which then sends `{type: 'event', channel, event: payload}` over WebSocket. FR-006 ("Update `setRelayPushEvent` callback signature in control-plane") is P1, but the IPC chain touches ~10 call sites across control-plane.
**Question**: Should the canonical field mapping (`channel`→`event`, `payload`→`data`, add `timestamp`) happen in the orchestrator's handler alone (minimal change, control-plane untouched), or should FR-006 rename the `PushEventFn` signature and update all control-plane callers?
**Options**:
- A: Map in orchestrator handler only (minimal scope — just fix the `client.send()` call in `internal-relay-events.ts`)
- B: Rename PushEventFn to `(event, data)` and update all ~10 control-plane call sites plus HTTP body format

**Answer**: **B — Rename PushEventFn signature and update all control-plane callers.** Maintaining `channel/payload` at the IPC layer while `event/data` is the wire format preserves the split-brain anti-pattern this issue is fixing. The actual cost is small: param-rename in `PushEventFn` type, param-rename in `bin/control-plane.ts`'s HTTP push impl, HTTP body shape changes from `{channel, payload}` to `{event, data, timestamp}`, orchestrator's `/internal/relay-events` Zod schema updates. The "~10 call sites" are positional callers (`pushEvent('cluster.audit', x)`) — they don't need touching. Real change concentrated in 2-3 files. Also drop `as unknown as RelayMessage` casts from the orchestrator's handler.

### Q3: EventMessageSchema Export for Cloud Prep
**Context**: `EventMessageSchema` in `cluster-relay/src/messages.ts` is currently a non-exported `const`. Steps 3-4 (cloud imports and validates against this schema) are explicitly out of scope for this PR, but the schema needs to be importable for the companion cloud PR.
**Question**: Should we export `EventMessageSchema` as a named export now to prepare for the cloud companion PR, or defer the export to that PR?
**Options**:
- A: Export now (one-line change, unblocks cloud PR)
- B: Defer export to cloud companion PR

**Answer**: **A — Export now.** One-line cost, unblocks the cloud companion PR to be written in parallel against the next preview release of `@generacy-ai/cluster-relay`. Also export `RelayMessageSchema` (the discriminated-union schema) since cloud's `relay-server.ts` needs the full union for validating inbound messages at the WebSocket boundary.
