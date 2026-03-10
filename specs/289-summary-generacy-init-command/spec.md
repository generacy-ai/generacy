# Feature Specification: Integrate cluster-templates into `generacy init`

**Branch**: `289-summary-generacy-init-command` | **Date**: 2026-03-03 | **Status**: Draft

## Summary

Extend the existing `generacy init` command to scaffold full development cluster configurations by pulling templates from the [cluster-templates](https://github.com/generacy-ai/cluster-templates) repository. Users select between **standard** (DooD) and **microservices** (DinD) cluster variants, and the command generates a complete `.devcontainer/` directory with Dockerfiles, Compose files, entrypoint scripts, and environment templates — with project-specific variable substitution applied.

Currently, `generacy init` generates a minimal devcontainer using the Generacy Dev Container Feature via the `@generacy-ai/templates` package. This feature replaces that with the richer cluster-templates approach: multi-stage Dockerfiles, orchestrator/worker entrypoint scripts, Redis services, and proper Docker-in-Docker support for the microservices variant.

### Context

- **cluster-templates repo**: Contains two variant directories (`standard/` and `microservices/`), each with a full `.devcontainer/` tree (Dockerfile, docker-compose.yml, devcontainer.json, .env.template, scripts/)
- **standard variant**: Orchestrator (DooD) + workers + Redis, for apps that don't run containers
- **microservices variant**: Adds Docker-in-Docker so each worker can run isolated container stacks (privileged mode, DinD setup script)
- **Related issues**: generacy#249 (`generacy init` command), generacy#247 (Onboarding PR template content)

## User Stories

### US1: New Project Scaffold with Standard Cluster

**As a** developer setting up a new Generacy project,
**I want** to run `generacy init` and select the "standard" cluster variant,
**So that** I get a fully configured `.devcontainer/` with orchestrator, workers, and Redis — ready for Docker-outside-of-Docker operation.

**Acceptance Criteria**:
- [ ] Running `generacy init` presents a variant selection prompt (standard / microservices)
- [ ] Selecting "standard" generates `.devcontainer/` with Dockerfile, docker-compose.yml, devcontainer.json, .env.template, and scripts/
- [ ] Generated files have project-specific values substituted (project name, repo URL, etc.)
- [ ] `.generacy/config.yaml` is generated with project metadata (existing behavior preserved)
- [ ] The generated cluster can be opened directly in VS Code Dev Containers / GitHub Codespaces

### US2: New Project Scaffold with Microservices Cluster

**As a** developer whose application needs to run isolated Docker container stacks,
**I want** to select the "microservices" variant during `generacy init`,
**So that** each worker gets its own Docker daemon via Docker-in-Docker.

**Acceptance Criteria**:
- [ ] Selecting "microservices" generates the microservices variant with DinD support
- [ ] The Dockerfile includes Docker CE installation stage
- [ ] docker-compose.yml includes `privileged: true` and `ENABLE_DIND=true`
- [ ] `setup-docker-dind.sh` script is included in the generated output
- [ ] All standard scripts are also included (entrypoint-orchestrator.sh, entrypoint-worker.sh, setup-credentials.sh)

### US3: Non-Interactive Initialization

**As a** CI/CD pipeline or automation script,
**I want** to specify the cluster variant via a CLI flag (`--variant standard`),
**So that** I can scaffold projects without interactive prompts.

**Acceptance Criteria**:
- [ ] `--variant <standard|microservices>` flag selects the cluster variant without prompting
- [ ] Combined with `--yes`, no interactive prompts are required
- [ ] Invalid variant values produce a clear error message

### US4: Re-initialization with Conflict Resolution

**As a** developer with an existing Generacy project,
**I want** to re-run `generacy init` to update my cluster configuration,
**So that** I can adopt newer template versions without losing my customizations.

**Acceptance Criteria**:
- [ ] Existing conflict resolution flow applies to cluster template files (Overwrite / Skip / Show diff)
- [ ] `--force` flag overwrites all files without prompting
- [ ] `.generacy/config.yaml` preserves existing values as prompt defaults (existing behavior)
- [ ] Previously selected variant is read from config and used as the default

### US5: Dry Run Preview

**As a** developer evaluating cluster variants,
**I want** to run `generacy init --dry-run` to preview what files would be generated,
**So that** I can compare variants before committing to one.

**Acceptance Criteria**:
- [ ] `--dry-run` lists all files that would be written, with their target paths
- [ ] No files are written to disk during dry run
- [ ] Variant selection still works in dry-run mode

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add `--variant <standard\|microservices>` CLI flag to `generacy init` | P1 | Default: prompt user; with `--yes`: default to "standard" |
| FR-002 | Add interactive variant selection prompt using `@clack/prompts` | P1 | Radio select with descriptions for each variant |
| FR-003 | Bundle cluster-templates in the `@generacy-ai/templates` package | P1 | See [Template Source Strategy](#template-source-strategy) below |
| FR-004 | Render cluster template files with Handlebars variable substitution | P1 | Reuse existing rendering engine (`strict: true`, `noEscape: true`) |
| FR-005 | Generate `.devcontainer/Dockerfile` from variant template | P1 | Multi-stage build with GH CLI, generacy CLI, Claude Code |
| FR-006 | Generate `.devcontainer/docker-compose.yml` from variant template | P1 | Orchestrator + workers (scaled) + Redis with health checks |
| FR-007 | Generate `.devcontainer/devcontainer.json` from variant template | P1 | Replaces current single-repo/multi-repo devcontainer.json templates |
| FR-008 | Generate `.devcontainer/.env.template` from variant template | P1 | With project-specific defaults pre-filled where possible |
| FR-009 | Generate `.devcontainer/scripts/` entrypoint and setup scripts | P1 | entrypoint-orchestrator.sh, entrypoint-worker.sh, setup-credentials.sh |
| FR-010 | Generate `setup-docker-dind.sh` for microservices variant only | P1 | Conditionally included when variant = microservices |
| FR-011 | Preserve `.generacy/config.yaml` generation | P1 | No regression to existing config generation |
| FR-012 | Preserve `.generacy/generacy.env.template` generation | P1 | No regression |
| FR-013 | Preserve `.vscode/extensions.json` smart merge | P1 | No regression |
| FR-014 | Apply existing conflict resolution to all new template files | P1 | Reuse `conflicts.ts` for Overwrite / Skip / Show diff |
| FR-015 | Persist selected variant in `.generacy/config.yaml` | P2 | Add `cluster.variant` field to config schema |
| FR-016 | Support `--dry-run` for cluster template files | P1 | Extend existing dry-run behavior to new files |
| FR-017 | Harmonize environment variable naming between templates | P2 | Resolve `GH_TOKEN` vs `GITHUB_TOKEN`, `CLAUDE_API_KEY` vs `ANTHROPIC_API_KEY` |
| FR-018 | Read previously selected variant from config on re-init | P2 | Default to existing variant when re-running init |

## Template Source Strategy

Cluster-templates will be **bundled into the `@generacy-ai/templates` package** at build time.

**Rationale:**
- Eliminates runtime dependency on GitHub API availability
- Ensures version consistency between CLI and templates
- Avoids authentication requirements for template fetching
- Enables offline usage
- Templates can be versioned and tested alongside CLI changes

**Implementation approach:**
- Copy cluster-templates source into `packages/templates/src/cluster/standard/` and `packages/templates/src/cluster/microservices/`
- Convert template files to Handlebars (`.hbs`) where variable substitution is needed
- Static files (shell scripts) can remain as-is or use a lightweight substitution pass
- Add a `renderCluster(variant, context)` export to `@generacy-ai/templates`

## Variable Substitution

The following variables must be substituted in cluster template files:

| Variable | Source | Used In |
|----------|--------|---------|
| `project.name` | `InitOptions.projectName` | devcontainer.json `name` field |
| `project.id` | `InitOptions.projectId` | config.yaml |
| `repos.primary` | `InitOptions.primaryRepo` | .env.template `REPO_URL`, entrypoint scripts |
| `defaults.baseBranch` | `InitOptions.baseBranch` | .env.template `REPO_BRANCH` |
| `defaults.agent` | `InitOptions.agent` | config.yaml |
| `orchestrator.workerCount` | Default (3) | docker-compose.yml `scale`, .env.template `WORKER_COUNT` |
| `orchestrator.port` | Default (3100) | docker-compose.yml port mapping, .env.template `ORCHESTRATOR_PORT` |
| `metadata.timestamp` | Generation time | config.yaml header comment |

## Generated File Manifest

### Both variants generate:

| Target Path | Source | Type |
|-------------|--------|------|
| `.devcontainer/Dockerfile` | cluster template | Handlebars |
| `.devcontainer/docker-compose.yml` | cluster template | Handlebars |
| `.devcontainer/devcontainer.json` | cluster template | Handlebars |
| `.devcontainer/.env.template` | cluster template | Handlebars |
| `.devcontainer/scripts/entrypoint-orchestrator.sh` | cluster template | Static + substitution |
| `.devcontainer/scripts/entrypoint-worker.sh` | cluster template | Static + substitution |
| `.devcontainer/scripts/setup-credentials.sh` | cluster template | Static |
| `.generacy/config.yaml` | shared template | Handlebars (existing) |
| `.generacy/generacy.env.template` | shared template | Handlebars (existing) |
| `.generacy/.gitignore` | shared template | Static (existing) |
| `.vscode/extensions.json` | shared template | Handlebars + merge (existing) |

### Microservices variant additionally generates:

| Target Path | Source | Type |
|-------------|--------|------|
| `.devcontainer/scripts/setup-docker-dind.sh` | cluster template | Static |

## Config Schema Changes

Extend `GeneracyConfigSchema` in `packages/generacy/src/config/schema.ts`:

```yaml
# Addition to .generacy/config.yaml
cluster:
  variant: "standard"  # or "microservices"
```

```typescript
// Addition to schema.ts
cluster: z.object({
  variant: z.enum(['standard', 'microservices']).default('standard'),
}).optional(),
```

## Integration Points

### Modified files:

| File | Change |
|------|--------|
| `packages/generacy/src/cli/commands/init/index.ts` | Add variant resolution step; pass variant to template rendering |
| `packages/generacy/src/cli/commands/init/types.ts` | Add `variant` to `InitOptions` |
| `packages/generacy/src/cli/commands/init/resolver.ts` | Resolve variant from flag > config > prompt > default |
| `packages/generacy/src/cli/commands/init/prompts.ts` | Add variant selection prompt |
| `packages/generacy/src/cli/commands/init/summary.ts` | Show selected variant in summary output |
| `packages/generacy/src/config/schema.ts` | Add `cluster.variant` to config schema |
| `packages/templates/src/index.ts` | Export `renderCluster()` function |

### New files:

| File | Purpose |
|------|---------|
| `packages/templates/src/cluster/standard/*.hbs` | Standard variant Handlebars templates |
| `packages/templates/src/cluster/microservices/*.hbs` | Microservices variant Handlebars templates |
| `packages/templates/src/cluster/shared/` | Scripts and assets shared between variants |
| `packages/generacy/src/cli/commands/init/__tests__/variant.test.ts` | Variant selection and rendering tests |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Variant selection prompt appears during interactive init | 100% of interactive runs | Manual testing + integration test |
| SC-002 | Generated standard cluster starts successfully | Orchestrator + worker + Redis all healthy | End-to-end test in Codespaces |
| SC-003 | Generated microservices cluster starts with DinD operational | Worker can run `docker compose up` inside container | End-to-end test in Codespaces |
| SC-004 | All existing `generacy init` tests pass | 0 regressions | CI pipeline (`pnpm test`) |
| SC-005 | Variable substitution produces valid YAML/JSON/Dockerfiles | 0 syntax errors in generated output | Unit tests with varied inputs |
| SC-006 | Non-interactive mode works with `--variant` flag | Init completes with `--yes --variant standard` | Integration test |
| SC-007 | Conflict resolution works for cluster template files | Overwrite / Skip / Diff all functional | Integration test |
| SC-008 | Re-init preserves previously selected variant as default | Variant read from existing config.yaml | Unit test |

## Assumptions

- The cluster-templates repo structure (standard/microservices variants with `.devcontainer/` subdirectories) is stable and will not change during implementation
- Bundling templates in the CLI package is acceptable for the initial implementation (vs. runtime GitHub API fetching)
- The existing `@generacy-ai/templates` Handlebars rendering engine can be extended for cluster templates without a rewrite
- The current 11-step init orchestration flow can accommodate the variant selection step without major restructuring (inserted between option resolution and template rendering)
- Users who previously ran `generacy init` (pre-cluster-templates) can re-run it to adopt the new cluster format via the conflict resolution flow
- The `GH_TOKEN` / `GITHUB_TOKEN` and `CLAUDE_API_KEY` / `ANTHROPIC_API_KEY` naming discrepancies will be resolved by standardizing on the cluster-templates naming convention (FR-017)

## Out of Scope

- **Runtime GitHub API fetching of templates** — templates will be bundled; a `--template-source` flag may be added in a future iteration
- **Custom or user-defined cluster variants** — only standard and microservices are supported initially
- **Template versioning or update-in-place** — no mechanism to check for or apply template updates after initial generation
- **Worker count configuration during init** — worker count remains a `.env.template` variable, not an init-time prompt
- **Kubernetes or non-Docker orchestration** — only Docker Compose-based clusters are supported
- **Cloud provider-specific configurations** — only GitHub Codespaces / VS Code Dev Containers are targeted
- **Automated migration tooling** — no automated migration from pre-cluster-templates devcontainer configurations to the new format
- **Changes to `generacy setup`** — the setup command continues to work independently of cluster variant

---

*Generated by speckit*
