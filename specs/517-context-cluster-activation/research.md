# Research: #517 Activation cloud_url Fix

## Root Cause Analysis

### Problem 1: Schema Rejection

`PollResponseSchema` in `packages/activation-client/src/types.ts:14-26` defines the `approved` variant without `cloud_url`. Zod's strict parsing (default behavior) strips unknown fields — so even though the cloud sends `cloud_url`, it is silently dropped after parse. With `z.discriminatedUnion`, the parsed output simply omits the field.

This means `pollResult.cloud_url` is `undefined` after parsing, even when the cloud sends it.

### Problem 2: Persistence Uses Config Input

In `packages/orchestrator/src/activation/index.ts:83`, the code persists `cloud_url: cloudUrl` — this is the *input config value* (typically `https://api.generacy.ai`), not the cloud-returned value. Even if the schema were fixed, this would still write the wrong URL for custom-cloud deployments where the cloud might return a different canonical URL.

### Problem 3: ActivationResult Missing cloudUrl

The shared `ActivationResult` type has no `cloudUrl` field. The orchestrator's `server.ts` can't read it from the activation result.

### Problem 4: Boot-Time No Override

`server.ts:313-314` only copies `apiKey` and `clusterApiKeyId` from the activation result. It doesn't touch cloud URLs, so even if `cluster.json` has the right URL, it's never used after boot.

## Technical Decisions

### Decision 1: cloud_url Required in Schema

**Choice**: `cloud_url: z.string().url()` (required, not optional)
**Rationale**: The cloud always returns `cloud_url` on approved responses per spec assumption. Making it required ensures schema and cloud stay in sync. If the cloud stops sending it, activation will fail-closed, which is the correct behavior (better to fail than silently use wrong URL).

### Decision 2: cloudUrl Optional in ActivationResult

**Choice**: `cloudUrl?: string` (optional)
**Rationale**: The existing-key path reads from `cluster.json`, which may not have `cloud_url` in pre-fix clusters. Optional field preserves backwards compatibility. The orchestrator only overrides config when the field is present.

### Decision 3: WSS URL Derivation

**Choice**: Simple scheme swap (`https:` → `wss:`, `http:` → `ws:`) + `/relay` suffix
**Rationale**: Matches existing pattern. `config.relay.cloudUrl` defaults to `wss://api.generacy.ai/relay`, which is exactly `https://api.generacy.ai` with scheme swap + `/relay`. No deployment needs split relay/activation URLs per spec assumption.

### Decision 4: Persist cloud-returned URL, Not Input Config

**Choice**: Change `cloud_url: cloudUrl` to `cloud_url: pollResult.cloud_url`
**Rationale**: The cloud is the authority on the canonical URL. The input `cloudUrl` might be a bootstrap URL that differs from the cloud's canonical self-reference. Using the cloud-returned value ensures correctness for redirected or multi-region deployments.

## Alternatives Considered

### A: Make PollResponseSchema Use .passthrough()

Rejected — `.passthrough()` would allow arbitrary unknown fields through, weakening validation. Better to explicitly declare the expected field.

### B: Read cluster.json Directly in server.ts (Skip ActivationResult)

Rejected per clarification Q2 — makes `ActivationResult` an incomplete contract. Both orchestrator and CLI deploy need `cloudUrl`; it should be in the shared type.

### C: Split FR-004 Into Follow-Up

Rejected per clarification Q3 — persisting without reading back is half-done. The fix should be complete.

## Key Code Patterns

- **Zod discriminated union**: `PollResponseSchema` uses `z.discriminatedUnion('status', [...])` — each variant must declare all fields it expects
- **Atomic file writes**: temp file + rename pattern used by `writeClusterJson`/`writeKeyFile`
- **Config mutation**: `server.ts` directly mutates config object properties after activation — this is the existing pattern
- **Re-exports**: Orchestrator's `activation/` module re-exports types from `@generacy-ai/activation-client` — changes to the shared package flow through automatically
