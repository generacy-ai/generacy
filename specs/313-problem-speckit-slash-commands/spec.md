# Feature Specification: Publish Speckit Commands as Claude Code Marketplace Plugin

**Branch**: `313-problem-speckit-slash-commands` | **Date**: 2026-03-06 | **Status**: Draft

## Summary

Migrate speckit slash commands from file-copy installation to a Claude Code marketplace plugin, enabling developers to install commands without cloning the agency repo and providing standard plugin lifecycle management.

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

## Related

- #310 — Previous attempt (closing due to stale orchestrator state)
- PR #309 — Current fix using file copy approach
- cluster-templates#3 — Worker entrypoint updates

## User Stories

### US1: Developer Installs Speckit via Marketplace

**As a** developer on the Generacy team,
**I want** to install speckit commands via `claude plugin install`,
**So that** I don't need the agency repo cloned locally to use speckit workflows.

**Acceptance Criteria**:
- [ ] Running `claude plugin install agency-spec-kit@generacy-marketplace` installs all speckit commands
- [ ] Installed commands are available as slash commands in Claude Code
- [ ] Installation works outside dev container environments

### US2: Clean Migration from File-Copy

**As a** developer with existing file-copy installed commands,
**I want** the marketplace install to clean up old file-copy commands,
**So that** I don't have duplicate or conflicting command definitions.

**Acceptance Criteria**:
- [ ] Old `~/.claude/commands/` speckit files are removed during marketplace install
- [ ] No command conflicts after migration

### US3: Version-Pinned Plugin Updates

**As a** developer,
**I want** plugin versions pinned by default with a `--latest` flag to override,
**So that** I get predictable behavior with the option to update.

**Acceptance Criteria**:
- [ ] Default install pins to a specific version
- [ ] `--latest` flag installs the most recent version
- [ ] Version info is visible in plugin metadata

### US4: Offline Fallback

**As a** developer working without network access,
**I want** the system to fall back to file-copy from the agency repo if available,
**So that** I can still use speckit commands when offline.

**Acceptance Criteria**:
- [ ] If marketplace is unreachable and agency repo exists locally, commands are copied from it
- [ ] If neither source is available, a clear error message is shown

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Set up a Claude Code marketplace (GitHub repo or URL) | P1 | Private, restricted to team members |
| FR-002 | Create plugin manifest for `agency-spec-kit` | P1 | Includes all speckit commands |
| FR-003 | Publish commands to the marketplace | P1 | |
| FR-004 | Update `generacy setup build` to install via marketplace | P1 | Replace file-copy logic |
| FR-005 | Update cluster-templates entrypoints for marketplace install | P1 | cluster-templates#3 |
| FR-006 | Clean up old file-copy commands during install | P2 | Remove `~/.claude/commands/` speckit files |
| FR-007 | Support version pinning with `--latest` override | P2 | Pin by default |
| FR-008 | Implement offline fallback to local agency repo | P3 | Error if neither source available |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Plugin installable without agency repo | 100% | Test install on clean environment |
| SC-002 | All speckit commands functional after marketplace install | 100% | Run each command end-to-end |
| SC-003 | Migration from file-copy is seamless | No duplicates | Verify no conflicting command files |
| SC-004 | Works for external contributors | Yes | Test from outside dev container |

## Assumptions

- Claude Code has a working `claude plugin install` / `claude plugin marketplace` system
- A GitHub repo can serve as a private marketplace
- Team members have GitHub access to the marketplace repo

## Out of Scope

- Public marketplace listing (starting private only)
- Plugin auto-update mechanisms beyond `--latest`
- Supporting non-Claude-Code plugin systems

---

*Generated by speckit*
