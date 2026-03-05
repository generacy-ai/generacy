# Quickstart: Speckit Marketplace Plugin

## For Developers (Installing the Plugin)

### Prerequisites

- Claude Code installed (v1.0.33+)
- Network access to GitHub

### Install via Marketplace

```bash
# Add the Generacy marketplace
/plugin marketplace add generacy-ai/claude-plugins

# Install the speckit plugin
/plugin install agency-spec-kit@generacy-marketplace
```

Or in one step from the CLI:

```bash
claude plugin marketplace add generacy-ai/claude-plugins
claude plugin install agency-spec-kit@generacy-marketplace
```

### Verify Installation

```bash
# Open plugin manager and check Installed tab
/plugin
```

You should see `agency-spec-kit` listed under installed plugins.

### Available Commands

After installation, the following commands are available (namespaced by plugin):

| Command | Description |
|---------|-------------|
| `/agency-spec-kit:specify` | Create a feature specification from a description |
| `/agency-spec-kit:clarify` | Identify underspecified areas and integrate answers |
| `/agency-spec-kit:plan` | Generate implementation plan from specification |
| `/agency-spec-kit:tasks` | Generate task list from plan |
| `/agency-spec-kit:implement` | Execute tasks with progress tracking |
| `/agency-spec-kit:checklist` | Generate quality checklist |
| `/agency-spec-kit:analyze` | Run consistency analysis across spec artifacts |
| `/agency-spec-kit:constitution` | Manage project governance principles |
| `/agency-spec-kit:taskstoissues` | Convert tasks to GitHub issues |

> **Note**: These commands also require the Agency MCP server to be running for full functionality. The MCP server is configured automatically by `generacy setup build`.

### Update the Plugin

```bash
/plugin marketplace update generacy-marketplace
/plugin update agency-spec-kit@generacy-marketplace
```

### Uninstall

```bash
/plugin uninstall agency-spec-kit@generacy-marketplace
```

## For Project Setup (Team Configuration)

### Auto-Install for Team Members

Add to your project's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "generacy-marketplace": {
      "source": {
        "source": "github",
        "repo": "generacy-ai/claude-plugins"
      }
    }
  },
  "enabledPlugins": {
    "agency-spec-kit@generacy-marketplace": true
  }
}
```

Team members will be prompted to install the marketplace when they trust the project folder.

### Via `generacy setup build`

If using the Generacy dev container:

```bash
generacy setup build
```

Phase 4 installs the marketplace plugin automatically.

## For Plugin Maintainers

### Updating Commands

1. Make changes to command `.md` files in `generacy-ai/claude-plugins/plugins/agency-spec-kit/commands/`
2. Bump the version in `plugins/agency-spec-kit/.claude-plugin/plugin.json`
3. Commit and push to `generacy-ai/claude-plugins`
4. Users with auto-update enabled will receive updates at next startup

### Testing Locally

```bash
# Clone the marketplace repo
git clone https://github.com/generacy-ai/claude-plugins.git

# Add as local marketplace
/plugin marketplace add ./claude-plugins

# Install the plugin
/plugin install agency-spec-kit@generacy-marketplace

# Test commands
/agency-spec-kit:specify "test feature"
```

### Validating the Marketplace

```bash
cd claude-plugins
claude plugin validate .
```

## Troubleshooting

### Commands Not Appearing

1. Check plugin is installed: `/plugin` → Installed tab
2. Reload plugins: `/reload-plugins`
3. Restart Claude Code

### Marketplace Add Fails

1. Check GitHub access: `gh auth status`
2. Verify repo exists: `gh repo view generacy-ai/claude-plugins`
3. Check network connectivity

### Plugin Install Fails

1. Ensure marketplace is added first: `/plugin marketplace list`
2. Check for errors: `/plugin` → Errors tab
3. Clear cache: `rm -rf ~/.claude/plugins/cache/generacy-marketplace/`
