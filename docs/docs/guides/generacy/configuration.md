---
sidebar_position: 2
---

# Generacy Configuration

This guide covers all configuration options for Generacy orchestration.

## Configuration File

Generacy is configured via `generacy.config.json` or environment variables:

```json title="generacy.config.json"
{
  "version": "1.0",
  "mode": "local",
  "orchestrator": {
    "port": 3000
  },
  "queue": {
    "type": "redis",
    "redis": {
      "url": "redis://localhost:6379"
    }
  },
  "workers": {
    "count": 4
  },
  "integrations": {}
}
```

## Configuration Options

### Mode Settings

```json
{
  "mode": "local",           // local, cloud, hybrid
  "environment": "development"  // development, staging, production
}
```

### Orchestrator Settings

```json
{
  "orchestrator": {
    "port": 3000,            // HTTP port
    "host": "0.0.0.0",       // Bind address
    "cors": {
      "origins": ["*"]       // CORS origins
    },
    "rateLimit": {
      "enabled": true,
      "requests": 100,       // Requests per window
      "window": "1m"         // Time window
    }
  }
}
```

### Queue Settings

```json
{
  "queue": {
    "type": "redis",         // redis, memory, postgres
    "redis": {
      "url": "redis://localhost:6379",
      "prefix": "generacy:"
    },
    "defaults": {
      "attempts": 3,         // Retry attempts
      "backoff": {
        "type": "exponential",
        "delay": 1000        // Initial delay (ms)
      },
      "timeout": "30m"       // Job timeout
    }
  }
}
```

### Worker Settings

```json
{
  "workers": {
    "count": 4,              // Number of workers
    "concurrency": 2,        // Jobs per worker
    "types": ["default", "priority"],  // Worker types
    "resources": {
      "memory": "2GB",       // Memory limit
      "cpu": 2               // CPU limit
    }
  }
}
```

### Integrations

#### GitHub Integration

```json
{
  "integrations": {
    "github": {
      "enabled": true,
      "auth": {
        "type": "app",       // app, token
        "appId": "$GITHUB_APP_ID",
        "privateKey": "$GITHUB_PRIVATE_KEY"
      },
      "webhooks": {
        "secret": "$GITHUB_WEBHOOK_SECRET",
        "events": ["issues", "pull_request", "push"]
      }
    }
  }
}
```

#### Jira Integration

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
      "projects": ["PROJ1", "PROJ2"]
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
      "botToken": "$SLACK_BOT_TOKEN",
      "signingSecret": "$SLACK_SIGNING_SECRET",
      "channels": {
        "default": "#generacy",
        "alerts": "#generacy-alerts"
      }
    }
  }
}
```

### Storage Settings

```json
{
  "storage": {
    "type": "postgres",      // postgres, sqlite, memory
    "postgres": {
      "url": "$DATABASE_URL"
    },
    "artifacts": {
      "type": "s3",          // s3, local, gcs
      "s3": {
        "bucket": "generacy-artifacts",
        "region": "us-east-1"
      }
    }
  }
}
```

### Logging Settings

```json
{
  "logging": {
    "level": "info",         // debug, info, warn, error
    "format": "json",        // json, pretty
    "outputs": ["stdout", "file"],
    "file": {
      "path": "./logs/generacy.log",
      "maxSize": "10MB",
      "maxFiles": 5
    }
  }
}
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `GENERACY_MODE` | Operating mode | `local` |
| `GENERACY_PORT` | HTTP port | `3000` |
| `REDIS_URL` | Redis connection URL | - |
| `DATABASE_URL` | Database connection URL | - |
| `GITHUB_APP_ID` | GitHub App ID | - |
| `GITHUB_PRIVATE_KEY` | GitHub App private key | - |
| `GITHUB_WEBHOOK_SECRET` | Webhook secret | - |

## Docker Configuration

### Docker Compose (Local)

```yaml title="docker-compose.yml"
version: '3.8'
services:
  orchestrator:
    image: generacy/orchestrator:latest
    ports:
      - "3000:3000"
    environment:
      - REDIS_URL=redis://redis:6379
      - DATABASE_URL=postgres://postgres:5432/generacy
    depends_on:
      - redis
      - postgres

  worker:
    image: generacy/worker:latest
    environment:
      - REDIS_URL=redis://redis:6379
    deploy:
      replicas: 4

  redis:
    image: redis:7-alpine

  postgres:
    image: postgres:15-alpine
    environment:
      - POSTGRES_DB=generacy
```

### Kubernetes (Cloud)

```yaml title="k8s/deployment.yaml"
apiVersion: apps/v1
kind: Deployment
metadata:
  name: generacy-orchestrator
spec:
  replicas: 2
  selector:
    matchLabels:
      app: generacy-orchestrator
  template:
    spec:
      containers:
        - name: orchestrator
          image: generacy/orchestrator:latest
          ports:
            - containerPort: 3000
          envFrom:
            - secretRef:
                name: generacy-secrets
```

## Examples

### Local Development

```json title="generacy.config.json"
{
  "version": "1.0",
  "mode": "local",
  "queue": {
    "type": "memory"
  },
  "workers": {
    "count": 2
  },
  "storage": {
    "type": "sqlite",
    "sqlite": {
      "path": "./data/generacy.db"
    }
  }
}
```

### Production

```json title="generacy.config.json"
{
  "version": "1.0",
  "mode": "cloud",
  "environment": "production",
  "orchestrator": {
    "port": 3000,
    "rateLimit": {
      "enabled": true,
      "requests": 1000,
      "window": "1m"
    }
  },
  "queue": {
    "type": "redis",
    "redis": {
      "url": "$REDIS_URL",
      "tls": true
    }
  },
  "workers": {
    "count": 10,
    "concurrency": 5
  },
  "storage": {
    "type": "postgres",
    "postgres": {
      "url": "$DATABASE_URL",
      "pool": {
        "min": 5,
        "max": 20
      }
    }
  },
  "integrations": {
    "github": {
      "enabled": true
    },
    "slack": {
      "enabled": true
    }
  },
  "logging": {
    "level": "info",
    "format": "json"
  }
}
```

## Validation

Validate configuration:

```bash
generacy config validate
```

Show effective configuration:

```bash
generacy config show
```

## Next Steps

- [Generacy Overview](/docs/guides/generacy/overview)
- [API Reference](/docs/reference/api)
- [Architecture](/docs/architecture/overview)
