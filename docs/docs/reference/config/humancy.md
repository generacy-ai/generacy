---
sidebar_position: 2
---

# Humancy Configuration Reference

Complete reference for all Humancy configuration options.

## Configuration File

Humancy reads configuration from `.humancy/config.json`:

```json title=".humancy/config.json"
{
  "version": "1.0",
  "defaults": {},
  "workflows": "./workflows",
  "integrations": {},
  "notifications": {},
  "reviewers": {}
}
```

## version

**Type**: `string`
**Required**: Yes
**Example**: `"1.0"`

Configuration schema version.

## defaults

Default settings for review gates and workflows.

```json
{
  "defaults": {
    "reviewGate": {
      "timeout": "24h",
      "requiredApprovals": 1,
      "autoApproveOnTimeout": false,
      "notifyOnPending": true,
      "notifyOnApproved": true,
      "notifyOnRejected": true
    },
    "workflow": {
      "timeout": "7d",
      "retries": 3,
      "retryDelay": "5m"
    }
  }
}
```

### reviewGate

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `timeout` | string | "24h" | Gate timeout duration |
| `requiredApprovals` | number | 1 | Approvals needed |
| `autoApproveOnTimeout` | boolean | false | Auto-approve on timeout |
| `notifyOnPending` | boolean | true | Notify when gate pending |
| `notifyOnApproved` | boolean | true | Notify on approval |
| `notifyOnRejected` | boolean | true | Notify on rejection |

### workflow

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `timeout` | string | "7d" | Workflow timeout |
| `retries` | number | 3 | Retry failed steps |
| `retryDelay` | string | "5m" | Delay between retries |

## workflows

Workflow file configuration.

```json
{
  "workflows": "./workflows",
  "workflowPatterns": ["*.yml", "*.yaml"]
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `workflows` | string | "./workflows" | Workflow directory |
| `workflowPatterns` | string[] | ["*.yml", "*.yaml"] | File patterns |

## integrations

Integration settings.

### github

```json
{
  "integrations": {
    "github": {
      "enabled": true,
      "features": {
        "prReviews": true,
        "issueComments": true,
        "checkRuns": true,
        "statusChecks": true
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

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `enabled` | boolean | false | Enable GitHub integration |
| `features.prReviews` | boolean | true | Use PR reviews |
| `features.issueComments` | boolean | true | Post to issue comments |
| `features.checkRuns` | boolean | true | Create check runs |
| `features.statusChecks` | boolean | true | Update commit status |
| `labels` | object | defaults | Custom label names |

### slack

```json
{
  "integrations": {
    "slack": {
      "enabled": true,
      "defaultChannel": "#reviews",
      "webhookUrl": "$SLACK_WEBHOOK_URL",
      "botToken": "$SLACK_BOT_TOKEN",
      "mentions": {
        "onPending": true,
        "onApproved": false,
        "onRejected": true,
        "onTimeout": true
      }
    }
  }
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `enabled` | boolean | false | Enable Slack integration |
| `defaultChannel` | string | - | Default notification channel |
| `webhookUrl` | string | - | Incoming webhook URL |
| `botToken` | string | - | Bot token for API |
| `mentions` | object | - | When to @mention reviewers |

### jira

```json
{
  "integrations": {
    "jira": {
      "enabled": true,
      "baseUrl": "https://company.atlassian.net",
      "projectKey": "PROJ",
      "linkGatesToIssues": true
    }
  }
}
```

## notifications

Notification channel configuration.

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
          "port": 587,
          "secure": true
        },
        "from": "humancy@company.com"
      },
      "teams": {
        "webhook": "$TEAMS_WEBHOOK_URL"
      }
    },
    "defaults": {
      "onPending": ["slack"],
      "onApproved": ["slack"],
      "onRejected": ["slack", "email"],
      "onTimeout": ["email"],
      "onEscalated": ["slack", "email"]
    }
  }
}
```

### Channel Configuration

#### slack

| Property | Type | Description |
|----------|------|-------------|
| `webhook` | string | Webhook URL |

#### email

| Property | Type | Description |
|----------|------|-------------|
| `smtp.host` | string | SMTP server host |
| `smtp.port` | number | SMTP port |
| `smtp.secure` | boolean | Use TLS |
| `from` | string | From address |

#### teams

| Property | Type | Description |
|----------|------|-------------|
| `webhook` | string | Webhook URL |

### Default Events

| Event | Description |
|-------|-------------|
| `onPending` | Gate created, awaiting approval |
| `onApproved` | Gate approved |
| `onRejected` | Gate rejected |
| `onTimeout` | Gate timed out |
| `onEscalated` | Gate escalated |

## reviewers

Reviewer configuration.

```json
{
  "reviewers": {
    "teams": {
      "@team-leads": ["alice@company.com", "bob@company.com"],
      "@security": ["security@company.com"],
      "@dba": ["dba@company.com"],
      "@frontend": ["fe1@company.com", "fe2@company.com"]
    },
    "escalation": {
      "after": "4h",
      "to": "@team-leads"
    },
    "rotations": {
      "@on-call": {
        "schedule": "weekly",
        "members": ["dev1@company.com", "dev2@company.com", "dev3@company.com"]
      }
    }
  }
}
```

| Property | Type | Description |
|----------|------|-------------|
| `teams` | object | Team definitions |
| `escalation` | object | Escalation settings |
| `rotations` | object | On-call rotations |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `HUMANCY_CONFIG` | Config file path | `.humancy/config.json` |
| `HUMANCY_LOG_LEVEL` | Log level | `info` |
| `GITHUB_TOKEN` | GitHub API token | - |
| `SLACK_WEBHOOK_URL` | Slack webhook | - |
| `SLACK_BOT_TOKEN` | Slack bot token | - |

## Complete Example

```json title=".humancy/config.json"
{
  "version": "1.0",
  "defaults": {
    "reviewGate": {
      "timeout": "24h",
      "requiredApprovals": 1,
      "autoApproveOnTimeout": false,
      "notifyOnPending": true
    },
    "workflow": {
      "timeout": "7d",
      "retries": 3,
      "retryDelay": "5m"
    }
  },
  "workflows": "./workflows",
  "integrations": {
    "github": {
      "enabled": true,
      "features": {
        "prReviews": true,
        "issueComments": true,
        "checkRuns": true
      },
      "labels": {
        "pending": "awaiting-review",
        "approved": "approved",
        "rejected": "changes-requested"
      }
    },
    "slack": {
      "enabled": true,
      "defaultChannel": "#engineering-reviews",
      "webhookUrl": "$SLACK_WEBHOOK_URL",
      "mentions": {
        "onPending": true,
        "onRejected": true
      }
    }
  },
  "notifications": {
    "channels": {
      "slack": {
        "webhook": "$SLACK_WEBHOOK_URL"
      },
      "email": {
        "smtp": {
          "host": "smtp.company.com",
          "port": 587,
          "secure": true
        },
        "from": "reviews@company.com"
      }
    },
    "defaults": {
      "onPending": ["slack"],
      "onApproved": ["slack"],
      "onRejected": ["slack", "email"],
      "onTimeout": ["email"],
      "onEscalated": ["slack", "email"]
    }
  },
  "reviewers": {
    "teams": {
      "@leads": ["alice@company.com", "bob@company.com"],
      "@security": ["security@company.com"],
      "@frontend": ["fe-lead@company.com"],
      "@backend": ["be-lead@company.com"]
    },
    "escalation": {
      "after": "4h",
      "to": "@leads"
    }
  }
}
```
