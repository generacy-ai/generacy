# Feature Specification: ## Summary

On a freshly deployed cluster (preview channel), the orchestrator fails to provision a smee

**Branch**: `965-summary-freshly-deployed` | **Date**: 2026-07-16 | **Status**: Draft

## Summary

## Summary

On a freshly deployed cluster (preview channel), the orchestrator fails to provision a smee.io webhook channel and falls back to polling. smee.io changed its `/new` API, and the provisioner's assumptions (`POST` + expect `302`) are both now wrong.

```
{"level":40,"attempts":2,"lastError":"unexpected status 200","msg":"Failed to provision smee channel after 2 attempts — cluster is webhook-less, falling back to polling"}
{"level":40,"remediation":["SMEE_CHANNEL_URL","orchestrator.smeeChannelUrl"],"msg":"No smee channel configured; polling fallback active"}
{"level":30,"intervalMs":10000,"reason":"webhooks-not-configured","msg":"Webhooks appear unhealthy, increasing poll frequency"}
```

## Impact

Every new cluster provisioned via auto-provisioning (i.e. without `SMEE_CHANNEL_URL` / `orchestrator.smeeChannelUrl` explicitly set) is webhook-less and degrades to 10s polling. Webhook-driven latency guarantees are lost fleet-wide until a channel URL is manually supplied.

## Root cause

`packages/orchestrator/src/services/smee-channel-resolver.ts` provisions a channel by issuing `POST https://smee.io/new` with `redirect: 'manual'` and treats **only** HTTP `302` (with a `Location` header matching `SMEE_URL_PATTERN`) as success:

```ts
// smee-channel-resolver.ts:137-142
const response = await this.fetchImpl(PROVISION_URL, {
  method: 'POST',
  redirect: 'manual',
  signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
});
if (response.status !== 302) {
  lastError = `unexpected status ${response.status}`;   // ← fires with "unexpected status 200"
}
```

smee.io's `/new` endpoint has since changed, verified live from the cluster's network:

| Request | Result |
|---|---|
| `POST https://smee.io/new` (what we do) | **200**, `content-length: 0`, **no `Location`** — a no-op |
| `GET  https://smee.io/new` | **307** → `location: https://smee.io/<channel>` |
| `HEAD https://smee.io/new` | **307** → `location: https://smee.io/<channel>` |

So the provisioner is wrong on two axes:
1. **Wrong method** — smee.io now mints a channel on `GET`/`HEAD`, not `POST`. `POST` returns an empty 200.
2. **Wrong status assertion** — even with the right method, the redirect is now **307**, not **302**, so `status !== 302` would still reject it.

The `Location`/`SMEE_URL_PATTERN` check itself is still valid — both returned channel URLs (e.g. `https://smee.io/3dCinhK6djyd2yK`) match the existing pattern.

Note: the resolver and its 302-only assertion were introduced in #952 (commit `d0bafbcd`, 2026-07-15) and have never had a redirect-following variant — this is not a regression from a redirect-mode flip. The unit test (`smee-channel-resolver.test.ts`) hand-builds a `Response(status: 302)` for every provisioning case, so no test ever exercised a real live-endpoint response and the failing branch is uncovered.

## Proposed fix

In `smee-channel-resolver.ts::provision()`:
- Use `GET` against `https://smee.io/new`, `redirect: 'manual'` (clarification Q2 → A: GET is the empirically verified path and avoids intermediary HEAD-handling quirks).
- Accept any 3xx redirect that carries a valid `Location` — replace `response.status !== 302` with `response.status < 300 || response.status >= 400` (clarification Q1 → B: broad range hedges against another silent smee.io flip; `SMEE_URL_PATTERN` validation on `Location` degrades safely for non-redirect 3xx statuses).
- Reword the rejection diagnostic from `"unexpected status ${status}"` to `"expected 3xx with Location, got ${status}"` (clarification Q3 → A: FR-007 ships in this PR since the same line is already being edited).
- The manual-redirect + `Location` approach is intentionally preferred over `redirect: 'follow'` — it keeps the existing `SMEE_URL_PATTERN` validation on the `Location` header and preserves the smaller-change footprint.

## Acceptance criteria

- A cluster with **no** `SMEE_CHANNEL_URL` / `orchestrator.smeeChannelUrl` configured provisions a smee channel successfully on boot and starts the smee pipeline (no "falling back to polling" / "webhooks-not-configured" warnings).
- `provision()` succeeds against smee.io's current `GET`/`HEAD` + `307` behavior and rejects genuinely malformed responses (missing/invalid `Location`).
- Regression test: add coverage that feeds a real-shaped `307`-with-`Location` response **and** a `200`-empty response, asserting success and failure respectively (the current mock only produces `302`).
- The `SMEE_CHANNEL_URL` / `orchestrator.smeeChannelUrl` override path continues to bypass provisioning unchanged.

## Environment

- Release channel: **preview** (`ghcr.io/generacy-ai/cluster-base:preview`, orchestrator `0.0.0-preview-20260716184512-4c1ff4d`)
- Local cluster deployed from staging (`app-staging.generacy.ai`), project `snappoll`.


## User Stories

### US1: Fresh cluster boots with a working smee channel

**As a** developer deploying a fresh Generacy cluster on the preview channel,
**I want** the orchestrator to auto-provision a smee.io webhook channel on first boot,
**So that** the cluster receives webhook-driven events at real-time latency without me having to hand-supply `SMEE_CHANNEL_URL`.

**Acceptance Criteria**:
- [ ] A cluster booted with no `SMEE_CHANNEL_URL` / `orchestrator.smeeChannelUrl` provisions a smee channel successfully against smee.io's current live behavior.
- [ ] The orchestrator log does NOT contain `"Failed to provision smee channel after 2 attempts"`, `"No smee channel configured; polling fallback active"`, or `"webhooks-not-configured"` on such a boot.
- [ ] The `SMEE_CHANNEL_URL` / `orchestrator.smeeChannelUrl` override path continues to bypass provisioning unchanged.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `provision()` issues `GET https://smee.io/new` with `redirect: 'manual'` (was `POST`). | P1 | Clarification Q2 → A: GET, not HEAD. |
| FR-002 | `provision()` accepts any response where `response.status >= 300 && response.status < 400` and carries a `Location` matching `SMEE_URL_PATTERN` (was strict `status === 302`). | P1 | Clarification Q1 → B: broad 3xx range, not explicit set. Do not hard-code 307. |
| FR-003 | `provision()` continues to validate the returned `Location` header against `SMEE_URL_PATTERN` — a redirect-family status with a malformed/missing `Location` is still a failure. | P1 | Preserves existing pattern check. |
| FR-004 | Explicit-override path (`SMEE_CHANNEL_URL` env or `orchestrator.smeeChannelUrl` config) bypasses `provision()` unchanged. | P1 | Non-regression. |
| FR-005 | Add regression test coverage: `307`-with-valid-`Location` → success; `200`-empty-body → failure; `3xx`-with-invalid-`Location` → failure. | P1 | Current mock only produces `302`; the failing branch is uncovered. |
| FR-006 | Retry envelope (attempts, backoff, timeout) around `provision()` is unchanged. | P1 | Preserve existing behavior. |
| FR-007 | Rejection diagnostic changes from `"unexpected status ${status}"` to `"expected 3xx with Location, got ${status}"`. | P2 | Clarification Q3 → A: ships in this PR (same line already edited). |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Fresh preview-channel cluster provisions smee channel on first boot. | 100% success (0 fallback to polling) on the current live smee.io behavior. | Boot a cluster from `ghcr.io/generacy-ai/cluster-base:preview` with no `SMEE_CHANNEL_URL` set; grep orchestrator logs for absence of `"falling back to polling"` and presence of a resolved smee URL. |
| SC-002 | Unit tests exercise real-shaped responses. | New tests for `307`-with-`Location` (success), `200`-empty (failure), `3xx`-with-invalid-`Location` (failure) all pass. | `pnpm --filter @generacy-ai/orchestrator test smee-channel-resolver`. |
| SC-003 | Rejection log message updated. | On a `200`-empty response, `lastError` reads `"expected 3xx with Location, got 200"`. | Assert in the new failure-mode test. |

## Assumptions

- smee.io's `/new` endpoint currently returns `307` with a `Location` header on `GET`/`HEAD`, verified live 2026-07-16 from the affected cluster's network.
- smee.io may silently flip its status code again (as it did with `302 → 307` and `POST → GET`). FR-002's broad 3xx range is the hedge; if smee.io stops using redirect status codes at all, this fix will not save us and we would need a new provisioner.
- `SMEE_URL_PATTERN` remains valid — both `POST`-era and current `GET`-era channel URLs (e.g. `https://smee.io/3dCinhK6djyd2yK`) match it.
- The existing retry-with-backoff envelope and 2-attempt budget in the caller are sufficient for the fixed provisioner — no change to retry policy.

## Out of Scope

- Switching to `redirect: 'follow'` semantics (considered and rejected in favor of the manual-redirect + `Location` approach — smaller change, preserves `SMEE_URL_PATTERN` validation).
- Adopting an alternative webhook-forwarder service in place of smee.io.
- Changing the retry-budget / backoff policy or the polling-fallback pathway itself.
- Adding a health check that periodically re-validates the provisioned channel URL.
- Cluster-side telemetry that would alert the fleet when the next smee.io breaking change lands.

---

*Generated by speckit*
