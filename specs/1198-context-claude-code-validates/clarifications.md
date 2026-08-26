# Clarifications

## Batch 2026-08-26

### Q1: `route` field vs subscription byte-identity
**Context**: FR-007 says `LaunchSpec` gains an informational `route` field, but FR-004/US2/SC-002/SC-004 require subscription launches to be **deep-equal to the pre-change output**. If every builder stamps `route: 'subscription'`, strict deep-equal against pre-change output fails — the two requirements conflict as written. This also determines whether the non-model `buildInvokeLaunch` gets a `route` field.
**Question**: Should `route` be present on every `LaunchSpec`, or only on gateway-routed ones?
**Options**:
- A: Gateway-only — builders set `route: 'gateway'` on gateway launches; subscription (and invoke) `LaunchSpec`s omit the field entirely, so strict deep-equal to pre-change output holds.
- B: Always present — every model-bearing builder stamps `route: 'subscription' | 'gateway'`; redefine FR-004/SC-004 byte-identity as "identical except the informational `route` field".

**Answer**: *Pending*

### Q2: `gatewayConfigDir` precedence
**Context**: FR-002 says the option defaults to `/home/node/.claude-gateway` and is "overridable via the `GENERACY_CLAUDE_GATEWAY_CONFIG_DIR` environment variable". It is ambiguous whether the env var overrides only the built-in default or also an explicitly passed constructor option. This decides the operator override story and the option-resolution test.
**Question**: What is the precedence order between the explicit `gatewayConfigDir` option, the `GENERACY_CLAUDE_GATEWAY_CONFIG_DIR` env var, and the built-in default?
**Options**:
- A: Explicit option > env var > default — conventional config precedence; env only fills in when the caller passes nothing.
- B: Env var > explicit option > default — env is an operator-level override that beats whatever the code passes.

**Answer**: *Pending*

### Q3: `settings.json` check cache semantics
**Context**: US3 scenario 2 says the existence check "is served from a per-process cache" after running once, but scenario 3 requires the ENOENT→exists transition to be honored later. These conflict if the negative (missing) result is cached for the process lifetime — a thrown `GatewayRouteUnavailableError` would then persist forever even after the operator provisions the file.
**Question**: How should the per-process cache treat the negative (file-missing) result?
**Options**:
- A: Cache only the positive result — once `settings.json` is seen, cache "exists" for the process lifetime (keyed per gateway dir path); while missing, re-stat on every gateway launch so provisioning is picked up immediately. Satisfies both scenarios.
- B: Cache both results with an explicit invalidation mechanism (TTL or fs.watch) that flips the cached "missing" entry when the file appears.

**Answer**: *Pending*

### Q4: Gateway launch CLI args unchanged?
**Context**: All model-bearing builders currently append `--model <model>` and, when set, `--effort <effort>`. The spec only mandates env injection for gateway routes; it is silent on whether the arg construction changes. Non-Anthropic gateway models may not honor `--effort`, but suppressing it would be a behavior change beyond env injection.
**Question**: For gateway-routed launches, is the CLI arg construction unchanged — the `provider/model` string passed verbatim via `--model` and `--effort` still appended when set?
**Options**:
- A: Unchanged — env injection (`CLAUDE_CONFIG_DIR`) is the only difference between routes; `--model` and `--effort` pass through exactly as today.
- B: Suppress `--effort` on gateway routes — pass only `--model`, since non-Anthropic models may reject effort; document as a gateway-route divergence.

**Answer**: *Pending*
