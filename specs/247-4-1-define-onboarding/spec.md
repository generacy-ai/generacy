# Feature Specification: Define Onboarding PR Template Content

**Branch**: `247-4-1-define-onboarding` | **Date**: 2026-02-24 | **Status**: Draft

## Summary

This feature defines the template file structure, content, and variable substitution system for onboarding PRs that automatically configure new developer projects with Generacy. When a user creates a project via generacy.ai, the system generates a PR to their primary repository containing `.generacy/` configuration, `.devcontainer/` setup with the Generacy Dev Container Feature, and VS Code extension recommendations. The templates must support both single-repo and multi-repo project architectures while remaining language-agnostic to work with any technology stack.

## User Stories

### US1: Define Configuration Files

**As a** Generacy platform developer,
**I want** to define the exact file structure and content that onboarding PRs will add to user repositories,
**So that** the PR generation service (Epic 4.3) can create consistent, valid configurations for all project types.

**Acceptance Criteria**:
- [ ] `.generacy/config.yaml` template defined with project ID, repo list, and settings placeholders
- [ ] `.generacy/generacy.env.template` defined with required environment variables (GitHub token, Anthropic API key, optional Generacy API key)
- [ ] `.devcontainer/devcontainer.json` template defined referencing the Generacy Dev Container Feature
- [ ] `.devcontainer/docker-compose.yml` template defined for multi-repo projects with orchestrator + workers
- [ ] `.vscode/extensions.json` template defined recommending Agency and Generacy VS Code extensions
- [ ] All templates are valid JSON/YAML with correct syntax

### US2: Support Variable Substitution

**As a** Generacy platform developer,
**I want** template files to support variable substitution for project-specific values,
**So that** each generated PR is customized for the user's specific project configuration.

**Acceptance Criteria**:
- [ ] Variable syntax defined (e.g., `{{project.id}}`, `{{project.name}}`, `{{repos.primary}}`)
- [ ] List of all supported template variables documented
- [ ] Variable substitution preserves valid YAML/JSON structure after replacement
- [ ] Multi-value variables supported (e.g., lists of dev repos, clone-only repos)
- [ ] Conditional content supported (e.g., docker-compose.yml only for multi-repo projects)

### US3: Single-Repo vs Multi-Repo Variants

**As a** developer adopting Generacy for a simple single-repo project,
**I want** the onboarding PR to include only the necessary files for single-repo setup,
**So that** I don't have unnecessary complexity in my configuration.

**As a** developer adopting Generacy for a multi-repo project,
**I want** the onboarding PR to include docker-compose configuration for orchestrator and workers,
**So that** my dev container can clone and work across multiple repositories.

**Acceptance Criteria**:
- [ ] Single-repo template variant defined (no docker-compose, simpler devcontainer.json)
- [ ] Multi-repo template variant defined (includes docker-compose.yml with orchestrator + workers)
- [ ] Logic defined for choosing between variants based on project configuration
- [ ] Both variants produce functional dev container setups
- [ ] Dev repos and clone-only repos correctly referenced in multi-repo variant

### US4: Language-Agnostic Base Templates

**As a** developer using Generacy with a Python/JavaScript/Java/Go/etc. project,
**I want** the onboarding PR to work with my existing tech stack,
**So that** I can use Generacy regardless of my programming language.

**Acceptance Criteria**:
- [ ] Templates do not assume a specific programming language
- [ ] Base image reference in devcontainer.json is configurable or uses universal base (e.g., Ubuntu)
- [ ] Language-specific features can be added via standard Dev Container features
- [ ] Documentation explains how to customize for specific languages
- [ ] Templates work with official Microsoft Dev Container base images (Python, Node, Java, .NET, etc.)

### US5: Valid PR Content

**As a** developer receiving an onboarding PR,
**I want** all files in the PR to be valid and immediately usable,
**So that** I can merge the PR and start using Generacy without manual fixes.

**Acceptance Criteria**:
- [ ] Templates produce valid devcontainer.json that VS Code can load
- [ ] Templates produce valid docker-compose.yml that Docker Compose can parse
- [ ] Templates produce valid YAML for .generacy/config.yaml
- [ ] Templates produce valid JSON for .vscode/extensions.json
- [ ] Generacy CLI can validate the generated .generacy/config.yaml
- [ ] Test cases validate template output for sample projects

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Define `.generacy/config.yaml` template structure with project ID, name, repos (primary, dev, clone), defaults (agent, baseBranch), and orchestrator settings | P1 | Core configuration file |
| FR-002 | Define `.generacy/generacy.env.template` with `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `GENERACY_API_KEY` (optional), and descriptive comments | P1 | Guides user through required secrets |
| FR-003 | Define `.devcontainer/devcontainer.json` template referencing `ghcr.io/generacy-ai/generacy/generacy:1` feature | P1 | Single-repo variant |
| FR-004 | Define `.devcontainer/devcontainer.json` template with `dockerComposeFile` reference for multi-repo projects | P1 | Multi-repo variant |
| FR-005 | Define `.devcontainer/docker-compose.yml` template with orchestrator, worker (scalable), and Redis services | P1 | Multi-repo orchestration |
| FR-006 | Define `.vscode/extensions.json` recommending `generacy-ai.generacy` and `generacy-ai.agency` | P1 | Extension discovery |
| FR-007 | Support variable substitution with syntax `{{variable.path}}` in all templates | P1 | Enables customization |
| FR-008 | Define template variable schema: project (id, name), repos (primary, dev[], clone[]), defaults (agent, baseBranch), orchestrator (pollIntervalMs, workerCount) | P1 | All substitutable values |
| FR-009 | Implement conditional template inclusion logic (e.g., docker-compose.yml only if repos.dev.length > 0 OR repos.clone.length > 0) | P2 | Conditional complexity |
| FR-010 | Support YAML array substitution for repos.dev and repos.clone lists | P1 | Multi-repo configs |
| FR-011 | Templates must not include language-specific dependencies or base images | P1 | Language-agnostic requirement |
| FR-012 | Provide documentation for customizing base images per language (Python, Node, Java, etc.) | P2 | Developer guidance |
| FR-013 | Templates reference preview or stable feature tags based on release stream | P2 | `:preview` vs `:1` |
| FR-014 | Include `.gitignore` entry for `.generacy/generacy.env` to prevent secret commits | P1 | Security |
| FR-015 | Include descriptive PR title and body templates explaining what was added and next steps | P2 | User onboarding UX |

## Technical Design

### Template File Structure

```
templates/
├── single-repo/
│   ├── .generacy/
│   │   ├── config.yaml
│   │   └── generacy.env.template
│   ├── .devcontainer/
│   │   └── devcontainer.json
│   ├── .vscode/
│   │   └── extensions.json
│   └── .gitignore.patch         # Adds .generacy/generacy.env
├── multi-repo/
│   ├── .generacy/
│   │   ├── config.yaml
│   │   └── generacy.env.template
│   ├── .devcontainer/
│   │   ├── devcontainer.json
│   │   └── docker-compose.yml
│   ├── .vscode/
│   │   └── extensions.json
│   └── .gitignore.patch
└── pr-templates/
    ├── title.txt
    └── body.md
```

### Template Variables

| Variable | Type | Example | Description |
|----------|------|---------|-------------|
| `{{project.id}}` | string | `proj_abc123` | Unique project ID from generacy.ai |
| `{{project.name}}` | string | `My API Project` | User-defined project name |
| `{{repos.primary}}` | string | `github.com/acme/main-api` | Primary repo where dev containers live |
| `{{repos.dev}}` | array | `["github.com/acme/lib", "github.com/acme/worker"]` | Repos for active development |
| `{{repos.clone}}` | array | `["github.com/acme/docs"]` | Repos for reference only |
| `{{defaults.agent}}` | string | `claude-code` | Default AI agent |
| `{{defaults.baseBranch}}` | string | `main` | Default base branch |
| `{{orchestrator.pollIntervalMs}}` | number | `5000` | Orchestrator poll interval |
| `{{orchestrator.workerCount}}` | number | `3` | Number of workers |
| `{{feature.tag}}` | string | `:1` or `:preview` | Dev Container Feature tag |

### Variable Substitution Logic

```typescript
function renderTemplate(template: string, variables: TemplateVariables): string {
  let output = template;

  // Simple scalar replacement
  output = output.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
    const value = getNestedValue(variables, path);
    return value !== undefined ? String(value) : match;
  });

  // YAML array replacement (custom logic for repos.dev and repos.clone)
  // Converts array variables to proper YAML list syntax

  return output;
}
```

### Conditional Template Selection

```typescript
function selectTemplateVariant(projectConfig: ProjectConfig): 'single-repo' | 'multi-repo' {
  const hasMultipleRepos = (projectConfig.repos.dev?.length ?? 0) > 0
                        || (projectConfig.repos.clone?.length ?? 0) > 0;
  return hasMultipleRepos ? 'multi-repo' : 'single-repo';
}
```

### Template Examples

#### `.generacy/config.yaml` (Multi-Repo)

```yaml
# Generacy Project Configuration
# Generated by generacy.ai on {{timestamp}}

project:
  id: "{{project.id}}"
  name: "{{project.name}}"

repos:
  primary: "{{repos.primary}}"
  dev:
{{#each repos.dev}}
    - "{{this}}"
{{/each}}
  clone:
{{#each repos.clone}}
    - "{{this}}"
{{/each}}

defaults:
  agent: "{{defaults.agent}}"
  baseBranch: "{{defaults.baseBranch}}"

orchestrator:
  pollIntervalMs: {{orchestrator.pollIntervalMs}}
  workerCount: {{orchestrator.workerCount}}
```

#### `.generacy/generacy.env.template`

```bash
# Generacy Environment Variables
# Copy this file to .generacy/generacy.env and fill in your values
# IMPORTANT: Never commit .generacy/generacy.env to version control

# GitHub Personal Access Token
# Required scopes: repo, read:org
# Generate at: https://github.com/settings/tokens
GITHUB_TOKEN=ghp_your_token_here

# Anthropic API Key for Claude Code
# Get your key at: https://console.anthropic.com/
ANTHROPIC_API_KEY=sk-ant-your_key_here

# Generacy API Key (optional, for cloud features)
# Generate in generacy.ai settings
# GENERACY_API_KEY=gen_your_key_here
```

#### `.devcontainer/devcontainer.json` (Single-Repo)

```json
{
  "name": "{{project.name}}",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "features": {
    "ghcr.io/generacy-ai/generacy/generacy{{feature.tag}}": {}
  },
  "customizations": {
    "vscode": {
      "extensions": [
        "generacy-ai.generacy",
        "generacy-ai.agency"
      ]
    }
  },
  "remoteUser": "vscode"
}
```

#### `.devcontainer/devcontainer.json` (Multi-Repo)

```json
{
  "name": "{{project.name}}",
  "dockerComposeFile": "docker-compose.yml",
  "service": "orchestrator",
  "runServices": ["orchestrator", "redis"],
  "workspaceFolder": "/workspace",
  "shutdownAction": "stopCompose",
  "customizations": {
    "vscode": {
      "extensions": [
        "generacy-ai.generacy",
        "generacy-ai.agency"
      ]
    }
  },
  "remoteUser": "node"
}
```

#### `.devcontainer/docker-compose.yml` (Multi-Repo)

```yaml
version: '3.8'

services:
  orchestrator:
    image: mcr.microsoft.com/devcontainers/base:ubuntu
    command: sleep infinity
    volumes:
      - workspace:/workspace
      - claude-config:/home/node/.claude
    environment:
      - REDIS_URL=redis://redis:6379
      - GENERACY_PROJECT_ID={{project.id}}
    env_file:
      - ../.generacy/generacy.env
    networks:
      - generacy-network
    depends_on:
      - redis

  worker:
    image: mcr.microsoft.com/devcontainers/base:ubuntu
    command: sleep infinity
    volumes:
      - claude-config:/home/node/.claude
    environment:
      - REDIS_URL=redis://redis:6379
      - GENERACY_PROJECT_ID={{project.id}}
    env_file:
      - ../.generacy/generacy.env
    networks:
      - generacy-network
    depends_on:
      - redis
    deploy:
      replicas: {{orchestrator.workerCount}}

  redis:
    image: redis:7-alpine
    networks:
      - generacy-network

networks:
  generacy-network:
    driver: bridge

volumes:
  workspace:
  claude-config:
```

#### `.vscode/extensions.json`

```json
{
  "recommendations": [
    "generacy-ai.generacy",
    "generacy-ai.agency"
  ]
}
```

#### PR Title Template

```
Setup Generacy development environment
```

#### PR Body Template

```markdown
# Generacy Setup

This PR configures your repository for development with Generacy AI.

## What's Added

### `.generacy/` — Project Configuration
- `config.yaml` — Links this repo to your Generacy project ({{project.id}})
- `generacy.env.template` — Template for required environment variables

### `.devcontainer/` — Development Container
{{#if multi-repo}}
- `devcontainer.json` — VS Code Dev Container configuration with multi-repo orchestration
- `docker-compose.yml` — Orchestrator, workers, and Redis for multi-repo development
{{else}}
- `devcontainer.json` — VS Code Dev Container configuration
{{/if}}

### `.vscode/` — VS Code Extensions
- `extensions.json` — Recommends Generacy and Agency extensions

### `.gitignore`
- Adds `.generacy/generacy.env` to prevent accidentally committing secrets

## Next Steps

1. **Merge this PR** to add Generacy to your repository
2. **Install VS Code extensions** (recommended in `.vscode/extensions.json`)
3. **Configure environment variables**:
   - Copy `.generacy/generacy.env.template` to `.generacy/generacy.env`
   - Fill in your `GITHUB_TOKEN` and `ANTHROPIC_API_KEY`
4. **Reopen in container**: Use VS Code command "Dev Containers: Reopen in Container"

## Documentation

- [Getting Started Guide](https://github.com/generacy-ai/generacy/docs/getting-started.md)
- [Configuration Reference](https://github.com/generacy-ai/generacy/docs/configuration.md)

---

*Generated by [Generacy](https://generacy.ai) — AI-powered development automation*
```

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Template validity | 100% | All generated files pass syntax validation (YAML, JSON) |
| SC-002 | Single-repo template | Functional | Dev container builds and starts successfully with test project |
| SC-003 | Multi-repo template | Functional | Docker Compose starts orchestrator + workers + Redis successfully |
| SC-004 | Variable substitution | 100% coverage | All template variables successfully replaced with test data |
| SC-005 | Language compatibility | 5+ languages | Templates tested with Python, Node, Java, Go, .NET base images |
| SC-006 | Generacy CLI validation | Pass | `generacy doctor` validates generated config files |

## Assumptions

- The Generacy Dev Container Feature exists and is published to GHCR (Epic 1.4, Issue 5.4)
- The feature tag `:1` will be used for stable releases and `:preview` for preview releases
- Users have Docker and VS Code with Dev Containers extension installed
- GitHub authentication will use personal access tokens or `gh` CLI auth
- The PR generation service (Epic 4.3) will handle Git operations and PR creation
- Template files will be stored in the `generacy` repository under `templates/`
- The onboarding PR will target the default branch of the primary repo
- Users can customize base images after onboarding if needed
- `.gitignore` already exists in most repos; template will append if missing or create if absent

## Out of Scope

- Implementation of the PR generation service (covered in Epic 4.3)
- VS Code extension implementation (covered in Epic 5)
- Dev Container Feature implementation (already exists, publishing in Epic 1.4)
- Authentication mechanisms (covered in Epic 2)
- Web interface for project creation (covered in Epic 3)
- CLI `generacy init` command (covered in Epic 4.5)
- Docker Compose orchestration logic (exists, template references it)
- Template versioning and migration (deferred to future iteration)
- Custom template support for advanced users (deferred to future iteration)
- Language-specific template variants (Python, Node, etc.) — users customize base images manually
- Automated testing of generated dev containers (future enhancement)

## Dependencies

| Dependency | Status | Notes |
|------------|--------|-------|
| Dev Container Feature | Exists | Already implemented at `/workspaces/generacy/packages/devcontainer-feature/` |
| `.generacy/config.yaml` schema | Blocked by #248 | Epic 4.2 defines the schema, this issue defines the template |
| GHCR publishing | Blocked by #243, #252 | Need CI/CD for feature tags |
| Template rendering library | TBD | Need to select or implement (Handlebars, Mustache, or custom) |

## Implementation Notes

- Templates should be stored in `generacy/templates/` directory
- Use a standard template engine (e.g., Handlebars) for variable substitution and conditionals
- Validate template output in tests using JSON Schema and YAML parsers
- Include test fixtures for single-repo and multi-repo scenarios
- Document template customization in developer-facing docs
- Consider preview vs stable feature tag selection based on project preferences (default to stable `:1`)

## Related Issues

- Epic 4: Project Setup Automation ([generacy#239](https://github.com/generacy-ai/generacy/issues/239))
- Issue 4.2: Define .generacy/config.yaml schema ([generacy#248](https://github.com/generacy-ai/generacy/issues/248))
- Issue 4.3: Implement onboarding PR generation service ([generacy-cloud#95](https://github.com/generacy-ai/generacy-cloud/issues/95))
- Issue 4.5: Generacy CLI `generacy init` ([generacy#249](https://github.com/generacy-ai/generacy/issues/249))
- Issue 5.4: Publish Dev Container Feature to GHCR ([generacy#252](https://github.com/generacy-ai/generacy/issues/252))

---

*Generated by speckit*
