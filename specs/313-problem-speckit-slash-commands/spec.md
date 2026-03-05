# Feature Specification: Publish Speckit Commands as Claude Code Marketplace Plugin

**Branch**: `313-problem-speckit-slash-commands` | **Date**: 2026-03-05 | **Status**: Draft

## Summary

Publish the `claude-plugin-agency-spec-kit` as a Claude Code marketplace plugin, replacing the current file-copy installation approach. This enables developers to install speckit commands via `claude plugin install` without needing the agency repo cloned locally.

## Problem

The speckit slash commands (`/specify`, `/clarify`, `/plan`, `/tasks`, `/implement`, etc.) currently live as markdown files in `agency/packages/claude-plugin-agency-spec-kit/commands/`. They are installed by `generacy setup build` which copies them to `~/.claude/commands/`.

This approach has two problems:
1. **Requires the agency repo to be cloned locally** — if `/workspaces/agency` doesn't exist, the commands silently aren't installed
2. **No distribution mechanism** — developers outside the dev container environment can't easily install these commands

## Proposed Solution

Publish the `claude-plugin-agency-spec-kit` as a Claude Code marketplace plugin so developers can install it with:
```bash
claude plugin install agency-spec-kit@generacy-marketplace
```

This requires:
1. Setting up a Claude Code marketplace (can be a GitHub repo or URL)
2. Publishing the plugin manifest and commands to the marketplace
3. Updating `generacy setup build` to install via marketplace instead of file copy
4. Updating cluster-templates entrypoints to install via marketplace

## Benefits

- Works without cloning the agency repo
- Standard plugin lifecycle (install, update, uninstall)
- Version management
- Works for external developers/contributors

## Clarification Answers (from #310)

- **Q1 (Plugin System)**: A — Claude Code has an existing `claude plugin install` / `claude plugin marketplace` system.
- **Q2 (Visibility)**: B — Start private, restricted to team members with GitHub access.
- **Q3 (Conflict Resolution)**: A — Clean up old file-copy commands during marketplace install.
- **Q4 (Version Pinning)**: C — Pin version by default, with a `--latest` flag to override.
- **Q5 (Offline Fallback)**: A — Fall back to file-copy from agency repo if available, error otherwise.

## Clarification Answers (from #313)

- **Q1 (Namespacing)**: C — Register both namespaced and bare names so existing references continue to work.
- **Q2 (MCP Server)**: C — Include MCP config in plugin manifest for marketplace installs, keep separate for fallback file-copy.
- **Q3 (Marketplace Repo)**: N/A — No separate repo; marketplace lives in agency repo alongside plugin source.
- **Q4 (Command Sync)**: N/A — Same repo, no sync problem.
- **Q5 (Version Pinning Location)**: A — Pin version in this repo (e.g., `package.json` or `autodev.json`).

## Related

- #310 — Previous attempt (closing due to stale orchestrator state)
- PR #309 — Current fix using file copy approach
- cluster-templates#3 — Worker entrypoint updates

## User Stories

### US1: Developer installs speckit commands via marketplace

**As a** developer on the Generacy team,
**I want** to install speckit slash commands via `claude plugin install`,
**So that** I don't need the agency repo cloned locally to use `/specify`, `/clarify`, `/plan`, `/tasks`, and `/implement`.

**Acceptance Criteria**:
- [ ] `claude plugin install agency-spec-kit` installs all speckit commands
- [ ] Commands are available in Claude Code after installation
- [ ] Old file-copy commands are cleaned up during install

### US2: Developer manages plugin versions

**As a** developer,
**I want** plugin versions to be pinned by default with a `--latest` flag to override,
**So that** I can control when I update to newer versions of the speckit commands.

**Acceptance Criteria**:
- [ ] Plugin installs a pinned version by default
- [ ] `--latest` flag fetches the most recent version
- [ ] Version is visible in plugin metadata

### US3: Developer works offline or without marketplace access

**As a** developer working in an environment without marketplace connectivity,
**I want** the system to fall back to file-copy from the agency repo if available,
**So that** I can still use speckit commands.

**Acceptance Criteria**:
- [ ] Falls back to agency repo file-copy if marketplace is unreachable and repo exists
- [ ] Shows a clear error if neither marketplace nor agency repo is available

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Set up Claude Code marketplace in agency repo | P1 | No separate repo; lives alongside plugin source |
| FR-002 | Create plugin manifest for `agency-spec-kit` | P1 | Lists all speckit commands |
| FR-003 | Publish plugin commands to marketplace | P1 | |
| FR-004 | Update `generacy setup build` to install via marketplace | P1 | Replace file-copy logic |
| FR-005 | Update cluster-templates entrypoints for marketplace install | P1 | cluster-templates#3 |
| FR-006 | Clean up old file-copy commands on marketplace install | P2 | Conflict resolution |
| FR-007 | Support version pinning with `--latest` override | P2 | |
| FR-008 | Implement offline fallback to agency repo file-copy | P2 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Plugin installable via CLI | 100% | `claude plugin install agency-spec-kit` succeeds |
| SC-002 | All speckit commands available post-install | All 6+ commands | Verify each command runs |
| SC-003 | No dependency on agency repo clone | Zero | Install succeeds without `/workspaces/agency` |
| SC-004 | Old commands cleaned up | Zero conflicts | No duplicate commands after migration |

## Assumptions

- Claude Code has a working `claude plugin install` / `claude plugin marketplace` system
- The marketplace can be backed by a private GitHub repo
- Team members have GitHub access to the marketplace repo
- The existing command markdown format is compatible with marketplace distribution

## Out of Scope

- Public marketplace listing (starting private)
- Auto-update mechanism (manual `--latest` for now)
- Plugin dependency resolution between multiple plugins
- Migration tooling for non-team external users

---

*Generated by speckit*
