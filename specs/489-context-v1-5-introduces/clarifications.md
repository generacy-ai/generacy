# Clarifications: Cluster-relay protocol additions and path-prefix dispatcher

## Batch 1 — 2026-04-28

### Q1: Path stripping on prefix match
**Context**: When the dispatcher matches a prefix like `/control-plane/`, it needs to construct the URL/path for the downstream target. This affects how the control-plane service mounts its routes and is critical for correct routing behavior.
**Question**: When forwarding a request that matches a prefix (e.g., `/control-plane/api/setup`), should the matched prefix be stripped from the path before forwarding (i.e., forward as `/api/setup`), or should the full original path be preserved (i.e., forward as `/control-plane/api/setup`)?
**Options**:
- A: Strip the matched prefix (e.g., `/control-plane/api/setup` → `/api/setup`)
- B: Preserve the full path (e.g., `/control-plane/api/setup` → `/control-plane/api/setup`)

**Answer**: A — Strip the matched prefix.** Standard reverse-proxy convention. Lets the control-plane service mount its routes naturally as `/state`, `/credentials/:id`, etc. without each downstream service needing to know its own prefix.

### Q2: Fallback vs 404 semantics
**Context**: The spec states both "all other paths preserve existing orchestrator-HTTP forwarding" and "paths matching no configured prefix return 404". These appear contradictory — if the orchestrator is always a fallback, no path would ever return 404. The implementation needs a clear rule for when 404 applies vs when the orchestrator fallback is used.
**Question**: Should the orchestrator serve as an implicit catch-all fallback (meaning 404 only applies when there is no orchestrator configured), or should the orchestrator be an explicit entry in the routes array (e.g., `{ prefix: "/", target: "http://localhost:3000" }`) and 404 is returned for any path not matching a configured prefix?
**Options**:
- A: Orchestrator is an implicit fallback — 404 only if no orchestrator URL is configured
- B: Orchestrator must be an explicit route entry (e.g., prefix `/`) — true 404 for unmatched paths
- C: Orchestrator is a fallback by default, but can be disabled to enable strict 404 mode

**Answer**: A — Orchestrator is an implicit fallback.** Preserves the existing model (`orchestratorUrl` is the catch-all) without forcing every downstream config to migrate. Pairs with Q3-A for clean backwards compatibility.

### Q3: Config shape evolution
**Context**: The current `RelayConfig` has a top-level `orchestratorUrl` field. The new dispatcher introduces `Array<{ prefix, target }>`. The relationship between these two config shapes determines backwards compatibility and migration strategy.
**Question**: Should the new routes/dispatcher config be a new field alongside `orchestratorUrl` (with `orchestratorUrl` still used as the default/fallback target), or should `orchestratorUrl` be replaced entirely by the routes array?
**Options**:
- A: Add new `routes` field alongside `orchestratorUrl` — `orchestratorUrl` becomes the fallback for unmatched paths
- B: Replace `orchestratorUrl` with `routes` array — the orchestrator must be configured as a route entry
- C: Support both — if `routes` is present use it, otherwise fall back to legacy `orchestratorUrl` behavior

**Answer**: A — Add `routes` alongside `orchestratorUrl`; `orchestratorUrl` is the fallback target.** Existing configs keep working unchanged. New configs add `routes: [{prefix: '/control-plane', target: 'unix:///run/generacy-control-plane/control.sock'}]` and the dispatcher tries those first, then falls through to `orchestratorUrl`.

### Q4: Activation data source
**Context**: The spec adds an optional `activation` field to `HandshakeMessage` with `code` and `clusterApiKeyId`, but doesn't specify where the cluster-relay client obtains this data at runtime. This determines what config/environment changes are needed.
**Question**: Where should the cluster-relay client get the activation code and cluster API key ID for the handshake? Should these come from environment variables, config file fields, CLI arguments, or some other mechanism?
**Options**:
- A: Environment variables (e.g., `ACTIVATION_CODE`, `CLUSTER_API_KEY_ID`)
- B: New fields in `RelayConfig` / config file
- C: CLI arguments passed at startup
- D: Both env vars and config fields (config takes precedence)

**Answer**: B — New fields in `RelayConfig`.** The orchestrator's activation module (issue #492) reads the persisted API key from `/var/lib/generacy/cluster-api-key` and constructs the `RelayClient` with that data programmatically. No env-var or CLI plumbing is needed at the relay-client layer — the orchestrator owns that. Env-var override can be added later if anyone needs it; YAGNI for now.

### Q5: Prefix matching order
**Context**: With multiple `{ prefix, target }` entries in the routes config, a request path could potentially match more than one prefix. The matching strategy affects behavior when routes overlap (e.g., `/control-plane/` and `/control-plane/admin/`).
**Question**: When multiple configured prefixes could match a request path, should the dispatcher use longest-prefix-match (most specific wins) or first-match (order in config array determines priority)?
**Options**:
- A: Longest-prefix-match (most specific prefix wins regardless of order)
- B: First-match (routes evaluated in config order, first match wins)

**Answer**: A — Longest-prefix-match.** Matches nginx/reverse-proxy convention; protects against config-order mistakes if a more specific prefix is ever added later (e.g., `/control-plane/admin/*`). Implementation: sort the routes array by prefix length descending at config load time.
