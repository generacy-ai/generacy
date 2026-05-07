# Data Model: Cluster Image Build Workflows

This feature has no runtime data model — it consists of GitHub Actions workflow YAML configuration. This document describes the workflow input/output schemas and the tagging convention.

## Workflow Input Schema

Both workflows share the same input schema:

```yaml
inputs:
  ref:
    description: "Branch to build"
    type: choice
    options:
      - develop
      - main
    required: true
```

| Field | Type | Required | Values | Description |
|-------|------|----------|--------|-------------|
| `ref` | choice | yes | `develop`, `main` | Source branch to check out from the template repo |

## Tag Mapping

| Input `ref` | Channel tag | SHA tag | Full image reference |
|-------------|-------------|---------|---------------------|
| `develop` | `preview` | `sha-<7chars>` | `ghcr.io/generacy-ai/cluster-base:preview` |
| `main` | `stable` | `sha-<7chars>` | `ghcr.io/generacy-ai/cluster-base:stable` |

Same pattern for `cluster-microservices`.

## Image Registry Structure

```
ghcr.io/generacy-ai/
├── cluster-base
│   ├── :preview          # Latest develop build
│   ├── :stable           # Latest main build
│   └── :sha-<commit>     # Immutable per-build tag
└── cluster-microservices
    ├── :preview
    ├── :stable
    └── :sha-<commit>
```

## Downstream Consumers

These images are referenced by:

1. **CLI scaffolder** (`packages/generacy/src/cli/commands/cluster/scaffolder.ts`): Generates `docker-compose.yml` with the `imageTag` provided by the cloud API
2. **Cloud API** (`LaunchConfig.imageTag`): Returns the full image reference including registry and tag
3. **docker-compose.yml** in user clusters: `image: ghcr.io/generacy-ai/<variant>:<channel>`

## Validation Rules

- `ref` must be one of `develop` or `main` (enforced by GitHub Actions `choice` type)
- Channel tag must be one of `preview` or `stable`
- SHA tag format: `sha-` followed by exactly 7 hex characters (first 7 of commit SHA)
