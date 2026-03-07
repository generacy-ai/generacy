# Tasks: Remove Claude Marketplace Plugin Install

**Input**: Design documents from `/specs/350-summary-remove-claude-code/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Implementation

- [ ] T001 [US1] Add `resolveSpeckitCommandsDir()` function to `packages/generacy/src/cli/commands/setup/build.ts` — implements two-tier resolution (local workspace `node_modules` → npm global root) using `existsSync` path probing, returning the resolved commands directory path or `null`
- [ ] T002 [US1] Rewrite `installClaudeCodeIntegration()` Phase 4 command-install section in `packages/generacy/src/cli/commands/setup/build.ts` — remove marketplace registration (`claude plugin marketplace list/add`), marketplace plugin install (`claude plugin install`), old file-copy cleanup logic, and `SPECKIT_COMMAND_FILES` constant; replace with: call `resolveSpeckitCommandsDir()`, copy all `.md` files from resolved directory to `~/.claude/commands/`, log resolution tier used and file count
- [ ] T003 [US2] Add error handling for unresolved package in `packages/generacy/src/cli/commands/setup/build.ts` — when `resolveSpeckitCommandsDir()` returns `null`, log a clear error message indicating `@generacy-ai/agency-plugin-spec-kit` was not found in local workspace or npm global, and which paths were checked

## Phase 2: Tests

- [ ] T004 [US1] Update existing tests in `packages/generacy/src/__tests__/setup/build.test.ts` — remove/replace test cases for marketplace registration and plugin install; add tests for `resolveSpeckitCommandsDir()` covering: local path found, global path found, neither found (null)
- [ ] T005 [P] [US2] Add test case in `packages/generacy/src/__tests__/setup/build.test.ts` for the rewritten `installClaudeCodeIntegration()` — verify `.md` files are copied from resolved directory to `~/.claude/commands/`, verify MCP server configuration is unchanged, verify error log when package not found

## Dependencies & Execution Order

- **T001** has no dependencies — new function, self-contained
- **T002** depends on **T001** — uses the new resolution function
- **T003** depends on **T001** — adds error path for the resolution function
- **T002** and **T003** can run in parallel after T001 (they modify different code paths)
- **T004** and **T005** depend on Phase 1 completion (T001-T003)
- **T004** and **T005** can run in parallel (different test scopes)

```
T001 ──┬── T002 ──┬── T004 [P]
       └── T003 ──┤
                  └── T005 [P]
```
