# Tasks: GitHub App Authentication Support

**Input**: Design documents from `/specs/041-add-github-app-authentication/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Setup & Dependencies

- [x] T001 Add `@octokit/auth-app` dependency to `packages/github-issues/package.json`
- [x] T002 [P] Create auth module directory structure: `packages/github-issues/src/auth/`

---

## Phase 2: Core Types & Interfaces

- [x] T003 [US1] Create `packages/github-issues/src/auth/types.ts` with auth configuration interfaces (GitHubAppConfig, AuthStrategy, CachedToken)
- [x] T004 [P] [US1] Create `packages/github-issues/src/utils/errors.ts` with GitHubAppAuthError class and error codes
- [x] T005 [P] [US1] Create Zod validation schemas for GitHubAppConfig in `packages/github-issues/src/auth/types.ts`

---

## Phase 3: Tests First (TDD)

- [x] T006 [US2] Create `packages/github-issues/tests/unit/auth/github-app.test.ts` with test cases for JWT generation, installation discovery, and token generation
- [x] T007 [P] [US2] Create `packages/github-issues/tests/unit/auth/token-cache.test.ts` with test cases for caching, expiry tracking, and proactive refresh
- [x] T008 [P] [US3] Create `packages/github-issues/tests/unit/auth/auth-factory.test.ts` with test cases for strategy selection and PAT fallback

---

## Phase 4: Core Implementation

- [x] T009 [US2] Implement `packages/github-issues/src/auth/github-app.ts` - GitHubAppAuthStrategy class with JWT generation using @octokit/auth-app
- [x] T010 [US2] Add Installation ID auto-discovery to `packages/github-issues/src/auth/github-app.ts` using `/app/installations` endpoint
- [x] T011 [US2] Implement `packages/github-issues/src/auth/token-cache.ts` - TokenCache class with expiry tracking and 50-minute proactive refresh timer

---

## Phase 5: Integration

- [x] T012 [US3] Implement `packages/github-issues/src/auth/auth-factory.ts` - createAuthStrategy function with GitHub App precedence and PAT fallback
- [x] T013 [US1] Extend `packages/github-issues/src/types/config.ts` to add optional `app` field to GitHubIssuesConfig
- [x] T014 [US1] Add environment variable reading for GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_PRIVATE_KEY_PATH
- [x] T015 [US3] Modify `packages/github-issues/src/client.ts` to use AuthFactory for authentication strategy selection
- [x] T016 Create `packages/github-issues/src/auth/index.ts` barrel export file

---

## Phase 6: Validation & Polish

- [x] T017 [US3] Add auth method logging in client initialization (log which auth method is active)
- [x] T018 Run all tests and ensure existing PAT tests still pass
- [x] T019 [US1] Update `specs/041-add-github-app-authentication/quickstart.md` with GitHub App setup instructions

---

## Dependencies & Execution Order

### Sequential Dependencies
```
T001 → T002 → T003/T004/T005 (parallel) → T006/T007/T008 (parallel) → T009 → T010 → T011 → T012 → T013 → T014 → T015 → T016 → T017 → T018 → T019
```

### Parallel Opportunities
- **Phase 2**: T003, T004, T005 can run in parallel (different files)
- **Phase 3**: T006, T007, T008 can run in parallel (different test files)

### Critical Path
1. T001 (dependency) → T009 (uses @octokit/auth-app)
2. T003 (types) → T009, T011, T012 (implementation uses types)
3. T009, T011 → T012 (factory uses both strategies)
4. T012 → T015 (client uses factory)

### User Story Coverage
- **US1 (Configure GitHub App)**: T003, T004, T005, T013, T014, T019
- **US2 (Seamless Token Management)**: T006, T007, T009, T010, T011
- **US3 (Backward Compatibility)**: T008, T012, T015, T017, T018
