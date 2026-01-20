---
sidebar_position: 3
---

# Generacy Configuration Reference

Complete reference for all Generacy orchestration configuration options.

## Configuration File

Generacy reads configuration from `generacy.config.json`:

```json title="generacy.config.json"
{
  "version": "1.0",
  "mode": "local",
  "environment": "development",
  "orchestrator": {},
  "queue": {},
  "workers": {},
  "storage": {},
  "integrations": {},
  "logging": {}
}
```

## version

**Type**: `string`
**Required**: Yes
**Example**: `"1.0"`

Configuration schema version.

## mode

**Type**: `"local" | "cloud" | "hybrid"`
**Default**: `"local"`

Operating mode:
- `local` - Single machine deployment
- `cloud` - Distributed cloud deployment
- `hybrid` - Mixed local/cloud

## environment

**Type**: `"development" | "staging" | "production"`
**Default**: `"development"`

Deployment environment.

## orchestrator

HTTP server configuration.

```json
{
  "orchestrator": {
    "port": 3000,
    "host": "0.0.0.0",
    "cors": {
      "enabled": true,
      "origins": ["*"],
      "methods": ["GET", "POST", "PUT", "DELETE"],
      "headers": ["Content-Type", "Authorization"]
    },
    "rateLimit": {
      "enabled": true,
      "requests": 1000,
      "window": "1m"
    },
    "auth": {
      "enabled": true,
      "type": "bearer",
      "secret": "$GENERACY_SECRET"
    }
  }
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `port` | number | 3000 | HTTP port |
| `host` | string | "0.0.0.0" | Bind address |
| `cors` | object | - | CORS configuration |
| `rateLimit` | object | - | Rate limiting |
| `auth` | object | - | Authentication |

## queue

Job queue configuration.

```json
{
  "queue": {
    "type": "redis",
    "redis": {
      "url": "redis://localhost:6379",
      "prefix": "generacy:",
      "tls": false
    },
    "defaults": {
      "attempts": 3,
      "backoff": {
        "type": "exponential",
        "delay": 1000
      },
      "timeout": "30m",
      "removeOnComplete": 100,
      "removeOnFail": 1000
    }
  }
}
```

### Queue Types

| Type | Description | Use Case |
|------|-------------|----------|
| `memory` | In-memory queue | Development |
| `redis` | Redis-backed queue | Production |
| `postgres` | PostgreSQL queue | Alternative |

### Redis Configuration

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `url` | string | - | Redis connection URL |
| `prefix` | string | "generacy:" | Key prefix |
| `tls` | boolean | false | Enable TLS |
| `maxRetriesPerRequest` | number | 3 | Max retries |

### Default Job Settings

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `attempts` | number | 3 | Retry attempts |
| `backoff.type` | string | "exponential" | Backoff strategy |
| `backoff.delay` | number | 1000 | Initial delay (ms) |
| `timeout` | string | "30m" | Job timeout |
| `removeOnComplete` | number | 100 | Keep completed jobs |
| `removeOnFail` | number | 1000 | Keep failed jobs |

## workers

Worker process configuration.

```json
{
  "workers": {
    "count": 4,
    "concurrency": 2,
    "types": ["default", "priority"],
    "resources": {
      "memory": "2GB",
      "cpu": 2
    },
    "healthCheck": {
      "enabled": true,
      "interval": "30s"
    }
  }
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `count` | number | 4 | Number of workers |
| `concurrency` | number | 2 | Jobs per worker |
| `types` | string[] | ["default"] | Worker types |
| `resources` | object | - | Resource limits |

## storage

Data storage configuration.

```json
{
  "storage": {
    "type": "postgres",
    "postgres": {
      "url": "$DATABASE_URL",
      "pool": {
        "min": 5,
        "max": 20
      },
      "ssl": true
    },
    "artifacts": {
      "type": "s3",
      "s3": {
        "bucket": "generacy-artifacts",
        "region": "us-east-1",
        "prefix": "artifacts/"
      }
    }
  }
}
```

### Storage Types

| Type | Description | Use Case |
|------|-------------|----------|
| `memory` | In-memory | Development |
| `sqlite` | SQLite database | Local/small |
| `postgres` | PostgreSQL | Production |

### Artifact Storage

| Type | Description |
|------|-------------|
| `local` | Local filesystem |
| `s3` | AWS S3 |
| `gcs` | Google Cloud Storage |

## integrations

External service integrations.

### github

```json
{
  "integrations": {
    "github": {
      "enabled": true,
      "auth": {
        "type": "app",
        "appId": "$GITHUB_APP_ID",
        "privateKey": "$GITHUB_PRIVATE_KEY",
        "installationId": "$GITHUB_INSTALLATION_ID"
      },
      "webhooks": {
        "enabled": true,
        "secret": "$GITHUB_WEBHOOK_SECRET",
        "events": ["issues", "pull_request", "push", "workflow_run"]
      }
    }
  }
}
```

### jira

```json
{
  "integrations": {
    "jira": {
      "enabled": true,
      "baseUrl": "https://company.atlassian.net",
      "auth": {
        "email": "$JIRA_EMAIL",
        "apiToken": "$JIRA_API_TOKEN"
      },
      "projects": ["PROJ1", "PROJ2"],
      "webhooks": {
        "enabled": true,
        "secret": "$JIRA_WEBHOOK_SECRET"
      }
    }
  }
}
```

### slack

```json
{
  "integrations": {
    "slack": {
      "enabled": true,
      "botToken": "$SLACK_BOT_TOKEN",
      "signingSecret": "$SLACK_SIGNING_SECRET",
      "channels": {
        "default": "#generacy",
        "alerts": "#generacy-alerts",
        "errors": "#generacy-errors"
      }
    }
  }
}
```

## logging

Logging configuration.

```json
{
  "logging": {
    "level": "info",
    "format": "json",
    "outputs": ["stdout", "file"],
    "file": {
      "path": "./logs/generacy.log",
      "maxSize": "10MB",
      "maxFiles": 5,
      "compress": true
    },
    "redact": ["password", "token", "secret", "apiKey"]
  }
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `level` | string | "info" | Log level |
| `format` | string | "json" | Output format |
| `outputs` | string[] | ["stdout"] | Output destinations |
| `file` | object | - | File output config |
| `redact` | string[] | - | Fields to redact |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `GENERACY_MODE` | Operating mode | `local` |
| `GENERACY_ENV` | Environment | `development` |
| `GENERACY_PORT` | HTTP port | `3000` |
| `GENERACY_SECRET` | Auth secret | - |
| `REDIS_URL` | Redis URL | - |
| `DATABASE_URL` | Database URL | - |
| `GITHUB_APP_ID` | GitHub App ID | - |
| `GITHUB_PRIVATE_KEY` | GitHub private key | - |
| `GITHUB_WEBHOOK_SECRET` | Webhook secret | - |

## Complete Example

```json title="generacy.config.json"
{
  "version": "1.0",
  "mode": "cloud",
  "environment": "production",
  "orchestrator": {
    "port": 3000,
    "host": "0.0.0.0",
    "cors": {
      "enabled": true,
      "origins": ["https://app.company.com"]
    },
    "rateLimit": {
      "enabled": true,
      "requests": 1000,
      "window": "1m"
    },
    "auth": {
      "enabled": true,
      "type": "bearer",
      "secret": "$GENERACY_SECRET"
    }
  },
  "queue": {
    "type": "redis",
    "redis": {
      "url": "$REDIS_URL",
      "tls": true
    },
    "defaults": {
      "attempts": 3,
      "timeout": "30m"
    }
  },
  "workers": {
    "count": 10,
    "concurrency": 5,
    "types": ["default", "priority"],
    "resources": {
      "memory": "4GB",
      "cpu": 4
    }
  },
  "storage": {
    "type": "postgres",
    "postgres": {
      "url": "$DATABASE_URL",
      "pool": { "min": 10, "max": 50 },
      "ssl": true
    },
    "artifacts": {
      "type": "s3",
      "s3": {
        "bucket": "company-generacy",
        "region": "us-east-1"
      }
    }
  },
  "integrations": {
    "github": {
      "enabled": true,
      "auth": {
        "type": "app",
        "appId": "$GITHUB_APP_ID",
        "privateKey": "$GITHUB_PRIVATE_KEY"
      },
      "webhooks": {
        "enabled": true,
        "secret": "$GITHUB_WEBHOOK_SECRET"
      }
    },
    "slack": {
      "enabled": true,
      "botToken": "$SLACK_BOT_TOKEN",
      "signingSecret": "$SLACK_SIGNING_SECRET",
      "channels": {
        "default": "#engineering",
        "alerts": "#engineering-alerts"
      }
    }
  },
  "logging": {
    "level": "info",
    "format": "json",
    "outputs": ["stdout"],
    "redact": ["password", "token", "secret"]
  }
}
```
