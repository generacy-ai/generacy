# Research: Speckit Marketplace Plugin

## Technology Decision: GitHub-hosted Marketplace

### Decision
Use a dedicated GitHub repository (`generacy-ai/claude-plugins`) as the Claude Code marketplace.

### Rationale
- Claude Code's plugin system supports GitHub repos as marketplace sources via `extraKnownMarketplaces`
- Decouples command distribution from the agency build process
- Standard plugin lifecycle: `claude plugin install`, `claude plugin update`, `claude plugin uninstall`
- Supports adding future plugins beyond speckit

### Alternatives Considered

| Alternative | Pros | Cons | Verdict |
|-------------|------|------|---------|
| **Subdirectory in agency repo** | No new repo; source of truth stays together | Couples distribution to agency build; requires cloning agency | Rejected — defeats the purpose |
| **npm package** | Standard JS distribution; versioning built-in | Claude Code doesn't support npm-based plugins | Not supported |
| **URL-based plugin source** | No GitHub dependency | Less discoverable; no version management | Not ideal for team use |
| **Monorepo plugin directory** | No new repo; lives in generacy | Marketplace needs its own repo structure | Claude Code expects repo-level marketplace |

## Claude Code Plugin System

### How It Works
1. **Marketplace** = GitHub repo with `.claude-plugin/marketplace.json` at root
2. **Plugin** = subdirectory with `.claude-plugin/plugin.json` and `commands/` dir
3. **Installation**: `claude plugin install <plugin-name>@<marketplace-name>`
4. **Registration**: Marketplaces added via `extraKnownMarketplaces` in settings or `claude plugin marketplace add`
5. **Command namespacing**: Commands are namespaced by plugin name (`/plugin-name:command`)

### Key Constraints
- Plugin names must be kebab-case
- Marketplace names must be kebab-case
- Commands are markdown files; filename becomes command name
- MCP servers can be declared in plugin manifest but require resolvable paths

## Implementation Patterns

### Fallback Strategy
```
1. Try marketplace install (network required)
2. If fail → try file copy from local agency repo
3. If fail → log warning, continue (MCP server still configurable separately)
```

### Settings.json Integration
Project-level `.claude/settings.json` supports `extraKnownMarketplaces` which auto-prompts team members to accept the marketplace when they open the project.

### Phase 4 Modification Pattern
The current Phase 4 in `build.ts` (lines 248-305) does:
1. Copy command `.md` files from agency repo to `~/.claude/commands/`
2. Configure Agency MCP server in `~/.claude.json`

New Phase 4 will:
1. Register marketplace in `~/.claude/settings.json`
2. Run `claude plugin install agency-spec-kit@generacy-marketplace`
3. Fallback to file copy if install fails
4. Configure Agency MCP server (unchanged)

## Key Sources
- Claude Code plugin documentation (built-in help: `claude plugin --help`)
- Existing plugin manifest: `agency/packages/claude-plugin-agency-spec-kit/.claude-plugin/plugin.json`
- Current build.ts Phase 4: `packages/generacy/src/cli/commands/setup/build.ts:248-305`
- Prior spec #310: `specs/310-speckit-marketplace-plugin/`
