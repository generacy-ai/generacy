# Research: Canonical Relay Event Schema

## Decision 1: Adopt Cloud's `{event, data}` Convention

**Decision**: Use `{event, data, timestamp}` as the canonical shape, not `{channel, event}`.

**Rationale**:
- Cloud already expects `{event, data}` — two of four send sites work precisely because they accidentally match this shape
- `event` as the event name is more semantically self-describing than `channel`
- `data` is the standard field name for event payloads (SSE spec, CloudEvents, DOM events)
- Minimizes cloud-side changes (companion PR only needs to import, not restructure)

**Alternative rejected**: Keep `{channel, event}` and fix cloud — would require changing cloud's filter logic (`message.event === 'cluster.X'` in ~6 places), cloud's persistence layer, and SSE forwarding. Much larger blast radius.

## Decision 2: Replace Orchestrator Types, Don't Duplicate

**Decision**: Delete `RelayEvent` and `RelayJobEvent` from `packages/orchestrator/src/types/relay.ts`, import `EventMessage` from `@generacy-ai/cluster-relay`.

**Rationale**:
- The orchestrator's `RelayMessage` union has two members with `type: 'event'` — `RelayEvent` (`{channel, event}`) and `RelayJobEvent` (`{event, data, timestamp}`). TypeScript cannot narrow a discriminated union when two members share the same discriminant value.
- This is the structural reason `as RelayMessage` casts exist — without them, TS can't prove which `type: 'event'` variant is being constructed.
- Replacing both with a single imported `EventMessage` eliminates the dual-discriminant trap.

**Alternative rejected**: Update local types to match canonical shape (option B from clarifications). Keeps the parallel type system that caused the original drift.

## Decision 3: Rename PushEventFn End-to-End

**Decision**: Rename `PushEventFn` parameters from `(channel, payload)` to `(event, data)` and update the HTTP body shape from `{channel, payload}` to `{event, data, timestamp}`.

**Rationale**:
- Maintaining different field names at the IPC layer preserves the split-brain pattern this issue is fixing.
- Actual cost is small: ~3 files change (type def, HTTP sender, Zod schema).
- Positional callers (`pushEvent('cluster.audit', x)`) don't need changes — only parameter names change.

**Alternative rejected**: Map fields only in the orchestrator handler. Leaves the IPC contract using non-canonical names, making it easy to introduce another mismatch.

## Decision 4: Make `timestamp` Required

**Decision**: `timestamp` is a required field on `EventMessage`, not optional.

**Rationale**:
- Cloud already receives and uses timestamps on job events.
- Adding it to all events enables consistent ordering and debugging.
- Minor breaking change to the Zod schema, but all senders will be updated in the same PR.

## Decision 5: Export Schemas for Cloud Companion PR

**Decision**: Export both `EventMessageSchema` and `RelayMessageSchema` as named exports from `@generacy-ai/cluster-relay`.

**Rationale**:
- Cloud companion PR needs `RelayMessageSchema` for WebSocket message validation (replacing manual shape checks).
- `EventMessageSchema` is needed for cloud's event filtering logic.
- One-line export change, zero risk, unblocks parallel work.

## Decision 6: Non-Event Casts Out of Scope

**Decision**: Only remove `as RelayMessage` casts on `type: 'event'` sends. Leave casts on lease, tunnel, conversation, and metadata messages.

**Rationale**:
- These other message types don't have known drops — they work correctly today.
- Fixing them requires adding their types to the cluster-relay `RelayMessage` union, which is a larger scope change.
- Can be addressed in follow-up if desired.

## Implementation Pattern

The fix follows a bottom-up dependency order:

1. **Schema layer** (cluster-relay) — define canonical type + schema
2. **Type layer** (orchestrator types) — delete duplicates, import canonical
3. **Send layer** (orchestrator services/routes) — update shapes, remove casts
4. **IPC layer** (control-plane) — rename parameters, update HTTP body

This ordering ensures each layer compiles against its dependencies before the next layer changes.

## Key Sources

- Spec: `specs/602-problem-every-events-silently/spec.md`
- Current cluster-relay EventMessage: `packages/cluster-relay/src/messages.ts:23-27`
- Current orchestrator RelayEvent: `packages/orchestrator/src/types/relay.ts:235`
- Current orchestrator RelayJobEvent: `packages/orchestrator/src/types/relay.ts:128`
- PushEventFn: `packages/control-plane/src/relay-events.ts:1`
- IPC wiring: `packages/control-plane/bin/control-plane.ts:44-64`
- IPC handler: `packages/orchestrator/src/routes/internal-relay-events.ts:19-52`
