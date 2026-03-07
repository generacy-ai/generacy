# Tasks: Fix `generacy setup build` Phase 4 npm Fallback

**Input**: Design documents from `/specs/342-summary-generacy-setup-build/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, clarifications.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Setup & Helper Extraction

- [ ] T001 Extract `resolveNpmGlobalRoot()` helper function in `packages/generacy/src/cli/commands/setup/build.ts` — move the existing `npm root -g` call (line 377) into a reusable function that returns `string | null`, and update the MCP CLI resolution (line 377-384) to use it
- [ ] T002 [P] Check existing test coverage for `installClaudeCodeIntegration()` in `packages/generacy/src/cli/commands/setup/build.test.ts` — if no tests exist, create the test file with basic scaffolding (imports, mocks for `execSafe`, `existsSync`, `copyFileSync`, `mkdirSync`)

## Phase 2: Core Implementation

- [ ] T003 Add npm-global fallback path in `installClaudeCodeIntegration()` (`packages/generacy/src/cli/commands/setup/build.ts`) — after the existing `else if (!pluginInstalled)` block at line 342, insert logic to: (1) call `resolveNpmGlobalRoot()`, (2) check for `<globalRoot>/@generacy-ai/agency/commands/` directory, (3) copy `.md` files to `~/.claude/commands/`, (4) log success or warning if all fallbacks fail
- [ ] T004 [P] Update the cleanup step (lines 345-362) to also run after a successful npm-global fallback when marketplace later succeeds — ensure the `else` branch (pluginInstalled) still removes old file-copy commands regardless of whether they came from source or npm fallback

## Phase 3: Tests

- [ ] T005 Add unit test: npm-global fallback copies `.md` files when marketplace fails and agency source is unavailable — mock `execSafe('npm root -g')` to return a valid path, mock `existsSync` to return true for npm commands dir, verify `copyFileSync` is called for each `.md` file
- [ ] T006 [P] Add unit test: npm-global fallback is skipped when marketplace plugin installs successfully — verify the npm fallback branch is not entered
- [ ] T007 [P] Add unit test: npm-global fallback logs warning when `npm root -g` fails or commands dir doesn't exist — verify `logger.warn` is called with appropriate message
- [ ] T008 [P] Add unit test: verify `resolveNpmGlobalRoot()` returns trimmed path on success and `null` on failure

## Phase 4: Verification

- [ ] T009 Run full test suite (`pnpm test` in `packages/generacy`) and verify all tests pass
- [ ] T010 Run linter/type-check (`pnpm lint` / `pnpm typecheck` in `packages/generacy`) and fix any issues

## Dependencies & Execution Order

- **T001** and **T002** can run in parallel (different concerns: production code vs test scaffolding)
- **T003** depends on **T001** (uses the extracted helper)
- **T004** can run in parallel with **T003** (different code section)
- **T005–T008** depend on **T003** (testing the implemented fallback) and **T002** (test scaffolding)
- **T005–T008** are all parallelizable (independent test cases)
- **T009–T010** depend on all previous tasks
