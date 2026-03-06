# Tasks: Publish Speckit Commands as Claude Code Marketplace Plugin

**Input**: Design documents from `/specs/313-problem-speckit-slash-commands/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, clarifications.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Agency Repo Marketplace Structure

Set up the marketplace and plugin structure in the agency repo (`agency/packages/claude-plugin-agency-spec-kit/`). No new repo needed — marketplace lives alongside the plugin source (per clarification Q3).

- [ ] T001 Create `.claude-plugin/marketplace.json` at root of `agency/` repo with marketplace catalog — name: `generacy-marketplace`, owner: `Generacy AI`, plugin entry for `agency-spec-kit@1.0.0` pointing to `./packages/claude-plugin-agency-spec-kit`
- [ ] T002 Verify/update `agency/packages/claude-plugin-agency-spec-kit/.claude-plugin/plugin.json` — ensure name (`agency-spec-kit`), version (`1.0.0`), description, author, keywords fields are correct per data-model.md
- [ ] T003 [P] Ensure command `.md` files in `agency/packages/claude-plugin-agency-spec-kit/commands/` are complete — all 9 commands: specify, clarify, plan, tasks, implement, checklist, analyze, constitution, taskstoissues
- [ ] T004 [P] Add MCP server configuration to plugin manifest (`plugin.json`) for marketplace installs — declare `agency` MCP server so plugin install auto-configures it (per clarification Q2: C)
- [ ] T005 Configure bare + namespaced command registration so both `/specify` and `/agency-spec-kit:specify` work (per clarification Q1: C) — investigate plugin.json `commands` field or alias mechanism
- [ ] T006 Tag agency repo as `v1.0.0` for version pinning reference

## Phase 2: Update `generacy setup build` Phase 4

Modify `installClaudeCodeIntegration()` in `packages/generacy/src/cli/commands/setup/build.ts` to install via marketplace with fallback.

- [ ] T007 Add marketplace registration — write `generacy-marketplace` entry to `~/.claude/settings.json` → `extraKnownMarketplaces` with `source: { source: "github", repo: "generacy-ai/agency" }` (agency repo is the marketplace)
- [ ] T008 Add marketplace plugin install — run `claude plugin install agency-spec-kit@generacy-marketplace --scope user` via `execSync`, wrapped in try/catch
- [ ] T009 Add fallback logic — if marketplace install fails and agency repo exists locally, fall back to current file-copy behavior; if neither works, log warning and continue
- [ ] T010 Add cleanup logic — remove old file-copy commands from `~/.claude/commands/` (9 `.md` files) when plugin installs successfully to avoid duplicates (per clarification from #310 Q3)
- [ ] T011 Add version pinning support — read pinned version from `package.json` or config, pass to install command; support `--latest` flag to override (per spec Q4: C, clarification Q5: A)
- [ ] T012 [P] Write tests in `packages/generacy/src/__tests__/setup/build.test.ts` — test marketplace registration, plugin install success, fallback to file copy, cleanup of old commands, version pinning, and error handling

## Phase 3: Project-Level Config

- [ ] T013 [P] Add `extraKnownMarketplaces` entry to `.claude/settings.json` in generacy repo — `generacy-marketplace` pointing to `generacy-ai/agency` GitHub source, so team members auto-discover the marketplace

## Phase 4: Worker Container Entrypoints

Update cluster-templates worker entrypoints (external `cluster-templates` repo).

- [ ] T014 Update worker entrypoint script to register marketplace: `claude plugin marketplace add generacy-ai/agency`
- [ ] T015 [P] Update worker entrypoint script to install plugin: `claude plugin install agency-spec-kit@generacy-marketplace`
- [ ] T016 [P] Remove dependency on agency repo being mounted for commands (MCP server still requires agency repo)

## Phase 5: Verification

- [ ] T017 Verify end-to-end: run `generacy setup build` on clean machine, confirm plugin installs and both bare + namespaced commands are available
- [ ] T018 Verify fallback: disconnect from network/marketplace, run `generacy setup build`, confirm file-copy fallback works when agency repo is available
- [ ] T019 Verify worker container: confirm worker entrypoint successfully registers marketplace and installs plugin

## Dependencies & Execution Order

**Sequential phase boundaries**:
- Phase 1 → Phase 2 (marketplace structure must exist before build references it)
- Phase 2 → Phase 4 (build logic informs entrypoint changes)
- Phase 2 → Phase 5 (verification requires build changes to be complete)

**Parallel opportunities within phases**:
- T003 and T004 can run in parallel (different files)
- T012 and T013 can run in parallel with each other and with T007-T011 (different files/repos)
- T015 and T016 can run in parallel (logically independent changes in same entrypoint)

**Cross-repo dependencies**:
- Phase 1 requires access to agency repo (source of commands + marketplace host)
- Phase 4 requires access to `cluster-templates` repo
- Phase 5 requires all prior phases complete
