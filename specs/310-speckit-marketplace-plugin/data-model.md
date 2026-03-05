# Data Model: Speckit Marketplace Plugin

## Overview

This feature deals primarily with configuration files and static assets rather than runtime data entities. The "data model" is the set of JSON configuration files that define the marketplace and plugin structure.

## Core Entities

### MarketplaceManifest

The top-level marketplace catalog file.

**Location**: `.claude-plugin/marketplace.json`

```typescript
interface MarketplaceManifest {
  name: string;                    // "generacy-marketplace"
  owner: {
    name: string;                  // "Generacy AI"
    email?: string;                // "support@generacy.ai"
  };
  metadata?: {
    description?: string;
    version?: string;
    pluginRoot?: string;           // "./plugins"
  };
  plugins: PluginEntry[];
}
```

### PluginEntry

A plugin listing within the marketplace.

```typescript
interface PluginEntry {
  name: string;                    // "agency-spec-kit"
  source: string | PluginSource;   // "./plugins/agency-spec-kit"
  description?: string;
  version?: string;                // "1.0.0"
  author?: { name: string; email?: string };
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  category?: string;
  tags?: string[];
  strict?: boolean;                // default: true
  commands?: string | string[];
  agents?: string | string[];
  hooks?: string | object;
  mcpServers?: string | object;
}
```

### PluginManifest

The plugin's own metadata file.

**Location**: `plugins/<name>/.claude-plugin/plugin.json`

```typescript
interface PluginManifest {
  name: string;                    // Required, kebab-case
  version?: string;                // Semver
  description?: string;
  author?: { name: string; email?: string };
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  commands?: string | string[];
  agents?: string | string[];
  skills?: string | string[];
  hooks?: string | object;
  mcpServers?: string | object;
  lspServers?: string | object;
  outputStyles?: string | string[];
}
```

### CommandDefinition

A slash command is a markdown file in `commands/`.

**Location**: `plugins/<name>/commands/<command-name>.md`

```typescript
// Not a typed interface — these are markdown files with frontmatter
// that Claude Code reads and registers as slash commands.
// The filename (minus .md) becomes the command name, namespaced
// by the plugin name: /agency-spec-kit:specify
```

## Configuration Changes

### Claude Settings (Modified by setup build)

```typescript
// ~/.claude/settings.json additions
interface ClaudeSettings {
  extraKnownMarketplaces?: {
    [marketplaceName: string]: {
      source: {
        source: "github";
        repo: string;        // "generacy-ai/claude-plugins"
        ref?: string;
      };
    };
  };
  enabledPlugins?: {
    [pluginAtMarketplace: string]: boolean;
    // "agency-spec-kit@generacy-marketplace": true
  };
}
```

### BuildConfig (Extended)

```typescript
// Existing interface in build.ts, no changes needed.
// The marketplace install is handled via CLI/settings writes,
// not via new config options.
```

## Relationships

```
MarketplaceManifest
  └── plugins[] → PluginEntry
                    └── source → Plugin Directory
                                  ├── .claude-plugin/plugin.json → PluginManifest
                                  └── commands/*.md → CommandDefinition[]

ClaudeSettings
  ├── extraKnownMarketplaces → MarketplaceManifest (via GitHub repo)
  └── enabledPlugins → PluginEntry (installed plugins)
```

## Validation Rules

- Marketplace `name` must be kebab-case, no spaces, not a reserved Anthropic name
- Plugin `name` must be kebab-case, no spaces
- Plugin `version` must be valid semver
- Plugin `source` relative paths must start with `./`
- Command files must end in `.md`
- No path traversal (`..`) in source paths
