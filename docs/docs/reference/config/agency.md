---
sidebar_position: 1
---

# Agency Configuration Reference

Complete reference for all Agency configuration options.

## Configuration File

Agency reads configuration from `.agency/config.json`:

```json title=".agency/config.json"
{
  "version": "1.0",
  "project": {},
  "tools": {},
  "context": {},
  "plugins": [],
  "performance": {}
}
```

## version

**Type**: `string`
**Required**: Yes
**Example**: `"1.0"`

Configuration schema version.

## project

Project metadata and settings.

```json
{
  "project": {
    "name": "my-project",
    "type": "node",
    "root": ".",
    "description": "Project description"
  }
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `name` | string | package.json name | Project name |
| `type` | string | auto-detect | Project type: `node`, `python`, `go`, `rust`, `java` |
| `root` | string | `.` | Project root directory |
| `description` | string | - | Project description |

## tools

Tool configuration.

```json
{
  "tools": {
    "enabled": ["project-info", "file-search"],
    "disabled": ["task-management"],
    "config": {
      "file-search": {
        "maxResults": 100
      }
    },
    "aliases": {
      "search": "file-search"
    }
  }
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `enabled` | string[] | all | Explicitly enabled tools |
| `disabled` | string[] | [] | Explicitly disabled tools |
| `config` | object | {} | Per-tool configuration |
| `aliases` | object | {} | Tool name aliases |

### Built-in Tools

| Tool | Description | Default |
|------|-------------|---------|
| `project-info` | Project metadata and structure | Enabled |
| `file-search` | Search files by name/content | Enabled |
| `code-analysis` | Analyze code patterns | Enabled |
| `git-context` | Git history and status | Enabled |
| `task-management` | Task tracking | Disabled |

### Tool-Specific Configuration

#### file-search

```json
{
  "file-search": {
    "maxResults": 50,
    "maxFileSize": "1MB",
    "excludePatterns": ["node_modules/**", "dist/**"]
  }
}
```

#### code-analysis

```json
{
  "code-analysis": {
    "includeMetrics": true,
    "includeDependencies": true,
    "maxDepth": 10
  }
}
```

#### git-context

```json
{
  "git-context": {
    "maxCommits": 50,
    "includeDiff": true,
    "includeStats": true
  }
}
```

## context

Context provider configuration.

```json
{
  "context": {
    "include": ["src/**/*", "package.json"],
    "exclude": ["node_modules", "dist", ".git"],
    "maxFileSize": "1MB",
    "maxFiles": 1000,
    "providers": []
  }
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `include` | string[] | ["**/*"] | Glob patterns to include |
| `exclude` | string[] | defaults | Glob patterns to exclude |
| `maxFileSize` | string | "1MB" | Max file size to analyze |
| `maxFiles` | number | 1000 | Max files to analyze |
| `providers` | object[] | [] | Custom context providers |

### Default Excludes

```json
[
  "node_modules",
  "dist",
  "build",
  ".git",
  ".next",
  "__pycache__",
  "*.pyc",
  "coverage",
  ".nyc_output"
]
```

### Custom Context Providers

```json
{
  "providers": [
    {
      "name": "custom-docs",
      "type": "file",
      "path": ".agency/context.md"
    },
    {
      "name": "api-docs",
      "type": "glob",
      "pattern": "docs/api/**/*.md"
    },
    {
      "name": "conventions",
      "type": "command",
      "command": "cat CONVENTIONS.md"
    }
  ]
}
```

## plugins

Plugin configuration.

```json
{
  "plugins": [
    "@generacy/plugin-jest",
    "@generacy/plugin-eslint",
    "./plugins/custom-plugin"
  ],
  "pluginConfig": {
    "@generacy/plugin-jest": {
      "testCommand": "npm test",
      "coverageThreshold": 80
    }
  }
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `plugins` | string[] | [] | Plugin package names or paths |
| `pluginConfig` | object | {} | Per-plugin configuration |

## performance

Performance tuning options.

```json
{
  "performance": {
    "cacheEnabled": true,
    "cacheTTL": "1h",
    "cacheDir": ".agency/cache",
    "parallelToolCalls": 4,
    "timeout": "30s"
  }
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `cacheEnabled` | boolean | true | Enable caching |
| `cacheTTL` | string | "1h" | Cache time-to-live |
| `cacheDir` | string | ".agency/cache" | Cache directory |
| `parallelToolCalls` | number | 4 | Max parallel tool calls |
| `timeout` | string | "30s" | Default tool timeout |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AGENCY_CONFIG` | Config file path | `.agency/config.json` |
| `AGENCY_LOG_LEVEL` | Log level (debug, info, warn, error) | `info` |
| `AGENCY_CACHE_DIR` | Cache directory | `.agency/cache` |
| `AGENCY_PLUGIN_DIR` | Plugin directory | `.agency/plugins` |
| `AGENCY_TIMEOUT` | Default timeout | `30s` |

## Complete Example

```json title=".agency/config.json"
{
  "version": "1.0",
  "project": {
    "name": "my-awesome-project",
    "type": "node",
    "description": "An awesome project"
  },
  "tools": {
    "enabled": [
      "project-info",
      "file-search",
      "code-analysis",
      "git-context"
    ],
    "config": {
      "file-search": {
        "maxResults": 100,
        "maxFileSize": "500KB"
      },
      "code-analysis": {
        "includeMetrics": true,
        "includeDependencies": true
      },
      "git-context": {
        "maxCommits": 100,
        "includeDiff": true
      }
    },
    "aliases": {
      "search": "file-search",
      "analyze": "code-analysis"
    }
  },
  "context": {
    "include": [
      "src/**/*",
      "package.json",
      "tsconfig.json",
      "README.md"
    ],
    "exclude": [
      "node_modules",
      "dist",
      "coverage",
      "**/*.test.ts",
      "**/*.spec.ts"
    ],
    "maxFileSize": "500KB",
    "maxFiles": 500,
    "providers": [
      {
        "name": "coding-standards",
        "type": "file",
        "path": ".agency/standards.md"
      }
    ]
  },
  "plugins": [
    "@generacy/plugin-jest",
    "@generacy/plugin-eslint",
    "@generacy/plugin-docker"
  ],
  "pluginConfig": {
    "@generacy/plugin-jest": {
      "testCommand": "npm test",
      "coverageThreshold": 80,
      "watchMode": false
    },
    "@generacy/plugin-eslint": {
      "autoFix": true,
      "extensions": [".ts", ".tsx"]
    }
  },
  "performance": {
    "cacheEnabled": true,
    "cacheTTL": "2h",
    "parallelToolCalls": 6,
    "timeout": "60s"
  }
}
```
