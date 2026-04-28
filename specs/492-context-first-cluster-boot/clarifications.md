# Clarifications for #492: Cluster-side device-flow activation client

## Batch 1 — 2026-04-28

### Q1: API key integration with relay config
**Context**: The orchestrator currently reads `GENERACY_API_KEY` from the environment to populate `config.relay.apiKey` (in `config/loader.ts`). After the activation module persists the key to `/var/lib/generacy/cluster-api-key`, the relay client needs to receive it. How this handoff works determines the activation module's contract.
**Question**: How should the activation module's persisted API key reach the relay client?
**Options**:
- A: Activation module returns the key; orchestrator entry point sets it on the config object before relay construction
- B: Config loader reads the key file as a fallback when `GENERACY_API_KEY` env var is absent
- C: Activation module sets `process.env.GENERACY_API_KEY` so the existing loader picks it up

**Answer**: *Pending*

### Q2: HTTP cloud URL derivation
**Context**: The spec references `GENERACY_CLOUD_URL` for device-code HTTP endpoints (`POST {GENERACY_CLOUD_URL}/api/clusters/device-code`), but the existing orchestrator config derives the relay WebSocket URL from `GENERACY_CHANNEL` (e.g., `wss://api.generacy.ai/relay`). There's no existing `GENERACY_CLOUD_URL` env var in the config loader — only the WSS relay URL.
**Question**: Is `GENERACY_CLOUD_URL` a new, separate env var with an HTTP base URL (e.g., `https://api.generacy.ai`), or should the activation module derive the HTTP URL from the existing WebSocket relay URL by stripping the `/relay` path and switching protocol?

**Answer**: *Pending*

### Q3: Retry budget parameters
**Context**: FR-007 requires "bounded retries with backoff" when `GENERACY_CLOUD_URL` is unreachable, but doesn't specify the retry count, backoff strategy, or timeouts. The existing relay uses 5s-300s exponential backoff for WebSocket reconnection. Different parameters affect first-boot UX (too aggressive = spam, too conservative = slow failure).
**Question**: What retry budget should the activation module use for the initial device-code request when the cloud is unreachable?
**Options**:
- A: 3 retries with exponential backoff (1s, 2s, 4s) — fail fast (~7s total)
- B: 5 retries with exponential backoff (2s, 4s, 8s, 16s, 32s) — moderate patience (~62s total)
- C: Match relay's existing backoff (5s-300s) — consistent with codebase but slow to fail

**Answer**: *Pending*

### Q4: Relationship to existing activation fields in relay handshake
**Context**: The relay handshake already sends optional `activation.code` and `activation.clusterApiKeyId` fields (in `relay.ts` lines 364-368), and `RelayConfig` already has `activationCode` and `clusterApiKeyId` fields. The device-flow spec introduces `device_code` and `user_code`. Understanding the relationship between these fields determines whether existing relay activation fields should be reused or are separate concepts.
**Question**: Are the relay's existing `activation.code`/`clusterApiKeyId` handshake fields the same mechanism as this device-flow, or are they a separate activation concept? Should the activation module populate these existing config fields?

**Answer**: *Pending*

### Q5: Device code expiry behavior
**Context**: FR-008 says "print instructions to re-run" when the device code expires before approval. This is ambiguous — "re-run" could mean the operator must restart the process, or the module could automatically request a new code.
**Question**: When the device code expires, should the activation module exit the process with a non-zero code (requiring operator to restart), or automatically request a new device code and restart the flow?
**Options**:
- A: Exit with non-zero code — operator must restart (simpler, explicit)
- B: Automatically request a new code and restart the flow (better UX, more complex)

**Answer**: *Pending*
