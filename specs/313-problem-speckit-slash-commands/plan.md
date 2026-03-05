# Implementation Plan: Publish Speckit Commands as Claude Code Marketplace Plugin

**Feature**: Distribute speckit slash commands via a Claude Code marketplace plugin, removing the hard dependency on the agency repo being cloned locally
**Branch**: `313-problem-speckit-slash-commands`
**Status**: Complete

## Summary

Create a Claude Code marketplace repository (`generacy-ai/claude-plugins`) that distributes the speckit slash commands (`/specify`, `/clarify`, `/plan`, `/tasks`, `/implement`, `/checklist`, `/analyze`, `/constitution`, `/taskstoissues`) as an installable plugin. Update `generacy setup build` Phase 4 to install via marketplace instead of file copy, with fallback to local file copy when offline. Update worker container entrypoints to install via marketplace.

## Technical Context

**Language/Version**: TypeScript 5.x (Node.js ≥20.0.0)
**Primary Dependencies**: Commander.js (CLI), Claude Code plugin system
**Testing**: Vitest
**Target Platform**: Linux (dev containers, worker containers), macOS (developer machines)
**Project Type**: Monorepo (pnpm workspaces)

## Architecture

### Two-Part Distribution

The speckit system has two components:

1. **Slash Commands** (Claude Code plugin) — Markdown files defining commands. Pure static files with no runtime dependencies.
2. **Agency MCP Server** — Node.js server providing speckit MCP tools (`get_paths`, `check_prereqs`, etc.). Requires the agency repo built and running.

This plan covers **Part 1 only**: distributing slash commands via marketplace. Agency MCP server configuration stays in `generacy setup build` as-is.

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

### Updated Phase 4 Flow

```
Phase 4: Install Claude Code integration
  ├── Register marketplace in ~/.claude/settings.json (extraKnownMarketplaces)
  ├── Try: claude plugin install agency-spec-kit@generacy-marketplace
  ├── Fallback: copy .md files from agency repo (current behavior, if agency dir exists)
  ├── Error: if both fail, log warning and continue
  └── Configure Agency MCP server in ~/.claude.json (unchanged)
```

## Implementation Phases

### Phase 1: Create Marketplace Repository

**Scope**: Set up `generacy-ai/claude-plugins` GitHub repo with marketplace structure.

**Steps**:
1. Create GitHub repo `generacy-ai/claude-plugins` (private, team access)
2. Create `.claude-plugin/marketplace.json` with marketplace catalog
3. Create `plugins/agency-spec-kit/.claude-plugin/plugin.json` with plugin manifest
4. Copy command `.md` files from `agency/packages/claude-plugin-agency-spec-kit/commands/`
5. Add README documenting marketplace usage and installation
6. Tag as `v1.0.0`

**Marketplace Manifest** (`.claude-plugin/marketplace.json`):
```json
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
      "author": { "name": "Generacy AI" },
      "homepage": "https://github.com/generacy-ai/claude-plugins",
      "keywords": ["speckit", "specification", "planning", "agency"]
    }
  ]
}
```

**Plugin Manifest** (`plugins/agency-spec-kit/.claude-plugin/plugin.json`):
```json
{
  "name": "agency-spec-kit",
  "version": "1.0.0",
  "description": "Speckit slash commands for specification-driven development workflows",
  "author": { "name": "Generacy AI" },
  "homepage": "https://github.com/generacy-ai/claude-plugins",
  "keywords": ["speckit", "specification", "planning"]
}
```

**Verification**: `claude plugin install agency-spec-kit@generacy-marketplace` works on a clean machine.

### Phase 2: Update `generacy setup build` Phase 4

**Scope**: Modify `installClaudeCodeIntegration()` in `packages/generacy/src/cli/commands/setup/build.ts`.

**Changes**:

1. **Register marketplace** — Write `generacy-marketplace` to `~/.claude/settings.json` → `extraKnownMarketplaces`:
   ```json
   {
     "extraKnownMarketplaces": {
       "generacy-marketplace": {
         "source": {
           "source": "github",
           "repo": "generacy-ai/claude-plugins"
         }
       }
     }
   }
   ```

2. **Install plugin** — Run `claude plugin install agency-spec-kit@generacy-marketplace --scope user` via `execSync`

3. **Fallback** — If marketplace install fails:
   - If agency repo exists locally, fall back to file copy (current behavior)
   - If not, log warning and continue (MCP server setup follows)

4. **Cleanup** — Remove old file-copy commands from `~/.claude/commands/` if they exist and plugin installed successfully (avoid duplicates)

**Files Modified**:
- `packages/generacy/src/cli/commands/setup/build.ts` — Phase 4 logic
- `packages/generacy/src/__tests__/setup/build.test.ts` — Tests for new behavior

### Phase 3: Add Project-Level Marketplace Config

**Scope**: Add `extraKnownMarketplaces` to `.claude/settings.json` in this repo so team members auto-discover the marketplace.

**Changes**:
- Add/update `.claude/settings.json` with `extraKnownMarketplaces` entry
- Team members cloning the repo will automatically see the marketplace

### Phase 4: Update Worker Container Entrypoints

**Scope**: Update cluster-templates worker entrypoints.

**Changes** (in `cluster-templates` repo):
1. Worker entrypoint registers marketplace: `claude plugin marketplace add generacy-ai/claude-plugins`
2. Worker entrypoint installs plugin: `claude plugin install agency-spec-kit@generacy-marketplace`
3. Remove dependency on agency repo being mounted for commands (MCP still needs it)

### Phase 5: Command Sync Process

**Scope**: Define how commands stay in sync between agency repo and marketplace repo.

**Approach**: Manual sync initially. Commands change infrequently enough that manual copy is acceptable.

**Future automation**: GitHub Action on push to `agency/packages/claude-plugin-agency-spec-kit/commands/` that auto-PRs updates to `claude-plugins` repo.

## Open Questions (from Clarifications)

These clarification questions are pending answers and may affect implementation:

| # | Question | Impact | Default Assumption |
|---|----------|--------|--------------------|
| Q1 | Command namespacing (`/specify` vs `/agency-spec-kit:specify`) | High — affects all command references | Register both bare and namespaced names if possible |
| Q2 | Agency MCP server in plugin manifest vs build | Medium — plugin self-containedness | Keep MCP in build (requires local binary path) |
| Q3 | Marketplace repo creation scope | Low — prerequisite | Create as part of this issue |
| Q4 | Command sync workflow | Low — can start manual | Manual sync initially |
| Q5 | Version pinning location | Low — can change later | Pin in marketplace manifest, reference from setup build |

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Separate marketplace repo | Yes (`generacy-ai/claude-plugins`) | Decouples distribution from build; supports future plugins |
| Marketplace name | `generacy-marketplace` | Clear branding, kebab-case convention |
| Plugin name | `agency-spec-kit` | Matches existing package naming |
| Command sync | Manual initially | Commands change infrequently |
| Fallback mechanism | File copy from local agency repo | Offline/air-gapped environments still work |
| MCP server config | Stays in setup build | Requires local binary path, not distributable via plugin |
| Visibility | Private initially | Team-only access via GitHub permissions |
| Version pinning | Pin in manifest, `--latest` flag to override | Predictable builds by default |

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Marketplace repo unreachable | Fallback to file copy in setup build |
| Claude Code plugin API changes | Pin format version, test on updates |
| Command version drift | Manual sync → automated CI/CD later |
| Worker containers can't reach GitHub | Pre-install in container image or mount locally |
| Namespace conflicts | Test both bare and namespaced command names |

## Files Modified

### In this repository (generacy)

| File | Change |
|------|--------|
| `packages/generacy/src/cli/commands/setup/build.ts` | Update Phase 4: marketplace install with fallback |
| `packages/generacy/src/__tests__/setup/build.test.ts` | Update tests for new Phase 4 behavior |
| `.claude/settings.json` | Add `extraKnownMarketplaces` for team auto-discovery |

### New repository (generacy-ai/claude-plugins)

| File | Description |
|------|-------------|
| `.claude-plugin/marketplace.json` | Marketplace catalog |
| `plugins/agency-spec-kit/.claude-plugin/plugin.json` | Plugin manifest |
| `plugins/agency-spec-kit/commands/*.md` | 9 speckit command definitions |
| `README.md` | Installation and usage docs |

### External (cluster-templates)

| File | Change |
|------|--------|
| Worker entrypoint script | Add marketplace registration + plugin install |

## Constitution Check

No constitution file found at `.specify/memory/constitution.md`. No gates to check.
