# Tasks: Publish Speckit Commands as Claude Code Marketplace Plugin

**Input**: Design documents from `/specs/313-problem-speckit-slash-commands/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Marketplace Repository Setup

Create the `generacy-ai/claude-plugins` GitHub repository with proper structure.

- [ ] T001 Create GitHub repo `generacy-ai/claude-plugins` (private, team access) via `gh repo create`
- [ ] T002 Create `.claude-plugin/marketplace.json` with marketplace catalog (name: `generacy-marketplace`, plugin listing for `agency-spec-kit@1.0.0`)
- [ ] T003 Create `plugins/agency-spec-kit/.claude-plugin/plugin.json` with plugin manifest (name, version, description, author, keywords)
- [ ] T004 Copy 9 command `.md` files from `agency/packages/claude-plugin-agency-spec-kit/commands/` to `plugins/agency-spec-kit/commands/` — commands: specify, clarify, plan, tasks, implement, checklist, analyze, constitution, taskstoissues
- [ ] T005 Add `README.md` documenting marketplace usage and installation instructions
- [ ] T006 Commit, push, and tag as `v1.0.0`

## Phase 2: Update `generacy setup build` Phase 4

Modify the CLI build command to install via marketplace with fallback.

- [ ] T007 Read current Phase 4 implementation in `packages/generacy/src/cli/commands/setup/build.ts` (lines 248-305) to understand existing file-copy logic
- [ ] T008 Add marketplace registration function — write `generacy-marketplace` entry to `~/.claude/settings.json` → `extraKnownMarketplaces` with `source: { source: "github", repo: "generacy-ai/claude-plugins" }`
- [ ] T009 Add marketplace plugin install — run `claude plugin install agency-spec-kit@generacy-marketplace --scope user` via `execSync`, wrapped in try/catch
- [ ] T010 Add fallback logic — if marketplace install fails, fall back to file copy from local agency repo if available, otherwise log warning and continue
- [ ] T011 Add cleanup logic — remove old file-copy commands from `~/.claude/commands/` (specify.md, clarify.md, plan.md, tasks.md, implement.md, checklist.md, analyze.md, constitution.md, taskstoissues.md) when plugin installs successfully
- [ ] T012 [P] Write tests in `packages/generacy/src/__tests__/setup/build.test.ts` — test marketplace install success path, fallback path, cleanup of old commands, and error handling

## Phase 3: Project-Level Marketplace Config

- [ ] T013 [P] Add `extraKnownMarketplaces` entry to `.claude/settings.json` in this repo for team auto-discovery of the generacy-marketplace

## Phase 4: Worker Container Entrypoints

Update cluster-templates worker entrypoints (external repo).

- [ ] T014 Update worker entrypoint script in `cluster-templates` repo to register marketplace: `claude plugin marketplace add generacy-ai/claude-plugins`
- [ ] T015 Update worker entrypoint script to install plugin: `claude plugin install agency-spec-kit@generacy-marketplace`
- [ ] T016 Remove dependency on agency repo being mounted for commands in worker entrypoint (MCP server still requires it)

## Phase 5: Verification & Sync Process

- [ ] T017 Verify end-to-end: run `generacy setup build` on clean machine, confirm plugin installs and commands are available
- [ ] T018 Verify fallback: run `generacy setup build` without network access to marketplace, confirm file-copy fallback works
- [ ] T019 Document command sync process — how to manually update marketplace repo when commands change in agency repo

## Dependencies & Execution Order

**Sequential phase boundaries**:
- Phase 1 → Phase 2 (marketplace must exist before build can reference it)
- Phase 2 → Phase 4 (build logic informs entrypoint changes)
- Phase 2 → Phase 5 (verification requires build changes)

**Parallel opportunities**:
- T012 and T013 can run in parallel (different files, no shared state)
- T014, T015, T016 can all run in parallel within Phase 4 (same entrypoint file but logically independent changes)
- Phase 3 (T013) can run in parallel with Phase 2 core work (T008-T011)

**Cross-repo dependencies**:
- Phase 1 requires access to agency repo for command source files
- Phase 4 requires access to `cluster-templates` repo
- Phase 5 requires both marketplace repo and build changes to be complete
