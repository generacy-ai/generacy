# Clarification Questions

## Status: Resolved

## Questions

### Q1: Project ID Format and Validation
**Context**: The spec mentions project IDs like "proj_abc123" but doesn't specify the exact format, length constraints, or character requirements. This affects validation rules and error messages.

**Question**: What is the exact format specification for project IDs issued by generacy.ai?

**Options**:
- A) Prefix-based format: Fixed prefix `proj_` followed by alphanumeric characters (e.g., `proj_abc123xyz`, min 12 chars total)
- B) UUID format: Standard UUID v4 format (e.g., `550e8400-e29b-41d4-a716-446655440000`)
- C) Flexible format: Any non-empty string accepted (validation only checks non-empty)
- D) Custom format: Specify exact pattern (prefix, length, allowed characters)

**Answer**: **Option A** — Prefix-based format: `proj_` prefix followed by alphanumeric characters. This follows common SaaS patterns (Stripe uses `cus_`, `sub_`, etc.), makes IDs instantly recognizable, and is URL-safe. The existing codebase already uses a similar pattern (`projectId: 'project-123'` in workflow test fixtures). IDs are server-issued by generacy.ai, so the CLI only needs to validate the format, not generate them.

---

### Q2: Repository Authentication Handling
**Context**: The config specifies repository URLs but doesn't address authentication. Dev containers need to clone repositories, which may be private and require credentials.

**Question**: How should authentication for repository access be handled during clone operations?

**Options**:
- A) SSH keys: Assume SSH agent forwarding, repos specified as `github.com/org/repo` are converted to `git@github.com:org/repo.git`
- B) Personal access tokens: Read from `.generacy/generacy.env` or environment variables for HTTPS cloning
- C) Both methods: Support both SSH and HTTPS, auto-detect based on available credentials
- D) Out of scope: Authentication is handled externally, config only stores repo identifiers

**Answer**: **Option D** — Out of scope. Config stores repo identifiers only. Auth is handled at runtime: the orchestrator uses GitHub App installation tokens (from generacy-cloud), and local dev uses credentials from `generacy.env` (`GITHUB_TOKEN`). The existing orchestrator already follows this pattern — `RepositoryConfigSchema` only stores `owner`/`repo`, not credentials.

---

### Q3: Primary Repository Self-Reference
**Context**: The spec shows `repos.primary` as a field, but it's unclear if this should reference the current repository or always a different one.

**Question**: Can `repos.primary` reference the same repository where the config file lives, or must it always be a different repository?

**Options**:
- A) Always self-reference: For single-repo projects, `repos.primary` should be the current repo (e.g., detected from git remote)
- B) Always external: `repos.primary` must be a different repository (current repo is implicit)
- C) Either allowed: Can be self-reference or external, both are valid configurations
- D) Optional field: `repos.primary` is optional when working in single-repo mode

**Answer**: **Option A** — Always self-reference. The `.generacy/config.yaml` lives in the primary repo (placed there by the onboarding PR). So `repos.primary` is always the repo where the config resides. It's still valuable to include explicitly so that external tools/services reading the config can identify which repo they're looking at without needing git context.

---

### Q4: Agent Name Validation
**Context**: FR-006 mentions valid values like `claude-code`, `claude-opus`, and "custom agent names" but doesn't define what makes a valid custom agent name or how they're registered.

**Question**: How should agent names be validated and what constitutes a valid agent identifier?

**Options**:
- A) Predefined list: Only specific agent names from a known registry (reject unknown names at validation time)
- B) Format-only validation: Any kebab-case string (alphanumeric + hyphens, e.g., `custom-agent-v2`) is valid
- C) No validation: Accept any non-empty string as agent name (validation happens at orchestrator runtime)
- D) Prefix convention: Built-in agents like `claude-*`, custom agents must use different prefix (e.g., `custom-*`)

**Answer**: **Option B** — Format-only validation: Any kebab-case string (alphanumeric + hyphens). The existing codebase uses string identifiers for agents with no registry. Kebab-case validation (`/^[a-z0-9]+(-[a-z0-9]+)*$/`) is pragmatic — it prevents obviously invalid names while allowing custom agents to be added without config schema changes.

---

### Q5: Base Branch Existence Validation
**Context**: The config specifies `defaults.baseBranch` but doesn't clarify whether this branch must exist at validation time or if it's just a string reference.

**Question**: Should the CLI validate that `defaults.baseBranch` exists in the repository during config validation?

**Options**:
- A) No validation: Accept any branch name string, validation happens when orchestrator creates PRs
- B) Warning only: Check if branch exists and warn if not found, but don't fail validation
- C) Strict validation: Fail config validation if branch doesn't exist in the repository
- D) Remote check: Validate against remote repository (requires network call during config load)

**Answer**: **Option A** — No validation. Accept any branch name string. The config might be created before the branch exists (e.g., a team setting `baseBranch: main` while still on `develop`). Validation happens at PR creation time in the orchestrator, which is the correct moment to fail.

---

### Q6: Repository URL Duplication
**Context**: The schema allows the same repository to appear in multiple lists (primary, dev, clone). This could lead to unclear workspace setups.

**Question**: Should the same repository be allowed to appear in multiple repo lists (e.g., in both `repos.dev` and `repos.clone`)?

**Options**:
- A) Forbid duplicates: Validation error if same repo appears in multiple lists
- B) Allow duplicates: Dev container setup determines precedence (dev takes priority over clone)
- C) Warning only: Warn about duplicates but allow them (last occurrence wins)
- D) Merge semantics: If repo appears in multiple lists, merge their properties (dev + clone = dev with special flag)

**Answer**: **Option A** — Forbid duplicates. A repo in both `dev` and `clone` is semantically contradictory — dev implies active development, clone implies read-only reference. Validation should reject this with a clear error. This matches the buildout plan's clear distinction between the two categories.

---

### Q7: Config File Change Detection
**Context**: The "Out of Scope" section mentions "Config changes require orchestrator restart (no hot-reloading in Phase 1)" but doesn't specify how changes are detected or communicated.

**Question**: When the config file changes (e.g., via merged PR), how should running services be notified?

**Options**:
- A) Manual restart: Developers must manually restart orchestrator after config changes (documented requirement)
- B) File watching: Orchestrator watches config file and logs warning when changed (requires restart)
- C) Graceful shutdown: Orchestrator detects change, completes current work, then exits (container orchestration restarts it)
- D) Not applicable: Config changes are rare enough that no special handling is needed (phase 1 scope)

**Answer**: **Option A** — Manual restart. Phase 1 explicitly scopes this out: "Config changes require orchestrator restart (no hot-reloading in Phase 1)." Manual restart is the right answer. Document it clearly in the Getting Started guide (Epic 6).

---

### Q8: Config Discovery in Monorepo
**Context**: The discovery logic "walks up directory tree until `.generacy/config.yaml` found" but doesn't address monorepo scenarios where multiple packages might have different contexts.

**Question**: In a monorepo with multiple packages, should there be one config at the root or multiple configs?

**Options**:
- A) Single root config: Only one `.generacy/config.yaml` at repository root (all packages share same config)
- B) Per-package configs: Each package can have its own `.generacy/config.yaml` (first found wins during discovery)
- C) Hierarchical merge: Root config + package-specific overrides (merge semantics defined)
- D) Explicit only: No directory walking in monorepos, require `GENERACY_CONFIG_PATH` environment variable

**Answer**: **Option A** — Single root config. The config represents a *project*, not a package. In a monorepo, all packages are part of the same Generacy project. One config at the repo root. This is consistent with the onboarding PR template which places `.generacy/` at the repository root.

---

### Q9: Repository List Order Semantics
**Context**: The `repos.dev` and `repos.clone` arrays preserve order, but it's unclear if order matters for clone operations, workspace setup, or priority resolution.

**Question**: Does the order of repositories in `repos.dev` and `repos.clone` arrays have semantic meaning?

**Options**:
- A) Clone order: Repositories are cloned in the order listed (matters for dependency setup)
- B) No semantics: Order is arbitrary, cloning happens in parallel or alphabetically
- C) Priority order: First entry has highest priority for conflict resolution or imports
- D) UI display order: Order only affects how repos are displayed in tools/dashboards

**Answer**: **Option B** — No semantics. Repos are cloned independently. The buildout plan doesn't describe any ordering dependencies between repos. Order may be preserved for UI display but shouldn't affect runtime behavior. Parallel cloning should be possible.

---

### Q10: Orchestrator Settings Scope
**Context**: The spec states "Orchestrator settings apply to entire project (not per-workflow overrides)" but doesn't clarify if these settings can differ between development and production deployments.

**Question**: Should orchestrator settings in the config apply to all environments or just development?

**Options**:
- A) Development only: Config settings apply to local dev containers, production uses separate deployment config
- B) All environments: Same config values used in dev, staging, and production (single source of truth)
- C) Environment variable overrides: Config provides defaults, but can be overridden by env vars in production
- D) Deployment-specific: Separate mechanism for production orchestrator settings (not in config.yaml)

**Answer**: **Option C** — Environment variable overrides. This aligns with the existing pattern. The orchestrator already reads config from YAML with env var overrides (see `packages/orchestrator/src/config/loader.ts`). The `.generacy/config.yaml` provides sensible development defaults; production deployments override via environment variables (`ORCHESTRATOR_*` prefix).

---

### Q11: Project Name Uniqueness and Constraints
**Context**: FR-002 requires `project.name` for "human-readable identification" but doesn't specify constraints on length, characters, or uniqueness requirements.

**Question**: What are the validation rules for `project.name`?

**Options**:
- A) Minimal constraints: Any non-empty string up to 255 characters, no uniqueness required
- B) Display-safe: Limit to alphanumeric + spaces/hyphens, 1-100 characters, no uniqueness check
- C) Unique per organization: Name must be unique within the organization's generacy.ai projects
- D) Globally unique: Name must be globally unique across all generacy.ai projects

**Answer**: **Option A** — Minimal constraints. Non-empty string, max 255 characters. No uniqueness required — the project ID handles uniqueness. Project names are purely for human readability in the dashboard and CLI output. Keep validation simple.

---

### Q12: Config Schema Version Management
**Context**: FR-015 mentions "Schema must support future extensibility without breaking changes" but doesn't specify how schema versions are tracked or migrated.

**Question**: Should the config file include a schema version field for future migration support?

**Options**:
- A) No version field: Schema is implicitly "v1", future versions use different file names or detection logic
- B) Optional version field: Add `schemaVersion: "1.0"` field, optional in v1 (becomes required in v2+)
- C) Required from start: Include `version: "1"` as required field now for future-proofing
- D) File format version: Use YAML tags or directives to indicate schema version (e.g., `!generacy/v1`)

**Answer**: **Option B** — Optional version field. Include `schemaVersion: "1"` in all generated configs (from the onboarding PR and `generacy init`). If omitted, default to `"1"`. This is zero-cost future-proofing — when v2 comes, the migration path is clear, and existing v1 configs work without modification.

---

### Q13: Invalid Repository URL Handling
**Context**: FR-012 validates repo URL format but doesn't specify behavior when a valid-format URL points to a non-existent or inaccessible repository.

**Question**: Should config validation check that repository URLs are accessible and exist?

**Options**:
- A) Format only: Only validate URL format at config load time, don't check accessibility
- B) Lazy validation: Check accessibility when actually cloning (fail at clone time, not config load)
- C) Startup validation: On orchestrator/CLI startup, verify all repos are accessible (fail fast)
- D) Warning mode: Attempt to check accessibility, warn if unreachable but don't fail validation

**Answer**: **Option A** — Format only. Validate URL format at config load time. Don't require network access to validate a config file. Accessibility checks happen when the orchestrator or CLI actually tries to clone. This keeps config loading fast and offline-capable.

---

### Q14: Empty Repository Lists Behavior
**Context**: US2 states "Config supports 0..N dev repos and 0..N clone-only repos" but doesn't clarify if empty lists have special meaning or if the fields can be omitted.

**Question**: How should empty or omitted repository lists be interpreted?

**Options**:
- A) Omit equals empty: Missing `repos.dev` field is equivalent to `repos.dev: []` (empty array)
- B) Explicit empty required: If no repos, must explicitly specify `repos.dev: []` (cannot omit field)
- C) Null vs empty: Distinguish between omitted (null), empty array `[]`, and undefined behavior
- D) Single-repo mode: Omitted dev/clone lists trigger single-repo configuration mode with different behavior

**Answer**: **Option A** — Omit equals empty. Missing `repos.dev` field is equivalent to `repos.dev: []` (empty array). This is standard YAML/schema convention and the most ergonomic for single-repo projects where the developer has no additional repos to list.

---

### Q15: CLI Package Location and Import Path
**Context**: FR-017 mentions "Generacy CLI must export config type definitions" and examples show `@generacy-ai/generacy/config`, but the actual package structure isn't defined.

**Question**: What is the npm package structure for the Generacy CLI and where should config exports live?

**Options**:
- A) Single package: `@generacy-ai/generacy` with subpath exports (`@generacy-ai/generacy/config`)
- B) Multiple packages: Separate packages like `@generacy-ai/cli` and `@generacy-ai/config`
- C) Monorepo packages: `@generacy/cli`, `@generacy/config`, `@generacy/types` in a monorepo
- D) Not specified yet: Package structure is defined in a separate spec (reference needed)

**Answer**: **Option A** — Single package with subpath exports. `@generacy-ai/generacy/config` as shown in the buildout plan. The `packages/generacy` package already exists as the CLI entry point. Subpath exports keep the config types co-located with the CLI validation logic while allowing other consumers (orchestrator, VS Code extension, generacy-cloud) to import just the types without the full CLI.

