# Feature Specification: Onboarding Slash Command Suite

**Branch**: `382-phase-4-2-cloud` | **Date**: 2026-03-14 | **Status**: Draft

## Summary

Create a suite of 7 interactive slash commands (`/onboard-*`) for agent-driven project onboarding. These commands enable AI-assisted onboarding from both the cloud UI (via the conversation proxy from issue 4.1) and local Claude Code sessions. Each command is interactive — it analyzes the project, presents findings, and applies changes with user approval.

## Context

These commands are the core building blocks for the Generacy onboarding experience. They are distributed via the `.claude/commands/` directory pattern (matching existing speckit commands like `/specify`, `/clarify`, `/plan`) and packaged through the cluster-base repo or the Generacy devcontainer feature.

## Commands to Implement

### 1. `/onboard-evaluate` — Assess onboarding readiness
- Check for required files (.devcontainer/, .generacy/, package.json, etc.)
- Verify environment prerequisites (Node.js version, Docker, etc.)
- Check GitHub permissions and access
- Report readiness score with specific gaps identified
- Suggest next steps based on findings

### 2. `/onboard-stack` — Document technical stack
- Analyze project to identify languages, frameworks, build tools
- Identify testing frameworks and CI/CD setup
- Document required system tools (databases, message queues, etc.)
- Generate or update a tech stack summary document
- Identify tools needed for fully-enabled/end-to-end testing

### 3. `/onboard-plugins` — Configure Generacy & Agency plugins
- Present available plugins with descriptions
- Recommend plugins based on detected tech stack
- Walk through configuration for selected plugins
- Write plugin configuration to `.generacy/config.yaml`
- Validate configuration

### 4. `/onboard-mcp` — Configure MCP servers
- Present available MCP servers with descriptions
- Recommend servers based on project needs (e.g., Playwright for web projects)
- Help configure `.mcp.json` with appropriate server entries
- Test MCP server connectivity if possible

### 5. `/onboard-init` — Initialize dev CLI configuration
- Create or update CLAUDE.md with project-specific instructions
- Ensure .gitignore includes appropriate entries (.env.local, .generacy/secrets/, etc.)
- Set up any required dotfiles or configuration
- Verify devcontainer configuration is correct

### 6. `/onboard-architecture` — Build architecture documentation
- Analyze codebase structure and patterns
- Generate or supplement architecture overview document
- Document key design decisions and patterns
- Create vision/roadmap document if needed
- Store docs in a conventional location (docs/ or .generacy/docs/)

### 7. `/onboard-backlog` — Populate repo with issues
- Analyze project state and documentation
- Identify gaps, missing features, tech debt
- Suggest issues with titles, descriptions, and labels
- Create issues in GitHub (with user approval for each batch)
- Apply appropriate labels for workflow processing

## Distribution

- Slash commands defined as `.claude/commands/onboard-*.md` files
- Distributed via:
  - cluster-base repo (available after merge)
  - Generacy devcontainer feature (available in devcontainer)
  - Could also be published as a standalone package

## Common Command Patterns

- All commands start by reading the current project state
- Present findings and recommendations to the user
- Ask for user confirmation before making changes
- Commit changes with descriptive messages
- Report what was done and suggest next steps
- Each command is self-contained — no dependency on other onboarding commands
- Commands are idempotent — running twice doesn't break things

## Technical Notes

- Existing speckit commands in `.claude/commands/` provide the implementation pattern
- Commands must work both locally and via the interactive conversation proxy (issue 4.1)
- Command files are markdown prompt templates that instruct Claude on behavior

## Dependencies

- None for command definitions (can start immediately)
- Issue 4.1 (conversation proxy) for remote invocation from cloud UI
- Consumed by: issue 4.4 (onboarding integration)

## Reference

See `docs/cloud-platform-buildout-reference.md` in tetrad-development for full architectural context.

## User Stories

### US1: Developer onboarding a new project

**As a** developer setting up a new project with Generacy,
**I want** interactive slash commands that guide me through onboarding step by step,
**So that** I can get my project fully configured without needing to read extensive documentation or manually discover requirements.

**Acceptance Criteria**:
- [ ] Running `/onboard-evaluate` produces a readiness report with actionable gaps
- [ ] Running `/onboard-stack` generates a tech stack summary document
- [ ] Running `/onboard-plugins` results in a valid `.generacy/config.yaml`
- [ ] Running `/onboard-mcp` produces a working `.mcp.json` configuration
- [ ] Running `/onboard-init` creates/updates CLAUDE.md and .gitignore correctly
- [ ] Running `/onboard-architecture` generates architecture docs in docs/ or .generacy/docs/
- [ ] Running `/onboard-backlog` creates GitHub issues with appropriate labels

### US2: Cloud UI user triggering onboarding remotely

**As a** user of the Generacy cloud dashboard,
**I want** to trigger onboarding commands on my connected cluster via the web UI,
**So that** I can onboard projects without needing a local terminal session.

**Acceptance Criteria**:
- [ ] Each command can be invoked via the conversation proxy (issue 4.1)
- [ ] Commands produce the same results whether invoked locally or remotely
- [ ] Interactive prompts work through the proxy conversation flow

### US3: Returning to a partially onboarded project

**As a** developer who previously ran some onboarding commands,
**I want** commands to detect existing configuration and skip or update rather than overwrite,
**So that** I don't lose previous onboarding work when re-running commands.

**Acceptance Criteria**:
- [ ] Each command checks for existing artifacts before creating new ones
- [ ] Running any command twice produces the same result (idempotent)
- [ ] Existing configuration is updated/merged rather than overwritten

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Implement `/onboard-evaluate` command file | P1 | Readiness assessment with scoring |
| FR-002 | Implement `/onboard-stack` command file | P1 | Tech stack analysis and documentation |
| FR-003 | Implement `/onboard-plugins` command file | P1 | Plugin discovery and configuration |
| FR-004 | Implement `/onboard-mcp` command file | P1 | MCP server setup and validation |
| FR-005 | Implement `/onboard-init` command file | P1 | CLAUDE.md, .gitignore, dotfile setup |
| FR-006 | Implement `/onboard-architecture` command file | P2 | Architecture doc generation |
| FR-007 | Implement `/onboard-backlog` command file | P2 | Issue creation with approval flow |
| FR-008 | All commands follow the common interactive pattern (analyze → present → confirm → apply) | P1 | Consistency across suite |
| FR-009 | All commands are idempotent and self-contained | P1 | No inter-command dependencies |
| FR-010 | Commands work via conversation proxy (issue 4.1) | P1 | No local-only assumptions |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Command count | 7 commands implemented | All `/onboard-*` files exist in `.claude/commands/` |
| SC-002 | Idempotency | All commands pass re-run test | Run each command twice; second run produces no errors or data loss |
| SC-003 | Self-containment | No command depends on another | Each command works on a fresh project independently |
| SC-004 | Pattern consistency | All commands follow common pattern | Code review confirms analyze → present → confirm → apply flow |

## Assumptions

- The `.claude/commands/` directory is the standard location for slash command definitions
- Claude Code supports markdown command files that define agent behavior through prompt templates
- The conversation proxy (issue 4.1) can forward slash command invocations transparently
- Users have GitHub CLI (`gh`) available for issue creation in `/onboard-backlog`
- Plugin and MCP server registries/catalogs exist or will be hardcoded initially

## Out of Scope

- Implementing the conversation proxy itself (issue 4.1)
- Building the cloud UI that invokes these commands (issue 4.4)
- Plugin or MCP server runtime — commands only configure, not execute
- Automated testing of commands (manual testing via Claude Code sessions)
- Publishing commands as a standalone npm package (future consideration)

---

*Generated by speckit*
