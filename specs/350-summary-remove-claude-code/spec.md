# Feature Specification: Remove Claude Marketplace Plugin Install

Replace Claude Code marketplace plugin installation with npm package-based speckit command copying in `generacy setup build` Phase 4.

**Branch**: `350-summary-remove-claude-code` | **Date**: 2026-03-07 | **Status**: Draft

## Summary

Remove the Claude Code marketplace plugin installation from `generacy setup build` (Phase 4) and replace it with copying speckit command files from the `@generacy-ai/agency-plugin-spec-kit` npm package.

## Background

The current `installClaudeCodeIntegration()` in `src/cli/commands/setup/build.ts` has three fallback mechanisms for installing speckit commands:
1. Claude marketplace plugin install (preferred) — doesn't reliably materialize `.md` files
2. Source directory fallback — only works when agency repo is cloned locally
3. NPM global fallback — works but requires commands to be bundled in the npm package

The marketplace approach is unreliable and adds unnecessary complexity. Since `@generacy-ai/agency-plugin-spec-kit` will be updated to bundle the command files, we should use the npm package as the primary (and only) install mechanism.

## Requirements

- Disable/remove the Claude marketplace plugin registration and install from `build.ts` Phase 4
- Use the npm package path (`@generacy-ai/agency-plugin-spec-kit`) as the primary source for copying commands to `~/.claude/commands/`
- Support both local workspace resolution (for tetrad-development) and npm global resolution (for external containers)
- Keep the Agency MCP server configuration in `~/.claude/settings.json`

## Dependencies

- generacy-ai/agency — Bundle speckit command files in agency-plugin-spec-kit npm package (must be completed first)

## Related Issues

- generacy-ai/tetrad-development — Rework devcontainer shared volume setup
- generacy-ai/cluster-templates — Port package install approach for external developers

## User Stories

### US1: Developer Running Setup Build

**As a** developer setting up a Generacy workspace,
**I want** `generacy setup build` to reliably install speckit commands from the npm package,
**So that** I can use speckit slash commands in Claude Code without marketplace plugin failures.

**Acceptance Criteria**:
- [ ] Running `generacy setup build` copies speckit `.md` command files to `~/.claude/commands/`
- [ ] Commands are sourced from the `@generacy-ai/agency-plugin-spec-kit` npm package
- [ ] No Claude marketplace plugin install is attempted
- [ ] Setup succeeds in both tetrad-development workspace and external container environments

### US2: External Developer Onboarding

**As an** external developer using Generacy outside the tetrad-development monorepo,
**I want** speckit commands to install via npm global resolution,
**So that** I don't need the agency repo cloned locally.

**Acceptance Criteria**:
- [ ] When `@generacy-ai/agency-plugin-spec-kit` is installed globally, commands resolve and copy correctly
- [ ] When the package is in the local workspace `node_modules`, that path is preferred
- [ ] Clear error message if the package cannot be found in either location

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Remove `claude mcp add-from-marketplace` calls from Phase 4 | P1 | Marketplace plugin install is unreliable |
| FR-002 | Resolve `@generacy-ai/agency-plugin-spec-kit` package path via local workspace first, then npm global | P1 | Two-tier resolution strategy |
| FR-003 | Copy all `.md` command files from package `commands/` directory to `~/.claude/commands/` | P1 | Replaces marketplace materialization |
| FR-004 | Retain Agency MCP server configuration in `~/.claude/settings.json` | P1 | MCP server is separate from commands |
| FR-005 | Remove marketplace plugin registration logic | P2 | Clean up unused code paths |
| FR-006 | Log which resolution path was used (local vs global) | P2 | Aids debugging setup issues |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Setup build completes without marketplace errors | 100% | Run `generacy setup build` in tetrad-development |
| SC-002 | Speckit commands available in `~/.claude/commands/` after setup | All commands present | Check file listing post-setup |
| SC-003 | Setup works in external container (no local agency repo) | Pass | Run in clean container with npm global package |

## Assumptions

- `@generacy-ai/agency-plugin-spec-kit` npm package will be updated to bundle command `.md` files before this feature ships
- The Agency MCP server registration mechanism remains unchanged
- Node.js `require.resolve` or equivalent can locate globally installed npm packages

## Out of Scope

- Changes to the Agency MCP server configuration
- Modifying the speckit command file contents themselves
- Updating the `@generacy-ai/agency-plugin-spec-kit` package (handled in generacy-ai/agency repo)
- Devcontainer shared volume rework (separate issue in tetrad-development)

---

*Generated by speckit*
