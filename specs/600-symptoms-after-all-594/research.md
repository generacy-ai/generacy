# Research: Fix malformed EventMessage shape

**Feature**: #600 — Fix swapped field names in relay event IPC handler

## Problem Analysis

### Root Cause

PR #594 introduced the `POST /internal/relay-events` handler to bridge control-plane relay events to the orchestrator's WebSocket client. The handler constructs the outgoing message with field names matching the **local** `EventMessage` TypeScript interface (`channel`, `event`) rather than the **cloud's** expected wire format (`event`, `data`, `timestamp`).

The `as unknown as RelayMessage` double-cast bypassed TypeScript's structural type checking, hiding the mismatch at compile time.

### Wire Format Mismatch

| Field | Local interface (`EventMessage`) | Cloud expectation | Handler sends (buggy) |
|-------|----------------------------------|-------------------|----------------------|
| Channel name | `channel: string` | `event: string` | `channel` (correct key, wrong field name) |
| Payload | `event: unknown` | `data: unknown` | `event` (payload in wrong field) |
| Timestamp | _(not present)_ | `timestamp: string` | _(missing)_ |

The cloud filters events by `message.event === 'cluster.vscode-tunnel'` (string comparison). Since `event` contains the payload object instead of the channel string, every event fails this filter silently.

### Same Bug Class: generacy-cloud#543

The cloud side had the identical field-swap pattern, already fixed in generacy-cloud#543. This confirms the wire format expectation: `{ type: 'event', event: <channel>, data: <payload>, timestamp: <ISO> }`.

## Decision: Cast Retention

**Option A**: Remove `as unknown as RelayMessage` entirely — requires updating `EventMessage` interface and Zod schema in `cluster-relay` (out of scope, #572).

**Option B**: Keep `as unknown as RelayMessage` — pragmatic, fixes the runtime bug now, defers type alignment.

**Chosen**: Option B. The runtime fix is critical (P0); the type alignment is a follow-up cleanup (#572). Adding a code comment explaining why the cast exists prevents future confusion.

## Decision: Timestamp Source

The handler uses `new Date().toISOString()` for the timestamp field. This is acceptable because:
- The timestamp represents "when the event was forwarded to the relay", not "when the event occurred"
- Control-plane events already carry their own timestamps inside the payload when relevant
- The cloud uses this top-level timestamp for ordering/deduplication, not business logic

## Affected Event Channels

All four IPC channels flow through this single handler:

| Channel | Producer | Consumer |
|---------|----------|----------|
| `cluster.vscode-tunnel` | `VsCodeTunnelProcessManager` | Cloud wizard UI (device code display) |
| `cluster.audit` | `AuditLog` flush | Firestore `audit_log` collection |
| `cluster.credentials` | `writeCredential()` | Cloud wizard credential status |
| `cluster.bootstrap` | `PeerRepoCloner`, `writeWizardEnvFile` | Cloud wizard progress |

## References

- PR #594 — introduced the handler
- PR #598 — refactored to deferred binding (getter pattern), handler shape unchanged
- generacy-cloud#543 — same field-swap bug on cloud side (fixed)
- Issue #572 — umbrella for relay wire-shape type safety
