# Tasks: Thread projectId into activation URL

**Input**: Design documents from `/specs/616-context-when-user-clicks/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Implementation

- [ ] T001 [P] [US1] Add `buildActivationUrl` helper to orchestrator activation (`packages/orchestrator/src/activation/index.ts`)
  - Create exported pure function `buildActivationUrl(verificationUri: string, userCode: string): string`
  - Use `new URL(verificationUri)` to construct URL
  - Append `code` param via `url.searchParams.set('code', userCode)`
  - Read `process.env['GENERACY_PROJECT_ID']`; if truthy, append `projectId` param
  - Return `url.toString()`
  - Replace `${deviceCode.verification_uri}` on line 61 with `${buildActivationUrl(deviceCode.verification_uri, deviceCode.user_code)}`

- [ ] T002 [P] [US1] Update deploy activation to use parameterized URL (`packages/generacy/src/cli/commands/deploy/activation.ts`)
  - Add `buildActivationUrl` helper (same pattern as T001 but reads `projectId` from deploy context or env)
  - Replace `deviceCode.verification_uri` on lines 43 and 47 with built URL including `code` and optional `projectId`
  - `openUrl()` call on line 47 should use the built URL

## Phase 2: Tests

- [ ] T003 [US1] Add unit tests for `buildActivationUrl` (`packages/orchestrator/src/activation/__tests__/activate.test.ts`)
  - Test: basic URL with `verification_uri` + `user_code` → URL contains `?code=XXXX`
  - Test: with `GENERACY_PROJECT_ID` set → URL contains `&projectId=<uuid>`
  - Test: without `GENERACY_PROJECT_ID` → no `projectId` param (US2 graceful fallback)
  - Test: `verification_uri` with existing query params → params merged correctly
  - Test: `verification_uri` with trailing slash → URL still valid

## Dependencies & Execution Order

- **T001 and T002** are independent (different packages) and can run in **parallel**
- **T003** depends on T001 (tests the function added in T001)
- Phase 1 → Phase 2 (tests verify implementation)

**Parallel opportunities**: T001 ‖ T002, then T003 sequentially
