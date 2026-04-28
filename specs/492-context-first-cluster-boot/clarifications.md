# Clarifications for #492: Cluster-side device-flow activation client

## Batch 1 — 2026-04-28

### Q1: API key integration with relay config
**Context**: The orchestrator currently reads `GENERACY_API_KEY` from the environment to populate `config.relay.apiKey` (in `config/loader.ts`). After the activation module persists the key to `/var/lib/generacy/cluster-api-key`, the relay client needs to receive it. How this handoff works determines the activation module's contract.
**Question**: How should the activation module's persisted API key reach the relay client?
**Options**:
- A: Activation module returns the key; orchestrator entry point sets it on the config object before relay construction
- B: Config loader reads the key file as a fallback when `GENERACY_API_KEY` env var is absent
- C: Activation module sets `process.env.GENERACY_API_KEY` so the existing loader picks it up

**Answer**: A — Activation module returns the key; orchestrator entry sets it on config before relay construction.** Cleanest separation of concerns: the activation module's responsibility is "produce a cluster API key" (whether by reading the persisted file or running the device flow). The orchestrator's main entry composes activation result → config → relay client. Option C (mutating `process.env`) is hacky and breaks dependency-injection patterns. Option B couples the config loader to file paths it shouldn't know about.

### Q2: HTTP cloud URL derivation
**Context**: The spec references `GENERACY_CLOUD_URL` for device-code HTTP endpoints (`POST {GENERACY_CLOUD_URL}/api/clusters/device-code`), but the existing orchestrator config derives the relay WebSocket URL from `GENERACY_CHANNEL` (e.g., `wss://api.generacy.ai/relay`). There's no existing `GENERACY_CLOUD_URL` env var in the config loader — only the WSS relay URL.
**Question**: Is `GENERACY_CLOUD_URL` a new, separate env var with an HTTP base URL (e.g., `https://api.generacy.ai`), or should the activation module derive the HTTP URL from the existing WebSocket relay URL by stripping the `/relay` path and switching protocol?

**Answer**: New separate env var `GENERACY_CLOUD_URL` (e.g., `https://api.generacy.ai`).** When unset, derive from the existing relay URL by stripping `/relay` and switching `wss://` → `https://` as a fallback so most users don't need to configure it explicitly. Explicit env-var override is needed for self-hosted generacy-cloud deployments and for testing against a local cloud server. Document the precedence: explicit env > derived from relay URL.

### Q3: Retry budget parameters
**Context**: FR-007 requires "bounded retries with backoff" when `GENERACY_CLOUD_URL` is unreachable, but doesn't specify the retry count, backoff strategy, or timeouts. The existing relay uses 5s-300s exponential backoff for WebSocket reconnection. Different parameters affect first-boot UX (too aggressive = spam, too conservative = slow failure).
**Question**: What retry budget should the activation module use for the initial device-code request when the cloud is unreachable?
**Options**:
- A: 3 retries with exponential backoff (1s, 2s, 4s) — fail fast (~7s total)
- B: 5 retries with exponential backoff (2s, 4s, 8s, 16s, 32s) — moderate patience (~62s total)
- C: Match relay's existing backoff (5s-300s) — consistent with codebase but slow to fail

**Answer**: B — 5 retries with exponential backoff (2s, 4s, 8s, 16s, 32s) — ~62s total.** Failing at ~7s (option A) is too aggressive for first-boot scenarios where the network is still coming up. Matching relay's 5s-300s (option C) is too patient — the user is staring at the activation prompt. ~1 minute of retries hits the right balance for first-boot UX, after which a clear error tells the operator what to check.

### Q4: Relationship to existing activation fields in relay handshake
**Context**: The relay handshake already sends optional `activation.code` and `activation.clusterApiKeyId` fields (in `relay.ts` lines 364-368), and `RelayConfig` already has `activationCode` and `clusterApiKeyId` fields. The device-flow spec introduces `device_code` and `user_code`. Understanding the relationship between these fields determines whether existing relay activation fields should be reused or are separate concepts.
**Question**: Are the relay's existing `activation.code`/`clusterApiKeyId` handshake fields the same mechanism as this device-flow, or are they a separate activation concept? Should the activation module populate these existing config fields?

**Answer**: They are conceptually the same activation concept but the v1.5 device-flow uses HTTP, not the relay handshake.** Populate `clusterApiKeyId` on `RelayConfig` from the API key prefix returned by the device-flow approval response — that field is a useful echo for diagnostics. Leave `activation.code` on the relay handshake **unset** — it's vestigial from the earlier design where the claim code was passed through the relay handshake itself. A small follow-up issue to remove `activation.code` from `HandshakeMessage` is appropriate after this work lands; for now, just don't populate it.

### Q5: Device code expiry behavior
**Context**: FR-008 says "print instructions to re-run" when the device code expires before approval. This is ambiguous — "re-run" could mean the operator must restart the process, or the module could automatically request a new code.
**Question**: When the device code expires, should the activation module exit the process with a non-zero code (requiring operator to restart), or automatically request a new device code and restart the flow?
**Options**:
- A: Exit with non-zero code — operator must restart (simpler, explicit)
- B: Automatically request a new code and restart the flow (better UX, more complex)

**Answer**: B — Automatically request a new device code and restart the flow.** Exiting the process (option A) crashes the orchestrator container; with default Docker restart policies that means a dead container until manual restart, which is worse than the in-process retry. The activation module should detect the `expired` status, log a clear message ("activation code expired, requesting a new one"), and re-initiate the device-code request. Bound the total retry attempts (e.g., 3 cycles) before bailing out so a misconfigured cluster doesn't loop forever.
