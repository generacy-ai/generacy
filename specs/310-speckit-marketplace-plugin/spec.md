# Feature Specification: Publish Speckit Commands as Claude Code Marketplace Plugin

**Feature Branch**: `310-speckit-marketplace-plugin`
**Created**: 2026-03-05
**Status**: Complete
**Input**: GitHub Issue #310

## User Scenarios & Testing

### User Story 1 - Developer Installs Speckit Plugin via Marketplace (Priority: P1)

A developer (internal or external) installs the speckit slash commands without needing the agency repo cloned locally. They run a single CLI command and all `/specify`, `/clarify`, `/plan`, `/tasks`, `/implement` commands become available in their Claude Code sessions.

**Why this priority**: Core functionality — removes the hard dependency on cloning the agency repo locally.

**Independent Test**: Can be tested by running the install command on a clean machine and verifying all speckit commands appear in Claude Code.

**Acceptance Scenarios**:

1. **Given** a developer with Claude Code installed but no agency repo, **When** they run `claude plugin install agency-spec-kit`, **Then** all speckit slash commands are available in Claude Code
2. **Given** the plugin is installed, **When** the developer starts a new Claude Code session, **Then** the speckit commands work without error

---

### User Story 2 - Setup Build Uses Marketplace Install (Priority: P2)

The `generacy setup build` command (Phase 4) switches from file-copy to marketplace-based installation. The setup script installs the plugin via the marketplace instead of copying `.md` files from the agency repo.

**Why this priority**: Updates the existing automated workflow to use the new distribution mechanism.

**Independent Test**: Run `generacy setup build` and verify speckit commands are installed via marketplace rather than file copy.

**Acceptance Scenarios**:

1. **Given** the agency repo is cloned locally, **When** `generacy setup build` runs, **Then** Phase 4 installs via marketplace instead of file copy
2. **Given** the agency repo is NOT cloned locally, **When** `generacy setup build` runs, **Then** Phase 4 still installs via marketplace successfully

---

### User Story 3 - Plugin Version Management (Priority: P3)

Developers can update the speckit plugin to a newer version when available, and the system supports versioning of the command definitions.

**Why this priority**: Long-term maintainability and update lifecycle.

**Independent Test**: Publish v2 of the plugin, run update command, verify new commands are present.

**Acceptance Scenarios**:

1. **Given** an older version is installed, **When** developer runs update, **Then** the latest version is installed
2. **Given** a specific version is needed, **When** developer specifies a version, **Then** that exact version is installed

---

### Edge Cases

- What happens when the marketplace/GitHub repo is unreachable?
- What happens if there's a version conflict between the plugin and Agency MCP server?
- How does the system handle partial installation failures?

## Requirements

### Functional Requirements

- **FR-001**: System MUST publish speckit command definitions (`.md` files) to a marketplace (GitHub repo)
- **FR-002**: System MUST support installation via `claude plugin install` CLI
- **FR-003**: `generacy setup build` MUST switch Phase 4 from file-copy to marketplace install
- **FR-004**: System MUST include a plugin manifest with version, commands, and metadata
- **FR-005**: Worker container entrypoints MUST install via marketplace
- **FR-006**: System MUST support offline/fallback to file-copy when marketplace is unreachable

### Key Entities

- **Plugin Manifest**: Defines the plugin metadata, version, and command list
- **Marketplace Repository**: GitHub repo hosting the plugin distribution
- **Command Definitions**: Markdown files defining slash commands for Claude Code

## Success Criteria

### Measurable Outcomes

- **SC-001**: Speckit commands can be installed on a machine without the agency repo cloned
- **SC-002**: `generacy setup build` successfully installs via marketplace
- **SC-003**: Worker containers can install the plugin during entrypoint
- **SC-004**: External contributors can install speckit commands independently
