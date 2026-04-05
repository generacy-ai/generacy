# Tasks: Update VS Code Extension Pricing Tiers

**Input**: Design documents from `/specs/420-summary-generacy-vs-code/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Type Definitions

- [X] T001 [US3] Update `OrgTier` type union in `packages/generacy-extension/src/api/types.ts:179` — replace `'starter' | 'team' | 'enterprise'` with `'free' | 'basic' | 'standard' | 'professional' | 'enterprise'`
- [X] T002 [US3] Update Zod enum in `packages/generacy-extension/src/api/types.ts:213` — replace `z.enum(['starter', 'team', 'enterprise'])` with `z.enum(['free', 'basic', 'standard', 'professional', 'enterprise'])`

## Phase 2: Core Implementation

- [X] T003 [US1] Update `getTierLimits()` in `packages/generacy-extension/src/api/endpoints/orgs.ts` — replace 3-case switch with 5 cases: free(1/1/50), basic(2/2/100), standard(5/3/500), professional(10/4/1000), enterprise(unlimited)
- [X] T004 [P] [US1] Update `getTierDisplayName()` in `packages/generacy-extension/src/api/endpoints/orgs.ts` — add Free, Basic, Standard, Professional display names, remove Starter/Team
- [X] T005 [P] [US1] Update `getTierPricing()` in `packages/generacy-extension/src/api/endpoints/orgs.ts` — set basic=$20, standard=$50, professional=$100, free=$0, enterprise=null; remove old min seat references
- [X] T006 [US2] Update CSS tier badge classes in `packages/generacy-extension/src/views/cloud/dashboard/webview.ts:389` — replace `.tier-starter`/`.tier-team` with `.tier-free`/`.tier-basic`/`.tier-standard`/`.tier-professional`
- [X] T007 [P] [US2] Update execution slot upgrade prompt in `packages/generacy-extension/src/views/cloud/dashboard/webview.ts:176` — implement full tier progression (free→basic→standard→professional→enterprise)
- [X] T008 [P] [US2] Update cluster upgrade prompt in `packages/generacy-extension/src/views/cloud/dashboard/webview.ts:188` — same tier progression logic
- [X] T009 [US2] Update Quick Actions upgrade CTA in `packages/generacy-extension/src/views/cloud/dashboard/webview.ts:299-307` — replace binary starter→team/team→enterprise with full tier progression using `getNextTier()` helper or inline map

## Phase 3: Tests & Documentation

- [X] T010 [US1] Update test fixtures in `packages/generacy-extension/src/views/cloud/dashboard/__tests__/webview.test.ts` — change mockDashboardData tier from `'team'`→`'standard'`, billing plan `'Team'`→`'Standard'`, pricePerSeat `99`→`50`, update assertions
- [X] T011 [P] Update pricing table in `packages/generacy-extension/README.md:105-109` — replace 3-tier table with 5-tier model

## Phase 4: Verification

- [X] T012 Run `pnpm tsc --noEmit` in extension package — zero type errors
- [X] T013 Run `pnpm vitest run` in extension package — all tests pass
- [X] T014 [P] Grep for old tier references — confirm zero hits for `'starter'`/`'team'` as tier values, `$49`/`$99`, `min 3`/`min 5` across `packages/generacy-extension/src/`

## Dependencies & Execution Order

**Phase 1 → Phase 2**: Type changes must land first so TypeScript catches exhaustiveness gaps in switch statements.

**Phase 2 internal parallelism**:
- T003, T004, T005 are in the same file (`orgs.ts`) — apply sequentially
- T006, T007, T008, T009 are in the same file (`webview.ts`) — apply sequentially
- The `orgs.ts` group [T003-T005] and `webview.ts` group [T006-T009] can run in parallel [P]

**Phase 3**: T010 and T011 are independent and can run in parallel [P] after Phase 2

**Phase 4**: All verification tasks run after Phase 3; T012/T013 are sequential (compile then test), T014 can run in parallel with tests

**Critical path**: T001/T002 → T003-T005 → T010 → T012 → T013
