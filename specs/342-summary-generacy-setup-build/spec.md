# Feature Specification: Fix `generacy setup build` Phase 4 speckit installation for external projects

**Branch**: `342-summary-generacy-setup-build` | **Issue**: #342 | **Date**: 2026-03-07 | **Status**: Draft

## Summary

`generacy setup build` Phase 4 (Claude Code integration — speckit commands + Agency MCP) fails for external projects because both installation paths require access to the private `generacy-ai/agency` repo.

## Background: What Phase 4 Installs

Phase 4 installs **two distinct speckit components**:

1. **Claude Code plugin** (`claude-plugin-agency-spec-kit`) — 9 slash command `.md` files (`specify.md`, `clarify.md`, `plan.md`, `tasks.md`, `implement.md`, `checklist.md`, `analyze.md`, `constitution.md`, `taskstoissues.md`) that workers invoke to process workflow phases. Installed via `claude plugin marketplace add` / `claude plugin install`, or file-copied to `~/.claude/commands/`.

2. **Agency MCP server** (`agency-plugin-spec-kit`) — Node.js MCP server providing speckit tools (`create_feature`, `check_prereqs`, `manage_clarifications`, etc.). Configured in `~/.claude.json` pointing to the agency CLI.

## Problem

Phase 4 has two installation paths, both requiring access to `generacy-ai/agency`:

1. **Marketplace plugin** — runs `claude plugin marketplace add generacy-ai/agency --scope user` → fails for external users (private repo, token lacks access)
2. **File-copy fallback** — copies `.md` files from `/workspaces/agency/packages/claude-plugin-agency-spec-kit/commands/` → skipped ("agency source not available" — repo not cloned)

**Key constraint:** The slash command `.md` files are **not distributable via npm**. Claude Code only recognizes them via its marketplace system or as files in `~/.claude/commands/`. The npm package `@generacy-ai/agency` currently only includes `["dist", "workflows"]` in its `files` field — no `.md` command files.

## Proposed Solutions

Several options, not mutually exclusive:

### Option A: Include `.md` files in the npm package

Add the slash command files to the `@generacy-ai/agency` npm package distribution:

- Update `packages/claude-plugin-agency-spec-kit/package.json` `files` field to include `commands/`
- Or include them in the `@generacy-ai/agency` root package
- Phase 4 adds a third fallback: copy `.md` files from `$(npm root -g)/@generacy-ai/agency/.../commands/` to `~/.claude/commands/`

**Pros:** Works with existing `npm install -g` in Dockerfile, no extra infrastructure
**Cons:** Slightly unconventional npm package contents, requires the file-copy path

### Option B: Bundle slash commands into `@generacy-ai/generacy`

Include the `.md` files in the generacy CLI package itself, so `generacy setup build` can self-install them without any external dependency:

- Ship commands as embedded assets in the generacy package
- Phase 4 copies from the generacy package's own install path

**Pros:** Zero external dependencies, simplest for external users
**Cons:** Couples generacy CLI releases to slash command updates

### Option C: Publish marketplace to a public repo

Move the marketplace definition (`.claude-plugin/marketplace.json` and the plugin source) to a public GitHub repo:

- `claude plugin marketplace add generacy-ai/claude-plugins --scope user` (public repo)

**Pros:** Uses the intended Claude Code plugin distribution mechanism
**Cons:** Requires maintaining a separate public repo, still needs GitHub network access

### Option D: Hybrid — npm package + generacy CLI installer

- Include `.md` files in the npm `@generacy-ai/agency` package (Option A)
- Add a `generacy setup build` fallback that discovers and copies from npm global
- Long-term, move to public marketplace (Option C)

## Current Installation Flow (for reference)

```
Phase 4:
  1. Register marketplace: claude plugin marketplace add generacy-ai/agency
  2. Install plugin: claude plugin install agency-spec-kit@generacy-marketplace
  3. (fallback) File-copy .md files from /workspaces/agency source
  4. (cleanup) Remove old file-copy commands if plugin installed
  5. Configure Agency MCP server in ~/.claude.json
```

## Context

This blocks external project onboarding via cluster-templates. Workers crash loop because speckit components aren't available after `generacy setup build` completes.

Related: generacy-ai/cluster-templates#9 (worker crash loop), generacy-ai/cluster-templates#8 (duplicate clone compounds the issue)

## Files Affected

- `packages/generacy/src/cli/commands/setup/build.ts` — Phase 4 implementation (lines 271-418)
- Potentially `packages/claude-plugin-agency-spec-kit/package.json` — `files` field (if Option A)

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## User Stories

### US1: External project worker uses speckit commands

**As an** external project worker (Claude Code agent running in a cluster-templates workspace),
**I want** `generacy setup build` to install speckit slash commands and the Agency MCP server without requiring access to the private `generacy-ai/agency` GitHub repo,
**So that** I can use speckit workflow commands (`/specify`, `/plan`, `/tasks`, `/implement`, etc.) immediately after build completes.

**Acceptance Criteria**:
- [ ] Phase 4 succeeds when the `generacy-ai/agency` GitHub repo is inaccessible
- [ ] All 9 speckit slash command `.md` files are installed to `~/.claude/commands/`
- [ ] The Agency MCP server is configured in `~/.claude.json`
- [ ] Workers no longer crash-loop after `generacy setup build` completes

### US2: Internal developer retains existing workflow

**As an** internal developer with access to the `generacy-ai/agency` repo,
**I want** the existing marketplace plugin and file-copy paths to continue working,
**So that** my current workflow is unaffected by the fix.

**Acceptance Criteria**:
- [ ] Marketplace plugin path still works when `generacy-ai/agency` repo is accessible
- [ ] File-copy fallback from `/workspaces/agency/` source still works when available
- [ ] New npm fallback is tried only when both existing paths fail

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Include speckit `.md` command files in the `@generacy-ai/agency` npm package distribution | P1 | Update `files` field in package.json to include `commands/` |
| FR-002 | Add npm-global fallback path in Phase 4 that copies `.md` files from `$(npm root -g)/@generacy-ai/agency/.../commands/` | P1 | Third fallback after marketplace and source-copy |
| FR-003 | Preserve existing marketplace plugin installation path as primary | P2 | No changes to steps 1-2 |
| FR-004 | Preserve existing file-copy fallback from agency source as secondary | P2 | No changes to step 3 |
| FR-005 | Agency MCP server configuration must work with globally-installed `agency` CLI | P1 | Already partially implemented via `npm root -g` |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | External project build success | 100% of Phase 4 completions install speckit | Run `generacy setup build` in a clean external project workspace |
| SC-002 | Worker crash-loop elimination | 0 crash loops due to missing speckit | Deploy external project via cluster-templates and verify worker stability |
| SC-003 | Internal developer regression | 0 regressions for internal workflows | Run `generacy setup build` in internal workspace with agency repo access |

## Assumptions

- `@generacy-ai/agency` is already installed globally via npm in the Docker image (Dockerfile handles this)
- The npm global install location is discoverable via `npm root -g`
- Claude Code recognizes `.md` files in `~/.claude/commands/` as slash commands
- The recommended approach is Option D (Hybrid) — npm package + generacy CLI installer with long-term marketplace migration

## Out of Scope

- Publishing a public marketplace repo (Option C) — future work
- Bundling commands into `@generacy-ai/generacy` (Option B) — rejected due to coupling
- Changes to the Agency MCP server installation (already working via npm global)
- Changes to the Docker image or Dockerfile

---

*Generated by speckit*
