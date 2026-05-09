# Feature Specification: Phase 4 Cleanup — Remove `GENERACY_CLOUD_URL` Fallback Chains

**Branch**: `551-summary-phase-4-cleanup` | **Date**: 2026-05-09 | **Status**: Draft

## Summary

Phase 4 cleanup of [#549](https://github.com/generacy-ai/generacy/issues/549) — once the new env var names (`GENERACY_API_URL`, `GENERACY_APP_URL`, `GENERACY_RELAY_URL`) and the new `LaunchConfig.cloud` object have been deployed everywhere and given enough time for in-the-wild clusters to migrate, remove the deprecated fallbacks.

This is a deliberate **future** issue, intentionally filed now so it doesn't get forgotten. Don't pick up until phases 1-3 have shipped and stabilized.

## Scope

### Env Var Fallback Removal (3 enumerated chains)

1. **Launch CLI** ([packages/generacy/src/cli/commands/launch/index.ts](https://github.com/generacy-ai/generacy/blob/develop/packages/generacy/src/cli/commands/launch/index.ts)) — change `process.env['GENERACY_CLOUD_URL'] ?? 'https://api.generacy.ai'` to read only `GENERACY_API_URL`. Drop the deprecation log.

2. **Orchestrator config loader** ([packages/orchestrator/src/config/loader.ts:245-290](https://github.com/generacy-ai/generacy/blob/develop/packages/orchestrator/src/config/loader.ts#L245-L290)) — both reads (activation config and relay config) drop their `GENERACY_CLOUD_URL` fallback chains. Activation reads only `GENERACY_API_URL`; relay reads only `GENERACY_RELAY_URL`. Also drop the `?projectId=` auto-append at lines 280-290 since the cloud now pre-appends (decided in #549 Q2 = A).

3. **Cluster-relay package** ([packages/cluster-relay/src/relay.ts:25](https://github.com/generacy-ai/generacy/blob/develop/packages/cluster-relay/src/relay.ts#L25)) — read only `GENERACY_RELAY_URL`. Update the comment.

### Additional `GENERACY_CLOUD_URL` Reference Cleanup (per SC-001)

4. **Error messages** — `cloud-client.ts` user-facing 404 message referencing `GENERACY_CLOUD_URL` → update to reference `GENERACY_API_URL` (or `--api-url`).

5. **Deprecated export** — Remove `resolveCloudUrl` deprecated alias export from `cloud-url.ts`.

6. **CLI option descriptions** — Update `launch/index.ts` and `deploy/index.ts` option descriptions from "overrides `GENERACY_CLOUD_URL`" to reference `GENERACY_API_URL`.

7. **Test files** — Update tests asserting `GENERACY_CLOUD_URL` behavior to use `GENERACY_API_URL`. Add negative assertions verifying the old name is no longer honored.

### CLI Flag Rename

8. **`--cloud-url` → `--api-url`** — Add `--api-url` as the canonical CLI flag for both `launch` and `deploy` commands. Keep `--cloud-url` as a hidden alias with a deprecation warning for one release cycle. File follow-up issue to remove the alias.

### Cloud-Side Cleanup (out of scope for this repo)

Plus the `LaunchConfig.cloudUrl` deprecated alias removal — but that's actually a separate cleanup PR in the generacy-cloud repo, since the field is emitted there. File a companion cleanup issue in generacy-cloud when this lands.

## Prerequisites for picking this up

- All three of these phases shipped and deployed for at least one release cycle:
  - generacy-cloud Phase 1 (cloud emits `cloud` object)
  - generacy-cloud Phase 3 (worker template + DigitalOcean writers)
  - cluster-base Phase 3 (.env.template split)
- generacy#549's Phase 2 (the reader fallback chains being removed in *this* issue) shipped at least one release cycle ago.
- No clusters in the wild that were scaffolded under the old code (or accept that any remaining ones will need re-launch).

Practically: probably wait until at least one minor version after v1.5 GA. The user population today is small enough that the deprecation window can be short, but extending it is cheap.

## Test plan

- [ ] Remove all env var fallbacks (items 1-3)
- [ ] Clean up all additional `GENERACY_CLOUD_URL` references in source (items 4-6)
- [ ] Update tests: replace `GENERACY_CLOUD_URL` assertions with `GENERACY_API_URL`; add negative assertions for old name (item 7)
- [ ] Implement `--api-url` flag with `--cloud-url` hidden alias (item 8)
- [ ] Run `rg GENERACY_CLOUD_URL src/` — zero hits (SC-001)
- [ ] Run a fresh `generacy launch` against current staging — should work end-to-end without the old name being involved anywhere.

## Related

- #549 — umbrella issue
- generacy-ai/generacy-cloud — Phase 1 and Phase 3 issues that this depends on
- generacy-ai/cluster-base — Phase 3 issue (`.env.template`) that this depends on

## User Stories

### US1: Clean Env Var Surface

**As a** cluster operator,
**I want** the codebase to use only `GENERACY_API_URL` and `GENERACY_RELAY_URL` without fallback chains,
**So that** configuration is unambiguous and misconfiguration is caught immediately.

**Acceptance Criteria**:
- [ ] Zero references to `GENERACY_CLOUD_URL` in `src/` directories (excluding test negative assertions)
- [ ] Orchestrator fails with a clear error if `GENERACY_API_URL` or `GENERACY_RELAY_URL` is missing (no silent fallback)
- [ ] CLI retains `https://api.generacy.ai` default for ergonomic interactive use

### US2: Orchestrator Fail-Loud on Missing Config

**As a** cluster operator,
**I want** missing `GENERACY_API_URL` or `GENERACY_RELAY_URL` to produce a clear error in the orchestrator,
**So that** misconfigured clusters surface the problem immediately rather than silently connecting to the wrong endpoint.

**Acceptance Criteria**:
- [ ] Missing `GENERACY_API_URL` in orchestrator context produces a clear error (not silent fallback)
- [ ] Missing `GENERACY_RELAY_URL` in orchestrator context produces a clear error (not silent fallback)
- [ ] CLI is not affected — continues to default to `https://api.generacy.ai` for ergonomic reasons

### US3: CLI Flag Migration

**As a** CLI user,
**I want** the `--cloud-url` flag renamed to `--api-url` with a deprecation transition,
**So that** my existing scripts continue to work for one release cycle while I migrate.

**Acceptance Criteria**:
- [ ] `--api-url` is the canonical flag name with help text referencing `GENERACY_API_URL`
- [ ] `--cloud-url` remains as a hidden alias, prints a one-time deprecation warning
- [ ] Follow-up issue filed to remove `--cloud-url` alias after one release

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Remove `GENERACY_CLOUD_URL` fallback from launch CLI | P1 | Item 1 |
| FR-002 | Remove `GENERACY_CLOUD_URL` fallback from orchestrator config loader (both activation and relay) | P1 | Item 2 |
| FR-003 | Remove `GENERACY_CLOUD_URL` fallback from cluster-relay | P1 | Item 3 |
| FR-004 | Update user-facing error messages to reference `GENERACY_API_URL` | P1 | Item 4 |
| FR-005 | Remove `resolveCloudUrl` deprecated alias export | P1 | Item 5 |
| FR-006 | Update CLI option descriptions to reference `GENERACY_API_URL` | P1 | Item 6 |
| FR-007 | Update tests: new env var assertions + negative assertions for old name | P1 | Item 7 |
| FR-008 | Add `--api-url` canonical flag, keep `--cloud-url` as hidden alias with deprecation warning | P2 | Item 8 |
| FR-009 | File follow-up issue for `--cloud-url` alias removal | P2 | |
| FR-010 | File companion cleanup issue in generacy-cloud for `LaunchConfig.cloudUrl` removal | P2 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `GENERACY_CLOUD_URL` references in source | Zero hits in `src/` dirs | `rg GENERACY_CLOUD_URL src/` returns empty |
| SC-002 | Test coverage for old env var | Negative assertions present | Tests verify old name is not honored |
| SC-003 | CLI ergonomics preserved | Default URL still works | `generacy launch --claim=X` works without explicit env var |

## Assumptions

- Phases 1-3 of #549 have shipped and stabilized
- All in-the-wild clusters have been scaffolded with the new env var names
- The cloud already emits the `LaunchConfig.cloud` object with split URLs

## Out of Scope

- `LaunchConfig.cloudUrl` removal from generacy-cloud (separate repo, separate issue)
- Removing `--cloud-url` hidden alias (follow-up issue after one release cycle)
- Changing the registry's `cloudUrl` field name (persisted data, rename deferred)

---

*Generated by speckit*
