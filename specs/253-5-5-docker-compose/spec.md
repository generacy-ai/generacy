# Feature Specification: Docker Compose Template for Multi-Repo Projects

**Branch**: `253-5-5-docker-compose` | **Date**: 2026-02-26 | **Status**: Draft

## Summary

Implement and validate the Handlebars template that generates a `docker-compose.yml` for multi-repo Generacy projects. When a user creates a multi-repo project on generacy.ai, the onboarding PR includes a `.devcontainer/docker-compose.yml` that defines three services — an **orchestrator** (the primary dev container), configurable **worker** replicas, and a **Redis** message queue — along with project-scoped networks, volumes, and environment configuration.

The generated compose file must work out of the box: running `docker compose up` from a fresh clone starts the full stack with all repositories mounted, inter-container networking established, and environment variables loaded from `.generacy/generacy.env`.

### Architecture

```
┌────────────────────────────────────────────────────┐
│  docker-compose.yml  (.devcontainer/)              │
│                                                    │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐       │
│  │  Redis    │   │Orchestr. │   │ Worker×N │       │
│  │ 7-alpine  │   │ (primary │   │ (scaled  │       │
│  │ ephemeral │   │  dev     │   │  via     │       │
│  │ queue     │◄──┤  cont.)  │──►│ replicas)│       │
│  └──────────┘   └──────────┘   └──────────┘       │
│       ▲               │              │             │
│       └───────────────┴──────────────┘             │
│              generacy bridge network               │
│                                                    │
│  Volumes:  generacy-state, vscode-server           │
│  Env:      .generacy/generacy.env                  │
└────────────────────────────────────────────────────┘
```

### Template Location

`packages/templates/src/multi-repo/docker-compose.yml.hbs`

The template is rendered by the `@generacy-ai/templates` package using `TemplateContext` data (project metadata, repo lists, orchestrator settings, dev container config). The rendered output is placed at `.devcontainer/docker-compose.yml` in the onboarding PR.

### Dependencies
- **4.1** (template content) — defines the onboarding PR file structure
- **4.2** (config.yaml schema) — provides `orchestrator.workerCount` and `orchestrator.pollIntervalMs` values consumed by the template

### Plan Reference
[onboarding-buildout-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/onboarding-buildout-plan.md) — Issue 5.5

---

### Execution
**Phase:** 2
**Blocked by:**
- [ ] generacy-ai/generacy#247 — Define onboarding PR template content

---

## User Stories

### US1: Zero-Config Multi-Repo Startup

**As a** developer who just merged an onboarding PR for a multi-repo project,
**I want** to run `docker compose up` and have the full orchestrator + worker + Redis stack start automatically,
**So that** I can begin development without manual container setup or service configuration.

**Acceptance Criteria**:
- [ ] `docker compose up` from `.devcontainer/` starts all three service types (Redis, orchestrator, worker)
- [ ] Redis becomes healthy before orchestrator and workers start (health-check dependency)
- [ ] Orchestrator becomes healthy before workers start (health-check dependency)
- [ ] Workers scale to the configured `workerCount` replica count
- [ ] All services join the project-scoped bridge network and can resolve each other by service name
- [ ] No manual edits to the generated compose file are required for a working setup

### US2: Configurable Worker Scaling

**As a** team lead tuning Generacy for my project's workload,
**I want** the worker count to be configurable via the project config,
**So that** I can scale parallel task execution to match my team's needs.

**Acceptance Criteria**:
- [ ] Worker replicas are set from `orchestrator.workerCount` in `config.yaml` (range 1–20)
- [ ] The `WORKER_COUNT` environment variable is passed to the orchestrator container so it knows how many workers to expect
- [ ] Changing `workerCount` in config and re-rendering the template produces a compose file with updated replica count
- [ ] Default worker count (when not specified) produces a functional compose file

### US3: Multi-Repo Workspace Mounting

**As a** developer working across multiple repositories,
**I want** all project repositories mounted into every container,
**So that** the orchestrator and workers can access code across all repos.

**Acceptance Criteria**:
- [ ] The primary repository is mounted read-write at `/workspaces/{repo-name}`
- [ ] Dev repositories are each mounted at `/workspaces/{repo-name}` with `:cached` mode
- [ ] Clone-only repositories are mounted at `/workspaces/{repo-name}` with `:cached` mode
- [ ] Volume mounts are generated dynamically based on `repos.dev` and `repos.clone` arrays in the template context
- [ ] The orchestrator's `working_dir` is set to the primary repo workspace
- [ ] State and cache persist across container restarts via named volumes (`generacy-state`, `vscode-server`)

### US4: Secure Environment Configuration

**As a** developer setting up my local environment,
**I want** secrets and configuration loaded from `.generacy/generacy.env`,
**So that** I can manage API keys and tokens in a single gitignored file without hardcoding them in the compose file.

**Acceptance Criteria**:
- [ ] All services reference `env_file: ../.generacy/generacy.env` for secrets (GitHub token, Anthropic API key)
- [ ] Runtime environment variables (`REDIS_URL`, `ROLE`, `PROJECT_ID`) are set inline and override env file values
- [ ] The env file path is relative to the `.devcontainer/` directory where the compose file lives
- [ ] Missing env file produces a clear Docker Compose error (not a silent startup with missing credentials)

### US5: Dev Container Integration

**As a** developer using VS Code or GitHub Codespaces,
**I want** the Docker Compose file to work seamlessly with the Dev Container specification,
**So that** opening the project in a dev container uses the orchestrator as the primary workspace.

**Acceptance Criteria**:
- [ ] `.devcontainer/devcontainer.json` references `docker-compose.yml` and targets the `orchestrator` service
- [ ] The orchestrator container installs the Generacy dev container feature (`ghcr.io/generacy-ai/features/generacy`)
- [ ] Multi-root workspace folders are configured for all mounted repositories
- [ ] The compose file works with both local Docker Desktop and remote Codespaces

---

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Redis service uses `redis:7-alpine` image with ephemeral storage (`--appendonly no --save ""`) | P1 | No persistence needed — Redis is a transient message queue |
| FR-002 | Redis health check uses `redis-cli ping` with 5s interval, 3s timeout, 5 retries | P1 | Gates orchestrator and worker startup |
| FR-003 | Orchestrator service uses configurable base image via `{{devcontainer.baseImage}}` | P1 | Default: `mcr.microsoft.com/devcontainers/universal` or similar |
| FR-004 | Orchestrator installs Generacy dev container feature via `ghcr.io/generacy-ai/features/generacy{{devcontainer.featureTag}}` | P1 | `:1` for stable, `:preview` for preview channel |
| FR-005 | Orchestrator loads secrets from `env_file: ../.generacy/generacy.env` | P1 | Relative to `.devcontainer/` directory |
| FR-006 | Orchestrator sets inline environment: `REDIS_URL`, `ROLE=orchestrator`, `WORKER_COUNT`, `POLL_INTERVAL_MS`, `PROJECT_ID`, `PROJECT_NAME`, `PRIMARY_REPO` | P1 | Inline vars override env file |
| FR-007 | Orchestrator mounts primary repo at `/workspaces/{repo-name}:cached` | P1 | Uses `{{repoName}}` Handlebars helper to extract repo name from URL |
| FR-008 | Orchestrator conditionally mounts dev repos via `{{#each repos.dev}}` loop | P1 | Only rendered when `repos.hasDevRepos` is true |
| FR-009 | Orchestrator conditionally mounts clone repos via `{{#each repos.clone}}` loop | P2 | Only rendered when `repos.hasCloneRepos` is true |
| FR-010 | Orchestrator mounts named volumes: `generacy-state` at `/home/vscode/.generacy`, `vscode-server` at `/home/vscode/.vscode-server` | P1 | Persists state and extensions across restarts |
| FR-011 | Orchestrator sets `working_dir` to primary repo workspace path | P1 | Dev container uses this as the initial working directory |
| FR-012 | Orchestrator uses `command: sleep infinity` to keep container running | P1 | Dev container lifecycle managed by VS Code/Codespaces |
| FR-013 | Orchestrator health check tests for `/home/vscode/.generacy/ready` file with 10s interval, 30s start period | P2 | Feature install creates this file on completion |
| FR-014 | Orchestrator `depends_on` Redis with `condition: service_healthy` | P1 | Ensures Redis is available before orchestrator starts |
| FR-015 | Worker service mirrors orchestrator base image and feature installation | P1 | Same dev container feature, same repo mounts |
| FR-016 | Worker sets `ROLE=worker` and omits orchestrator-only vars (`WORKER_COUNT`, `PROJECT_NAME`, `PRIMARY_REPO`) | P1 | Workers only need queue connection and project ID |
| FR-017 | Worker scales via `deploy.replicas: {{orchestrator.workerCount}}` | P1 | Maps directly to `config.yaml` orchestrator.workerCount |
| FR-018 | Worker `depends_on` both Redis and orchestrator with healthy conditions | P1 | Ensures full stack readiness before workers poll |
| FR-019 | Worker does not mount `generacy-state` volume | P2 | Workers share `vscode-server` but have no persistent state |
| FR-020 | Project-scoped bridge network named `{{project.id}}-network` | P1 | Isolates project containers from other Docker networks |
| FR-021 | All services join the `generacy` network | P1 | Enables service name DNS resolution (`redis`, `orchestrator`, `worker`) |
| FR-022 | Named volumes use project-scoped names: `{{project.id}}-state`, `{{project.id}}-vscode-server` | P1 | Prevents volume name collisions across projects |
| FR-023 | Redis port `6379` exposed to host for local debugging | P2 | Optional — useful for Redis CLI inspection |
| FR-024 | Container names use `{{project.id}}-{service}` pattern for orchestrator and Redis | P1 | Workers use auto-generated names due to replicas |
| FR-025 | Template renders valid YAML for all fixture contexts (minimal, full, large multi-repo) | P1 | Validated by template test suite |
| FR-026 | Generated compose file includes metadata header with timestamp, schema version, and generator name | P2 | Aids debugging and traceability |

---

## Technical Design

### Template Rendering Pipeline

```
TemplateContext (schema.ts)
    │
    ▼
Handlebars.compile(docker-compose.yml.hbs)
    │
    ├── Helpers: repoName(url) → extracts "repo" from "github.com/owner/repo"
    │
    ▼
Rendered docker-compose.yml string
    │
    ▼
YAML.parse() validation (ensures valid YAML output)
    │
    ▼
Written to .devcontainer/docker-compose.yml in onboarding PR
```

### Template Context Shape (relevant fields)

```typescript
interface TemplateContext {
  project: { id: string; name: string }
  repos: {
    primary: string                    // "github.com/owner/repo"
    dev: string[]                      // Active development repos
    clone: string[]                    // Read-only reference repos
    isMultiRepo: boolean               // true when dev or clone repos exist
    hasDevRepos: boolean               // dev.length > 0
    hasCloneRepos: boolean             // clone.length > 0
  }
  orchestrator: {
    workerCount: number                // 1–20, default 2
    pollIntervalMs: number             // >= 5000, default 5000
  }
  devcontainer: {
    baseImage: string                  // e.g., "mcr.microsoft.com/devcontainers/universal:2"
    featureTag: string                 // ":1" or ":preview"
  }
  metadata: {
    timestamp: string
    generatedBy: string
    version: string
  }
}
```

### Service Dependency Graph

```
redis (healthy) ──► orchestrator (healthy) ──► worker ×N
```

Workers will not start until the orchestrator is healthy. The orchestrator will not start until Redis is healthy. This ensures the full infrastructure is ready before any task processing begins.

### Volume Mount Strategy

| Mount | Source | Target | Mode | Services |
|-------|--------|--------|------|----------|
| Primary repo | `../..` | `/workspaces/{primary}` | cached | orchestrator, worker |
| Dev repos | `../../{repo}` | `/workspaces/{repo}` | cached | orchestrator, worker |
| Clone repos | `../../{repo}` | `/workspaces/{repo}` | cached | orchestrator, worker |
| Generacy state | Named volume | `/home/vscode/.generacy` | rw | orchestrator only |
| VS Code Server | Named volume | `/home/vscode/.vscode-server` | rw | orchestrator, worker |

All repo mounts use `:cached` mode for performance on macOS/Windows Docker Desktop.

### Dev Container Integration

The `.devcontainer/devcontainer.json` complements the compose file:

```json
{
  "dockerComposeFile": "docker-compose.yml",
  "service": "orchestrator",
  "workspaceFolder": "/workspaces/{primary-repo}"
}
```

VS Code attaches to the orchestrator container as the primary development environment. Workers run headless in the background.

---

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Fresh-clone startup | `docker compose up` starts all services without errors | Manual test from a clean clone with valid `generacy.env` |
| SC-002 | Template renders valid YAML | All fixture contexts produce parseable YAML | Automated: `YAML.parse()` succeeds for every rendered fixture |
| SC-003 | Worker scaling | Worker replicas match `orchestrator.workerCount` config | Automated: rendered YAML `deploy.replicas` equals context value |
| SC-004 | Volume mount correctness | All repos from context appear as volume mounts | Automated: rendered YAML contains mount entries for every repo in context |
| SC-005 | Network isolation | All services join the project-scoped network | Automated: every service in rendered YAML includes `networks: [generacy]` |
| SC-006 | Health check ordering | Workers depend on orchestrator; orchestrator depends on Redis | Automated: `depends_on` with `condition: service_healthy` in rendered YAML |
| SC-007 | Env file reference | All services reference `.generacy/generacy.env` | Automated: `env_file` present in orchestrator and worker service definitions |
| SC-008 | Fixture coverage | Minimal (1 repo), standard (3 repos), large (5+ repos) contexts render correctly | Automated test suite with fixture files for each scenario |
| SC-009 | Conditional rendering | Template omits dev/clone mount sections when those repo lists are empty | Automated: minimal context with no dev/clone repos produces clean YAML without empty mount blocks |

---

## Assumptions

- The dev container feature (`ghcr.io/generacy-ai/features/generacy`) is published and available at the tag specified by `devcontainer.featureTag` (Epic 5.4)
- All repositories listed in the template context are cloned as siblings of the primary repo (the parent directory `../..` contains all repo directories)
- The `repoName` Handlebars helper correctly extracts the repository name from `github.com/{owner}/{repo}` format URLs
- Docker Compose V2 (`docker compose` CLI plugin) is available in the dev environment — the `version: "3.8"` field is included for compatibility but is not required by Compose V2
- The `.generacy/generacy.env` file is created by the developer after merging the onboarding PR (from the committed `.generacy/generacy.env.template`)
- The `vscode` user exists in the base image and is the default non-root user for dev containers
- Workers do not need independent persistent state — only the orchestrator maintains `generacy-state`
- The `deploy.replicas` field is supported by the Docker Compose implementation used (Docker Desktop, Codespaces)

## Out of Scope

- **Docker Compose override files** — No `docker-compose.override.yml` template for local customization (can be added in a future iteration)
- **GPU or hardware acceleration** — No `deploy.resources` configuration for GPU-accelerated agents
- **Custom Dockerfile builds** — Services use pre-built base images with dev container features, not project-specific Dockerfiles
- **Production deployment** — This compose file is for local development and Codespaces only, not production orchestration
- **TLS / mTLS for Redis** — Redis runs on an isolated bridge network without encryption (acceptable for local dev)
- **Log aggregation** — No centralized logging service (Loki, Fluentd) — developers use `docker compose logs`
- **Container resource limits** — No `mem_limit`, `cpus`, or other resource constraints (dev environment, not production)
- **Runtime worker scaling** — `WORKER_COUNT` is a static template value; dynamic scaling requires re-rendering and restarting
- **Non-Docker container runtimes** — Only Docker / Docker Desktop / Codespaces supported (no Podman, containerd direct)
- **Single-repo compose** — Single-repo projects use a direct dev container, not Docker Compose (separate template path)

---

*Generated by speckit*
