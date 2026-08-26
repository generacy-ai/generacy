# Clarifications: Gateway-route validate warning + doctor llm-gateway check

## Batch 1 — 2026-08-26

### Q1: resolveRoute dependency availability
**Context**: FR-011 requires both consumers to import `resolveRoute` from `@generacy-ai/generacy-plugin-claude-code`, but no such export exists in that package today (the only `resolveRoute` in the repo is the unrelated path-prefix dispatcher in `cluster-relay`). The spec assumes it "exists (or lands with this work under the epic)". If the sibling issue has not merged by implement time, the import target is undefined and implementation blocks.
**Question**: How should this issue proceed if the shared `resolveRoute` helper has not landed when implementation starts?
**Options**:
- A: Block/requeue this issue until the sibling epic issue ships `resolveRoute` (hard dependency).
- B: Define `resolveRoute` in `@generacy-ai/generacy-plugin-claude-code` as part of THIS issue (this issue becomes the owner; sibling issues consume it).
- C: Ship a local interim route-classification helper inside `packages/generacy` and swap to the shared import in a follow-up once the sibling lands.

**Answer**: *Pending*

### Q2: Doctor check env source
**Context**: Existing doctor checks read credentials from `context.envVars` (populated by the `env-file` check from `.generacy/generacy.env` — see `anthropic-key.ts` which declares `dependencies: ['env-file']` and skips when envVars are unavailable). US1's validate warning explicitly reads `process.env`. The spec does not say which source the `llm-gateway` doctor check uses; the choice changes skip semantics (URL present in the process env but absent from the env file, or vice versa).
**Question**: Where should the `llm-gateway` doctor check read `GENERACY_LLM_GATEWAY_URL` / `GENERACY_LLM_GATEWAY_TOKEN` from?
**Options**:
- A: `context.envVars` with a `dependencies: ['env-file']` declaration (mirrors `anthropic-key`).
- B: `process.env` only (mirrors the validate warning's env source).
- C: `context.envVars` first, falling back to `process.env` when the key is absent from the env file.

**Answer**: *Pending*

### Q3: Probe endpoint choice
**Context**: FR-008 offers two probe shapes — `GET <url>/v1/models` OR "a 1-token `POST /v1/messages` with a configured model" — without picking one. Some gateway deployments may not implement `/v1/models`; a `POST /v1/messages` probe consumes tokens and needs a model name to exist in config. The check needs one deterministic behavior to test against (SC-002).
**Question**: Which probe should the `llm-gateway` check issue?
**Options**:
- A: `GET /v1/models` only; any non-200 maps per FR-010 (simplest, no token spend, mirrors `anthropic-key`).
- B: `POST /v1/messages` with `max_tokens: 1` using a gateway-routed model from config (proves end-to-end routing, but spends tokens and requires a configured model).
- C: `GET /v1/models` primary; on 404/405 fall back to the 1-token `POST /v1/messages` probe.

**Answer**: *Pending*

### Q4: URL set but token missing
**Context**: FR-007/FR-008 define behavior for URL-unset (skip) and URL-set-with-token (probe), but not for `GENERACY_LLM_GATEWAY_URL` set while `GENERACY_LLM_GATEWAY_TOKEN` is unset or empty. `anthropic-key` fails fast on a missing key without probing. Some gateways may accept unauthenticated requests.
**Question**: What should the check return when the URL is set but the token is missing/empty?
**Options**:
- A: `fail` immediately with a token-related suggestion, without issuing the probe (mirrors `anthropic-key`'s missing-key branch).
- B: Issue the probe unauthenticated and map the response per FR-010 (a 401 then produces the token suggestion naturally).
- C: `warn` — reachability may still be fine; token issues surface at spawn time.

**Answer**: *Pending*

### Q5: Gateway auth header scheme
**Context**: The spec says the gateway "speaks the Anthropic-style `/v1/models` and/or `/v1/messages` API and authenticates with `GENERACY_LLM_GATEWAY_TOKEN`", but does not specify the header. Anthropic's native API uses `x-api-key` + `anthropic-version`; typical gateway products (e.g., LiteLLM) accept `Authorization: Bearer`. A wrong header turns every probe into a misleading 401 `fail`.
**Question**: Which auth header should the check (and any future consumers) send the cluster token with?
**Options**:
- A: `Authorization: Bearer <token>` (common gateway convention).
- B: `x-api-key: <token>` + `anthropic-version` header (byte-compatible with Anthropic's API, mirrors `anthropic-key`).
- C: Send both headers on the probe.

**Answer**: *Pending*
