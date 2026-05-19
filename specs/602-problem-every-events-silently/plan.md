# Implementation Plan: Canonical Relay Event Schema

**Feature**: Unify relay event wire shape across cluster and cloud
**Branch**: `602-problem-every-events-silently`
**Status**: Complete

## Summary

Every "events silently dropped" bug in recent weeks (#543, #594, #600) shares one root cause: the cluster-relay package defines `EventMessage` as `{channel, event}` while the cloud expects `{event, data, timestamp}`. Two shapes, same `type: 'event'` discriminant, no compile-time enforcement. The orchestrator itself emits both shapes via `as RelayMessage` casts that bypass type checking.

This plan unifies the wire shape by:
1. Updating `EventMessage` in `@generacy-ai/cluster-relay` to the canonical `{event, data, timestamp}` shape
2. Updating all cluster-side senders to emit the canonical shape
3. Replacing orchestrator's duplicate `RelayEvent`/`RelayJobEvent` types with the canonical import
4. Renaming `PushEventFn` from `(channel, payload)` to `(event, data)` end-to-end
5. Removing all `as RelayMessage` casts on event sends
6. Exporting schemas for the cloud companion PR

## Technical Context

**Language/Version**: TypeScript 5.x, Node >= 22 (ESM)
**Primary Dependencies**: `zod` (schema validation), `ws` (WebSocket)
**Testing**: vitest (unit tests in cluster-relay)
**Packages touched**:
- `packages/cluster-relay` — canonical type + schema definition
- `packages/orchestrator` — all send sites, delete duplicate types
- `packages/control-plane` — PushEventFn signature, IPC body shape

## Constitution Check

No constitution file found at `.specify/memory/constitution.md`. No gates to check.

## Project Structure

### Documentation (this feature)

```text
specs/602-problem-every-events-silently/
├── spec.md              # Feature specification
├── clarifications.md    # Clarification Q&A
├── plan.md              # This file
├── research.md          # Technical decisions
├── data-model.md        # Type definitions (before/after)
└── quickstart.md        # Verification guide
```

### Source Code (files modified)

```text
packages/cluster-relay/
└── src/
    └── messages.ts              # EventMessage type + EventMessageSchema (canonical)

packages/orchestrator/
├── src/
│   ├── types/
│   │   └── relay.ts             # Delete RelayEvent + RelayJobEvent, import from cluster-relay
│   ├── services/
│   │   ├── relay-bridge.ts      # Fix SSE forward (line ~390), fix job emit (line ~148)
│   │   └── lease-manager.ts     # Non-event casts — out of scope (lease types)
│   ├── routes/
│   │   └── internal-relay-events.ts  # Fix IPC handler shape + Zod schema
│   └── server.ts                # Fix job event emitter (line ~221), tunnel handler (line ~692)

packages/control-plane/
├── src/
│   └── relay-events.ts          # Rename PushEventFn: (channel, payload) → (event, data)
└── bin/
    └── control-plane.ts         # Update HTTP body: {channel, payload} → {event, data, timestamp}
```

## Implementation Phases

### Phase 1: Canonical Schema (cluster-relay)

**Goal**: Single source of truth for `EventMessage`.

1. **Update `EventMessage` interface** in `messages.ts`:
   - `channel: string` → `event: string` (event name)
   - `event: unknown` → `data: unknown` (payload)
   - Add `timestamp: string` (ISO 8601, required)

2. **Update `EventMessageSchema`** Zod schema to match:
   - `channel` → `event` (z.string())
   - `event` → `data` (z.unknown())
   - Add `timestamp` (z.string().datetime())

3. **Export both schemas**:
   - `EventMessageSchema` — named export (currently non-exported const)
   - `RelayMessageSchema` — named export (the discriminated union)

4. **Add round-trip unit test** (FR-008):
   - Construct `EventMessage`, serialize to JSON, parse with schema, assert equality

### Phase 2: Orchestrator Type Cleanup

**Goal**: Eliminate duplicate type system.

1. **Delete `RelayEvent` and `RelayJobEvent`** from `types/relay.ts`
2. **Import `EventMessage`** from `@generacy-ai/cluster-relay`
3. **Update `RelayMessage` union** in `types/relay.ts` to use imported `EventMessage` instead of the two deleted types
4. **Fix all import sites** that reference `RelayEvent` or `RelayJobEvent`

### Phase 3: Fix All Send Sites

**Goal**: Every event send uses the canonical shape, no casts.

| Send site | Current shape | Fix |
|-----------|--------------|-----|
| `relay-bridge.ts:~148` (job events) | `{event, data, timestamp} as RelayMessage` | Remove cast — already canonical shape |
| `relay-bridge.ts:~390` (SSE forward) | `{channel, event}` | `channel` → `event`, `event` → `data`, add `timestamp` |
| `internal-relay-events.ts:~46` (IPC) | `{channel, event: payload} as unknown as RelayMessage` | `channel` → `event`, `payload` → `data`, add `timestamp`, remove cast |
| `server.ts:~225` (worker job events) | `{event, data, timestamp} as RelayMessage` | Remove cast — already canonical shape |
| `server.ts:~692` (tunnel handler) | `msg as RelayMessage` | Keep or type-narrow (tunnel messages, not events — out of scope) |

### Phase 4: PushEventFn Rename (control-plane IPC)

**Goal**: End-to-end canonical naming through IPC boundary.

1. **Rename `PushEventFn`** in `relay-events.ts`:
   - `(channel: string, payload: unknown)` → `(event: string, data: unknown)`
2. **Update HTTP body** in `bin/control-plane.ts`:
   - `JSON.stringify({ channel, payload })` → `JSON.stringify({ event, data, timestamp: new Date().toISOString() })`
3. **Update Zod schema** in `internal-relay-events.ts`:
   - `{ channel, payload }` → `{ event, data, timestamp }`
4. **Update handler** to use new field names when calling `client.send()`

**Note**: Positional callers (`pushEvent('cluster.audit', x)`) are unchanged — only the parameter names change.

## Scope Boundaries

### In scope
- `EventMessage` type unification (FR-001 through FR-008)
- All event send sites in orchestrator
- PushEventFn rename through IPC chain
- Export schemas for cloud companion PR
- Round-trip unit test

### Out of scope
- Cloud-side changes (Steps 3-4 from spec: re-export types, Zod validation)
- Non-event `as RelayMessage` casts (lease, tunnel, conversation — different message types)
- Migrating other relay types from `types/relay.ts` to cluster-relay imports
- Other message types (`ApiRequestMessage`, `ApiResponseMessage`, etc.)

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Breaking existing working event flows | High | Job events already use `{event, data, timestamp}` — no shape change for them |
| TypeScript compilation errors after type deletion | Medium | Phase 2 changes types, Phase 3 fixes usages — do together |
| Control-plane callers broken by PushEventFn rename | Low | Positional callers unchanged; only parameter names change |
| Cloud rejects new shape | None | Cloud already expects `{event, data}` — that's why it works for job events |
