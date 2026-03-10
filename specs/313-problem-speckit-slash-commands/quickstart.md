# Quickstart: Speckit Marketplace Plugin

## Prerequisites

- Claude Code CLI installed
- GitHub access to `generacy-ai/claude-plugins` (private repo)

## Installation (End User)

### Option 1: Via Marketplace (preferred)

```bash
# Register the marketplace
claude plugin marketplace add generacy-ai/claude-plugins

# Install the plugin
claude plugin install agency-spec-kit@generacy-marketplace
```

### Option 2: Via `generacy setup build` (automated)

```bash
generacy setup build
# Phase 4 automatically registers marketplace and installs the plugin
```

### Option 3: Via project settings (team auto-discovery)

Clone a repo with `.claude/settings.json` containing the marketplace config. Claude Code auto-prompts to accept and install.

## Verify Installation

```bash
# List installed plugins
claude plugin list

# Start a Claude Code session and try a command
claude
# Then type: /specify
```

## Available Commands

| Command | Description |
|---------|-------------|
| `/specify` | Create a new feature spec from a description |
| `/clarify` | Identify underspecified areas and integrate answers |
| `/plan` | Generate implementation plan from spec |
| `/tasks` | Generate task list with dependency ordering |
| `/implement` | Execute tasks with progress tracking |
| `/checklist` | Generate quality checklist for the feature |
| `/analyze` | Run consistency analysis across spec artifacts |
| `/constitution` | Manage project governance principles |
| `/taskstoissues` | Convert tasks to GitHub issues |

## Updating

```bash
# Update to latest version
claude plugin update agency-spec-kit@generacy-marketplace
```

## Uninstalling

```bash
claude plugin uninstall agency-spec-kit
```

## Troubleshooting

### Commands not appearing
1. Verify plugin is installed: `claude plugin list`
2. Check if Agency MCP server is configured: look for `@generacy-ai/agency-plugin-spec-kit` in `~/.claude.json`
3. Run `generacy setup build` to configure both plugin and MCP server

### Marketplace unreachable
- Ensure GitHub access to `generacy-ai/claude-plugins`
- If offline, run `generacy setup build` with the agency repo cloned locally (falls back to file copy)

### Command namespacing
Commands may appear as `/agency-spec-kit:specify` (namespaced). Both bare and namespaced forms should work.
