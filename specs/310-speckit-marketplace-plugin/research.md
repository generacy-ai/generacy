# Research: Speckit Marketplace Plugin

## Claude Code Plugin System

### How It Works

Claude Code uses a marketplace/plugin system for distributing extensions:

- **Marketplace**: A git repository with `.claude-plugin/marketplace.json` at its root
- **Plugin**: A directory with optional `.claude-plugin/plugin.json` manifest, plus `commands/`, `skills/`, `agents/`, `hooks/`, `.mcp.json`, etc.
- **Installation**: `claude plugin install <plugin>@<marketplace>` or via `/plugin` interactive UI

### Key Architecture Details

1. **Plugin Caching**: Plugins are copied to `~/.claude/plugins/cache/` on install. Files outside the plugin directory are not available.
2. **Scopes**: `user` (default, `~/.claude/settings.json`), `project` (`.claude/settings.json`), `local` (`.claude/settings.local.json`), `managed`
3. **Auto-updates**: Marketplaces can auto-update at startup. Controlled per-marketplace.
4. **Team distribution**: `extraKnownMarketplaces` in `.claude/settings.json` auto-prompts team members

### Marketplace Sources

| Source | Format | Notes |
|--------|--------|-------|
| GitHub | `owner/repo` | Simplest, recommended |
| Git URL | Full HTTPS/SSH URL | GitLab, Bitbucket, self-hosted |
| Local path | `./path/to/dir` | For development/testing |
| Remote URL | `https://...marketplace.json` | Limited (no relative paths) |

### Plugin Sources within Marketplace

| Source | Use Case |
|--------|----------|
| Relative path (`./plugins/x`) | Plugins in same repo as marketplace |
| GitHub (`{source: "github", repo: "owner/repo"}`) | Plugins in separate repos |
| Git subdir (`{source: "git-subdir", ...}`) | Plugin in subdirectory of another repo |
| npm (`{source: "npm", package: "@scope/pkg"}`) | npm-distributed plugins |

## Alternatives Considered

### Option A: Separate Marketplace Repository (Selected)

Create `generacy-ai/claude-plugins` as a standalone marketplace repo with commands bundled inline.

**Pros**:
- Clean separation from agency build process
- Extensible for future plugins
- Simple relative paths for plugin source
- Standard marketplace pattern

**Cons**:
- Requires syncing commands when they change in agency repo
- Additional repo to maintain

### Option B: Git-Subdir Source Pointing at Agency Repo

Use `git-subdir` plugin source to point at `agency/packages/claude-plugin-agency-spec-kit/`.

```json
{
  "source": {
    "source": "git-subdir",
    "url": "https://github.com/generacy-ai/agency.git",
    "path": "packages/claude-plugin-agency-spec-kit"
  }
}
```

**Pros**:
- No sync needed; always uses latest from agency
- Single source of truth

**Cons**:
- Requires agency repo to be public (or auth token configured)
- Sparse clone of large agency repo on each install
- Tightly couples marketplace to agency repo structure

### Option C: npm Package Distribution

Publish commands as an npm package, reference via `npm` source.

**Pros**:
- Standard versioning and distribution
- Works with private registries

**Cons**:
- Overkill for static markdown files
- Adds npm publish step to release process
- No obvious benefit over git-based approach

### Decision: Option A

Selected for simplicity, extensibility, and decoupling from the agency build process. The command sync concern is minimal since commands change infrequently.

## Implementation Patterns

### Settings.json Integration for Teams

```json
// .claude/settings.json (checked into generacy repo)
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

### Programmatic Marketplace Install (for setup build)

The `generacy setup build` command needs to install the marketplace programmatically. Two approaches:

1. **Write settings.json directly** (preferred for setup scripts):
   ```typescript
   // Write extraKnownMarketplaces to ~/.claude/settings.json
   // Write enabledPlugins to ~/.claude/settings.json
   // Then run: claude plugin install agency-spec-kit@generacy-marketplace
   ```

2. **Shell out to claude CLI**:
   ```bash
   claude plugin marketplace add generacy-ai/claude-plugins
   claude plugin install agency-spec-kit@generacy-marketplace
   ```

### Fallback Strategy

For environments without network access or where the marketplace is unavailable:

```typescript
try {
  // Try marketplace install
  exec('claude plugin install agency-spec-kit@generacy-marketplace');
} catch {
  // Fallback: copy from local agency repo if available
  if (existsSync(pluginCommandsDir)) {
    copyFiles(pluginCommandsDir, userCommandsDir);
  }
}
```

## References

- [Claude Code Plugin Docs: Discover Plugins](https://code.claude.com/docs/en/discover-plugins)
- [Claude Code Plugin Docs: Create Marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)
- [Claude Code Plugin Docs: Plugin Reference](https://code.claude.com/docs/en/plugins-reference)
- [Official Anthropic Marketplace](https://github.com/anthropics/claude-plugins-official)
- [Demo Marketplace](https://github.com/anthropics/claude-code/tree/main/plugins)
