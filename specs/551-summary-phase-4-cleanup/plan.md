# Implementation Plan: Phase 4 Cleanup — Remove `GENERACY_CLOUD_URL` Fallback Chains

**Feature**: Remove deprecated `GENERACY_CLOUD_URL` env var fallbacks and rename `--cloud-url` CLI flag to `--api-url`
**Branch**: `551-summary-phase-4-cleanup`
**Status**: Complete

## Summary

This is a cleanup issue removing all deprecated `GENERACY_CLOUD_URL` fallback chains from the codebase, now that `GENERACY_API_URL`, `GENERACY_RELAY_URL`, and `GENERACY_APP_URL` (introduced in #549) have been deployed and stabilized. The work spans three packages (generacy CLI, orchestrator, cluster-relay) and touches ~15 files.

The changes are:
1. **Remove env var fallback chains** — 3 locations that read `GENERACY_CLOUD_URL` as a fallback
2. **Clean up all remaining references** — error messages, deprecated exports, CLI option descriptions
3. **Update tests** — replace `GENERACY_CLOUD_URL` assertions, add negative assertions
4. **Rename CLI flag** — `--cloud-url` → `--api-url` with hidden alias for one release cycle

## Technical Context

- **Language**: TypeScript (ESM)
- **Runtime**: Node.js >=22
- **Packages**: `commander` (CLI), `zod` (validation), `pino` (logging), `ws` (WebSocket)
- **Build**: pnpm monorepo
- **Test framework**: Vitest (inferred from `.test.ts` files)

## Project Structure — Files to Modify

### Package: `packages/generacy/` (CLI)

| File | Change | FR |
|------|--------|----|
| `src/cli/utils/cloud-url.ts` | Remove `GENERACY_CLOUD_URL` fallback (tier 3), remove `resolveCloudUrl` deprecated alias, rename `resolveApiUrl` flag param doc | FR-001, FR-005 |
| `src/cli/commands/launch/index.ts` | Rename `--cloud-url` to `--api-url`, add `--cloud-url` as hidden alias with deprecation warning, update option description | FR-006, FR-008 |
| `src/cli/commands/launch/cloud-client.ts` | Update 404 error message: `GENERACY_CLOUD_URL` → `GENERACY_API_URL` (or `--api-url`) | FR-004 |
| `src/cli/commands/deploy/index.ts` | Same flag rename as launch (`--api-url` canonical, `--cloud-url` hidden alias) | FR-006, FR-008 |
| `src/cli/utils/__tests__/cloud-url.test.ts` | Remove tests for `GENERACY_CLOUD_URL` fallback, add negative assertion that old var is not read | FR-007 |
| `src/cli/commands/launch/__tests__/cloud-client.test.ts` | Update assertions referencing `GENERACY_CLOUD_URL` | FR-007 |
| `src/cli/commands/launch/__tests__/scaffolder.test.ts` | Update any `GENERACY_CLOUD_URL` references | FR-007 |
| `src/cli/commands/cluster/__tests__/scaffolder.test.ts` | Update any `GENERACY_CLOUD_URL` references | FR-007 |
| `tests/unit/deploy/scaffolder.test.ts` | Update any `GENERACY_CLOUD_URL` references | FR-007 |

### Package: `packages/orchestrator/`

| File | Change | FR |
|------|--------|----|
| `src/config/loader.ts` (lines 245-289) | Remove `GENERACY_CLOUD_URL` fallback for both activation and relay. Activation: read only `GENERACY_API_URL`, throw if missing. Relay: read only `GENERACY_RELAY_URL`, fall back to channel-derived URL (not `GENERACY_CLOUD_URL`). | FR-002 |
| `src/config/__tests__/loader-workspace.test.ts` | Update env var assertions, add negative assertions | FR-007 |

### Package: `packages/cluster-relay/`

| File | Change | FR |
|------|--------|----|
| `src/relay.ts` (line 25-26) | Update comment from `GENERACY_CLOUD_URL` reference to `GENERACY_RELAY_URL` | FR-003 |

### No file changes needed (out of scope)

| Item | Reason |
|------|--------|
| `cluster/scaffolder.ts` | Already writes `GENERACY_API_URL` / `GENERACY_RELAY_URL` to `.env` — no `GENERACY_CLOUD_URL` references |
| `launch/types.ts` | `cloudUrl` field stays (cloud API response schema, not our env var) |
| `cluster/registry.ts` | `cloudUrl` field name stays (persisted data, rename deferred per spec) |
| `deploy/scaffolder.ts` | Uses shared scaffolder, no direct env var references |
| Orchestrator `config/schema.ts` | Internal field name `cloudUrl` stays (internal API, not env var name) |

## Implementation Order

### Phase A: Core Env Var Removal (no dependencies between items)

1. **`cloud-url.ts`** — Remove tier 3 (`GENERACY_CLOUD_URL` fallback) and `resolveCloudUrl` export
2. **`loader.ts`** — Remove both `GENERACY_CLOUD_URL` fallbacks; activation reads only `GENERACY_API_URL` (throw if missing), relay reads only `GENERACY_RELAY_URL` (fall back to channel-derived, not old var)
3. **`relay.ts`** — Update comment only

### Phase B: Reference Cleanup (depends on Phase A for consistency)

4. **`cloud-client.ts`** — Update 404 error message
5. **`launch/index.ts`** — Flag rename + option description
6. **`deploy/index.ts`** — Flag rename + option description

### Phase C: Test Updates (depends on A+B)

7. **`cloud-url.test.ts`** — Remove old var tests, add negative assertions
8. **`loader-workspace.test.ts`** — Update orchestrator config tests
9. **All other test files** — Update any remaining `GENERACY_CLOUD_URL` assertions

### Phase D: Follow-up Issues

10. **File GitHub issue** — Remove `--cloud-url` hidden alias after one release cycle
11. **File companion issue** — generacy-cloud repo: remove `LaunchConfig.cloudUrl` deprecated field

## Key Design Decisions

1. **Orchestrator fails loud on missing config** — Per US2/clarification Q2, `GENERACY_API_URL` missing in orchestrator = error. CLI keeps its `https://api.generacy.ai` default for ergonomic interactive use.

2. **Relay channel-derived fallback preserved** — When `GENERACY_RELAY_URL` is not set, the orchestrator still derives the relay URL from `GENERACY_CHANNEL` (stable vs preview). This is not a `GENERACY_CLOUD_URL` fallback — it's an independent derivation path that remains useful.

3. **`--cloud-url` kept as hidden alias** — Per clarification Q1 (answer C), the CLI flag gets a one-release deprecation cycle. `--cloud-url` remains functional but hidden from `--help` and prints a deprecation warning on use.

4. **Field names `cloudUrl` in internal types unchanged** — The spec explicitly defers renaming `cloudUrl` in registry entries, config schemas, and launch config types. These are internal identifiers, not env var names. The `cloud_url` field in `cluster.json` is also unchanged (persisted data).

5. **SC-001 scope** — Zero `GENERACY_CLOUD_URL` references in `src/` directories. Test files may contain the string only in negative assertions verifying the old name is no longer honored.

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| In-the-wild clusters still using old env var | Prerequisites gate: only pick up after phases 1-3 shipped + one release cycle. Small user population. |
| Breaking existing scripts using `--cloud-url` | Hidden alias with deprecation warning for one release cycle |
| Orchestrator boot failure if env var missing | Intentional — fail loud. Env var is always set by scaffolder in compose `.env` file. |
