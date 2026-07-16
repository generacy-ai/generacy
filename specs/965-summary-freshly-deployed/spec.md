# Feature Specification: Fix smee channel provisioning on freshly deployed clusters

**Branch**: `965-summary-freshly-deployed` | **Date**: 2026-07-16 | **Status**: Draft
**Issue**: [#965](https://github.com/generacy-ai/generacy/issues/965) | **Workflow**: `workflow:speckit-bugfix`

## Summary

On a freshly deployed cluster (preview channel), the orchestrator fails to provision a smee.io webhook channel and falls back to polling. smee.io changed its `/new` API, and the provisioner's assumptions (`POST` + expect `302`) are both now wrong. Every new cluster provisioned via auto-provisioning is now webhook-less and degrades to 10s polling.

## Impact

Every new cluster provisioned via auto-provisioning (i.e. without `SMEE_CHANNEL_URL` / `orchestrator.smeeChannelUrl` explicitly set) is webhook-less and degrades to 10s polling. Webhook-driven latency guarantees are lost fleet-wide until a channel URL is manually supplied.

Observable failure signature in orchestrator logs:

```
{"level":40,"attempts":2,"lastError":"unexpected status 200","msg":"Failed to provision smee channel after 2 attempts — cluster is webhook-less, falling back to polling"}
{"level":40,"remediation":["SMEE_CHANNEL_URL","orchestrator.smeeChannelUrl"],"msg":"No smee channel configured; polling fallback active"}
{"level":30,"intervalMs":10000,"reason":"webhooks-not-configured","msg":"Webhooks appear unhealthy, increasing poll frequency"}
```

## Root cause

`packages/orchestrator/src/services/smee-channel-resolver.ts::provision()` issues `POST https://smee.io/new` with `redirect: 'manual'` and treats **only** HTTP `302` (with a `Location` header matching `SMEE_URL_PATTERN`) as success:

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

**Regression context**: the resolver and its 302-only assertion were introduced in #952 (commit `d0bafbcd`, 2026-07-15) and have never had a redirect-following variant — this is not a regression from a redirect-mode flip inside our codebase, but from a live smee.io upstream change. The unit test (`smee-channel-resolver.test.ts`) hand-builds a `Response(status: 302)` for every provisioning case, so no test ever exercised a real live-endpoint response and the failing branch is uncovered.

## User Stories

### US1: Freshly deployed cluster gets webhook-driven latency out of the box

**As an** operator deploying a new Generacy cluster (no `SMEE_CHANNEL_URL` override),
**I want** the orchestrator to auto-provision a smee.io channel on boot,
**So that** GitHub webhook events reach the cluster at real-time latency instead of degrading to 10s polling.

**Acceptance Criteria**:
- [ ] Cluster boots and orchestrator log shows successful smee channel provisioning (no "falling back to polling" / "webhooks-not-configured" warnings).
- [ ] Provisioned channel URL matches `SMEE_URL_PATTERN` (e.g. `https://smee.io/<channel>`).
- [ ] Smee client pipeline connects to the provisioned channel and receives at least one heartbeat.

### US2: Operator override continues to bypass provisioning

**As an** operator who explicitly configures `SMEE_CHANNEL_URL` or `orchestrator.smeeChannelUrl`,
**I want** the resolver to skip provisioning entirely and use my configured channel,
**So that** existing deployments and CI overrides are unaffected by this change.

**Acceptance Criteria**:
- [ ] With `SMEE_CHANNEL_URL` set, `provision()` is not called; the configured URL is used verbatim.
- [ ] With `orchestrator.smeeChannelUrl` set (config file), same behavior.

### US3: Malformed upstream responses are still rejected

**As a** platform maintainer,
**I want** the resolver to reject genuinely malformed responses (missing `Location`, invalid channel URL shape, non-3xx),
**So that** we don't silently accept garbage from a future upstream regression.

**Acceptance Criteria**:
- [ ] A `200` empty response fails with a clear error (attempts exhausted, fall back path taken).
- [ ] A `3xx` with missing `Location` fails.
- [ ] A `3xx` with `Location` not matching `SMEE_URL_PATTERN` fails.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `provision()` MUST issue `GET` (or `HEAD`) against `PROVISION_URL` (`https://smee.io/new`) with `redirect: 'manual'`. `POST` MUST NOT be used. | P0 | Root cause axis 1. |
| FR-002 | `provision()` MUST accept any 3xx redirect status carrying a valid `Location` header (accept the family `{301, 302, 307, 308}`, or equivalently `>= 300 && < 400`). | P0 | Root cause axis 2. Do not hard-code `307`; upstream may flip again. |
| FR-003 | `provision()` MUST continue to validate the returned `Location` against `SMEE_URL_PATTERN` and reject malformed URLs. | P0 | Existing check is still correct. |
| FR-004 | The `SMEE_CHANNEL_URL` / `orchestrator.smeeChannelUrl` override path MUST continue to bypass provisioning unchanged. | P0 | US2. No behavior change on this path. |
| FR-005 | Regression test coverage MUST include a real-shaped `307`-with-`Location` mock (success) and a `200`-empty-body mock (failure). Existing hand-built `302` mock MAY remain but is no longer sufficient. | P0 | Test file: `packages/orchestrator/src/services/__tests__/smee-channel-resolver.test.ts`. |
| FR-006 | Existing retry / attempts / timeout semantics MUST be preserved. Only the request method and success-condition change. | P1 | Do not widen scope. |
| FR-007 | Error messages on failure SHOULD reflect the new success condition (e.g. `"expected 3xx with Location, got 200"` rather than `"unexpected status 200"`) so future upstream drift is diagnosable from logs alone. | P2 | Nice-to-have, not blocking. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Provision success rate on freshly deployed clusters (no override) | 100% (was 0%) | Boot orchestrator on a fresh cluster; check for `smee.io/<channel>` URL in logs and absence of `falling back to polling` warning. |
| SC-002 | Webhook-driven event latency on fresh clusters | Sub-second (webhook path), not 10s (poll path) | Trigger a GitHub webhook event; measure orchestrator ingestion timestamp vs. GitHub delivery timestamp. |
| SC-003 | Regression test suite for `smee-channel-resolver` | ≥ 1 test asserts success on `307`+`Location`; ≥ 1 test asserts failure on `200`-empty | `pnpm --filter @generacy-ai/orchestrator test smee-channel-resolver` passes with the new cases. |
| SC-004 | Override path unchanged | 100% of existing tests exercising the override branch pass unchanged | Full test suite. |

## Assumptions

- smee.io's `/new` endpoint behavior (`GET`/`HEAD` → `307` with `Location`) is stable enough to rely on. Widening the accepted redirect family (`3xx` with `Location`) rather than hard-coding `307` hedges against another silent flip.
- The `SMEE_URL_PATTERN` regex is still correct for channel URLs minted by the new endpoint (verified in the issue: `https://smee.io/3dCinhK6djyd2yK` matches).
- No CI or fixture depends on the `POST`-shaped request; the only consumer of `provision()` is the orchestrator's startup path.
- Fix ships as a bugfix under `workflow:speckit-bugfix` (patch bump on `@generacy-ai/orchestrator` per the changeset rules in CLAUDE.md).

## Out of Scope

- Auto-provisioning against smee alternatives (webhookrelay, custom relay endpoints) — the resolver stays smee-only.
- Health-checking the provisioned channel post-connect beyond what the smee client already does.
- Backfilling operational alerting when polling fallback engages (that's a fleet-observability concern, tracked separately).
- Changes to the polling fallback path itself — it continues to work as today for genuinely webhook-less deployments.
- Cloud-side changes (this is purely an in-cluster orchestrator fix).

---

*Generated by speckit*
