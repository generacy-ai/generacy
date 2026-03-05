# Feature Specification: Publish Speckit Commands as Claude Code Marketplace Plugin

**Branch**: `313-problem-speckit-slash-commands` | **Date**: 2026-03-05 | **Status**: Draft

## Summary

Publish the `claude-plugin-agency-spec-kit` as a Claude Code marketplace plugin to eliminate the dependency on cloning the agency repo locally, enabling standard plugin lifecycle management and broader developer access.

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

## Clarification Answers (from #310)

- **Q1 (Plugin System)**: A — Claude Code has an existing `claude plugin install` / `claude plugin marketplace` system.
- **Q2 (Visibility)**: B — Start private, restricted to team members with GitHub access.
- **Q3 (Conflict Resolution)**: A — Clean up old file-copy commands during marketplace install.
- **Q4 (Version Pinning)**: C — Pin version by default, with a `--latest` flag to override.
- **Q5 (Offline Fallback)**: A — Fall back to file-copy from agency repo if available, error otherwise.

## User Stories

### US1: Developer Installs Speckit Plugin

**As a** developer on the Generacy team,
**I want** to install speckit commands via a marketplace plugin,
**So that** I don't need the agency repo cloned locally to use speckit slash commands.

**Acceptance Criteria**:
- [ ] Can install speckit plugin with `claude plugin install agency-spec-kit@generacy-marketplace`
- [ ] All speckit commands (`/specify`, `/clarify`, `/plan`, `/tasks`, `/implement`, `/analyze`, `/checklist`) are available after install
- [ ] Plugin version is pinned by default

### US2: Developer Updates Speckit Plugin

**As a** developer,
**I want** to update the speckit plugin to the latest version when needed,
**So that** I get new commands and improvements without manual file management.

**Acceptance Criteria**:
- [ ] Can update to latest with a `--latest` flag
- [ ] Version pinning prevents unexpected breaking changes
- [ ] Update process is non-destructive to existing specs

### US3: Offline/Fallback Developer Experience

**As a** developer working without network access or marketplace availability,
**I want** the system to fall back to file-copy installation from the agency repo,
**So that** I can still use speckit commands in degraded environments.

**Acceptance Criteria**:
- [ ] Falls back to file-copy from agency repo if available
- [ ] Provides clear error if neither marketplace nor agency repo is available
- [ ] No silent failures

### US4: Clean Migration from File-Copy

**As a** developer with existing file-copy installed commands,
**I want** old file-copy commands cleaned up during marketplace install,
**So that** I don't have duplicate or conflicting command definitions.

**Acceptance Criteria**:
- [ ] Old `~/.claude/commands/` speckit files are removed during marketplace install
- [ ] No duplicate command registrations after migration

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Set up a Claude Code marketplace (GitHub repo or URL) | P1 | Private, restricted to team members |
| FR-002 | Create plugin manifest for `agency-spec-kit` | P1 | Include all speckit commands |
| FR-003 | Publish plugin commands to the marketplace | P1 | |
| FR-004 | Update `generacy setup build` to install via marketplace | P1 | Replace file-copy approach |
| FR-005 | Update cluster-templates entrypoints for marketplace install | P1 | cluster-templates#3 |
| FR-006 | Implement version pinning with `--latest` override | P2 | Pin by default |
| FR-007 | Implement offline fallback to file-copy from agency repo | P2 | Error if neither available |
| FR-008 | Clean up old file-copy commands during marketplace install | P1 | Prevent conflicts |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Plugin install success rate | 100% for team members | Manual testing across environments |
| SC-002 | All speckit commands functional after install | All commands work identically to file-copy | Run each command post-install |
| SC-003 | Migration from file-copy is clean | Zero duplicate commands | Verify `~/.claude/commands/` state |
| SC-004 | Offline fallback works | Graceful degradation | Test without network/marketplace |

## Assumptions

- Claude Code has a working `claude plugin install` / `claude plugin marketplace` system
- A GitHub repo can serve as a private marketplace
- Team members have GitHub access to the marketplace repo
- The plugin manifest format is compatible with existing speckit command structure

## Out of Scope

- Public marketplace listing (starting private)
- Auto-update mechanism (manual update with `--latest` for now)
- Plugin dependency management between multiple Generacy plugins
- GUI/UI for plugin management

## Related

- #310 — Previous attempt (closing due to stale orchestrator state)
- PR #309 — Current fix using file copy approach
- cluster-templates#3 — Worker entrypoint updates

---

*Generated by speckit*
