# Feature Specification: ## Summary

`generacy setup build` Phase 4 (Claude Code integration — speckit commands + Agency MCP) fails for external projects because both installation paths require access to the private `generacy-ai/agency` repo

**Branch**: `342-summary-generacy-setup-build` | **Date**: 2026-03-07 | **Status**: Draft

## Summary

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

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
