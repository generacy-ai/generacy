---
sidebar_position: 2
---

# Humancy Configuration

This guide covers all configuration options for Humancy.

## Configuration File

Humancy is configured via `.humancy/config.json`:

```json title=".humancy/config.json"
{
  "version": "1.0",
  "defaults": {
    "reviewGate": {
      "timeout": "24h",
      "requiredApprovals": 1
    }
  },
  "workflows": "./workflows",
  "integrations": {},
  "notifications": {}
}
```

## Configuration Options

### Default Settings

```json
{
  "defaults": {
    "reviewGate": {
      "timeout": "24h",           // Default gate timeout
      "requiredApprovals": 1,     // Default approvals needed
      "autoApproveOnTimeout": false, // Auto-approve on timeout
      "notifyOnPending": true     // Notify when gate pending
    },
    "workflow": {
      "timeout": "7d",            // Default workflow timeout
      "retries": 3,               // Retry failed steps
      "retryDelay": "5m"          // Delay between retries
    }
  }
}
```

### Workflow Directory

```json
{
  "workflows": "./workflows",    // Directory for workflow files
  "workflowPatterns": ["*.yml", "*.yaml"]  // File patterns
}
```

### Integrations

#### GitHub Integration

```json
{
  "integrations": {
    "github": {
      "enabled": true,
      "features": {
        "prReviews": true,       // Use PR review system
        "issueComments": true,   // Post to issue comments
        "checkRuns": true,       // Create check runs
        "statusChecks": true     // Update commit status
      },
      "labels": {
        "pending": "review-pending",
        "approved": "review-approved",
        "rejected": "review-rejected"
      }
    }
  }
}
```

#### Slack Integration

```json
{
  "integrations": {
    "slack": {
      "enabled": true,
      "defaultChannel": "#reviews",
      "webhookUrl": "$SLACK_WEBHOOK_URL",
      "mentions": {
        "onPending": true,
        "onApproved": false,
        "onRejected": true
      }
    }
  }
}
```

### Notifications

```json
{
  "notifications": {
    "channels": {
      "slack": {
        "webhook": "$SLACK_WEBHOOK_URL"
      },
      "email": {
        "smtp": {
          "host": "smtp.example.com",
          "port": 587
        }
      }
    },
    "defaults": {
      "onPending": ["slack"],
      "onApproved": ["slack"],
      "onRejected": ["slack", "email"],
      "onTimeout": ["email"]
    }
  }
}
```

### Reviewers Configuration

```json
{
  "reviewers": {
    "teams": {
      "@team-leads": ["alice@company.com", "bob@company.com"],
      "@security": ["security@company.com"],
      "@dba": ["dba@company.com"]
    },
    "escalation": {
      "after": "4h",
      "to": "@team-leads"
    }
  }
}
```

## Workflow Configuration

Workflows are defined in YAML files:

```yaml title=".humancy/workflows/deploy.yml"
name: Deployment
description: Deploy to environments with approval

triggers:
  - command: "/deploy"
  - on: push
    branches: ["main"]

env:
  NODE_ENV: production

steps:
  - id: build
    type: action
    action: npm-build
    timeout: 10m

  - id: approval
    type: review-gate
    title: "Approve Deployment"
    reviewers:
      - "@team-leads"
    requiredApprovals: 1
    timeout: 4h

  - id: deploy
    type: action
    action: deploy
    requires: [approval]
```

### Workflow Options

```yaml
name: string              # Workflow name
description: string       # Description
enabled: boolean          # Enable/disable workflow

triggers:
  - command: string       # Command trigger (/command)
  - on: string            # Event trigger (push, pull_request)
    branches: [string]    # Branch filter
    paths: [string]       # Path filter

env:                      # Environment variables
  KEY: value

timeout: duration         # Workflow timeout
retries: number           # Retry count
retryDelay: duration      # Retry delay

steps: []                 # Workflow steps
```

### Step Types

#### Action Step

```yaml
- id: build
  type: action
  action: npm-build       # Action to run
  timeout: 10m            # Step timeout
  env:                    # Step environment
    NODE_ENV: production
  requires: [step-id]     # Dependencies
  condition: ${{ success() }}  # Condition
```

#### Review Gate Step

```yaml
- id: approval
  type: review-gate
  title: string           # Gate title
  description: string     # Gate description
  reviewers:              # Allowed reviewers
    - "@team"
    - "user@email.com"
  requiredApprovals: 1    # Approvals needed
  timeout: 24h            # Gate timeout
  autoApproveOnTimeout: false
  blocking: true          # Pause workflow
  requires: [step-id]     # Dependencies
```

## Agent Configuration

### Claude Code

```json title=".claude/settings.json"
{
  "mcpServers": {
    "humancy": {
      "command": "humancy",
      "args": ["mcp"]
    }
  }
}
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `HUMANCY_CONFIG` | Config file path | `.humancy/config.json` |
| `HUMANCY_LOG_LEVEL` | Log level | `info` |
| `GITHUB_TOKEN` | GitHub API token | - |
| `SLACK_WEBHOOK_URL` | Slack webhook | - |

## Examples

### Minimal Configuration

```json title=".humancy/config.json"
{
  "version": "1.0",
  "workflows": "./workflows"
}
```

### Production Configuration

```json title=".humancy/config.json"
{
  "version": "1.0",
  "defaults": {
    "reviewGate": {
      "timeout": "24h",
      "requiredApprovals": 1,
      "notifyOnPending": true
    }
  },
  "workflows": "./workflows",
  "integrations": {
    "github": {
      "enabled": true,
      "features": {
        "prReviews": true,
        "checkRuns": true
      }
    },
    "slack": {
      "enabled": true,
      "defaultChannel": "#deployments",
      "webhookUrl": "$SLACK_WEBHOOK_URL"
    }
  },
  "reviewers": {
    "teams": {
      "@leads": ["lead1@company.com", "lead2@company.com"],
      "@security": ["security@company.com"]
    },
    "escalation": {
      "after": "4h",
      "to": "@leads"
    }
  }
}
```

## Validation

Validate configuration:

```bash
humancy config validate
```

Test workflows:

```bash
humancy workflow test ./workflows/deploy.yml
```

## Next Steps

- [Humancy Overview](/docs/guides/humancy/overview)
- [Creating Workflows](/docs/plugins/humancy-plugins)
