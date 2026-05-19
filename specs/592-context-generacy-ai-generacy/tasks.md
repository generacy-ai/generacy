# Tasks: wizard-env-writer: extract `token` from github-app JSON value

**Input**: Design documents from `/specs/592-context-generacy-ai-generacy/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Implementation

- [X] T001 [US1] Split `github-app` and `github-pat` branches in `mapCredentialToEnvEntries` — `packages/control-plane/src/services/wizard-env-writer.ts:37-39`. Replace combined `if (type === 'github-app' || type === 'github-pat')` with separate branches: `github-app` branch JSON-parses the value, extracts `parsed.token` if it's a non-empty string, returns `[]` on parse failure or missing token; `github-pat` branch keeps raw value unchanged.

## Phase 2: Tests

- [X] T002 [US1] Update existing `github-app` test case in `packages/control-plane/__tests__/services/wizard-env-writer.test.ts` — change value from raw string to JSON payload `'{"installationId":1,"token":"ghs_abc"}'`, assert returns `[{ key: 'GH_TOKEN', value: 'ghs_abc' }]`
- [X] T003 [P] [US1] Add test: `github-app` with missing `token` field — `mapCredentialToEnvEntries('github-main-org', 'github-app', '{"installationId":1}')` returns `[]`
- [X] T004 [P] [US1] Add test: `github-app` with unparseable value — `mapCredentialToEnvEntries('github-main-org', 'github-app', 'not-json')` returns `[]`
- [X] T005 [P] [US1] Verify existing `github-pat` test unchanged — `mapCredentialToEnvEntries('some-pat', 'github-pat', 'ghp_xyz')` returns `[{ key: 'GH_TOKEN', value: 'ghp_xyz' }]`
- [X] T006 [US1] Update integration-level happy path test — update stored secret to JSON format, verify extracted token appears in env file output

## Phase 3: Verification

- [X] T007 Run tests — `cd packages/control-plane && npx vitest run __tests__/services/wizard-env-writer.test.ts`

## Dependencies & Execution Order

- **T001** must complete first (source change)
- **T002–T006** depend on T001; T003, T004, T005 are parallelizable with each other
- **T007** depends on all prior tasks
