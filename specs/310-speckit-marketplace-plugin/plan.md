# Implementation Plan: Publish Speckit Commands as Claude Code Marketplace Plugin

**Feature**: Publish speckit slash commands as a Claude Code marketplace plugin for distribution without requiring the agency repo
**Branch**: `310-speckit-marketplace-plugin`
**Status**: Complete

## Summary

Create a Claude Code marketplace in the `generacy-ai` GitHub organization that distributes the speckit slash commands (`/specify`, `/clarify`, `/plan`, `/tasks`, `/implement`, etc.) as an installable plugin. Update `generacy setup build` Phase 4 to install via marketplace instead of file copy, and update worker container entrypoints to do the same. This removes the hard dependency on the agency repo being cloned locally.

## Technical Context

**Language/Version**: TypeScript 5.x (Node.js ≥20.0.0)
**Primary Dependencies**: Commander.js (CLI), Claude Code plugin system
**Testing**: Vitest
**Target Platform**: Linux (dev containers, worker containers), macOS (developer machines)
**Project Type**: Monorepo (pnpm workspaces)

## Architecture

### Two-Part Distribution

The speckit system has two components that need distribution:

1. **Slash Commands** (Claude Code plugin) — Markdown files defining `/specify`, `/clarify`, `/plan`, `/tasks`, `/implement` commands. These are pure static files with no runtime dependencies.

2. **Agency MCP Server** — Node.js server providing speckit MCP tools (`get_paths`, `check_prereqs`, `copy_template`, `update_agent`). This requires the agency repo built and running.

This plan focuses on **Part 1: distributing slash commands via marketplace**. The Agency MCP server configuration remains as-is since it requires a built binary.

### Approach: GitHub-hosted Marketplace Repository

Create a new GitHub repository `generacy-ai/claude-plugins` that serves as a Claude Code marketplace. The speckit commands are published as a plugin within this marketplace.

**Why a separate repo** (not a subdirectory of agency):
- Decouples command distribution from the agency build process
- Allows updates to commands without rebuilding agency
- Clean separation of concerns: marketplace is infrastructure, agency is runtime
- Supports adding future plugins (not just speckit)

### Plugin Structure

```
generacy-ai/claude-plugins/
├── .claude-plugin/
│   └── marketplace.json         # Marketplace catalog
├── plugins/
│   └── agency-spec-kit/
│       ├── .claude-plugin/
│       │   └── plugin.json      # Plugin manifest
│       └── commands/            # Slash command definitions
│           ├── specify.md
│           ├── clarify.md
│           ├── plan.md
│           ├── tasks.md
│           ├── implement.md
│           ├── checklist.md
│           ├── analyze.md
│           ├── constitution.md
│           └── taskstoissues.md
└── README.md
```

### Marketplace Manifest

```json
// .claude-plugin/marketplace.json
{
  "name": "generacy-marketplace",
  "owner": {
    "name": "Generacy AI",
    "email": "support@generacy.ai"
  },
  "metadata": {
    "description": "Official Generacy AI plugins for Claude Code",
    "pluginRoot": "./plugins"
  },
  "plugins": [
    {
      "name": "agency-spec-kit",
      "source": "./plugins/agency-spec-kit",
      "description": "Speckit slash commands for specification-driven development",
      "version": "1.0.0",
      "author": {
        "name": "Generacy AI"
      },
      "homepage": "https://github.com/generacy-ai/claude-plugins",
      "keywords": ["speckit", "specification", "planning", "agency"]
    }
  ]
}
```

### Plugin Manifest

```json
// plugins/agency-spec-kit/.claude-plugin/plugin.json
{
  "name": "agency-spec-kit",
  "version": "1.0.0",
  "description": "Speckit slash commands for specification-driven development workflows",
  "author": {
    "name": "Generacy AI"
  },
  "homepage": "https://github.com/generacy-ai/claude-plugins",
  "keywords": ["speckit", "specification", "planning"]
}
```

## Implementation Phases

### Phase 1: Create Marketplace Repository

**Scope**: Set up `generacy-ai/claude-plugins` GitHub repo with marketplace structure.

**Steps**:
1. Create GitHub repo `generacy-ai/claude-plugins`
2. Create `.claude-plugin/marketplace.json`
3. Create `plugins/agency-spec-kit/.claude-plugin/plugin.json`
4. Copy command `.md` files from `agency/packages/claude-plugin-agency-spec-kit/commands/` into `plugins/agency-spec-kit/commands/`
5. Add README documenting marketplace usage
6. Tag as `v1.0.0`

**Verification**: `claude plugin install agency-spec-kit@generacy-marketplace` works on a clean machine with network access.

### Phase 2: Update `generacy setup build` Phase 4

**Scope**: Modify `installClaudeCodeIntegration()` in `packages/generacy/src/cli/commands/setup/build.ts` to install via marketplace.

**Changes to `build.ts`**:

1. **Add marketplace**: Register `generacy-ai/claude-plugins` as a known marketplace
   - Write to `~/.claude/settings.json` → `extraKnownMarketplaces`

2. **Install plugin**: Run `claude plugin install agency-spec-kit@generacy-marketplace --scope user`

3. **Fallback**: If marketplace install fails (offline, no network), fall back to file copy from local agency repo (current behavior)

4. **Remove old cleanup**: Phase 1 cleanup of `painworth-marketplace` references can be removed or updated to clean the old marketplace name

**Updated Phase 4 flow**:
```
Phase 4: Install Claude Code integration
  ├── Configure marketplace in settings.json
  ├── Try: claude plugin install agency-spec-kit@generacy-marketplace
  ├── Fallback: copy .md files from agency repo (if available)
  └── Configure Agency MCP server in ~/.claude.json (unchanged)
```

### Phase 3: Update Worker Container Entrypoints

**Scope**: Update cluster-templates worker entrypoints to install via marketplace.

**Changes**:
1. Worker entrypoint adds the marketplace: `claude plugin marketplace add generacy-ai/claude-plugins`
2. Worker entrypoint installs the plugin: `claude plugin install agency-spec-kit@generacy-marketplace`
3. Remove dependency on agency repo being mounted/cloned in worker containers for commands (MCP server still needs agency)

### Phase 4: CI/CD for Command Sync

**Scope**: Automate syncing command files from agency repo to marketplace repo.

**Options** (in order of simplicity):
1. **Manual sync**: Copy files manually when commands change (acceptable for low-frequency changes)
2. **GitHub Action**: On push to agency repo's `claude-plugin-agency-spec-kit/commands/`, auto-PR to `claude-plugins` repo
3. **Monorepo approach**: Keep commands in agency, use `git-subdir` source in marketplace to point at agency repo subdirectory

**Recommendation**: Start with Option 1 (manual) and add automation later if command changes become frequent.

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Separate marketplace repo | Yes | Decouples distribution from build, supports future plugins |
| Marketplace name | `generacy-marketplace` | Clear branding, follows kebab-case convention |
| Plugin name | `agency-spec-kit` | Matches existing package naming |
| Command sync | Manual initially | Commands change infrequently; automation adds complexity |
| Fallback mechanism | File copy if marketplace fails | Ensures offline/air-gapped environments still work |
| Project settings | `extraKnownMarketplaces` in `.claude/settings.json` | Auto-prompts team members, checked into version control |

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Marketplace repo unavailable | Fallback to file copy in setup build |
| Claude Code plugin API changes | Pin marketplace format version, test on updates |
| Command version drift between agency and marketplace | Sync process (manual → automated) |
| Worker containers can't reach GitHub | Pre-install plugin in container image, or mount marketplace locally |
| Breaking changes to commands | Semantic versioning in plugin manifest |

## Files Modified

### In this repository (generacy)

| File | Change |
|------|--------|
| `packages/generacy/src/cli/commands/setup/build.ts` | Update Phase 4 to use marketplace install with fallback |
| `packages/generacy/src/__tests__/setup/build.test.ts` | Update tests for new Phase 4 behavior |
| `.claude/settings.json` | Add `extraKnownMarketplaces` for team auto-install |

### New repository (generacy-ai/claude-plugins)

| File | Description |
|------|-------------|
| `.claude-plugin/marketplace.json` | Marketplace catalog |
| `plugins/agency-spec-kit/.claude-plugin/plugin.json` | Plugin manifest |
| `plugins/agency-spec-kit/commands/*.md` | Speckit command definitions |
| `README.md` | Installation and usage docs |

### External (cluster-templates)

| File | Change |
|------|--------|
| Worker entrypoint script | Add marketplace add + plugin install commands |

## Constitution Check

No constitution file found at `.specify/memory/constitution.md`. No gates to check.
