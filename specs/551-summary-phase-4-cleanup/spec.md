# Feature Specification: Phase 4 Cleanup — Remove `GENERACY_CLOUD_URL` Fallback Chains

**Branch**: `551-summary-phase-4-cleanup` | **Date**: 2026-05-09 | **Status**: Draft

## Summary

Phase 4 cleanup of [#549](https://github.com/generacy-ai/generacy/issues/549) — remove the deprecated `GENERACY_CLOUD_URL` fallback chains now that the new purpose-specific env vars (`GENERACY_API_URL`, `GENERACY_APP_URL`, `GENERACY_RELAY_URL`) and the `LaunchConfig.cloud` object are deployed everywhere.

This is a deliberate **future** issue. Do not pick up until phases 1-3 have shipped and stabilized (at least one release cycle post-v1.5 GA).

## Scope

Three fallback chains to remove:

1. **Launch CLI** (`packages/generacy/src/cli/commands/launch/index.ts`) — remove `GENERACY_CLOUD_URL` fallback, read only `GENERACY_API_URL`. Drop the deprecation log.

2. **Orchestrator config loader** (`packages/orchestrator/src/config/loader.ts:245-290`) — activation config reads only `GENERACY_API_URL`; relay config reads only `GENERACY_RELAY_URL`. Drop `GENERACY_CLOUD_URL` fallback chains. Remove `?projectId=` auto-append (cloud now pre-appends per #549 Q2).

3. **Cluster-relay package** (`packages/cluster-relay/src/relay.ts:25`) — read only `GENERACY_RELAY_URL`. Update the interface comment.

Additionally: `LaunchConfig.cloudUrl` deprecated alias removal is a separate PR in `generacy-cloud`. File a companion cleanup issue there when this lands.

## Prerequisites

- All three upstream phases shipped and deployed for at least one release cycle:
  - generacy-cloud Phase 1 (cloud emits `cloud` object)
  - generacy-cloud Phase 3 (worker template + DigitalOcean writers)
  - cluster-base Phase 3 (`.env.template` split)
- generacy#549 Phase 2 (the reader fallback chains) shipped at least one release cycle ago
- No clusters in the wild scaffolded under the old code (or accept they need re-launch)

## User Stories

### US1: Platform Engineer Removes Deprecated Config

**As a** platform engineer maintaining Generacy,
**I want** the deprecated `GENERACY_CLOUD_URL` fallback chains removed,
**So that** the codebase has a single, unambiguous path for each URL purpose and no dead code.

**Acceptance Criteria**:
- [ ] No reference to `GENERACY_CLOUD_URL` remains in the generacy repo
- [ ] All env var reads use the purpose-specific names (`GENERACY_API_URL`, `GENERACY_RELAY_URL`, `GENERACY_APP_URL`)
- [ ] No deprecation log messages remain for the old var name

### US2: Cluster Operator Gets Clear Error on Misconfiguration

**As a** cluster operator running a freshly launched cluster,
**I want** the system to fail clearly if only the old `GENERACY_CLOUD_URL` is set,
**So that** I know to update my configuration to the new env var names.

**Acceptance Criteria**:
- [ ] Missing `GENERACY_API_URL` produces a clear error (not silent fallback)
- [ ] Missing `GENERACY_RELAY_URL` produces a clear error (not silent fallback)

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Remove `GENERACY_CLOUD_URL` fallback in Launch CLI `resolveApiUrl()` | P1 | `packages/generacy/src/cli/utils/cloud-url.ts` |
| FR-002 | Remove `GENERACY_CLOUD_URL` fallback in orchestrator activation config | P1 | `packages/orchestrator/src/config/loader.ts` ~L245 |
| FR-003 | Remove `GENERACY_CLOUD_URL` fallback in orchestrator relay config | P1 | `packages/orchestrator/src/config/loader.ts` ~L263 |
| FR-004 | Remove `?projectId=` auto-append in orchestrator relay URL builder | P1 | `packages/orchestrator/src/config/loader.ts` ~L280-290 |
| FR-005 | Update cluster-relay comment to reference `GENERACY_RELAY_URL` only | P2 | `packages/cluster-relay/src/relay.ts` ~L25 |
| FR-006 | Remove or update tests asserting `GENERACY_CLOUD_URL` as input | P1 | |
| FR-007 | File companion cleanup issue in `generacy-cloud` for `LaunchConfig.cloudUrl` removal | P2 | Separate repo |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Zero references to `GENERACY_CLOUD_URL` in generacy repo | 0 occurrences | `grep -r GENERACY_CLOUD_URL` returns nothing |
| SC-002 | Fresh `generacy launch` succeeds end-to-end on staging | Pass | Manual E2E test against staging |
| SC-003 | Existing clusters with new env vars continue working | Pass | No regressions in cluster connectivity |

## Test Plan

- [ ] Remove all fallbacks per FR-001 through FR-005
- [ ] Update/remove tests that assert `GENERACY_CLOUD_URL` as input
- [ ] Run `grep -r GENERACY_CLOUD_URL` across the repo — expect zero hits
- [ ] Run a fresh `generacy launch` against current staging — full end-to-end without old var
- [ ] Verify orchestrator boots correctly with only `GENERACY_API_URL` and `GENERACY_RELAY_URL`

## Assumptions

- All upstream phases (cloud Phase 1/3, cluster-base Phase 3) are shipped and stable
- No active clusters rely solely on the old `GENERACY_CLOUD_URL` env var
- The user population is small enough that a short deprecation window is acceptable

## Out of Scope

- `LaunchConfig.cloudUrl` field removal (generacy-cloud repo, separate PR)
- `GENERACY_APP_URL` changes (no in-cluster consumer exists)
- Migration tooling for existing clusters (manual re-launch is acceptable)

## Related

- [#549](https://github.com/generacy-ai/generacy/issues/549) — umbrella issue for cloud URL disambiguation
- generacy-ai/generacy-cloud — Phase 1 and Phase 3 dependencies
- generacy-ai/cluster-base — Phase 3 (`.env.template`) dependency

---

*Generated by speckit*
