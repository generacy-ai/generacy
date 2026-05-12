# Clarifications

## Batch 1 — 2026-05-12

### Q1: Credential Enumeration Strategy
**Context**: `ClusterLocalBackend` has no public `listKeys()` or `getAllSecrets()` method. The `bootstrap-complete` handler (FR-001) needs to unseal "all stored credentials," but `fetchSecret(key)` requires knowing the key upfront. `credentials.yaml` (written by `writeCredential()`) contains the credential IDs and types.
**Question**: Should the handler enumerate credentials by reading IDs from `credentials.yaml`, or should we add a `listKeys()` method to `ClusterLocalBackend`?
**Options**:
- A: Read credential IDs from `credentials.yaml` (no backend API change, metadata already exists)
- B: Add `listKeys()` to `ClusterLocalBackend` (cleaner API, single source of truth for what's in the credstore)

**Answer**: *Pending*

### Q2: Credential-to-Env-Var Mapping
**Context**: FR-003 maps `github-app` → `GH_TOKEN` and `api-key` (anthropic) → `ANTHROPIC_API_KEY`. However, `api-key` is a generic credential type used by multiple plugins (Stripe, generic API keys, etc.). The env var name can't be derived from type alone for `api-key` credentials.
**Question**: How should the handler determine the env var name for each credential? Specifically: what are the exact credential IDs the wizard uses, and should the mapping key off credential ID (e.g., `anthropic-api-key` → `ANTHROPIC_API_KEY`) rather than type?
**Options**:
- A: Map by credential ID (e.g., `github-main-org` → `GH_TOKEN`, `anthropic-api-key` → `ANTHROPIC_API_KEY`) — requires knowing exact wizard IDs
- B: Map by type + credential ID pattern (e.g., type `api-key` with ID containing `anthropic` → `ANTHROPIC_API_KEY`)
- C: Cloud sends an `envName` hint in the credential payload (requires cloud-side change)

**Answer**: *Pending*

### Q3: github-app Stored Value Format
**Context**: The `github-app` plugin in credhelper-daemon normally generates installation access tokens from an App's private key + installation ID. But during wizard flow, the cloud sends a raw value via `PUT /credentials/:id` with `{ type, value }`. The handler needs to write this value as `GH_TOKEN=<value>` in the env file.
**Question**: Is the value stored for `github-app` type a raw installation access token (e.g., `ghs_...`) directly usable as `GH_TOKEN`? Or is it structured data (JSON with app private key, installation ID) that requires token generation before writing to the env file?
**Options**:
- A: Raw token string — use directly as `GH_TOKEN` value
- B: Structured JSON — needs parsing and token generation step

**Answer**: *Pending*

### Q4: Error Handling on Credential Unseal Failure
**Context**: The `bootstrap-complete` handler currently always succeeds (writes sentinel, starts code-server). Adding credential unsealing introduces a new failure mode — a credential could fail to unseal due to corrupt data or missing master key, but blocking `bootstrap-complete` entirely would prevent the cluster from progressing.
**Question**: If one credential fails to unseal, should the handler fail the entire `bootstrap-complete` action, or write a partial env file with only successfully unsealed credentials?
**Options**:
- A: Fail hard — return error, don't write sentinel, block post-activation
- B: Best-effort — write partial env file, log warning, continue with sentinel write
- C: Best-effort with relay event — like B but also emit a relay event so cloud UI can show a warning

**Answer**: *Pending*
