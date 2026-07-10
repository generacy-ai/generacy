# Feature Specification: Orchestrator surfaces a real version on `/health`

**Branch**: `907-symptom-connected-clusters` | **Date**: 2026-07-10 | **Status**: Draft
**Issue**: [#907](https://github.com/generacy-ai/generacy/issues/907)

## Summary

Every connected cluster in the cloud dashboard currently reports **Orchestrator: v0.0.0**, regardless of which build is actually running. The orchestrator's `/health` route never emits a `version` field, so cluster-relay's metadata collector falls back to the literal string `"0.0.0"` and forwards that to the cloud. This spec covers surfacing a real orchestrator version on `/health`, wiring it through the response schema, and letting the cloud dashboard show the true build identifier.

## Root Cause (as diagnosed in the issue)

- `packages/cluster-relay/src/metadata.ts` (≈ line 57) reads the version defensively: `String(data['version'] ?? '0.0.0')`.
- `packages/orchestrator/src/routes/health.ts` (≈ lines 131-137) constructs the response *without* a `version` field.
- Even if the handler were updated, the Fastify response schema (≈ lines 70-82) does not declare `version`, and Fastify strips undeclared fields on serialization. Both the handler and the schema need the field.

Net effect: `data['version']` is always `undefined` → `"0.0.0"` on every cluster.

## Impact

Cosmetic / observability only. No effect on connectivity, activation, or workflow execution. But:
- The dashboard cannot show which orchestrator build a cluster is running.
- Version-based rollout monitoring (preview vs. stable) is blind.
- Debugging build-specific bugs across clusters requires out-of-band inspection.

## User Stories

### US1: Operator sees the real orchestrator version in the dashboard

**As a** cloud operator (Generacy team member) monitoring connected clusters,
**I want** each cluster's dashboard row to show the actual orchestrator version it is running,
**So that** I can tell at a glance whether a cluster is on preview, stable, or an older tag, and correlate reports with the build in flight.

**Acceptance Criteria**:
- [ ] A freshly connected cluster running the fixed orchestrator image reports a non-`0.0.0` version in Firestore's `orchestratorVersion` field.
- [ ] The value shown in the dashboard matches the version identifier baked into the running orchestrator container.
- [ ] Reconnects and periodic heartbeats continue to report the same value for the lifetime of the process.

### US2: Cluster-relay forwards whatever `/health` reports

**As a** relay maintainer,
**I want** the relay's metadata collector to receive a real `version` string from the orchestrator's `/health` endpoint,
**So that** the `?? '0.0.0'` fallback path in `metadata.ts` is only hit for genuine errors (unreachable orchestrator), not for a routine field that was silently stripped by Fastify.

**Acceptance Criteria**:
- [ ] `GET /health` on a running orchestrator returns a JSON body that includes `version: "<non-empty-string>"`.
- [ ] The response passes the Fastify response-schema validator (i.e. `version` is declared in the schema, not silently dropped).
- [ ] Relay's `collectMetadata()` observes the field and does not fall back to `'0.0.0'`.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The `HealthResponse` TypeScript type in `packages/orchestrator/src/routes/health.ts` must declare a `version: string` field. | P1 | |
| FR-002 | The Fastify response schema for `/health` (both 200 and 503 branches, matching current shape) must declare `version: { type: 'string' }`. | P1 | Fastify strips undeclared fields; both response codes must include it or reconnect/health-503 paths will regress. |
| FR-003 | The `/health` handler must populate `version` with a real, non-empty identifier before returning. | P1 | Never emit the literal `"0.0.0"` from the handler when a real value is resolvable. |
| FR-004 | The version source must be resolvable at container startup without a network call and must reflect the build actually running. | P1 | Preferred source: a build-time env var (e.g. `ORCHESTRATOR_VERSION`) baked into the image at publish time. Acceptable fallback: `package.json` version read at startup. Precedence and exact source strategy to be decided in `/plan`. |
| FR-005 | If no version source is resolvable at startup (missing env var and unreadable package.json), the handler must emit a sentinel string that is clearly distinguishable from `"0.0.0"` (e.g. `"unknown"`) rather than falling back to the numeric sentinel. | P2 | Prevents future silent regressions from looking identical to the pre-fix behaviour. |
| FR-006 | Cluster-relay's `metadata.ts` fallback path (line ~57 and ~74) is not modified by this change. | P1 | The fix is orchestrator-side; the relay's defensive `?? '0.0.0'` stays as-is so relay behaviour is unchanged when the orchestrator is unreachable. |
| FR-007 | The change ships with a test in `packages/orchestrator/src/__tests__/health-*.test.ts` that asserts the response body contains a non-empty `version` string, i.e. would fail against the current buggy code. | P2 | Guards against schema-strip regressions specifically. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Connected clusters running the fixed orchestrator report a non-`"0.0.0"` `orchestratorVersion` in the cloud dashboard. | 100% of clusters on the fixed image. | Inspect Firestore cluster docs (or dashboard UI) for a sample of `preview`/`stable` clusters after the image rolls out. |
| SC-002 | `GET /health` on a running fixed orchestrator returns JSON containing a `version` field with a non-empty string value. | Field present, value ≠ `""` and ≠ `"0.0.0"` (assuming a real source is configured). | Manual `curl` against a running container, plus the unit test in FR-007. |
| SC-003 | Cluster-relay's `metadata.ts` no longer hits its `?? '0.0.0'` fallback for connected clusters. | 0 occurrences in logs / observed metadata. | Log inspection or dashboard-value sampling post-rollout. |

## Assumptions

- The orchestrator image is rebuilt and republished as part of the normal cluster-base / cluster-microservices publish workflow (see workflows in `.github/workflows/publish-cluster-*.yml`). Users won't see the fix until they pull the new image tag.
- A build-time version identifier (env var, git SHA, or package.json version) is available or can be introduced in the image build. The exact source is a `/plan`-phase decision.
- Cluster-relay's contract with the orchestrator (`GET /health` returning a JSON body) is unchanged; only the presence of one new field is added.
- The Fastify response schema is authoritative — declaring the field there is required, not optional.

## Out of Scope

- Changes to cluster-relay's metadata collector or its `?? '0.0.0'` fallback logic.
- Changes to the cloud dashboard UI beyond the fact that it will start displaying a non-`0.0.0` string.
- Changes to the Firestore schema for `orchestratorVersion` (already a string; a real value is a drop-in improvement).
- Version schemes for other cluster components (`credhelper-daemon`, `control-plane`, `code-server`, etc.). If a broader "component versions" surface is desired, that is a follow-up.
- Rollout automation, canary policies, or version-gated feature flags.
- Backfilling the reported version for clusters running old (pre-fix) images — they will keep reporting `"0.0.0"` until upgraded.

---

*Generated by speckit*
