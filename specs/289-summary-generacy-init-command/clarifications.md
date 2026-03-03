# Clarification Questions

## Status: Resolved

## Questions

### Q1: Single-Repo / Multi-Repo Template Fate
**Context**: The current init command generates different devcontainer configurations based on whether the project is single-repo or multi-repo (via `repos.isMultiRepo`). The spec says cluster templates "replace current single-repo/multi-repo devcontainer.json templates" (FR-007), but cluster templates always include orchestrator + workers + Redis, which is inherently a multi-service setup. It's unclear whether single-repo projects still get the lightweight, image-only devcontainer or whether all projects now receive the full cluster setup.
**Question**: Do cluster templates fully replace the existing single-repo and multi-repo templates for all projects, or should single-repo projects retain the lightweight devcontainer option? If cluster templates replace everything, should there be a "none" or "simple" variant for projects that don't need orchestrator/workers?
**Options**:
- A) Full replacement: All projects get cluster templates (standard or microservices). Remove single-repo/multi-repo templates entirely.
- B) Additive: Cluster templates are a new option alongside the existing single-repo/multi-repo templates. Users choose between "simple" (current) and "cluster" (new), then pick a cluster variant if applicable.
- C) Conditional: Multi-repo projects always get cluster templates; single-repo projects keep the lightweight devcontainer unless the user explicitly opts into a cluster variant.
**Answer**: **A (Full replacement)** — All projects get cluster templates (standard or microservices). The existing single-repo/multi-repo templates and the Dev Container Feature onboarding path are being deprecated. Cluster templates become the sole onboarding mechanism. The standard cluster variant serves as the lightweight option (no DinD, just orchestrator + workers + Redis). No need for a "none" or "simple" variant.

---

### Q2: Environment Variable Naming Standardization
**Context**: FR-017 (P2) calls for harmonizing environment variable naming between the existing templates and cluster-templates, specifically `GH_TOKEN` vs `GITHUB_TOKEN` and `CLAUDE_API_KEY` vs `ANTHROPIC_API_KEY`. The cluster-templates repo uses `GH_TOKEN` and `CLAUDE_API_KEY`, while Anthropic's official convention is `ANTHROPIC_API_KEY` and GitHub Actions uses `GITHUB_TOKEN`. This affects every generated `.env.template`, entrypoint script, and Dockerfile.
**Question**: Which environment variable names should be standardized on?
**Options**:
- A) Cluster-templates convention: Use `GH_TOKEN` and `CLAUDE_API_KEY` everywhere (matches what cluster-templates already use)
- B) Official conventions: Use `GITHUB_TOKEN` and `ANTHROPIC_API_KEY` (matches GitHub Actions and Anthropic SDK defaults)
- C) Support both with fallbacks: Scripts check for both names (e.g., `${ANTHROPIC_API_KEY:-$CLAUDE_API_KEY}`) and document the preferred name
- D) Defer: Ship with cluster-templates naming for now, standardize in a follow-up issue
**Answer**: **C (Support both with fallbacks), standardizing on official names** — Use `GITHUB_TOKEN` and `ANTHROPIC_API_KEY` as the documented/preferred names (matching GitHub Actions, `gh` CLI, and Anthropic SDK defaults), but support fallbacks: `${GITHUB_TOKEN:-$GH_TOKEN}` and `${ANTHROPIC_API_KEY:-$CLAUDE_API_KEY}`. The generacy init `github.ts` already looks for `GITHUB_TOKEN` first. The `.env.template` should list the official names as primary with comments noting the aliases. This avoids breaking anyone already using the cluster-templates names while aligning with ecosystem conventions going forward.

---

### Q3: Shell Script File Permissions
**Context**: The cluster templates include executable shell scripts (`entrypoint-orchestrator.sh`, `entrypoint-worker.sh`, `setup-credentials.sh`, `setup-docker-dind.sh`). The current `writer.ts` uses `fs.writeFileSync()` without setting file permissions. On Unix systems, generated scripts will lack the execute bit, causing Docker entrypoints to fail with "permission denied" unless the Dockerfile adds `RUN chmod +x`.
**Question**: How should execute permissions be handled for generated shell scripts?
**Options**:
- A) Set permissions in writer: Extend `writer.ts` to call `fs.chmodSync(path, 0o755)` for `.sh` files after writing
- B) Dockerfile handles it: Add `RUN chmod +x /scripts/*.sh` in the generated Dockerfile (cluster-templates may already do this)
- C) Git handles it: Mark scripts as executable via `git update-index --chmod=+x` after generation, relying on git to preserve permissions
**Answer**: **A (Set permissions in writer)** — Add `fs.chmodSync(path, 0o755)` for `.sh` files in `writer.ts`. The cluster-templates Dockerfiles already use `COPY --chmod=755` so permissions are handled at build time too, but setting them correctly on disk ensures scripts work regardless of consumption context (local execution, non-Docker setups, git operations). One-line change with no downside.

---

### Q4: Variant Selection Step Placement in Init Flow
**Context**: The current init command has an 11-step orchestration flow. The spec says variant selection is "inserted between option resolution and template rendering" but doesn't specify exactly where. The variant choice affects which templates are rendered and what context is built, so it must come before `buildTemplateContext()`. However, variant resolution itself follows the same priority chain (flag → config → prompt → default) as other options.
**Question**: Should variant resolution be integrated into the existing `resolveOptions()` step (step 2), or added as a separate new step between resolution and context building?
**Options**:
- A) Integrated: Add variant to the existing `resolveOptions()` flow in `resolver.ts`, treating it like any other option (projectName, agent, etc.)
- B) Separate step: Add a dedicated step 3 ("Resolve cluster variant") after option resolution but before GitHub validation, keeping variant logic isolated
**Answer**: **A (Integrated into resolveOptions)** — The variant follows the exact same priority chain as every other option: flag -> config -> prompt -> default. The existing `resolver.ts` already handles projectName, agent, baseBranch, releaseStream with this pattern. Adding variant is consistent and keeps resolution logic centralized.

---

### Q5: --yes with Re-init Variant Defaulting
**Context**: FR-001 says `--yes` defaults to "standard" variant. FR-018 says re-init reads the previously selected variant from config. These can conflict: if a user previously initialized with "microservices" and re-runs `generacy init --yes`, should they get "standard" (the --yes default) or "microservices" (their previous choice)?
**Question**: When `--yes` is used during re-initialization, which takes priority for variant selection: the `--yes` default ("standard") or the previously saved variant from `.generacy/config.yaml`?
**Options**:
- A) Config wins: Previously selected variant from config takes priority over the --yes default (consistent with how other options like projectName preserve existing values)
- B) Flag default wins: --yes always uses "standard" unless `--variant` is explicitly provided (simpler, more predictable)
- C) Explicit only: --yes uses the config value if present, otherwise "standard"; --variant flag always overrides both
**Answer**: **C (Explicit only)** — Config value takes priority if present, otherwise defaults to "standard"; `--variant` flag always overrides both. This is consistent with how `resolveOptions()` already handles other options — existing config values from `.generacy/config.yaml` are loaded as defaults via `loadExistingDefaults()`, and CLI flags always win. A user who previously chose "microservices" shouldn't have `--yes` silently downgrade them.

---

### Q6: Dockerfile Base Image Source
**Context**: The existing template context schema has a `devcontainer.baseImage` field (default: `mcr.microsoft.com/devcontainers/base:ubuntu`), and `withBaseImage()` allows overriding it. The cluster-templates Dockerfiles hardcode `mcr.microsoft.com/devcontainers/typescript-node:22-bookworm` as the base image. If the Dockerfile becomes a Handlebars template, should the base image be a substitutable variable or remain hardcoded in the cluster template?
**Question**: Should the Dockerfile base image in cluster templates be configurable via the existing `devcontainer.baseImage` context field, or fixed to the cluster-templates default?
**Options**:
- A) Fixed: Hardcode `typescript-node:22-bookworm` in the cluster Dockerfile templates (simpler, tested combination)
- B) Configurable: Make it a Handlebars variable `{{devcontainer.baseImage}}` with the cluster default, allowing override via context builders
- C) Per-variant defaults: Each variant defines its own default base image, but it's still overridable
**Answer**: **A (Fixed)** — Hardcode `typescript-node:22-bookworm` in cluster templates. The cluster Dockerfiles install specific tooling (gh CLI, Docker CE, Claude Code) tested against this base image. Making it configurable invites untested combinations for minimal benefit. Users who need a different base image can edit the generated Dockerfile post-init.

---

### Q7: Existing Devcontainer File Cleanup on Migration
**Context**: Users who previously ran `generacy init` have a `.devcontainer/devcontainer.json` (and possibly `.devcontainer/docker-compose.yml` for multi-repo). When re-running init with cluster templates, new files like `.devcontainer/Dockerfile`, `.devcontainer/scripts/`, and `.devcontainer/.env.template` will be added. But the old `devcontainer.json` content may be incompatible with the new cluster format (e.g., it references a direct image instead of docker-compose). The conflict resolution only handles files that exist in both old and new output.
**Question**: How should the migration path work for users upgrading from pre-cluster-templates to cluster-templates? Should old files that are incompatible be detected and removed/replaced?
**Options**:
- A) Overwrite only: Conflict resolution handles `devcontainer.json` normally (overwrite/skip/diff). Users manually clean up any orphaned files.
- B) Detect and warn: If old-format devcontainer.json is detected (e.g., has `image` key instead of `dockerComposeFile`), warn the user that the format is changing and recommend a full overwrite.
- C) Full replacement prompt: When migrating from old to new format, prompt the user to replace the entire `.devcontainer/` directory rather than per-file conflict resolution.
**Answer**: **B (Detect and warn)** — If the existing `devcontainer.json` has an `image` key (old format) and the user is generating cluster templates (which use `dockerComposeFile`), warn that the format is changing and recommend full overwrite. This respects user agency while clearly communicating the incompatibility. Users may have customizations in their `.devcontainer/` directory they want to preserve.

---

### Q8: Template Rendering Strategy for Shell Scripts
**Context**: The spec says "Static files (shell scripts) can remain as-is or use a lightweight substitution pass." The cluster-templates shell scripts reference environment variables at runtime (e.g., `$REPO_URL`, `$WORKER_COUNT`) which don't need build-time substitution. However, some scripts contain hardcoded values like paths (`/workspaces`) or tool versions that might benefit from being templateable. The decision affects complexity and maintainability.
**Question**: Should shell scripts be treated as static files (copied as-is) or as Handlebars templates with substitution?
**Options**:
- A) Static: Copy shell scripts verbatim from cluster-templates. Runtime env vars handle all configuration. Simplest approach.
- B) Handlebars: Convert all scripts to `.hbs` templates, allowing build-time substitution of paths, versions, and defaults alongside runtime env vars.
- C) Hybrid: Most scripts are static, but specific ones (e.g., `setup-credentials.sh`) use Handlebars for values known at init time (like repo URL defaults).
**Answer**: **A (Static)** — Copy shell scripts verbatim. The cluster-templates scripts already use runtime environment variables (`$REPO_URL`, `$WORKER_COUNT`, etc.) for all configuration. Treating shell scripts as Handlebars templates risks breaking bash syntax (e.g., `${VAR:-default}` conflicts with Handlebars `{{` delimiters) and adds complexity for zero gain.

---

### Q9: Generacy Dev Container Feature Interaction
**Context**: The current templates install Generacy via a Dev Container Feature (`ghcr.io/generacy-ai/features/generacy`), referenced in `devcontainer.json` with a feature tag (`:1` or `:preview` based on release stream). The cluster-templates Dockerfile installs the Generacy CLI directly via npm in a build stage. If both mechanisms are active, the CLI could be installed twice. The spec doesn't clarify whether cluster templates should continue using the Feature or rely solely on the Dockerfile installation.
**Question**: Should cluster-template devcontainer.json files include the Generacy Dev Container Feature, or rely solely on the Dockerfile's npm-based installation?
**Options**:
- A) Dockerfile only: Remove the Feature reference from cluster devcontainer.json; the Dockerfile handles CLI installation (avoids duplication, more control over version)
- B) Feature only: Keep the Feature in devcontainer.json; remove the npm install from the Dockerfile (consistent with current approach, Feature handles updates)
- C) Both with deduplication: Include the Feature but make the Dockerfile check if it's already installed before running npm install
**Answer**: **A (Dockerfile only)** — Cluster template `devcontainer.json` files should NOT include the Generacy Dev Container Feature. The Dockerfile already installs the Generacy CLI, Agency MCP server, and Claude Code. The Feature onboarding path is being deprecated in favor of cluster templates as the sole onboarding mechanism (see Q1).

---

### Q10: renderCluster API Relationship to renderProject
**Context**: The spec mentions adding a `renderCluster(variant, context)` export to `@generacy-ai/templates`, but doesn't specify how it relates to the existing `renderProject(context)` function. Currently `renderProject` renders all templates (config.yaml, extensions.json, devcontainer.json, docker-compose.yml). The new cluster templates add Dockerfile, .env.template, and scripts. It's unclear whether `renderCluster` is a standalone function or whether `renderProject` should be extended to handle cluster templates.
**Question**: Should `renderCluster` be a separate function called alongside `renderProject`, or should `renderProject` be extended to handle cluster templates based on a variant field in the context?
**Options**:
- A) Extend renderProject: Add variant to TemplateContext; `renderProject` selects and renders the appropriate cluster templates alongside shared templates (single entry point, consistent API)
- B) Separate renderCluster: `renderCluster(variant, context)` returns only cluster-specific files; the init command merges results from both `renderProject` (shared files) and `renderCluster` (cluster files)
- C) Replace renderProject: Create a new unified `renderInit(context)` that handles everything (shared + cluster), deprecating the current `renderProject`
**Answer**: **A (Extend renderProject)** — Add a `variant` field to `TemplateContext` and extend `selectTemplates(context)` to include cluster template sets when a variant is specified. This follows the same pattern as the current single-repo/multi-repo selection. The existing single-repo/multi-repo template paths should be marked for removal as cluster templates become the only path (per Q1). One entry point, consistent API, no duplicate rendering logic.

---

### Q11: Validation for Generated Cluster Files
**Context**: The templates package has validators for devcontainer.json, docker-compose.yml, and config.yaml. Cluster templates generate a Dockerfile and shell scripts that have no current validation. Invalid Dockerfiles or scripts won't be caught until the user tries to build the container, potentially wasting significant time. The spec's SC-005 says "Variable substitution produces valid YAML/JSON/Dockerfiles" but doesn't specify what Dockerfile validation looks like.
**Question**: What level of validation should be applied to generated Dockerfiles and shell scripts?
**Options**:
- A) Syntax check: Validate Dockerfile has required directives (FROM, valid stage names) and shell scripts have proper shebang lines
- B) Undefined variable check only: Reuse `findUndefinedVariables()` to catch unrendered `{{placeholders}}` in all generated files (lightweight, catches template errors)
- C) No additional validation: Trust that the bundled templates are correct; only validate YAML/JSON files as currently done
**Answer**: **B (Undefined variable check only)** — Reuse `findUndefinedVariables()` to scan all generated files for unrendered `{{placeholders}}`. This catches the highest-impact class of errors (template rendering failures) with minimal implementation cost. Full Dockerfile syntax validation is complex and low-value since the templates themselves are tested in the cluster-templates repo. JSON/YAML validators already cover config and devcontainer files.

---

### Q12: Worker Count and Orchestrator Port as Init-Time Options
**Context**: The spec lists `orchestrator.workerCount` (default 3) and `orchestrator.port` (default 3100) in the variable substitution table and explicitly says "Worker count configuration during init" is out of scope. However, these values end up in generated `.env.template` and `docker-compose.yml` files. If they're only in `.env.template`, users edit them later. But if they're baked into `docker-compose.yml` via Handlebars substitution, the generated file has a specific default that's harder to change without re-running init.
**Question**: Should worker count and orchestrator port be rendered as Handlebars variables in docker-compose.yml (baked in at generation time), or should docker-compose.yml reference them as runtime environment variables (e.g., `${WORKER_COUNT:-3}`)?
**Options**:
- A) Runtime env vars: docker-compose.yml uses `${WORKER_COUNT:-3}` and `${ORCHESTRATOR_PORT:-3100}` syntax, so users change values in .env without re-running init
- B) Baked in: Handlebars substitution writes the actual values into docker-compose.yml at generation time (matches spec's variable substitution table)
- C) Hybrid: Worker count uses runtime env var (frequently changed), port is baked in (rarely changed)
**Answer**: **A (Runtime env vars)** — Use `${WORKER_COUNT:-3}` and `${ORCHESTRATOR_PORT:-3100}` in docker-compose.yml. This is already the pattern used in the cluster-templates repo. Users change values in `.env` without re-running init. The spec noting these as "out of scope" for init-time options aligns perfectly — they're runtime configuration, not generation-time decisions.
