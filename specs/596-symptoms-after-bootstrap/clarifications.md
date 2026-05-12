# Clarifications — #596 Orchestrator `/health` always reports `codeServerReady: false`

## Batch 1 — 2026-05-12

### Q1: relay-bridge.ts scope
**Context**: `relay-bridge.ts:501` has the identical cross-process singleton bug — `collectMetadata()` calls `getCodeServerManager()?.getStatus() === 'running'`. The spec's FR-001 only targets `health.ts`. If left unfixed, periodic metadata updates will also report `codeServerReady: false` even when code-server is running.
**Question**: Should this PR also fix the `collectMetadata()` call in `relay-bridge.ts`, or is that deferred to a separate issue?
**Options**:
- A: Fix both in this PR (same root cause, same fix pattern)
- B: Fix only `health.ts` now; file a follow-up for `relay-bridge.ts`

**Answer**: *Pending*

### Q2: Async ripple in collectMetadata
**Context**: If `relay-bridge.ts` is in scope (Q1=A), `collectMetadata()` is currently synchronous. Adding an async socket probe requires making it `async`, which ripples into `sendMetadata()` (the caller). Two strategies: (a) make `collectMetadata`/`sendMetadata` async, or (b) cache the last probe result (updated on a short interval or from `/health` calls) and read it synchronously in `collectMetadata`.
**Question**: If relay-bridge is in scope, which approach for the metadata path?
**Options**:
- A: Make `collectMetadata()` and `sendMetadata()` async (simplest, consistent with health.ts)
- B: Cache the probe result and read synchronously (avoids async ripple, bounded staleness)

**Answer**: *Pending*
