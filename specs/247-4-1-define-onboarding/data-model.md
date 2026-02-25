# Data Model: Onboarding Templates

## Template Variable Schema

Variables passed to Handlebars templates during PR generation or `generacy init`.

### Top-Level Context

```typescript
interface TemplateContext {
  project: ProjectContext;
  repos: ReposContext;
  defaults: DefaultsContext;
  orchestrator: OrchestratorContext;
  devcontainer: DevContainerContext;
  metadata: MetadataContext;
}
```

### Project Context

```typescript
interface ProjectContext {
  id: string;              // e.g., "proj_abc123"
  name: string;            // e.g., "My Project"
}
```

### Repos Context

```typescript
interface ReposContext {
  primary: string;         // Shorthand: "owner/repo"
  dev: string[];           // Array of "owner/repo" strings
  clone: string[];         // Array of "owner/repo" strings

  // Helper flags (computed)
  hasDevRepos: boolean;
  hasCloneRepos: boolean;
  isMultiRepo: boolean;    // true if dev.length > 0
}
```

### Defaults Context

```typescript
interface DefaultsContext {
  agent: string;           // "claude-code" (default)
  baseBranch: string;      // "main" or "develop" (from repo default)
  releaseStream: "stable" | "preview";  // Determines feature tag
}
```

### Orchestrator Context

```typescript
interface OrchestratorContext {
  pollIntervalMs: number;  // Default: 5000
  workerCount: number;     // Default: 3 (multi-repo), 0 (single-repo)
}
```

### DevContainer Context

```typescript
interface DevContainerContext {
  baseImage: string;       // Default: "mcr.microsoft.com/devcontainers/base:ubuntu"
  featureTag: string;      // ":1" (stable) or ":preview"
}
```

### Metadata Context

```typescript
interface MetadataContext {
  timestamp: string;       // ISO 8601 UTC: "2026-02-24T15:30:00Z"
  generatedBy: string;     // "generacy-cloud" or "generacy-cli"
  version: string;         // Template schema version: "1.0.0"
}
```

---

## Template File Schema

Templates are organized by project type and file location.

### Directory Structure

```
packages/templates/
├── package.json
├── src/
│   ├── index.ts                    # Template rendering API
│   ├── schema.ts                   # TypeScript types for context
│   ├── shared/                     # Files used by both types
│   │   ├── config.yaml.hbs
│   │   ├── generacy.env.template.hbs
│   │   ├── extensions.json.hbs
│   │   └── .gitignore
│   ├── single-repo/
│   │   └── devcontainer.json.hbs
│   └── multi-repo/
│       ├── devcontainer.json.hbs
│       └── docker-compose.yml.hbs
└── README.md
```

### Template Metadata

Each template can optionally include front matter for validation:

```yaml
---
# Template metadata (stripped before rendering)
schema_version: "1.0.0"
target_path: ".generacy/config.yaml"
required_context:
  - project.id
  - project.name
  - repos.primary
---
```

---

## Generated File Paths

Mapping of templates to target file paths in user's repo:

| Template | Target Path | Condition |
|----------|-------------|-----------|
| `shared/config.yaml.hbs` | `.generacy/config.yaml` | Always |
| `shared/generacy.env.template.hbs` | `.generacy/generacy.env.template` | Always |
| `shared/.gitignore` | `.generacy/.gitignore` | Always |
| `shared/extensions.json.hbs` | `.vscode/extensions.json` | Always (merge) |
| `single-repo/devcontainer.json.hbs` | `.devcontainer/devcontainer.json` | `!repos.isMultiRepo` |
| `multi-repo/devcontainer.json.hbs` | `.devcontainer/devcontainer.json` | `repos.isMultiRepo` |
| `multi-repo/docker-compose.yml.hbs` | `.devcontainer/docker-compose.yml` | `repos.isMultiRepo` |

---

## Config.yaml Output Schema

The rendered `.generacy/config.yaml` follows this schema:

```yaml
# .generacy/config.yaml
# Generated: {{metadata.timestamp}}
# Schema version: {{metadata.version}}

project:
  id: "{{project.id}}"
  name: "{{project.name}}"

repos:
  primary: "{{repos.primary}}"
  {{#if repos.hasDevRepos}}
  dev:
    {{#each repos.dev}}
    - "{{this}}"
    {{/each}}
  {{/if}}
  {{#if repos.hasCloneRepos}}
  clone:
    {{#each repos.clone}}
    - "{{this}}"
    {{/each}}
  {{/if}}

defaults:
  agent: "{{defaults.agent}}"
  baseBranch: "{{defaults.baseBranch}}"

{{#if repos.isMultiRepo}}
orchestrator:
  pollIntervalMs: {{orchestrator.pollIntervalMs}}
  workerCount: {{orchestrator.workerCount}}
{{/if}}
```

---

## Extensions.json Merge Logic

When `.vscode/extensions.json` exists, use smart merge:

```typescript
interface ExtensionsJson {
  recommendations: string[];
  unwantedRecommendations?: string[];
}

const GENERACY_EXTENSIONS = [
  "generacy-ai.agency",
  "generacy-ai.generacy"
];

function mergeExtensions(existing: ExtensionsJson | null): ExtensionsJson {
  if (!existing) {
    return {
      recommendations: GENERACY_EXTENSIONS
    };
  }

  const merged = {
    ...existing,
    recommendations: [
      ...new Set([
        ...(existing.recommendations || []),
        ...GENERACY_EXTENSIONS
      ])
    ]
  };

  return merged;
}
```

---

## Template Versioning

Templates are versioned with the `@generacy-ai/templates` npm package:

- **Preview stream**: `@generacy-ai/templates@1.0.0-preview.20260224`
- **Stable stream**: `@generacy-ai/templates@1.0.0`

Each template includes a `schema_version` in metadata for forward compatibility. If config schema changes, older templates can be migrated automatically.

### Migration Strategy

```typescript
interface TemplateMigration {
  fromVersion: string;
  toVersion: string;
  migrate: (oldContext: any) => TemplateContext;
}

// Example: Migrating from 0.9.0 to 1.0.0
const migrations: TemplateMigration[] = [
  {
    fromVersion: "0.9.0",
    toVersion: "1.0.0",
    migrate: (old) => ({
      ...old,
      defaults: {
        ...old.defaults,
        releaseStream: "stable" // New field in 1.0.0
      }
    })
  }
];
```
