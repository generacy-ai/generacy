# Tasks: Wizard Credentials Env Bridge

**Input**: Design documents from `/specs/589-symptoms-after-bootstrap/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Implementation

- [X] T001 [US1] Create `wizard-env-writer.ts` service — `packages/control-plane/src/services/wizard-env-writer.ts`
  - `writeWizardEnvFile(options)`: read `.agency/credentials.yaml`, enumerate credential IDs/types, call `ClusterLocalBackend.fetchSecret()` for each, map to env vars, write env file (mode 0600)
  - `mapCredentialToEnvEntries(id, type, value)`: static mapping — `github-app`/`github-pat` → `GH_TOKEN`, ID matching `anthropic` → `ANTHROPIC_API_KEY`, fallback → `idToEnvName(id)`
  - `idToEnvName(id)`: kebab-case to UPPER_SNAKE (`my-api-key` → `MY_API_KEY`)
  - `formatEnvFile(entries)`: serialize as `KEY=value\n` lines
  - Return `{ written: string[], failed: string[] }` with best-effort semantics (partial unseal → partial file + failed list)
  - Reuse `getCredentialBackend()` singleton from `credential-writer.ts`

- [X] T002 [US1] Modify `bootstrap-complete` handler in `lifecycle.ts` — `packages/control-plane/src/routes/lifecycle.ts`
  - Import `writeWizardEnvFile` from new service
  - Before writing sentinel file: call `writeWizardEnvFile({ agencyDir, envFilePath })`
  - On partial failure (`result.failed.length > 0`): emit `cluster.bootstrap` relay warning via `getRelayPushEvent()`
  - Wrap in try/catch — env file write failure is non-fatal (log and continue to sentinel)
  - `agencyDir` from `AGENCY_DIR` env var (default `/workspaces/.agency`)
  - `envFilePath` from `WIZARD_CREDS_PATH` env var (default `/var/lib/generacy/wizard-credentials.env`)

## Phase 2: Tests

- [X] T003 [P] [US1] Write unit tests for `wizard-env-writer.ts` — `packages/control-plane/__tests__/services/wizard-env-writer.test.ts`
  - Happy path: two credentials (github-app + api-key) → env file with `GH_TOKEN` and `ANTHROPIC_API_KEY`
  - Empty `credentials.yaml` → empty env file, no error
  - Missing `credentials.yaml` → empty result, no error
  - One credential fails to unseal → partial file written + failed list populated
  - `mapCredentialToEnvEntries` mapping correctness for each type (`github-app`, `github-pat`, anthropic pattern, generic fallback)
  - `idToEnvName` conversion: `my-api-key` → `MY_API_KEY`, edge cases
  - `formatEnvFile` output format: `KEY=value\n` per line
  - File permissions: written with mode 0600
  - Mock `ClusterLocalBackend` via `setCredentialBackend()` DI pattern (same as `credential-writer.test.ts`)

- [X] T004 [P] [US1] Add lifecycle integration tests — `packages/control-plane/__tests__/routes/lifecycle.test.ts`
  - `bootstrap-complete` writes env file before sentinel
  - `bootstrap-complete` with no `credentials.yaml` still writes sentinel successfully
  - `bootstrap-complete` with unseal failure still writes sentinel (non-fatal)
  - Relay warning emitted on partial credential unseal failure
  - Follow existing test patterns in `lifecycle.test.ts`

## Phase 3: Verification

- [X] T005 [US1] Run tests and verify build — `packages/control-plane`
  - Run `pnpm test` in `packages/control-plane` to verify all new and existing tests pass
  - Run `pnpm build` (or `tsc --noEmit`) to verify no type errors
  - Verify no lint errors

## Dependencies & Execution Order

- **T001 → T002**: T002 imports from T001, so T001 must be complete first
- **T003 ∥ T004**: Both test tasks can run in parallel (different test files, independent mocks)
- **T003, T004 depend on T001 + T002**: Tests exercise the implementation
- **T005 depends on all**: Final verification after implementation and tests

```
T001 → T002 → T003 [P]  → T005
                T004 [P]  ↗
```

**Total tasks**: 5
**Phases**: 3 (Core Implementation → Tests → Verification)
**Parallel opportunities**: T003 and T004 can run concurrently

**Next step**: `/speckit:implement` to begin execution
