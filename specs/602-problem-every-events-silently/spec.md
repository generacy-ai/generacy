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

### Step 2: Update all cluster-side senders to the canonical shape

- \`packages/orchestrator/src/services/relay-bridge.ts:390\` — change \`channel\` → \`event\`, \`event\` → \`data\`, add \`timestamp\`
- \`packages/orchestrator/src/routes/internal-relay-events.ts\` — same change (overlap with #600; can fold or ship serially)

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

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
