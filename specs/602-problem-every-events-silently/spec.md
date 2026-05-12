# Feature Specification: ## Problem

Every "events silently dropped" bug we've shipped in the past two weeks (#543 / #594 / #600, plus latent drops of \`cluster

**Branch**: `602-problem-every-events-silently` | **Date**: 2026-05-12 | **Status**: Draft

## Summary

## Problem

Every "events silently dropped" bug we've shipped in the past two weeks (#543 / #594 / #600, plus latent drops of \`cluster.audit\` and \`cluster.credentials\` since the patterns first landed) shares a single root cause: **there is no canonical, shared definition of the relay event wire shape.** Each repo has its own type that describes the same wire bytes differently, and senders/receivers pick whichever shape happens to match the local type — which often doesn't match the other side.

## The diverging definitions

### Cluster: \`packages/cluster-relay/src/messages.ts:23\`
\`\`\`typescript
export interface EventMessage {
  type: 'event';
  channel: string;     // ← "channel" carries the event name
  event: unknown;      // ← "event" carries the payload
}
\`\`\`
Backed by [\`EventMessageSchema\` at line 168](packages/cluster-relay/src/messages.ts#L168) (Zod), validates and parses incoming WebSocket messages.

### Cloud: \`services/api/src/services/relay/relay-types.ts:44\`
\`\`\`typescript
export interface EventMessage extends RelayMessageBase {
  type: 'event';
  event: string;       // ← "event" carries the event name (string)
  data: unknown;       // ← "data" carries the payload
}
\`\`\`
Used by [\`message-handler.ts\`](https://github.com/generacy-ai/generacy-cloud/blob/main/services/api/src/services/relay/message-handler.ts) for filtering and persistence. Every filter check is \`message.event === 'cluster.<something>'\` — assuming \`event\` is a string.

### Two repos, two shapes, same wire bytes

JSON serialization preserves field names. When the cluster sends \`{ channel: 'cluster.audit', event: {...} }\`, the cloud parses it as a JSON object with those same fields. Cloud's TS type says \`event\` should be a string, but the actual runtime value is the payload object — and \`message.event === 'cluster.audit'\` returns false because we're comparing an object to a string.

## The orchestrator itself emits both shapes

The escape hatch that hides this: nearly every \`relayClient.send()\` call casts \`as RelayMessage\` or \`as unknown as RelayMessage\`, bypassing type checking. Here's how schizophrenic it is in [\`packages/orchestrator\`](packages/orchestrator/) right now:

| Call site | Shape emitted | Match to cluster type? | Match to cloud type? | Status |
|---|---|---|---|---|
| [\`server.ts:221\`](packages/orchestrator/src/server.ts#L221) (job events) | \`{event, data, timestamp}\` | ✗ | ✓ | Works — cloud reads it correctly |
| [\`relay-bridge.ts:144\`](packages/orchestrator/src/services/relay-bridge.ts#L144) (SSE forward) | \`{event, data, timestamp}\` | ✗ | ✓ | Works |
| [\`relay-bridge.ts:390\`](packages/orchestrator/src/services/relay-bridge.ts#L390) (other SSE path) | \`{channel, event: payload}\` | ✓ | ✗ | Silently dropped by cloud |
| [\`internal-relay-events.ts\`](packages/orchestrator/src/routes/internal-relay-events.ts) (#594) | \`{channel, event: payload}\` | ✓ | ✗ | Silently dropped — #600 |

Two of these are documented as broken (#594/#600 traced through to the same bug). The other two work by happening to use the cloud-compatible shape. Nothing structurally guarantees correctness.

## Fix — single canonical schema, shared between repos

### Step 1: Define the canonical shape in \`@generacy-ai/cluster-relay\`

Adopt the cloud's existing convention (it's more semantically self-describing — \`event\` for the event name, \`data\` for the payload):

\`\`\`typescript
// packages/cluster-relay/src/messages.ts
export interface EventMessage {
  type: 'event';
  event: string;       // event name, e.g. 'cluster.vscode-tunnel'
  data: unknown;       // payload object
  timestamp: string;   // ISO timestamp
}

export const EventMessageSchema = z.object({
  type: z.literal('event'),
  event: z.string(),
  data: z.unknown(),
  timestamp: z.string().datetime(),
});
\`\`\`

(\`timestamp\` becomes required where it was previously optional — minor breaking change.)

Export both \`EventMessageSchema\` and \`RelayMessageSchema\` as named exports to unblock the cloud companion PR. Cloud's \`relay-server.ts\` needs the full discriminated-union schema for validating inbound WebSocket messages.

### Step 2: Update all cluster-side senders to the canonical shape

- \`packages/orchestrator/src/services/relay-bridge.ts:390\` — change \`channel\` → \`event\`, \`event\` → \`data\`, add \`timestamp\`
- \`packages/orchestrator/src/routes/internal-relay-events.ts\` — same change (overlap with #600; can fold or ship serially)
- **Replace orchestrator's local relay types** (\`packages/orchestrator/src/types/relay.ts\`) with imports from \`@generacy-ai/cluster-relay\` — eliminate \`RelayEvent\` and \`RelayJobEvent\` (both share \`type: 'event'\` discriminant, making TS narrowing impossible). At minimum, delete these two types and import canonical \`EventMessage\` from cluster-relay. Other relay types can be migrated in follow-up.
- **Rename \`PushEventFn\` signature** in control-plane: change from \`(channel, payload)\` to \`(event, data)\`, update HTTP body shape from \`{channel, payload}\` to \`{event, data, timestamp}\`, update orchestrator's \`/internal/relay-events\` Zod schema to match. Positional callers (\`pushEvent('cluster.audit', x)\`) are unchanged.

Remove every \`as RelayMessage\` and \`as unknown as RelayMessage\` cast on event sends. Let the type system enforce.

### Step 3: Cloud imports the schema from \`@generacy-ai/cluster-relay\` instead of duplicating

\`\`\`typescript
// services/api/src/services/relay/relay-types.ts
export type {
  EventMessage, ApiRequestMessage, ApiResponseMessage, /* etc */,
} from '@generacy-ai/cluster-relay';
\`\`\`

Drop the cloud's duplicate definitions. One source of truth.

### Step 4: Cloud validates incoming WebSocket messages against the imported Zod schema

Cloud's [\`relay-server.ts\`](https://github.com/generacy-ai/generacy-cloud/blob/main/services/api/src/services/relay/relay-server.ts) currently treats incoming messages as \`RelayMessage\` after a minimal shape check. Replace with \`RelayMessageSchema.safeParse()\` from the shared package — same Zod schema the cluster uses on its WebSocket reader. Any future drift is caught at the runtime boundary with a clear error.

## Why this matters beyond fixing the current bugs

Every recurrence so far has cost us:
- A round of testing → failure observation
- An investigation traced to a wire-shape mismatch
- An issue filed, clarification answered, PR opened, deploy
- And after each fix, the door is still open for the next mismatch

Four times in two weeks. The structural fix takes the door away. Wire-shape drift becomes a compile error, not a four-hour debugging session.

## Test plan
- [ ] Single canonical \`EventMessage\` type lives in \`@generacy-ai/cluster-relay\`
- [ ] Cloud's \`relay-types.ts\` re-exports rather than redefines
- [ ] All four send-sites in the orchestrator use the same shape (no \`as RelayMessage\` casts on event sends)
- [ ] Incoming cloud messages validated against the Zod schema; invalid shapes log a structured error with the offending message
- [ ] Existing audit / credential / tunnel / job event flows still work (regression check)
- [ ] Add a unit test in the cluster-relay package that round-trips an \`EventMessage\` through JSON and validates with the schema — locks the contract

## Out of scope

- The other message types (\`ApiRequestMessage\`, \`ApiResponseMessage\`, conversation, lease, tunnel) have the same structural risk but no known drops today. Address as a follow-up if there's interest, or piggyback if the implementer wants to do a sweep while touching the file.

## Related
- generacy-ai/generacy-cloud#543 (vscode-tunnel event filter — cloud-side symptom of the same mismatch)
- #594, #600 (cluster-side IPC, both versions wrong shape)
- #596 (cross-process state query; same architectural family but not strictly wire-shape)
- #572 (cluster ↔ cloud contract umbrella — this is the canonical example)

## User Stories

### US1: Relay Events Reach Cloud

**As a** cluster operator,
**I want** all relay events (audit, credentials, vscode-tunnel, bootstrap) to be received by the cloud,
**So that** the dashboard reflects real-time cluster state without silent data loss.

**Acceptance Criteria**:
- [ ] All four orchestrator send-sites emit the canonical `{type, event, data, timestamp}` shape
- [ ] Cloud receives and processes events from all channels (no silent drops)
- [ ] No `as RelayMessage` or `as unknown as RelayMessage` casts remain on event sends

### US2: Type-Safe Event Contract

**As a** developer working on cluster-cloud integration,
**I want** a single canonical event schema shared between repos,
**So that** wire-shape drift causes a compile error instead of a runtime silent drop.

**Acceptance Criteria**:
- [ ] `EventMessage` and `EventMessageSchema` defined once in `@generacy-ai/cluster-relay`
- [ ] Orchestrator's duplicate `RelayEvent`/`RelayJobEvent` types deleted, imports from cluster-relay
- [ ] `PushEventFn` signature uses canonical field names (`event`, `data`)

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Define canonical `EventMessage` type with `{type, event, data, timestamp}` in `cluster-relay` | P1 | Adopt cloud convention |
| FR-002 | Export `EventMessageSchema` and `RelayMessageSchema` from `cluster-relay` | P1 | Unblocks cloud companion PR |
| FR-003 | Update `relay-bridge.ts:390` to emit canonical shape | P1 | Currently emits `{channel, event}` — silently dropped |
| FR-004 | Update `internal-relay-events.ts` to emit canonical shape | P1 | Currently emits `{channel, event}` — #600 |
| FR-005 | Delete `RelayEvent`/`RelayJobEvent` from orchestrator's `types/relay.ts`, import from cluster-relay | P1 | Eliminates dual-discriminant trap |
| FR-006 | Rename `PushEventFn` from `(channel, payload)` to `(event, data)`, update HTTP body and Zod schema | P1 | End-to-end canonical naming |
| FR-007 | Remove all `as RelayMessage` / `as unknown as RelayMessage` casts on event sends | P1 | Let type system enforce |
| FR-008 | Add round-trip unit test for `EventMessage` schema in cluster-relay | P2 | Locks the contract |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Zero `as RelayMessage` casts on event sends | 0 remaining | Grep across orchestrator |
| SC-002 | All event channels reach cloud | 100% (audit, credentials, tunnel, bootstrap, job) | Integration test / manual verify |
| SC-003 | Single `EventMessage` definition | 1 source of truth in cluster-relay | No duplicate definitions in orchestrator or control-plane |

## Assumptions

- Cloud's existing `{event, data}` convention is the correct canonical shape (more semantically self-describing)
- Cloud companion PR (Steps 3-4: import schema, validate with Zod) will be done separately
- Positional callers of `pushEvent()` do not need changes (only the type signature and HTTP body shape change)

## Out of Scope

- Cloud-side changes (Steps 3-4: re-export types, Zod validation) — separate companion PR
- Other message types (`ApiRequestMessage`, `ApiResponseMessage`, conversation, lease, tunnel) — follow-up if needed
- Migrating non-event relay types from orchestrator's `types/relay.ts` to cluster-relay imports — follow-up

---

*Generated by speckit*
