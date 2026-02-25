# Data Model: .generacy/config.yaml Schema

**Feature:** 4.2 — Define .generacy/config.yaml schema
**Version:** 1.0 (Schema Version "1")

## Overview

This document defines the complete data model for the `.generacy/config.yaml` configuration file. The schema uses TypeScript types (inferred from Zod schemas) and YAML examples for clarity.

## Root Schema: GeneracyConfig

The root configuration object for a Generacy project.

### TypeScript Definition

```typescript
interface GeneracyConfig {
  /** Schema version for future migration support (optional, defaults to "1") */
  schemaVersion?: string;

  /** Project metadata linking to generacy.ai */
  project: ProjectConfig;

  /** Repository configuration */
  repos: ReposConfig;

  /** Workflow defaults (optional) */
  defaults?: DefaultsConfig;

  /** Orchestrator settings (optional) */
  orchestrator?: OrchestratorSettings;
}
```

### YAML Example

```yaml
schemaVersion: "1"
project:
  id: "proj_abc123xyz"
  name: "My Project"
repos:
  primary: "github.com/acme/main-api"
  dev:
    - "github.com/acme/shared-lib"
  clone:
    - "github.com/acme/design-system"
defaults:
  agent: claude-code
  baseBranch: main
orchestrator:
  pollIntervalMs: 5000
  workerCount: 3
```

### Validation Rules

| Field | Required | Default | Validation |
|-------|----------|---------|------------|
| `schemaVersion` | No | `"1"` | Must be string "1" if present |
| `project` | Yes | - | Must be valid ProjectConfig |
| `repos` | Yes | - | Must be valid ReposConfig |
| `defaults` | No | - | Must be valid DefaultsConfig if present |
| `orchestrator` | No | - | Must be valid OrchestratorSettings if present |

---

## ProjectConfig

Project metadata for identification on generacy.ai platform.

### TypeScript Definition

```typescript
interface ProjectConfig {
  /** Unique project identifier issued by generacy.ai */
  id: string;

  /** Human-readable project name */
  name: string;
}
```

### YAML Example

```yaml
project:
  id: "proj_abc123xyz"
  name: "My Awesome Project"
```

### Validation Rules

| Field | Required | Constraints | Error Message |
|-------|----------|-------------|---------------|
| `id` | Yes | Regex: `/^proj_[a-z0-9]+$/`<br>Min length: 12 chars | "Project ID must start with 'proj_' followed by at least 8 alphanumeric characters" |
| `name` | Yes | Non-empty string<br>Max length: 255 chars | "Project name must be between 1 and 255 characters" |

### Notes

- **Project ID**: Server-issued by generacy.ai during project creation (Q1)
- **Project Name**: Not required to be unique; ID handles uniqueness (Q11)
- **Format**: Follows SaaS convention (similar to Stripe's `cus_`, `sub_` prefixes)

---

## ReposConfig

Repository relationships defining primary, development, and reference repositories.

### TypeScript Definition

```typescript
interface ReposConfig {
  /** Primary repository (where this config lives) */
  primary: string;

  /** Development repositories (cloned for active development) */
  dev?: string[];

  /** Clone-only repositories (cloned as read-only reference) */
  clone?: string[];
}
```

### YAML Examples

**Single-Repo Project:**
```yaml
repos:
  primary: "github.com/acme/main-api"
```

**Multi-Repo Project:**
```yaml
repos:
  primary: "github.com/acme/main-api"
  dev:
    - "github.com/acme/shared-lib"
    - "github.com/acme/worker-service"
  clone:
    - "github.com/acme/design-system"
    - "github.com/public/api-docs"
```

**Omitted vs Empty Arrays:**
```yaml
# These are equivalent (Q14)
repos:
  primary: "github.com/acme/api"
  # dev field omitted

repos:
  primary: "github.com/acme/api"
  dev: []  # explicit empty array
```

### Validation Rules

| Field | Required | Constraints | Error Message |
|-------|----------|-------------|---------------|
| `primary` | Yes | Format: `github.com/{owner}/{repo}`<br>Regex: `/^github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/` | "Primary repository must be in format 'github.com/owner/repo'" |
| `dev` | No | Array of repository URLs<br>Same format as `primary` | "Each dev repository must be in format 'github.com/owner/repo'" |
| `clone` | No | Array of repository URLs<br>Same format as `primary` | "Each clone repository must be in format 'github.com/owner/repo'" |

### Custom Validation

**Repository Deduplication (Q6):**
- A repository MUST NOT appear in more than one list (primary, dev, clone)
- Validation error if duplicates detected

```typescript
// Pseudo-code validation
function validateNoDuplicateRepos(repos: ReposConfig): void {
  const allRepos = [
    repos.primary,
    ...(repos.dev || []),
    ...(repos.clone || [])
  ];

  const duplicates = findDuplicates(allRepos);
  if (duplicates.length > 0) {
    throw new ValidationError(
      `Repository appears in multiple lists: ${duplicates.join(', ')}`
    );
  }
}
```

### Notes

- **Format**: No protocol (`https://` or `git@`), no `.git` suffix (Q2, Q4)
- **Authentication**: Handled at runtime, not in config (Q2)
- **Primary Repository**: Always self-reference (config lives in primary repo) (Q3)
- **Empty Arrays**: Omitted field equals empty array `[]` (Q14)
- **Order**: No semantic meaning, preserved for display only (Q9)
- **Accessibility**: Not validated at config load time (Q13)

---

## DefaultsConfig

Default settings for workflow execution.

### TypeScript Definition

```typescript
interface DefaultsConfig {
  /** Default agent to use for workflow execution */
  agent?: string;

  /** Default base branch for pull requests */
  baseBranch?: string;
}
```

### YAML Example

```yaml
defaults:
  agent: claude-code
  baseBranch: main
```

### Validation Rules

| Field | Required | Default | Constraints | Error Message |
|-------|----------|---------|-------------|---------------|
| `agent` | No | `"claude-code"` | Kebab-case format<br>Regex: `/^[a-z0-9]+(-[a-z0-9]+)*$/` | "Agent name must be kebab-case (lowercase alphanumeric with hyphens)" |
| `baseBranch` | No | `"main"` | Non-empty string | "Base branch cannot be empty" |

### Valid Agent Names

**Built-in Agents:**
- `claude-code`
- `claude-opus`
- `claude-sonnet`
- `claude-haiku`

**Custom Agents:**
- Any kebab-case string (e.g., `custom-agent-v2`, `gpt-4-turbo`)

### Notes

- **Agent Validation**: Format-only, no registry check (Q4)
- **Base Branch**: String reference only, existence not validated (Q5)
- **Rationale**: Config may be created before branch exists
- **Runtime Validation**: Branch existence checked at PR creation time

---

## OrchestratorSettings

Runtime settings for the orchestrator service.

### TypeScript Definition

```typescript
interface OrchestratorSettings {
  /** Polling interval for workflow queue in milliseconds */
  pollIntervalMs?: number;

  /** Maximum number of concurrent workers */
  workerCount?: number;
}
```

### YAML Example

```yaml
orchestrator:
  pollIntervalMs: 5000
  workerCount: 3
```

### Validation Rules

| Field | Required | Default | Constraints | Error Message |
|-------|----------|---------|-------------|---------------|
| `pollIntervalMs` | No | `5000` | Integer<br>Min: 5000 (5 seconds)<br>Max: 300000 (5 minutes) | "Poll interval must be between 5000 and 300000 milliseconds" |
| `workerCount` | No | `3` | Integer<br>Min: 1<br>Max: 20 | "Worker count must be between 1 and 20" |

### Notes

- **Scope**: Applies to entire project (Q10)
- **Environment Overrides**: Production deployments override via env vars (Q10)
  - `ORCHESTRATOR_POLL_INTERVAL_MS`
  - `ORCHESTRATOR_MAX_CONCURRENT_WORKERS`
- **Development Defaults**: Config provides sensible development defaults
- **No Hot-Reload**: Changes require orchestrator restart (Q7)

---

## Complete Schema Examples

### Minimal Configuration

The absolute minimum required configuration:

```yaml
project:
  id: "proj_minimum123"
  name: "Minimal Project"
repos:
  primary: "github.com/acme/solo-repo"
```

**Defaults Applied:**
- `schemaVersion`: `"1"`
- `defaults.agent`: `"claude-code"`
- `defaults.baseBranch`: `"main"`
- `orchestrator.pollIntervalMs`: `5000`
- `orchestrator.workerCount`: `3`

### Single-Repo Project

Project with no additional repositories:

```yaml
schemaVersion: "1"
project:
  id: "proj_single123"
  name: "Single Repo Project"
repos:
  primary: "github.com/acme/monolith"
defaults:
  agent: claude-code
  baseBranch: develop
orchestrator:
  pollIntervalMs: 10000
  workerCount: 5
```

### Multi-Repo Project

Project with development and reference repositories:

```yaml
schemaVersion: "1"
project:
  id: "proj_multi456"
  name: "Multi-Repo Microservices"
repos:
  primary: "github.com/acme/api-gateway"
  dev:
    - "github.com/acme/auth-service"
    - "github.com/acme/payment-service"
    - "github.com/acme/shared-types"
  clone:
    - "github.com/acme/ui-components"
    - "github.com/acme/documentation"
    - "github.com/public/industry-standards"
defaults:
  agent: claude-opus
  baseBranch: main
orchestrator:
  pollIntervalMs: 5000
  workerCount: 3
```

### Monorepo Project

Monorepo with single root config (Q8):

```yaml
schemaVersion: "1"
project:
  id: "proj_monorepo789"
  name: "Enterprise Monorepo"
repos:
  primary: "github.com/enterprise/monorepo"
  clone:
    - "github.com/enterprise/design-system"
    - "github.com/external/reference-impl"
defaults:
  agent: claude-code
  baseBranch: main
orchestrator:
  pollIntervalMs: 8000
  workerCount: 4
```

---

## Validation Error Examples

### Invalid Project ID

```yaml
project:
  id: "invalid-id"  # Missing 'proj_' prefix
  name: "Test"
```

**Error:**
```
Validation error at project.id: Project ID must start with 'proj_' followed by at least 8 alphanumeric characters
Received: "invalid-id"
Expected: /^proj_[a-z0-9]+$/ with min length 12
```

### Duplicate Repository

```yaml
repos:
  primary: "github.com/acme/main"
  dev:
    - "github.com/acme/lib"
  clone:
    - "github.com/acme/lib"  # Duplicate!
```

**Error:**
```
Validation error: Repository appears in multiple lists: github.com/acme/lib
A repository cannot be in both 'dev' and 'clone' lists.
```

### Invalid Agent Name

```yaml
defaults:
  agent: "Claude Code"  # Spaces not allowed
```

**Error:**
```
Validation error at defaults.agent: Agent name must be kebab-case (lowercase alphanumeric with hyphens)
Received: "Claude Code"
Expected: /^[a-z0-9]+(-[a-z0-9]+)*$/
Valid examples: claude-code, custom-agent-v2
```

### Invalid Repository Format

```yaml
repos:
  primary: "https://github.com/acme/repo"  # Protocol not allowed
```

**Error:**
```
Validation error at repos.primary: Repository must be in format 'github.com/owner/repo'
Received: "https://github.com/acme/repo"
Do not include protocol (https://) or .git suffix
```

### Out of Range Poll Interval

```yaml
orchestrator:
  pollIntervalMs: 2000  # Too low
```

**Error:**
```
Validation error at orchestrator.pollIntervalMs: Poll interval must be between 5000 and 300000 milliseconds
Received: 2000
Minimum interval is 5 seconds to avoid excessive API calls
```

---

## Schema Version Management

### Version Field

```yaml
schemaVersion: "1"
```

- **Optional**: Defaults to `"1"` if omitted (Q12)
- **Future-Proofing**: Enables migration detection for v2+
- **Generated Configs**: Always include explicitly
- **Manual Configs**: Work without it (backward compatible)

### Future Migration Path

When schema v2 is released:

1. Loader detects `schemaVersion` field
2. If `"1"` or omitted: Use v1 parser
3. If `"2"`: Use v2 parser
4. CLI command: `generacy config migrate` to upgrade

---

## Type Exports

### Import Path

```typescript
import {
  GeneracyConfig,
  ProjectConfig,
  ReposConfig,
  DefaultsConfig,
  OrchestratorSettings,
  loadConfig,
  validateConfig
} from '@generacy-ai/generacy/config';
```

### Consumer Examples

**Orchestrator Integration:**
```typescript
import { GeneracyConfig } from '@generacy-ai/generacy/config';

function initOrchestrator(config: GeneracyConfig) {
  const settings = config.orchestrator || {};
  return new Orchestrator({
    pollIntervalMs: settings.pollIntervalMs || 5000,
    maxWorkers: settings.workerCount || 3
  });
}
```

**VS Code Extension:**
```typescript
import { loadConfig } from '@generacy-ai/generacy/config';

async function getProjectName(): Promise<string> {
  try {
    const config = loadConfig();
    return config.project.name;
  } catch (error) {
    vscode.window.showErrorMessage('No Generacy config found');
    throw error;
  }
}
```

**generacy-cloud Server:**
```typescript
import { validateConfig } from '@generacy-ai/generacy/config';

app.post('/api/projects/:id/config', async (req, res) => {
  try {
    const config = validateConfig(req.body);
    await saveProjectConfig(req.params.id, config);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
```

---

## Implementation Notes

### Zod Schema Structure

```typescript
import { z } from 'zod';

// Project ID validation (Q1)
const PROJECT_ID_REGEX = /^proj_[a-z0-9]+$/;

export const ProjectConfigSchema = z.object({
  id: z.string()
    .regex(PROJECT_ID_REGEX, "Project ID must start with 'proj_' followed by alphanumeric characters")
    .min(12, "Project ID must be at least 12 characters"),
  name: z.string()
    .min(1, "Project name cannot be empty")
    .max(255, "Project name must be under 255 characters")
});

// Repository URL validation (Q2, Q13)
const REPO_URL_REGEX = /^github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/;

export const ReposConfigSchema = z.object({
  primary: z.string()
    .regex(REPO_URL_REGEX, "Repository must be in format 'github.com/owner/repo'"),
  dev: z.array(
    z.string().regex(REPO_URL_REGEX)
  ).optional(),
  clone: z.array(
    z.string().regex(REPO_URL_REGEX)
  ).optional()
});

// Agent name validation (Q4)
const AGENT_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const DefaultsConfigSchema = z.object({
  agent: z.string()
    .regex(AGENT_NAME_REGEX, "Agent name must be kebab-case")
    .optional()
    .default("claude-code"),
  baseBranch: z.string()
    .min(1, "Base branch cannot be empty")
    .optional()
    .default("main")
});

// Orchestrator settings
export const OrchestratorSettingsSchema = z.object({
  pollIntervalMs: z.number()
    .int()
    .min(5000, "Poll interval must be at least 5000ms")
    .max(300000, "Poll interval must be under 300000ms")
    .optional()
    .default(5000),
  workerCount: z.number()
    .int()
    .min(1, "Worker count must be at least 1")
    .max(20, "Worker count must be under 20")
    .optional()
    .default(3)
});

// Root schema
export const GeneracyConfigSchema = z.object({
  schemaVersion: z.string()
    .optional()
    .default("1"),
  project: ProjectConfigSchema,
  repos: ReposConfigSchema,
  defaults: DefaultsConfigSchema.optional(),
  orchestrator: OrchestratorSettingsSchema.optional()
});

export type GeneracyConfig = z.infer<typeof GeneracyConfigSchema>;
```

### Custom Deduplication Validator

```typescript
export function validateNoDuplicateRepos(config: GeneracyConfig): void {
  const allRepos = [
    config.repos.primary,
    ...(config.repos.dev || []),
    ...(config.repos.clone || [])
  ];

  const seen = new Set<string>();
  const duplicates: string[] = [];

  for (const repo of allRepos) {
    if (seen.has(repo)) {
      duplicates.push(repo);
    }
    seen.add(repo);
  }

  if (duplicates.length > 0) {
    throw new Error(
      `Repository appears in multiple lists: ${duplicates.join(', ')}\n` +
      `A repository cannot be in both 'dev' and 'clone' lists.`
    );
  }
}
```

---

## References

- [Implementation Plan](./plan.md)
- [Clarifications Q1-Q15](./clarifications.md)
- Zod Documentation: https://zod.dev/
- YAML Specification: https://yaml.org/spec/1.2.2/
