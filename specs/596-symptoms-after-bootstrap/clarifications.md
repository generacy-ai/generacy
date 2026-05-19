# Clarifications — #596 Orchestrator `/health` always reports `codeServerReady: false`

## Batch 1 — 2026-05-12

### Q1: relay-bridge.ts scope
**Context**: `relay-bridge.ts:501` has the identical cross-process singleton bug — `collectMetadata()` calls `getCodeServerManager()?.getStatus() === 'running'`. The spec's FR-001 only targets `health.ts`. If left unfixed, periodic metadata updates will also report `codeServerReady: false` even when code-server is running.
**Question**: Should this PR also fix the `collectMetadata()` call in `relay-bridge.ts`, or is that deferred to a separate issue?
**Options**:
- A: Fix both in this PR (same root cause, same fix pattern)
- B: Fix only `health.ts` now; file a follow-up for `relay-bridge.ts`

**Answer**: A — Fix both in this PR. Same root cause, same fix shape. Splitting creates a window where `/health` reports correctly but the 60s metadata heartbeat overwrites Firestore with the wrong value. The cluster-relay path (`collectMetadata` in `packages/cluster-relay/src/metadata.ts`) already reads `codeServerReady` from `/health` over HTTP, so once `/health` is correct that path is fixed transitively. Only the in-process relay-bridge callsite needs explicit attention.

### Q2: Async ripple in collectMetadata
**Context**: If `relay-bridge.ts` is in scope (Q1=A), `collectMetadata()` is currently synchronous. Adding an async socket probe requires making it `async`, which ripples into `sendMetadata()` (the caller). Two strategies: (a) make `collectMetadata`/`sendMetadata` async, or (b) cache the last probe result (updated on a short interval or from `/health` calls) and read it synchronously in `collectMetadata`.
**Question**: If relay-bridge is in scope, which approach for the metadata path?
**Options**:
- A: Make `collectMetadata()` and `sendMetadata()` async (simplest, consistent with health.ts)
- B: Cache the probe result and read synchronously (avoids async ripple, bounded staleness)

**Answer**: A — Make it async, but extract the probe into a shared helper (`packages/orchestrator/src/services/code-server-probe.ts`). The async ripple is shallow: `collectMetadata` → `sendMetadata` → the `setInterval` callback. Three function signatures change, one `.catch()` on the interval callback. Option B's cache management (TTL, invalidation, stale-state risk) is worse than the async cost. Drop `getCodeServerManager()?.getStatus()` calls entirely — they were the wrong abstraction (cross-process singleton fallacy). The probe is the right abstraction.
