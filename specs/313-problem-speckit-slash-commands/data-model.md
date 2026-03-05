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
  source: string;                  // "./plugins/agency-spec-kit"
  description?: string;
  version?: string;                // "1.0.0"
  author?: { name: string; email?: string };
  homepage?: string;
  repository?: string;
  keywords?: string[];
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
  keywords?: string[];
  commands?: string | string[];    // Defaults to "commands/" directory
}
```

### CommandDefinition

Slash commands are markdown files in `commands/`.

**Location**: `plugins/<name>/commands/<command-name>.md`

The filename (minus `.md`) becomes the command name, namespaced by plugin name: `/agency-spec-kit:specify`.

## Configuration Changes

### Claude Settings (Modified by setup build)

```typescript
// ~/.claude/settings.json additions
interface ClaudeSettingsAdditions {
  extraKnownMarketplaces?: {
    [marketplaceName: string]: {
      source: {
        source: "github";
        repo: string;        // "generacy-ai/claude-plugins"
        ref?: string;        // optional git ref for version pinning
      };
    };
  };
}
```

### Project Settings (Checked into repo)

```typescript
// .claude/settings.json (project-level)
// Same structure as user settings — auto-prompts team members
interface ProjectSettings {
  extraKnownMarketplaces?: {
    [marketplaceName: string]: {
      source: {
        source: "github";
        repo: string;
      };
    };
  };
}
```

## Relationships

```
MarketplaceManifest
  └── plugins[] → PluginEntry
                    └── source → Plugin Directory
                                  ├── .claude-plugin/plugin.json → PluginManifest
                                  └── commands/*.md → CommandDefinition[]

ClaudeSettings (user or project)
  └── extraKnownMarketplaces → MarketplaceManifest (via GitHub repo)
```

## Validation Rules

- Marketplace `name` must be kebab-case, no spaces
- Plugin `name` must be kebab-case, no spaces
- Plugin `version` must be valid semver
- Plugin `source` relative paths must start with `./`
- Command files must end in `.md`
- No path traversal (`..`) in source paths
