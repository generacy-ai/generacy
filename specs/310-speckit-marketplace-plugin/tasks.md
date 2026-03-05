# Tasks: Publish Speckit Commands as Claude Code Marketplace Plugin

**Input**: Design documents from `/specs/310-speckit-marketplace-plugin/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Create Marketplace Repository

- [ ] T001 [US1] Create `generacy-ai/claude-plugins` GitHub repo with initial structure: `.claude-plugin/marketplace.json`, `plugins/agency-spec-kit/.claude-plugin/plugin.json`, `plugins/agency-spec-kit/commands/`, and `README.md`
- [ ] T002 [US1] Copy speckit command `.md` files from `agency/packages/claude-plugin-agency-spec-kit/commands/` into `plugins/agency-spec-kit/commands/` (specify.md, clarify.md, plan.md, tasks.md, implement.md, checklist.md, analyze.md, constitution.md, taskstoissues.md)
- [ ] T003 [US3] Tag marketplace repo as `v1.0.0`

## Phase 2: Update Setup Build

- [ ] T004 [US2] Add marketplace registration to `installClaudeCodeIntegration()` in `packages/generacy/src/cli/commands/setup/build.ts` — write `extraKnownMarketplaces` config to `~/.claude/settings.json` pointing to `generacy-ai/claude-plugins`
- [ ] T005 [US2] Replace file-copy logic in `installClaudeCodeIntegration()` with `claude plugin install agency-spec-kit@generacy-marketplace` CLI call, keeping file-copy as fallback when marketplace install fails (`packages/generacy/src/cli/commands/setup/build.ts`)
- [ ] T006 [US2] Add project-level `.claude/settings.json` to generacy repo with `extraKnownMarketplaces` for team auto-prompting
- [ ] T007 [P] [US2] Write/update tests for Phase 4 marketplace install + fallback behavior in `packages/generacy/src/__tests__/setup/build.test.ts`

## Phase 3: Update Worker Container Entrypoints

- [ ] T008 [US1] Update cluster-templates worker entrypoint script to run `claude plugin marketplace add generacy-ai/claude-plugins` and `claude plugin install agency-spec-kit@generacy-marketplace` instead of relying on agency repo mount for commands

## Phase 4: Verification & Polish

- [ ] T009 [P] [US1] Verify end-to-end: install plugin on clean environment (no agency repo), confirm all speckit commands appear in Claude Code
- [ ] T010 [P] [US3] Document manual sync process for updating commands from agency repo to marketplace repo in the marketplace README

## Dependencies & Execution Order

**Sequential dependencies**:
- T001 → T002 → T003 (marketplace repo must exist before populating commands and tagging)
- T003 → T004, T005, T008 (marketplace must be published before consumers can install from it)
- T004 → T005 (marketplace must be registered before plugin install call)
- T005 → T007 (implementation before tests, unless TDD)
- T005, T008 → T009 (verification after all install paths updated)

**Parallel opportunities**:
- T007 can be written in parallel with T006 (different files)
- T009 and T010 can run in parallel (independent verification vs documentation)
- T006 is independent of T005 (different file: `.claude/settings.json` vs `build.ts`)

**Cross-repo note**: T001-T003 operate on the new `generacy-ai/claude-plugins` repo. T004-T007 operate on this repo (generacy). T008 operates on cluster-templates.
