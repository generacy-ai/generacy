# Feature Specification: Unify Relay Event Wire Schema

**Branch**: `602-problem-every-events-silently` | **Date**: 2026-05-12 | **Status**: Draft

## Summary

Cluster and cloud have structurally different `EventMessage` types (`{channel, event}` vs `{event, data}`), causing repeated silent event drops. Four bugs in two weeks (#543, #594, #600, plus latent audit/credential drops) all trace to this single root cause. Fix by defining one canonical `EventMessage` schema in `@generacy-ai/cluster-relay` and aligning all senders/consumers.

## Problem

There is no canonical, shared definition of the relay event wire shape. Each repo defines the same message type differently:

- **Cluster** (`packages/cluster-relay/src/messages.ts`): `{ type: 'event', channel: string, event: unknown }`
- **Cloud** (`services/api/src/services/relay/relay-types.ts`): `{ type: 'event', event: string, data: unknown }`

When the cluster sends `{ channel: 'cluster.audit', event: {...} }`, the cloud's filter `message.event === 'cluster.audit'` compares an object to a string — always false. Events are silently dropped.

The orchestrator itself emits **both shapes** depending on the call site, with `as RelayMessage` casts hiding the mismatch from TypeScript:

| Call site | Shape emitted | Works? |
|---|---|---|
| `server.ts:221` (job events) | `{event, data, timestamp}` | Yes (matches cloud) |
| `relay-bridge.ts:144` (SSE forward) | `{event, data, timestamp}` | Yes (matches cloud) |
| `relay-bridge.ts:390` (other SSE path) | `{channel, event: payload}` | No — silently dropped |
| `internal-relay-events.ts` (#594) | `{channel, event: payload}` | No — silently dropped |

## Fix — Single Canonical Schema

### Step 1: Define canonical shape in `@generacy-ai/cluster-relay`

Adopt the cloud's convention (`event` = name, `data` = payload, `timestamp` required):

```typescript
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
```

### Step 2: Update all cluster-side senders

- `relay-bridge.ts:390` — `channel` → `event`, `event` → `data`, add `timestamp`
- `internal-relay-events.ts` — same transformation
- Remove all `as RelayMessage` / `as unknown as RelayMessage` casts on event sends

### Step 3: Cloud imports schema from `@generacy-ai/cluster-relay`

Cloud's `relay-types.ts` re-exports from the shared package instead of duplicating definitions.

### Step 4: Cloud validates with shared Zod schema

Replace cloud's minimal shape check with `RelayMessageSchema.safeParse()` from the shared package. Future drift becomes a runtime error with a structured log, not a silent drop.

## User Stories

### US1: Relay Event Reliability

**As a** platform developer,
**I want** a single canonical relay event wire schema shared between cluster and cloud,
**So that** wire-shape mismatches are caught at compile time rather than silently dropping events in production.

**Acceptance Criteria**:
- [ ] `EventMessage` type and `EventMessageSchema` in `@generacy-ai/cluster-relay` are the single source of truth
- [ ] All orchestrator event send-sites use the canonical shape without type casts
- [ ] Cloud imports and validates against the shared schema

### US2: Event Flow Integrity

**As a** user of the bootstrap wizard,
**I want** credential, audit, and VS Code tunnel events to reliably reach the cloud,
**So that** the wizard UI reflects actual cluster state (credentials saved, tunnel connected, etc.).

**Acceptance Criteria**:
- [ ] `cluster.credentials` events from control-plane reach cloud event handlers
- [ ] `cluster.vscode-tunnel` events reach cloud event handlers
- [ ] `cluster.audit` batches reach cloud audit persistence

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Redefine `EventMessage` in `cluster-relay` with `{event, data, timestamp}` shape | P0 | Breaking change to cluster-relay types |
| FR-002 | Update `EventMessageSchema` Zod validator to match new shape | P0 | `timestamp` becomes required |
| FR-003 | Update `relay-bridge.ts:390` sender to canonical shape | P0 | Currently uses `{channel, event}` |
| FR-004 | Update `internal-relay-events.ts` sender to canonical shape | P0 | Currently uses `{channel, event}` |
| FR-005 | Remove `as RelayMessage` casts on event send-sites | P1 | Let compiler enforce correctness |
| FR-006 | Update `setRelayPushEvent` callback signature in control-plane | P1 | Must emit canonical shape |
| FR-007 | Cloud re-exports types from `@generacy-ai/cluster-relay` | P1 | Cross-repo; may ship separately |
| FR-008 | Cloud validates incoming messages with shared Zod schema | P1 | Cross-repo; may ship separately |
| FR-009 | Add round-trip unit test for `EventMessage` schema | P1 | Locks the wire contract |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Zero `as RelayMessage` casts on event sends | 0 casts | grep for cast pattern in orchestrator event send paths |
| SC-002 | All event channels reach cloud handlers | 100% | Integration test: emit each channel, verify cloud receipt |
| SC-003 | Wire-shape drift caught at compile time | Yes | Introduce intentional field rename, verify tsc fails |
| SC-004 | No silent event drops in bootstrap flow | 0 drops | End-to-end wizard test: credentials, tunnel, audit events all arrive |

## Assumptions

- Cloud's `{event, data}` convention is the correct canonical shape (more semantically descriptive)
- The `timestamp` field can become required without breaking existing consumers (cloud already expects it on most paths)
- Cross-repo changes (Steps 3-4) can ship as a companion PR to `generacy-cloud` after the cluster-side schema is published

## Out of Scope

- Other message types (`ApiRequestMessage`, `ApiResponseMessage`, conversation, lease, tunnel) — same structural risk but no known drops. Follow-up if desired.
- Cloud-side implementation (Steps 3-4) is specified here but implemented in the `generacy-cloud` repo as a companion PR.

## Related Issues

- generacy-ai/generacy-cloud#543 — vscode-tunnel event filter (cloud-side symptom)
- #594, #600 — cluster-side IPC, both wrong shape
- #596 — cross-process state query (same architectural family)
- #572 — cluster-cloud contract umbrella

---

*Generated by speckit*
