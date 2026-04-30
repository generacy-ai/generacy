# Clarifications — #517 Cluster Activation cloud_url Fix

## Batch 1 — 2026-04-30

### Q1: FR-003 Boot-Time Config Override Target
**Context**: FR-003 says "Orchestrator reads `cloud_url` from `cluster.json` on boot" and falls back to `https://api.generacy.ai`. However, the orchestrator has *two* separate cloud URL configs: `config.relay.cloudUrl` (WSS format, default `wss://api.generacy.ai/relay`) and `config.activation.cloudUrl` (HTTPS format, default `https://api.generacy.ai`). These are different URL schemes/paths. The persisted `cloud_url` in `cluster.json` is a single HTTPS URL.
**Question**: When the orchestrator reads `cloud_url` from `cluster.json` on boot, which config value(s) should it override? Should it derive the WSS relay URL from the HTTPS `cloud_url` (e.g., `https://api.example.com` → `wss://api.example.com/relay`), or should only `config.activation.cloudUrl` be updated?
**Options**:
- A: Override both — derive relay WSS URL from persisted HTTPS `cloud_url` (e.g., `https://X` → `wss://X/relay`)
- B: Override only `config.activation.cloudUrl` — relay URL remains independently configured
- C: FR-003 is out of scope for this fix (defer boot-time override to a follow-up)

**Answer**: A — Override both. Derive the WSS relay URL from the persisted HTTPS `cloud_url`. Pattern: `https://X` → `wss://X/relay` (and `http://X` → `ws://X/relay` for local-dev). Keeps the self-hosted cloud story simple — one URL fully configures both activation and relay. If a future deployment ever needs split URLs, an explicit override field can be added without breaking this default.

### Q2: ActivationResult Type Extension
**Context**: `ActivationResult` is defined in the shared `@generacy-ai/activation-client` package and currently lacks a `cloudUrl` field. To implement FR-003, the `activate()` function's existing-key path (lines 37-46 of `index.ts`) needs to return the `cloud_url` read from `cluster.json`. This either requires adding `cloudUrl` to the shared `ActivationResult` type (which also affects CLI deploy) or having the orchestrator read `cluster.json` separately in `server.ts`.
**Question**: Should `cloudUrl` be added to the shared `ActivationResult` type in `activation-client`, or should the orchestrator handle `cloud_url` persistence/retrieval internally without modifying the shared type?
**Options**:
- A: Add `cloudUrl` to `ActivationResult` in `activation-client` (clean API, but CLI deploy must also handle it)
- B: Keep `ActivationResult` unchanged — orchestrator reads `cluster.json` directly in `server.ts` boot sequence

**Answer**: A — Add `cloudUrl` to `ActivationResult` in `activation-client`. The activation result is the canonical contract; making it complete lets both consumers (orchestrator at boot, CLI deploy) get the value cleanly. CLI deploy already needs `cloudUrl` for its own purposes. Mark the field optional in the type for backwards compat with test fixtures.

### Q3: Affected Files Completeness
**Context**: The spec's "Affected Files" section lists only 2 files (`activation-client/src/types.ts` and `orchestrator/src/activation/index.ts`). FR-001 and FR-002 are covered by these files. However, FR-003 ("Orchestrator reads `cloud_url` from `cluster.json` on boot") implies additional changes to: the `ActivationResult` type or `server.ts` boot sequence, and possibly `config/loader.ts`. The current `server.ts` boot code (lines 307-315) only copies `apiKey` and `clusterApiKeyId` from the activation result — it doesn't touch `cloudUrl`.
**Question**: Should FR-003 be implemented as part of this fix (expanding the affected files list), or is it intended as a separate follow-up issue?
**Options**:
- A: Implement FR-003 in this fix — expand affected files to include `server.ts` and related types
- B: Split FR-003 into a follow-up issue — this fix only covers FR-001 and FR-002

**Answer**: A — Implement FR-003 in this fix; expand the affected files list. Persisting `cloud_url` to `cluster.json` without reading it back at boot is half-done. Expanded affected files: `packages/orchestrator/src/server.ts` (boot sequence reads activation result's `cloudUrl` and passes through to relay/activation config), and the `ActivationResult` type.
