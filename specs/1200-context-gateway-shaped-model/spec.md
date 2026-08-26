# Feature Specification: Gateway-route validate warning + doctor llm-gateway check

**Branch**: `1200-context-gateway-shaped-model` | **Date**: 2026-08-26 | **Status**: Draft

## Summary

A gateway-shaped model (`provider/model`) in `.generacy/config.yaml` only functions
when the cluster has an LLM gateway configured (`GENERACY_LLM_GATEWAY_URL` +
`GENERACY_LLM_GATEWAY_TOKEN`). Today nothing warns an operator that they have
configured a gateway-routed model without the gateway environment in place, and
`generacy doctor` has no way to confirm a configured gateway is actually reachable.

This feature adds two operator-facing safety nets, both routing model strings
through the shared `resolveRoute` helper from `@generacy-ai/generacy-plugin-claude-code`:

1. **`generacy validate` warning** — for every resolved agent entry whose model
   resolves to the `gateway` route, emit a non-fatal warning when
   `GENERACY_LLM_GATEWAY_URL` is unset in the validator's environment.
2. **`generacy doctor` `llm-gateway` check** — a new health check that is *skipped*
   (not failed) when `GENERACY_LLM_GATEWAY_URL` is unset, and when set verifies the
   gateway is reachable and authenticating with the cluster token.

## Context

- `loadConfigWithWarnings` currently only collects effort-mechanism-mismatch warnings
  via `collectEffortWarnings` (`packages/generacy/src/config/loader.ts:346-411`).
  Exit code stays 0 on warnings; only errors exit 1. The new gateway warnings share
  this warnings-only, exit-0 surface.
- `generacy doctor` checks live under `packages/generacy/src/cli/commands/doctor/checks/`.
  Each check implements `CheckDefinition` returning a `CheckResult` with status
  `'pass' | 'fail' | 'warn' | 'skip'`. The `anthropic-key` check
  (`checks/anthropic-key.ts`) is the closest model: it `fetch`es a `/v1/models`
  endpoint, maps 401 → fail, other non-200 → fail, network error → fail, and returns
  detail. The new `llm-gateway` check mirrors this shape but *skips* when the URL is
  absent rather than failing.
- `resolveRoute` is a shared helper owned by sibling issue generacy-ai/generacy#1198
  under the LLM-gateway epic (generacy-ai/generacy#1197). It maps a model string to a
  route (`anthropic` | `gateway`). Both consumers depend on it; this issue does not
  define it. **Hard dependency (clarification Q1=A)**: if #1198 has not shipped
  `resolveRoute` when implementation starts, this issue blocks/requeues — it must NOT
  define the helper itself or ship a local interim classifier.
- The `cockpit.auto.agents.*` config surface is also part of the epic; the warning
  walk must cover it when it exists.

## User Stories

### US1: Operator catches a gateway model with no gateway env (P1)

**As a** cluster operator editing `.generacy/config.yaml`,
**I want** `generacy validate` to warn me when I configure a gateway-routed model
but no `GENERACY_LLM_GATEWAY_URL` is set,
**So that** I learn at config-edit time — not at spawn time — that the model will
not route anywhere.

**Acceptance Criteria**:
- [ ] A resolved agent entry whose model resolves to the `gateway` route + no
  `GENERACY_LLM_GATEWAY_URL` in env → one warning naming the config path and the model.
- [ ] The same entry with `GENERACY_LLM_GATEWAY_URL` set → no warning.
- [ ] An entry whose model resolves to the `anthropic` route → no warning (regardless
  of gateway env).
- [ ] Warnings are emitted for `defaults`, per-workflow defaults, per-phase overrides,
  and `cockpit.auto.agents.*` entries.
- [ ] Exit code stays 0 on warnings-only (mirrors effort warnings).

### US2: Operator confirms a configured gateway is reachable (P1)

**As a** cluster operator who has configured an LLM gateway,
**I want** `generacy doctor` to verify the gateway responds and authenticates with
the cluster token,
**So that** I can distinguish a misconfigured/unreachable gateway from a working one
before running workloads.

**Acceptance Criteria**:
- [ ] `GENERACY_LLM_GATEWAY_URL` unset → check status `skip` (not `fail`).
- [ ] URL set + `GENERACY_LLM_GATEWAY_TOKEN` missing/empty → status `fail` with a
  token-related suggestion, **without issuing the probe** (Q4=A, mirrors
  `anthropic-key`'s missing-key branch).
- [ ] URL set + endpoint returns 200 with the cluster token → status `pass`; reports
  the gateway's model list when the response provides one.
- [ ] URL set + endpoint returns 401 → status `fail` with a token-related suggestion.
- [ ] URL set + `GET /v1/models` returns 404/405 → fall back to a 1-token
  `POST /v1/messages` probe (Q3=C); the fallback's response maps per FR-010.
- [ ] URL set + connection refused / network error → status `fail` with a
  reachability suggestion and the underlying error in detail.
- [ ] Env vars are read from `context.envVars` first, falling back to `process.env`
  when the key is absent from the env file (Q2=C).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `loadConfigWithWarnings` collects gateway-route warnings alongside existing effort warnings. | P1 | Warnings-only channel; no new error path. |
| FR-002 | Walk every resolved agent entry — `defaults`, per-workflow defaults, per-phase overrides, and `cockpit.auto.agents.*` — resolving each model through `resolveRoute`. | P1 | Mirror the tier-walk in `collectEffortWarnings`. |
| FR-003 | For any entry resolving to the `gateway` route, emit a warning **only when** `GENERACY_LLM_GATEWAY_URL` is unset in the process env. | P1 | Read from the environment the validator runs in. |
| FR-004 | Warning text names the config path and the model string. | P1 | Consistent with effort-warning format. |
| FR-005 | Validate exit code stays 0 on gateway warnings-only. | P1 | Matches effort-warning behavior. |
| FR-006 | New `llm-gateway` doctor check registered in the doctor check registry. | P1 | New file under `checks/`. |
| FR-007 | `llm-gateway` check returns `skip` when `GENERACY_LLM_GATEWAY_URL` is unset. | P1 | Not `fail`. Env read: `context.envVars` first, `process.env` fallback (Q2=C). |
| FR-008 | When URL set: issue `GET <url>/v1/models` with the cluster token; on 404/405 fall back to a 1-token `POST /v1/messages` probe using a configured gateway-routed model; 200 → `pass`. | P1 | Q3=C. Auth header: `Authorization: Bearer <token>` (Q5=A). |
| FR-009 | On `pass`, report the gateway's model list when the response includes one. | P2 | Best-effort; absence is not a failure. |
| FR-010 | Map 401 → `fail` (token), other non-200 (except the FR-008 404/405 fallback trigger) → `fail` (HTTP status in detail), network/timeout error → `fail` (reachability). | P1 | Mirror `anthropic-key` error mapping. |
| FR-011 | Both consumers import `resolveRoute` from `@generacy-ai/generacy-plugin-claude-code`. | P1 | Single source of route classification. Hard dependency on generacy#1198 (Q1=A) — block/requeue until it ships. |
| FR-012 | URL set + `GENERACY_LLM_GATEWAY_TOKEN` missing/empty → `fail` with a token-related suggestion, without issuing the probe. | P1 | Q4=A; mirrors `anthropic-key`'s missing-key branch. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Warning matrix coverage | gateway+no-URL → warn; gateway+URL → silent; anthropic → silent | Unit tests over `collectGatewayWarnings` (or extended `loadConfigWithWarnings`). |
| SC-002 | Doctor check behavior against stubbed HTTP | 200 → pass; 401 → fail; ECONNREFUSED → fail; URL unset → skip; URL set + token missing → fail without probe; 404/405 on `/v1/models` → `POST /v1/messages` fallback | Unit tests with a stubbed `fetch`/endpoint. |
| SC-003 | Build + test suite | green | `pnpm -r build` and package tests pass. |
| SC-004 | Config path fidelity | warning names the exact `orchestrator.agents...` / `cockpit.auto.agents...` path | Assertion in warning-matrix tests. |

## Assumptions

- `resolveRoute` from `@generacy-ai/generacy-plugin-claude-code` is shipped by sibling
  issue generacy-ai/generacy#1198 and returns a discriminable `gateway` vs `anthropic`
  route. This issue blocks/requeues until it lands (Q1=A) — it never defines the
  helper itself.
- The gateway guarantees the Anthropic-style `POST /v1/messages` endpoint;
  `GET /v1/models` is optional (discovery gated behind
  `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` in the Claude Code gateway contract),
  hence the Q3=C fallback. Authentication is `Authorization: Bearer
  <GENERACY_LLM_GATEWAY_TOKEN>` (Q5=A) — the same header real launches send via
  `ANTHROPIC_AUTH_TOKEN`, so a green check predicts a working spawn.
- The `cockpit.auto.agents.*` config surface either exists or is optional; the walk
  must not crash when it is absent.
- The validator reads gateway env from `process.env`, matching how the cluster
  environment is populated at validate time.

## Out of Scope

- Defining/introducing `resolveRoute` itself (owned by the epic / a sibling issue).
- Scaffolder provisioning of `GENERACY_LLM_GATEWAY_URL` / `_TOKEN` (epic P2).
- Auto-fix for the doctor check.
- Making gateway warnings fatal (they stay warnings-only, exit 0).
- Runtime spawn-time gateway routing behavior.

---
Part of epic generacy-ai/generacy#1197 (LLM gateway model routing). Full design:
`docs/llm-gateway-model-routing-plan.md` in generacy-ai/tetrad-development; a condensed
design summary lives in the epic body.

*Generated by speckit*
