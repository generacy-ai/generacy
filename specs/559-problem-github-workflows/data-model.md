# Data Model: Auto-publish cluster images on push

## Core Entities

### Matrix Entry

Each poll cycle checks 4 (repo, branch) tuples. The matrix is the primary "data model" for this workflow.

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `repo` | string | Target repository name | `cluster-base` |
| `branch` | string | Branch to monitor | `develop` |
| `image` | string | GHCR image name | `cluster-base` |
| `workflow` | string | Publish workflow filename | `publish-cluster-base-image.yml` |

### Matrix Values

```yaml
matrix:
  include:
    - { repo: cluster-base, branch: develop, image: cluster-base, workflow: publish-cluster-base-image.yml }
    - { repo: cluster-base, branch: main, image: cluster-base, workflow: publish-cluster-base-image.yml }
    - { repo: cluster-microservices, branch: develop, image: cluster-microservices, workflow: publish-cluster-microservices-image.yml }
    - { repo: cluster-microservices, branch: main, image: cluster-microservices, workflow: publish-cluster-microservices-image.yml }
```

## GHCR Tag Convention

The existing publish workflows produce two tags per build:

| Tag Pattern | Derivation | Purpose |
|------------|------------|---------|
| `:preview` | develop branch | Mutable channel tag |
| `:stable` | main branch | Mutable channel tag |
| `:sha-<7chars>` | `git rev-parse --short=7 HEAD` | Immutable build identifier |

The poll workflow uses the `:sha-<7chars>` tag as the deduplication key.

### Branch-to-Channel Mapping

| Branch | Channel Tag | Published By |
|--------|------------|-------------|
| `develop` | `:preview` | Publish workflow |
| `main` | `:stable` | Publish workflow |

## API Response Shapes

### Commit SHA Query

```
GET /repos/generacy-ai/{repo}/commits/{branch}
```

Response (relevant field):
```json
{
  "sha": "abc1234567890abcdef1234567890abcdef123456"
}
```

Truncated to 7 chars: `abc1234`

### GHCR Package Versions Query

```
GET /orgs/generacy-ai/packages/container/{image}/versions
```

Response (relevant fields):
```json
[
  {
    "id": 12345,
    "metadata": {
      "container": {
        "tags": ["preview", "sha-abc1234"]
      }
    }
  },
  {
    "id": 12344,
    "metadata": {
      "container": {
        "tags": ["sha-def5678"]
      }
    }
  }
]
```

The poll workflow checks if `sha-{HEAD_SHA}` appears in any version's tags array.

## State Machine

The poll workflow has no persistent state. Each run is stateless:

```
[Cron Trigger] --> [Query HEAD SHA] --> [Query GHCR Tags] --> {SHA in tags?}
                                                                |         |
                                                               YES        NO
                                                                |         |
                                                            [Skip]   [Dispatch]
```

Self-healing: if a dispatch fails or a build fails, the next poll cycle will detect the missing tag and re-dispatch.

## Concurrency Keys

| Matrix Entry | Concurrency Group |
|-------------|-------------------|
| cluster-base / develop | `poll-cluster-cluster-base-develop` |
| cluster-base / main | `poll-cluster-cluster-base-main` |
| cluster-microservices / develop | `poll-cluster-cluster-microservices-develop` |
| cluster-microservices / main | `poll-cluster-cluster-microservices-main` |
