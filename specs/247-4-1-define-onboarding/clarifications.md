# Clarification Questions

## Status: Resolved

## Questions

### Q1: Template Rendering Library Selection
**Context**: The spec mentions using a template engine (Handlebars, Mustache, or custom) for variable substitution and conditionals. The choice affects maintenance burden, template syntax, and whether templates can be rendered client-side (in generacy.ai web UI) or server-side only.

**Question**: Which template rendering library should be used for variable substitution and conditional logic?

**Options**:
- A) Handlebars: Full-featured with helpers, conditionals, loops. Popular but larger dependency. Syntax: `{{#each}}`, `{{#if}}`.
- B) Mustache: Simpler, logic-less, smaller footprint. Limited conditionals. Syntax: `{{#list}}`, `{{^inverted}}`.
- C) Custom implementation: Maximum control, minimal dependencies. Requires writing and maintaining custom parser for `{{variable.path}}` syntax.
- D) Template literals (JS): Use ES6 template strings with a function wrapper. Simple but requires escaping for JSON/YAML special characters.

**Answer**: **A) Handlebars**

The existing codebase uses simple regex replacement for workflow templates, but onboarding templates need conditionals (single vs multi-repo), loops (iterating repo lists in config.yaml), and nested variable paths. Handlebars provides all of this with a well-known syntax. It works both server-side (generacy-cloud PR generation) and in the CLI (`generacy init`). Mustache is too limited for the conditional file logic we need. Custom is unnecessary maintenance burden.

---

### Q2: Conditional Template File Inclusion Strategy
**Context**: The spec mentions conditional inclusion (e.g., docker-compose.yml only for multi-repo projects) but doesn't specify how this is implemented. This affects whether we maintain two complete template sets or use conditional blocks within files.

**Question**: How should conditional file inclusion be implemented for single-repo vs multi-repo variants?

**Options**:
- A) Separate template directories: Maintain `single-repo/` and `multi-repo/` directories with complete file sets. Simple but duplicates common files.
- B) Conditional blocks within templates: Use template conditionals (`{{#if multi-repo}}`) within files. Single source of truth but more complex templates.
- C) Hybrid approach: Separate devcontainer.json and docker-compose.yml, shared config.yaml and extensions.json. Balances duplication and complexity.

**Answer**: **C) Hybrid approach**

The files that differ substantially between single-repo and multi-repo are `devcontainer.json` and `docker-compose.yml` (which only exists for multi-repo). The shared files — `config.yaml`, `generacy.env.template`, `extensions.json`, `.gitignore` — are identical or nearly so. Maintain separate `devcontainer.json` variants, conditionally include `docker-compose.yml`, and share everything else. This avoids full duplication while keeping templates readable.

---

### Q3: .gitignore Patch Strategy
**Context**: The spec includes `.gitignore.patch` files but doesn't specify how to handle cases where .gitignore doesn't exist, already contains the entry, or has conflicting patterns.

**Question**: How should the .gitignore update be handled in the generated PR?

**Options**:
- A) Append-only: Always append `.generacy/generacy.env` to .gitignore, create file if missing. Simple but may create duplicates.
- B) Smart merge: Check if entry exists before adding. Create file if missing. Requires PR generation service to parse .gitignore.
- C) Separate .generacy/.gitignore: Add a `.generacy/.gitignore` file containing `generacy.env`. Avoids modifying user's .gitignore but requires Git 2.x features.
- D) Manual instruction only: Include instructions in PR body for user to add entry manually. No automated modification.

**Answer**: **C) Separate `.generacy/.gitignore`**

Add a `.generacy/.gitignore` containing `generacy.env`. This is scoped, doesn't touch the user's root `.gitignore`, and avoids any merge/duplication logic. Git 2.x is universal and supports nested `.gitignore` files. This is the cleanest approach with zero risk of conflicting with existing patterns.

---

### Q4: Feature Tag Selection Logic
**Context**: FR-013 mentions templates should reference `:preview` or `:1` tags based on "release stream" but doesn't define how this is determined or exposed in project configuration.

**Question**: How should the Dev Container Feature tag (`:preview` vs `:1`) be selected for each project?

**Options**:
- A) Project-level setting: Add `releaseStream: "stable" | "preview"` to project configuration during creation on generacy.ai.
- B) Always stable: Default all projects to `:1` (stable) tag. Users can manually edit devcontainer.json to use `:preview`.
- C) User choice during onboarding: Ask user during project creation which release stream they prefer.
- D) Environment-based: Use `:preview` for dev environments, `:1` for production, determined by branch or environment variable.

**Answer**: **A) Project-level setting**

Add `releaseStream: "stable" | "preview"` to the project configuration, defaulting to `stable` (`:1` tag). The project creation wizard on generacy.ai already has multiple steps — this fits naturally as a setting. Early adopters and beta testers can opt into `:preview`. This keeps it explicit and auditable per-project rather than buried in environment logic.

---

### Q5: Base Image Configuration
**Context**: FR-011 requires language-agnostic templates, suggesting `mcr.microsoft.com/devcontainers/base:ubuntu`, but different languages benefit from different base images. The spec doesn't specify if users select this during onboarding or customize post-merge.

**Question**: How should the base image be determined for new projects?

**Options**:
- A) Always Ubuntu base: Use generic Ubuntu base in templates. Documentation guides customization. Simple but requires post-onboarding work.
- B) Language selection during creation: Ask user for primary language during project creation on generacy.ai, use appropriate base image (e.g., `mcr.microsoft.com/devcontainers/python:3.11`).
- C) Auto-detect from repo: PR generation service scans primary repo for package.json, requirements.txt, etc. and selects base image. Smart but complex.
- D) Template variable: Include `{{base.image}}` variable with sensible default, allow override via API/UI during project creation.

**Answer**: **D) Template variable with sensible default**

Use `{{baseImage}}` in the devcontainer.json template with a default of `mcr.microsoft.com/devcontainers/base:ubuntu`. The devcontainer feature already handles installing all Generacy tooling on top of any Debian/Ubuntu base. The project creation API can optionally accept a base image override, and the project detail page can expose it for editing later. Auto-detection is over-engineering for MVP.

---

### Q6: Multi-Repo Worker Volume Mounts
**Context**: The docker-compose.yml example shows orchestrator mounting `workspace:/workspace` but workers don't have explicit workspace mounts. Unclear if workers need access to cloned repos or only orchestrator does.

**Question**: What volumes should worker containers mount in multi-repo configurations?

**Options**:
- A) Workers mount workspace: Workers get `workspace:/workspace` read-only. Allows workers to read cloned repos but not modify.
- B) Workers mount workspace read-write: Same as orchestrator. Allows workers to make changes across repos.
- C) Workers have no workspace mount: Workers only access code via Redis/API from orchestrator. Orchestrator handles all file operations.
- D) Configurable per project: Add `orchestrator.workerVolumeAccess: "none" | "readonly" | "readwrite"` to config.yaml template.

**Answer**: **C) Workers have no shared workspace mount**

Looking at the existing tetrad-development docker-compose, workers clone repos independently via `REPO_URL` and `REPO_BRANCH` env vars. Each worker gets assigned an issue, clones the relevant repo into its own ephemeral workspace, does the work, commits, and pushes. No shared volume with the orchestrator. This avoids conflicts between concurrent workers and matches the existing proven architecture.

---

### Q7: Repository URL Format
**Context**: Template examples show repos as `github.com/acme/main-api` but Git URLs can be HTTPS (`https://github.com/...`), SSH (`git@github.com:...`), or shorthand. Unclear which format is expected/supported.

**Question**: What repository URL format should be used in config.yaml templates?

**Options**:
- A) HTTPS URLs: `https://github.com/owner/repo`. Explicit and works with tokens. Verbose.
- B) Shorthand: `github.com/owner/repo` or `owner/repo`. Concise. Requires CLI/service to expand to full URLs.
- C) Git URLs: `git@github.com:owner/repo.git`. Traditional Git format. Requires SSH keys.
- D) Flexible: Support all formats, normalize during parsing. User-friendly but requires more validation logic.

**Answer**: **B) Shorthand `owner/repo`**

Since Generacy is GitHub-first and the GitHub App provides all auth context, `owner/repo` is concise and natural. The CLI and cloud service can expand to full HTTPS URLs using the GitHub App installation token. This matches how developers think about GitHub repos and keeps config files clean.

---

### Q8: Environment Variable Validation
**Context**: FR-002 requires `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` in generacy.env.template, but doesn't specify if these are validated, where validation happens, or how to handle missing/invalid values.

**Question**: How should environment variable validation be handled for the generated configuration?

**Options**:
- A) No validation in templates: Templates only provide examples. Validation happens at runtime when dev container starts or CLI runs.
- B) CLI validation: `generacy doctor` command validates presence and format of required env vars. Fails with helpful error messages.
- C) Dev Container Feature validation: The Feature itself validates on container start and displays errors in VS Code UI.
- D) Optional validation service: PR includes a validation script users can run: `./generacy/validate-env.sh`.

**Answer**: **B) CLI validation via `generacy doctor`**

This aligns directly with issue #254 (`generacy doctor`) which is already planned. Templates should stay simple — just provide the `.env.template` with comments explaining each variable. Validation happens at runtime when the user runs `generacy doctor`, which gives clear pass/fail output with fix suggestions. The devcontainer feature can also do basic checks on container start.

---

### Q9: Orchestrator Poll Interval and Worker Count Defaults
**Context**: Template variables include `{{orchestrator.pollIntervalMs}}` and `{{orchestrator.workerCount}}` but doesn't specify recommended defaults or acceptable ranges.

**Question**: What are the default values and acceptable ranges for orchestrator settings?

**Options**:
- A) Conservative defaults: `pollIntervalMs: 10000` (10s), `workerCount: 1`. Safe for all systems but slower.
- B) Balanced defaults: `pollIntervalMs: 5000` (5s), `workerCount: 3`. Good performance for most projects.
- C) Aggressive defaults: `pollIntervalMs: 2000` (2s), `workerCount: 5`. Fast but higher resource usage.
- D) Project-type based: Small projects (1-3 repos) get `workerCount: 1`, large projects (4+ repos) get `workerCount: 3`. Poll interval fixed at 5000ms.

**Answer**: **B) Balanced defaults: `pollIntervalMs: 5000`, `workerCount: 3`**

These are the exact values shown in the buildout plan's config.yaml example, and the existing tetrad standalone docker-compose also defaults to 3 workers. 5s polling is responsive without hammering the API. 3 workers handles typical parallel workloads. Users can tune these in config.yaml after onboarding.

---

### Q10: PR Target Branch Strategy
**Context**: Spec assumes "onboarding PR will target the default branch" but doesn't specify how to handle repos where default branch has protection rules (require reviews, CI checks) that would block auto-merge.

**Question**: How should the PR target branch be determined, especially for repos with branch protection?

**Options**:
- A) Always default branch: Target repo's default branch (main/master). User handles any branch protection manually.
- B) Detect and create setup branch: If default branch has protection, create PR targeting `generacy-setup` branch. User merges to default later.
- C) User choice during creation: Let user specify target branch during project creation on generacy.ai.
- D) Smart detection: Check if default branch is protected via GitHub API. If protected, ask user for target branch. If not, use default.

**Answer**: **A) Always default branch**

The onboarding PR is a one-time setup that the developer manually reviews and merges. They understand their own branch protection rules. Adding complexity to detect protection or prompt for alternatives is unnecessary — the developer can always retarget the PR themselves in GitHub's UI if needed. Keep the automation simple.

---

### Q11: Timestamp Format and Timezone
**Context**: Template example includes `{{timestamp}}` variable but doesn't specify format (ISO 8601, Unix, human-readable) or timezone (UTC, user's local, server).

**Question**: What format should the timestamp variable use in generated templates?

**Options**:
- A) ISO 8601 UTC: `2026-02-24T15:30:00Z`. Unambiguous, machine-readable.
- B) Human-readable UTC: `February 24, 2026 at 3:30 PM UTC`. User-friendly but longer.
- C) ISO 8601 local: `2026-02-24T10:30:00-05:00`. Shows user's timezone but assumes server knows it.
- D) Unix timestamp: `1740407400`. Machine-readable but not human-friendly.

**Answer**: **A) ISO 8601 UTC (`2026-02-24T15:30:00Z`)**

Standard, unambiguous, machine-readable. This appears in config metadata and PR descriptions, not in user-facing dashboards. ISO 8601 UTC is the universal choice for generated configuration files.

---

### Q12: Template Storage Location and Versioning
**Context**: Spec says templates stored in `generacy/templates/` but doesn't specify if this is the main generacy repo, generacy-cloud repo, or a separate templates repo. Also unclear how template versioning works when schema changes.

**Question**: Where should template files be stored and how should they be versioned?

**Options**:
- A) Main generacy repo: Store in `generacy/packages/templates/`. Versioned with main repo releases. Simple but couples templates to CLI.
- B) Generacy-cloud repo: Store in `generacy-cloud/templates/`. Versioned with cloud service. Decoupled but complicates CLI-only usage.
- C) Separate templates repo: Create `generacy-templates` repo. Versioned independently with semver tags. Maximum flexibility but adds maintenance overhead.
- D) Embedded in multiple repos: Templates in both generacy (for CLI) and generacy-cloud (for web service). Risk of drift but allows independent operation.

**Answer**: **A) Main generacy repo (`packages/templates/`)**

Templates need to be consumable by both the CLI (`generacy init`) and the cloud service (PR generation). Storing in `generacy/packages/templates/` means they're published as an npm package the cloud service can depend on, directly available to the CLI, and publicly visible to adopters. This follows the existing pattern where the generacy repo already contains workflow templates in `packages/generacy-extension/resources/templates/`.

---

### Q13: Extensions.json Merge Strategy
**Context**: Most projects already have `.vscode/extensions.json` with their own recommendations. Spec doesn't specify how to handle adding Generacy extensions to existing recommendations.

**Question**: How should .vscode/extensions.json be updated if it already exists?

**Options**:
- A) Replace entirely: Overwrite existing extensions.json with Generacy recommendations. Simple but loses existing recommendations.
- B) Append to recommendations array: Parse existing JSON, add Generacy extensions if not present. Safe but requires JSON parsing in PR service.
- C) Create .vscode/extensions.generacy.json: Separate file for Generacy-specific extensions. Avoids conflicts but non-standard.
- D) Manual instruction: Don't modify existing file, include instructions in PR body for user to add extensions manually.

**Answer**: **B) Append to recommendations array**

Parse the existing `.vscode/extensions.json`, add Generacy extension IDs (`generacy-ai.agency`, `generacy-ai.generacy`) to the `recommendations` array if not already present. If no file exists, create it. JSON parsing is trivial, and this preserves the developer's existing extension recommendations. Much better UX than replacing or requiring manual edits.

---

### Q14: Redis Persistence Configuration
**Context**: Docker-compose.yml includes Redis service but doesn't specify persistence settings. Unclear if Redis data should persist across container restarts or be ephemeral.

**Question**: Should Redis data persist across dev container restarts in multi-repo configurations?

**Options**:
- A) Ephemeral (no persistence): Redis data lost on restart. Simpler, avoids stale data issues.
- B) Persistent volume: Mount Redis data directory to named volume. Preserves queue state across restarts.
- C) RDB snapshots only: Redis saves periodic snapshots to volume. Balance between persistence and performance.
- D) Configurable: Add `orchestrator.redisPersistence: boolean` to config.yaml template, default false.

**Answer**: **A) Ephemeral (no persistence)**

For a dev container, the orchestrator rescans open GitHub issues on startup and repopulates the work queue. Persisting stale queue data across restarts could actually cause issues (duplicate work, stale references). The existing tetrad standalone compose doesn't persist Redis data. Keep it simple — ephemeral is the right default for development environments.

---

### Q15: Dev vs Clone Repo Distinction Clarity
**Context**: Config.yaml distinguishes between `repos.dev` (active development) and `repos.clone` (reference only) but doesn't specify how this affects the dev container setup or orchestrator behavior.

**Question**: How should dev repos and clone-only repos be treated differently in the generated dev container?

**Options**:
- A) All cloned equally: Both dev and clone repos cloned to workspace. No behavioral difference. User discipline determines usage.
- B) Clone repos read-only: Clone repos mounted/cloned as read-only in workspace. Dev repos read-write.
- C) Clone repos in separate directory: Dev repos in `/workspace/dev/`, clone repos in `/workspace/reference/`. Clear separation.
- D) Dev repos only in worker scope: Workers only access dev repos. Clone repos only accessible from orchestrator. Enforces separation.

**Answer**: **A) All cloned equally (into `/workspaces/`)**

All repos — primary, dev, and clone — are cloned side-by-side under `/workspaces/` (e.g., `/workspaces/main-api/`, `/workspaces/shared-lib/`, `/workspaces/design-system/`). This matches the existing tetrad-development pattern where all repos live as siblings under `/workspaces/`. The distinction between dev and clone is enforced at the orchestrator/worker level — workers only create branches and PRs on repos listed in `repos.dev`, while `repos.clone` are available for agent context but not targeted for modifications. No directory-level separation needed.

