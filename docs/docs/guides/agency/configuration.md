---
sidebar_position: 2
---

# Agency Configuration

This guide covers all configuration options for Agency.

## Configuration File

Agency is configured via `.agency/config.json` in your project root:

```json title=".agency/config.json"
{
  "version": "1.0",
  "project": {
    "name": "my-project",
    "type": "node"
  },
  "tools": {
    "enabled": ["project-info", "file-search", "code-analysis"],
    "disabled": []
  },
  "context": {
    "include": ["src/**/*", "package.json"],
    "exclude": ["node_modules", "dist", ".git"]
  },
  "plugins": []
}
```

## Configuration Options

### Project Settings

```json
{
  "project": {
    "name": "string",           // Project name (default: package.json name)
    "type": "node|python|go",   // Project type for context
    "root": "string"            // Project root (default: config file location)
  }
}
```

### Tool Configuration

```json
{
  "tools": {
    "enabled": ["tool1", "tool2"],  // Explicitly enabled tools
    "disabled": ["tool3"],           // Explicitly disabled tools
    "config": {
      "tool-name": {
        // Tool-specific configuration
      }
    }
  }
}
```

#### Built-in Tools

| Tool | Description | Default |
|------|-------------|---------|
| `project-info` | Project metadata and structure | Enabled |
| `file-search` | Search files by name/content | Enabled |
| `code-analysis` | Analyze code patterns | Enabled |
| `git-context` | Git history and status | Enabled |
| `task-management` | Task tracking | Disabled |

### Context Configuration

```json
{
  "context": {
    "include": ["src/**/*"],     // Globs to include
    "exclude": ["**/*.test.ts"], // Globs to exclude
    "maxFileSize": "1MB",        // Max file size to analyze
    "maxFiles": 1000             // Max files to analyze
  }
}
```

### Plugin Configuration

```json
{
  "plugins": [
    "@generacy/plugin-jest",         // npm package
    "./plugins/my-custom-plugin"     // Local plugin
  ],
  "pluginConfig": {
    "@generacy/plugin-jest": {
      "testCommand": "npm test"
    }
  }
}
```

## Agent Configuration

### Claude Code

```json title=".claude/settings.json"
{
  "mcpServers": {
    "agency": {
      "command": "agency",
      "args": ["mcp"],
      "env": {
        "AGENCY_CONFIG": ".agency/config.json"
      }
    }
  }
}
```

### Cursor

```json title=".cursor/mcp.json"
{
  "servers": {
    "agency": {
      "command": "agency",
      "args": ["mcp"]
    }
  }
}
```

### Continue

```json title=".continue/config.json"
{
  "mcpServers": [
    {
      "name": "agency",
      "command": "agency",
      "args": ["mcp"]
    }
  ]
}
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AGENCY_CONFIG` | Path to config file | `.agency/config.json` |
| `AGENCY_LOG_LEVEL` | Logging level | `info` |
| `AGENCY_CACHE_DIR` | Cache directory | `.agency/cache` |
| `AGENCY_PLUGIN_DIR` | Plugin directory | `.agency/plugins` |

## Advanced Configuration

### Custom Context Providers

```json
{
  "context": {
    "providers": [
      {
        "name": "custom-context",
        "type": "file",
        "path": ".agency/context.md"
      },
      {
        "name": "api-docs",
        "type": "glob",
        "pattern": "docs/api/**/*.md"
      }
    ]
  }
}
```

### Tool Aliases

```json
{
  "tools": {
    "aliases": {
      "search": "file-search",
      "analyze": "code-analysis"
    }
  }
}
```

### Performance Tuning

```json
{
  "performance": {
    "cacheEnabled": true,
    "cacheTTL": "1h",
    "parallelToolCalls": 4,
    "timeout": "30s"
  }
}
```

## Validation

Validate your configuration:

```bash
agency config validate
```

View effective configuration:

```bash
agency config show
```

## Examples

### Minimal Configuration

```json title=".agency/config.json"
{
  "version": "1.0"
}
```

### Full Configuration

```json title=".agency/config.json"
{
  "version": "1.0",
  "project": {
    "name": "my-awesome-project",
    "type": "node"
  },
  "tools": {
    "enabled": ["project-info", "file-search", "code-analysis", "git-context"],
    "config": {
      "file-search": {
        "maxResults": 50
      },
      "code-analysis": {
        "includeMetrics": true
      }
    }
  },
  "context": {
    "include": ["src/**/*", "package.json", "tsconfig.json"],
    "exclude": ["node_modules", "dist", "coverage", "**/*.test.ts"],
    "maxFileSize": "500KB"
  },
  "plugins": [
    "@generacy/plugin-jest",
    "@generacy/plugin-eslint"
  ],
  "pluginConfig": {
    "@generacy/plugin-jest": {
      "testCommand": "npm test",
      "coverageThreshold": 80
    }
  },
  "performance": {
    "cacheEnabled": true,
    "parallelToolCalls": 4
  }
}
```

## Next Steps

- [Plugin Development](/docs/plugins/agency-plugins) - Create custom plugins
- [Agency Overview](/docs/guides/agency/overview) - Learn more about Agency
