---
sidebar_position: 5
---

# Plugin Manifest Reference

Complete reference for the plugin manifest.json file.

## Overview

Every Generacy plugin requires a `manifest.json` file that describes the plugin's capabilities, tools, and configuration.

## Base Schema

```json
{
  "name": "string",
  "version": "string",
  "type": "agency | humancy | generacy",
  "description": "string",
  "author": "string",
  "license": "string",
  "repository": "string",
  "engines": {
    "generacy": "^1.0.0"
  }
}
```

## Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique plugin name (npm package style) |
| `version` | string | Semantic version (e.g., "1.0.0") |
| `type` | string | Plugin type: "agency", "humancy", or "generacy" |
| `description` | string | Brief plugin description |

## Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `author` | string | Plugin author |
| `license` | string | License identifier |
| `repository` | string | Repository URL |
| `homepage` | string | Documentation URL |
| `engines` | object | Version requirements |
| `dependencies` | object | Required plugins |

## Agency Plugin Fields

### tools

Define MCP tools provided by the plugin:

```json
{
  "tools": [
    {
      "name": "tool-name",
      "description": "What the tool does",
      "schema": {
        "type": "object",
        "properties": {
          "param1": {
            "type": "string",
            "description": "Parameter description"
          }
        },
        "required": ["param1"]
      },
      "examples": [
        {
          "description": "Example usage",
          "params": { "param1": "value" }
        }
      ]
    }
  ]
}
```

#### Tool Schema Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | string | Yes | Tool identifier |
| `description` | string | Yes | What the tool does |
| `schema` | object | Yes | JSON Schema for parameters |
| `examples` | array | No | Usage examples |
| `dangerous` | boolean | No | Requires confirmation |
| `timeout` | string | No | Execution timeout |

### contextProviders

Define context providers:

```json
{
  "contextProviders": [
    {
      "name": "context-name",
      "description": "What context this provides",
      "refresh": "on-change | interval | manual",
      "interval": 60000
    }
  ]
}
```

### fileProcessors

Define file type processors:

```json
{
  "fileProcessors": [
    {
      "pattern": "*.proto",
      "description": "Process protobuf files",
      "mimeTypes": ["application/protobuf"]
    }
  ]
}
```

## Humancy Plugin Fields

### actions

Define workflow actions:

```json
{
  "actions": [
    {
      "name": "action-name",
      "description": "Action description",
      "schema": {
        "type": "object",
        "properties": {}
      },
      "outputs": {
        "type": "object",
        "properties": {
          "result": { "type": "string" }
        }
      }
    }
  ]
}
```

### gateTypes

Define custom review gate types:

```json
{
  "gateTypes": [
    {
      "name": "gate-type-name",
      "description": "Gate type description",
      "config": {
        "type": "object",
        "properties": {
          "minApprovals": {
            "type": "number",
            "default": 1
          }
        }
      }
    }
  ]
}
```

### notifications

Define notification channels:

```json
{
  "notifications": [
    {
      "name": "channel-name",
      "description": "Notification channel",
      "config": {
        "type": "object",
        "properties": {
          "webhookUrl": {
            "type": "string",
            "format": "uri"
          }
        },
        "required": ["webhookUrl"]
      }
    }
  ]
}
```

## Generacy Plugin Fields

### integrations

Define external integrations:

```json
{
  "integrations": [
    {
      "name": "integration-name",
      "description": "Integration description",
      "auth": {
        "type": "oauth2 | apiKey | basic",
        "config": {}
      },
      "capabilities": ["read", "write", "webhook"]
    }
  ]
}
```

### jobProcessors

Define job processors:

```json
{
  "jobProcessors": [
    {
      "name": "processor-name",
      "description": "What jobs this processes",
      "concurrency": 5,
      "timeout": "30m",
      "retries": {
        "attempts": 3,
        "backoff": "exponential"
      }
    }
  ]
}
```

### webhooks

Define webhook handlers:

```json
{
  "webhooks": [
    {
      "name": "webhook-name",
      "path": "/webhooks/service",
      "description": "Handle service webhooks",
      "verifySignature": true,
      "signatureHeader": "X-Signature"
    }
  ]
}
```

### schedulers

Define scheduled jobs:

```json
{
  "schedulers": [
    {
      "name": "scheduler-name",
      "cron": "0 * * * *",
      "job": "job-processor-name",
      "data": {},
      "timezone": "UTC"
    }
  ]
}
```

## Configuration

### config

Define plugin configuration schema:

```json
{
  "config": {
    "type": "object",
    "properties": {
      "apiKey": {
        "type": "string",
        "description": "API key for the service",
        "env": "SERVICE_API_KEY"
      },
      "timeout": {
        "type": "number",
        "default": 30000,
        "description": "Request timeout in ms"
      }
    },
    "required": ["apiKey"]
  }
}
```

### Environment Variables

Reference environment variables in config:

```json
{
  "config": {
    "properties": {
      "apiKey": {
        "type": "string",
        "env": "MY_PLUGIN_API_KEY"
      }
    }
  }
}
```

## Complete Example

```json title="manifest.json"
{
  "name": "@myorg/generacy-plugin-jira",
  "version": "1.0.0",
  "type": "generacy",
  "description": "Jira integration for Generacy",
  "author": "My Organization",
  "license": "MIT",
  "repository": "https://github.com/myorg/generacy-plugin-jira",
  "engines": {
    "generacy": "^1.0.0"
  },
  "integrations": [
    {
      "name": "jira",
      "description": "Jira Cloud integration",
      "auth": {
        "type": "oauth2",
        "config": {
          "authorizationUrl": "https://auth.atlassian.com/authorize",
          "tokenUrl": "https://auth.atlassian.com/oauth/token",
          "scopes": ["read:jira-work", "write:jira-work"]
        }
      },
      "capabilities": ["read", "write", "webhook"]
    }
  ],
  "jobProcessors": [
    {
      "name": "sync-jira-issues",
      "description": "Sync issues from Jira",
      "concurrency": 2,
      "timeout": "10m"
    },
    {
      "name": "create-jira-issue",
      "description": "Create issue in Jira",
      "timeout": "1m"
    }
  ],
  "webhooks": [
    {
      "name": "jira-webhook",
      "path": "/webhooks/jira",
      "description": "Handle Jira webhooks",
      "verifySignature": true
    }
  ],
  "schedulers": [
    {
      "name": "jira-sync",
      "cron": "*/15 * * * *",
      "job": "sync-jira-issues",
      "data": { "incremental": true }
    }
  ],
  "config": {
    "type": "object",
    "properties": {
      "jiraUrl": {
        "type": "string",
        "format": "uri",
        "description": "Jira instance URL"
      },
      "projectKeys": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Jira project keys to sync"
      }
    },
    "required": ["jiraUrl"]
  }
}
```

## Validation

Validate your manifest:

```bash
generacy plugin validate ./manifest.json
```

## Next Steps

- [Developing Plugins](/docs/plugins/developing-plugins) - Get started
- [Agency Plugins](/docs/plugins/agency-plugins) - Agency specifics
- [Humancy Plugins](/docs/plugins/humancy-plugins) - Humancy specifics
- [Generacy Plugins](/docs/plugins/generacy-plugins) - Generacy specifics
