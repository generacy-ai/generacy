# Clarification Questions

## Status: Pending

## Questions

### Q1: Project ID Format and Validation
**Context**: The spec mentions project IDs like "proj_abc123" but doesn't specify the exact format, length constraints, or character requirements. This affects validation rules and error messages.

**Question**: What is the exact format specification for project IDs issued by generacy.ai?

**Options**:
- A) Prefix-based format: Fixed prefix `proj_` followed by alphanumeric characters (e.g., `proj_abc123xyz`, min 12 chars total)
- B) UUID format: Standard UUID v4 format (e.g., `550e8400-e29b-41d4-a716-446655440000`)
- C) Flexible format: Any non-empty string accepted (validation only checks non-empty)
- D) Custom format: Specify exact pattern (prefix, length, allowed characters)

**Answer**:

---

### Q2: Repository Authentication Handling
**Context**: The config specifies repository URLs but doesn't address authentication. Dev containers need to clone repositories, which may be private and require credentials.

**Question**: How should authentication for repository access be handled during clone operations?

**Options**:
- A) SSH keys: Assume SSH agent forwarding, repos specified as `github.com/org/repo` are converted to `git@github.com:org/repo.git`
- B) Personal access tokens: Read from `.generacy/generacy.env` or environment variables for HTTPS cloning
- C) Both methods: Support both SSH and HTTPS, auto-detect based on available credentials
- D) Out of scope: Authentication is handled externally, config only stores repo identifiers

**Answer**:

---

### Q3: Primary Repository Self-Reference
**Context**: The spec shows `repos.primary` as a field, but it's unclear if this should reference the current repository or always a different one.

**Question**: Can `repos.primary` reference the same repository where the config file lives, or must it always be a different repository?

**Options**:
- A) Always self-reference: For single-repo projects, `repos.primary` should be the current repo (e.g., detected from git remote)
- B) Always external: `repos.primary` must be a different repository (current repo is implicit)
- C) Either allowed: Can be self-reference or external, both are valid configurations
- D) Optional field: `repos.primary` is optional when working in single-repo mode

**Answer**:

---

### Q4: Agent Name Validation
**Context**: FR-006 mentions valid values like `claude-code`, `claude-opus`, and "custom agent names" but doesn't define what makes a valid custom agent name or how they're registered.

**Question**: How should agent names be validated and what constitutes a valid agent identifier?

**Options**:
- A) Predefined list: Only specific agent names from a known registry (reject unknown names at validation time)
- B) Format-only validation: Any kebab-case string (alphanumeric + hyphens, e.g., `custom-agent-v2`) is valid
- C) No validation: Accept any non-empty string as agent name (validation happens at orchestrator runtime)
- D) Prefix convention: Built-in agents like `claude-*`, custom agents must use different prefix (e.g., `custom-*`)

**Answer**:

---

### Q5: Base Branch Existence Validation
**Context**: The config specifies `defaults.baseBranch` but doesn't clarify whether this branch must exist at validation time or if it's just a string reference.

**Question**: Should the CLI validate that `defaults.baseBranch` exists in the repository during config validation?

**Options**:
- A) No validation: Accept any branch name string, validation happens when orchestrator creates PRs
- B) Warning only: Check if branch exists and warn if not found, but don't fail validation
- C) Strict validation: Fail config validation if branch doesn't exist in the repository
- D) Remote check: Validate against remote repository (requires network call during config load)

**Answer**:

---

### Q6: Repository URL Duplication
**Context**: The schema allows the same repository to appear in multiple lists (primary, dev, clone). This could lead to unclear workspace setups.

**Question**: Should the same repository be allowed to appear in multiple repo lists (e.g., in both `repos.dev` and `repos.clone`)?

**Options**:
- A) Forbid duplicates: Validation error if same repo appears in multiple lists
- B) Allow duplicates: Dev container setup determines precedence (dev takes priority over clone)
- C) Warning only: Warn about duplicates but allow them (last occurrence wins)
- D) Merge semantics: If repo appears in multiple lists, merge their properties (dev + clone = dev with special flag)

**Answer**:

---

### Q7: Config File Change Detection
**Context**: The "Out of Scope" section mentions "Config changes require orchestrator restart (no hot-reloading in Phase 1)" but doesn't specify how changes are detected or communicated.

**Question**: When the config file changes (e.g., via merged PR), how should running services be notified?

**Options**:
- A) Manual restart: Developers must manually restart orchestrator after config changes (documented requirement)
- B) File watching: Orchestrator watches config file and logs warning when changed (requires restart)
- C) Graceful shutdown: Orchestrator detects change, completes current work, then exits (container orchestration restarts it)
- D) Not applicable: Config changes are rare enough that no special handling is needed (phase 1 scope)

**Answer**:

---

### Q8: Config Discovery in Monorepo
**Context**: The discovery logic "walks up directory tree until `.generacy/config.yaml` found" but doesn't address monorepo scenarios where multiple packages might have different contexts.

**Question**: In a monorepo with multiple packages, should there be one config at the root or multiple configs?

**Options**:
- A) Single root config: Only one `.generacy/config.yaml` at repository root (all packages share same config)
- B) Per-package configs: Each package can have its own `.generacy/config.yaml` (first found wins during discovery)
- C) Hierarchical merge: Root config + package-specific overrides (merge semantics defined)
- D) Explicit only: No directory walking in monorepos, require `GENERACY_CONFIG_PATH` environment variable

**Answer**:

---

### Q9: Repository List Order Semantics
**Context**: The `repos.dev` and `repos.clone` arrays preserve order, but it's unclear if order matters for clone operations, workspace setup, or priority resolution.

**Question**: Does the order of repositories in `repos.dev` and `repos.clone` arrays have semantic meaning?

**Options**:
- A) Clone order: Repositories are cloned in the order listed (matters for dependency setup)
- B) No semantics: Order is arbitrary, cloning happens in parallel or alphabetically
- C) Priority order: First entry has highest priority for conflict resolution or imports
- D) UI display order: Order only affects how repos are displayed in tools/dashboards

**Answer**:

---

### Q10: Orchestrator Settings Scope
**Context**: The spec states "Orchestrator settings apply to entire project (not per-workflow overrides)" but doesn't clarify if these settings can differ between development and production deployments.

**Question**: Should orchestrator settings in the config apply to all environments or just development?

**Options**:
- A) Development only: Config settings apply to local dev containers, production uses separate deployment config
- B) All environments: Same config values used in dev, staging, and production (single source of truth)
- C) Environment variable overrides: Config provides defaults, but can be overridden by env vars in production
- D) Deployment-specific: Separate mechanism for production orchestrator settings (not in config.yaml)

**Answer**:

---

### Q11: Project Name Uniqueness and Constraints
**Context**: FR-002 requires `project.name` for "human-readable identification" but doesn't specify constraints on length, characters, or uniqueness requirements.

**Question**: What are the validation rules for `project.name`?

**Options**:
- A) Minimal constraints: Any non-empty string up to 255 characters, no uniqueness required
- B) Display-safe: Limit to alphanumeric + spaces/hyphens, 1-100 characters, no uniqueness check
- C) Unique per organization: Name must be unique within the organization's generacy.ai projects
- D) Globally unique: Name must be globally unique across all generacy.ai projects

**Answer**:

---

### Q12: Config Schema Version Management
**Context**: FR-015 mentions "Schema must support future extensibility without breaking changes" but doesn't specify how schema versions are tracked or migrated.

**Question**: Should the config file include a schema version field for future migration support?

**Options**:
- A) No version field: Schema is implicitly "v1", future versions use different file names or detection logic
- B) Optional version field: Add `schemaVersion: "1.0"` field, optional in v1 (becomes required in v2+)
- C) Required from start: Include `version: "1"` as required field now for future-proofing
- D) File format version: Use YAML tags or directives to indicate schema version (e.g., `!generacy/v1`)

**Answer**:

---

### Q13: Invalid Repository URL Handling
**Context**: FR-012 validates repo URL format but doesn't specify behavior when a valid-format URL points to a non-existent or inaccessible repository.

**Question**: Should config validation check that repository URLs are accessible and exist?

**Options**:
- A) Format only: Only validate URL format at config load time, don't check accessibility
- B) Lazy validation: Check accessibility when actually cloning (fail at clone time, not config load)
- C) Startup validation: On orchestrator/CLI startup, verify all repos are accessible (fail fast)
- D) Warning mode: Attempt to check accessibility, warn if unreachable but don't fail validation

**Answer**:

---

### Q14: Empty Repository Lists Behavior
**Context**: US2 states "Config supports 0..N dev repos and 0..N clone-only repos" but doesn't clarify if empty lists have special meaning or if the fields can be omitted.

**Question**: How should empty or omitted repository lists be interpreted?

**Options**:
- A) Omit equals empty: Missing `repos.dev` field is equivalent to `repos.dev: []` (empty array)
- B) Explicit empty required: If no repos, must explicitly specify `repos.dev: []` (cannot omit field)
- C) Null vs empty: Distinguish between omitted (null), empty array `[]`, and undefined behavior
- D) Single-repo mode: Omitted dev/clone lists trigger single-repo configuration mode with different behavior

**Answer**:

---

### Q15: CLI Package Location and Import Path
**Context**: FR-017 mentions "Generacy CLI must export config type definitions" and examples show `@generacy-ai/generacy/config`, but the actual package structure isn't defined.

**Question**: What is the npm package structure for the Generacy CLI and where should config exports live?

**Options**:
- A) Single package: `@generacy-ai/generacy` with subpath exports (`@generacy-ai/generacy/config`)
- B) Multiple packages: Separate packages like `@generacy-ai/cli` and `@generacy-ai/config`
- C) Monorepo packages: `@generacy/cli`, `@generacy/config`, `@generacy/types` in a monorepo
- D) Not specified yet: Package structure is defined in a separate spec (reference needed)

**Answer**:

