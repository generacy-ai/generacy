# Feature 297: Publish Speckit Commands as Claude Code Marketplace Plugin

**Source**: [GitHub Issue #310](https://github.com/generacy-ai/generacy/issues/310)

## Problem

The speckit slash commands (`/specify`, `/clarify`, `/plan`, `/tasks`, `/implement`, etc.) currently live as markdown files in `agency/packages/claude-plugin-agency-spec-kit/commands/` and are installed by `generacy setup build` which copies them to `~/.claude/commands/`.

This approach has two problems:
1. **Requires the agency repo to be cloned locally** — if `/workspaces/agency` doesn't exist, the commands silently aren't installed
2. **No distribution mechanism** — developers outside the dev container environment can't easily install these commands

## User Stories

- **As a developer outside the dev container**, I want to install speckit commands without cloning the agency repo, so I can use the full workflow tooling anywhere.
- **As a team lead**, I want a standard plugin lifecycle (install, update, uninstall) for speckit commands, so I can manage tooling versions across the team.
- **As a contributor**, I want to run `claude plugin install agency-spec-kit` and immediately have all speckit commands available, so I can onboard quickly.

## Proposed Solution

Publish `claude-plugin-agency-spec-kit` as a Claude Code marketplace plugin installable via:
```bash
claude plugin install agency-spec-kit@generacy-marketplace
```

## Functional Requirements

1. **Marketplace Setup**
   - Create a Claude Code marketplace (GitHub repo or URL-based)
   - Define the plugin manifest format for speckit commands
   - Host plugin artifacts (command markdown files, metadata)

2. **Plugin Packaging**
   - Package all speckit command files into a publishable plugin structure
   - Include plugin manifest with version, description, command list
   - Ensure commands work identically when installed via marketplace vs file copy

3. **Installation Integration**
   - Update `generacy setup build` to install via marketplace instead of file copy
   - Update cluster-templates entrypoints to install via marketplace
   - Provide fallback or error messaging if marketplace is unreachable

4. **Version Management**
   - Support versioned plugin releases
   - Enable update workflow (`claude plugin update agency-spec-kit`)
   - Track installed version for consistency checks

## Success Criteria

- [ ] Speckit commands can be installed via `claude plugin install` without the agency repo being present
- [ ] `generacy setup build` uses marketplace installation instead of file copy
- [ ] Cluster-template worker entrypoints install via marketplace
- [ ] All existing speckit commands (`/specify`, `/clarify`, `/plan`, `/tasks`, `/implement`, `/analyze`, `/checklist`, `/constitution`) work identically after marketplace installation
- [ ] Plugin version can be queried and updated
- [ ] External developers/contributors can install and use speckit commands

## Open Questions

- What is the exact Claude Code marketplace format/protocol? (Need to research current Claude Code plugin system)
- Should the marketplace be a public GitHub repo or a private one with auth?
- How should plugin versioning align with agency repo releases?
- What happens when a developer has both file-copy and marketplace-installed commands?

## Related

- PR #309 — Current fix using file copy approach
- cluster-templates#3 — Worker entrypoint updates
