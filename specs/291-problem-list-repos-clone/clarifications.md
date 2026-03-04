# Clarification Questions

## Status: Resolved

## Questions

### Q1: Circular Dependency Between Packages
**Context**: The spec requires `packages/orchestrator/src/config/loader.ts` to import from generacy config utilities (`getMonitoredRepos`, `loadConfig`). However, `@generacy-ai/generacy` already depends on `@generacy-ai/orchestrator`. Adding the reverse import creates a circular dependency. The spec's risk section acknowledges this but the mitigation ("can be extracted to shared package if needed") is not concrete.
**Question**: How should the orchestrator package access the generacy config repo utilities without creating a circular dependency?
**Options**:
- A) Shared package: Extract `repos.ts` and config schema into a new `@generacy-ai/config` shared package that both generacy and orchestrator depend on
- B) Inline duplication: Duplicate the repo-parsing logic in the orchestrator package (small surface area, ~30 lines)
- C) Runtime dynamic import: Use dynamic `import()` in orchestrator to avoid build-time circular dependency
- D) Restructure dependencies: Remove orchestrator dependency from generacy package and restructure the import graph
**Answer**: **A) Shared package.** Extract config utilities (`repos.ts`, config schema, loader) into a new `@generacy-ai/config` shared package that both `generacy` and `orchestrator` depend on. The config schema, loader, validator, and repo helpers together form a meaningful module both packages legitimately need. A shared package avoids duplication that will inevitably drift.

### Q2: Graceful Config Loading Pattern
**Context**: `loadConfig()` currently throws `ConfigNotFoundError` when no config file exists. FR-009 requires graceful handling in workspace setup (where config hasn't been cloned yet), but the same concern applies to orchestrator and job-handler startup. Each consumer needs to handle the missing-config case, but the spec doesn't specify whether this should be a shared pattern or per-consumer try/catch.
**Question**: Should we add a `tryLoadConfig()` function that returns `null` instead of throwing, or should each consumer wrap `loadConfig()` in its own try/catch with consumer-specific fallback logic?
**Options**:
- A) Add `tryLoadConfig()`: New function returning `GeneracyConfig | null`, used by all consumers — centralizes the fallback pattern
- B) Per-consumer try/catch: Each consumer catches `ConfigNotFoundError` and applies its own fallback — more explicit about what each consumer does when config is missing
**Answer**: **A) Add `tryLoadConfig()`.** New function returning `GeneracyConfig | null`, used by all consumers. Three consumers need the same "config might not exist" pattern — centralizing the null-return avoids repeating try/catch + error-type-check in each. The fallback logic (what to do when config is missing) still lives in each consumer; `tryLoadConfig()` just standardizes the "is it there?" question.

### Q3: Override Priority for `workspace.org` and `workspace.branch`
**Context**: The spec defines override priority for repo lists (`CLI > env > config > defaults`) but the workspace setup command also resolves `githubOrg` (from `GITHUB_ORG` env) and `branch` (from `REPO_BRANCH` / `DEFAULT_BRANCH` env). The new `workspace.org` and `workspace.branch` config fields overlap with these existing env vars. The spec doesn't specify where config values fall in the priority chain for these fields.
**Question**: What is the override priority for `org` and `branch` in workspace setup?
**Options**:
- A) Same as repos: CLI flag > env var (`GITHUB_ORG`, `REPO_BRANCH`) > config file (`workspace.org`, `workspace.branch`) > built-in defaults
- B) Env vars take precedence over config for all fields: CLI > env > config > defaults (consistent, but env vars always win over config)
- C) Config takes precedence over env vars: CLI > config > env > defaults (config file is "source of truth" philosophy)
**Answer**: **A) Same as repos.** CLI flag > env var (`GITHUB_ORG`, `REPO_BRANCH`) > config file (`workspace.org`, `workspace.branch`) > built-in defaults. Consistent override semantics across all fields is easier to reason about and document.

### Q4: `getRepoWorkdir` Base Path
**Context**: The spec defines `getRepoWorkdir()` mapping repos to `/workspaces/{repoName}`. However, the workspace setup command already supports a configurable `--workdir` flag (defaulting to `/workspaces`). Hardcoding `/workspaces` in `getRepoWorkdir()` would break if someone uses a custom workdir.
**Question**: Should `getRepoWorkdir()` accept a configurable base path, or is `/workspaces` always the correct base?
**Options**:
- A) Hardcoded `/workspaces`: All devcontainers use this convention; keep it simple
- B) Configurable parameter: `getRepoWorkdir(config, owner, repo, basePath = '/workspaces')` — allows workspace setup's `--workdir` to pass through
- C) Add `workdir` to config schema: Add `workspace.workdir` field to config, so `getRepoWorkdir` reads it from config with `/workspaces` as default
**Answer**: **B) Configurable parameter.** `getRepoWorkdir(config, owner, repo, basePath = '/workspaces')` — one extra parameter with a sensible default. Respects the existing `--workdir` flag without over-engineering. Adding `workdir` to the config schema (option C) would create permanent schema surface area for what's really a runtime/CLI concern.

### Q5: FR-008 Drift Detection Behavior
**Context**: FR-008 says "warn if config file repos and `MONITORED_REPOS` env var are both set but differ." The definition of "differ" is ambiguous — it could mean different repos, different ordering, a subset relationship, or different formatting of the same repos. Also unclear: should this be a log warning only, or should it affect behavior (e.g., prefer one source and warn about the other)?
**Question**: What constitutes a "difference" and what should happen when drift is detected?
**Options**:
- A) Set comparison only: Warn if the sets of repos differ (ignoring order and format). Log warning only, env var still takes priority as override. Message: "MONITORED_REPOS env var differs from config file repos — env var takes priority"
- B) Strict comparison: Warn on any difference including missing repos in either direction. Log each discrepancy individually to help identify which repos are misaligned
- C) Superset check: Only warn if env var is missing repos from config (subset is OK since env var is an intentional override). Warns about potential misconfiguration without flagging intentional narrows
**Answer**: **A) Set comparison, log warning.** Normalize both sources to `owner/repo` sets, compare, warn if they differ, env var takes priority. Ordering doesn't matter. Message: `"MONITORED_REPOS env var differs from config file repos — env var takes priority"`. Option B is too noisy; option C's superset/subset distinction adds confusion.

### Q6: BOOTSTRAP_REPOS Maintenance Strategy
**Context**: `BOOTSTRAP_REPOS` is the hardcoded fallback when config.yaml hasn't been cloned yet. Once config.yaml becomes the source of truth, these two lists could drift apart. The spec doesn't address how to keep `BOOTSTRAP_REPOS` in sync, or whether it's acceptable for them to differ.
**Question**: How should `BOOTSTRAP_REPOS` be maintained relative to the config file?
**Options**:
- A) Minimal bootstrap: Reduce `BOOTSTRAP_REPOS` to only `tetrad-development` (enough to clone the config file), then re-read config and clone remaining repos in a second pass
- B) Full mirror: Keep `BOOTSTRAP_REPOS` as a full list that mirrors the config, with a comment/test that validates they match
- C) Accept drift: `BOOTSTRAP_REPOS` is a "good enough" default for fresh setups; exact sync isn't critical since config takes over after first clone
**Answer**: **No hardcoded repo list at all.** There should be no `BOOTSTRAP_REPOS` constant. The config file (`.generacy/config.yaml`) in the primary repo is the sole source of truth — it has been committed to `tetrad-development/develop` as of `783829e`. The `generacy setup workspace` command knows which repo to start with (specified via CLI arg, env var, or already present on disk). Once that primary repo is cloned/located, config is read and remaining repos are cloned. If no config file exists, the command fails with a clear error: "No `.generacy/config.yaml` found."

### Q7: Testing Requirements
**Context**: The spec lists success criteria including "existing tests pass" and "backward compatibility" but doesn't specify what new tests should be written. The new `repos.ts` utility module, the config fallback paths in each consumer, and the override priority logic all have testable behavior.
**Question**: What level of test coverage is expected for this feature?
**Options**:
- A) Unit tests only: Test `repos.ts` helper functions (parseRepoUrl, getWorkspaceRepos, getMonitoredRepos, getRepoWorkdir) with various config shapes and edge cases
- B) Unit + integration: Unit tests for helpers, plus integration tests that verify the full override priority chain (CLI > env > config > defaults) for each consumer
- C) Unit + integration + e2e: All of the above, plus an end-to-end test that runs `generacy setup workspace` with a real config file and verifies correct cloning behavior
**Answer**: **B) Unit + integration.** Unit tests for `repos.ts` helpers (parseRepoUrl, getWorkspaceRepos, getMonitoredRepos, getRepoWorkdir) with various config shapes and edge cases. Integration tests verifying the full override priority chain (CLI > env > config > defaults) for each consumer. E2e tests for a config refactor are expensive to maintain and the behavior is well-covered by integration tests.

### Q8: `--repos` CLI Format Consistency
**Context**: The `--repos` CLI flag currently accepts bare repo names (`generacy,humancy`). The config file uses `github.com/owner/repo` format. If a developer copies a repo entry from config.yaml to use as a CLI override, they'd need to mentally strip the prefix. The spec doesn't address whether CLI flags should accept multiple formats.
**Question**: Should the `--repos` CLI flag accept formats beyond bare names?
**Options**:
- A) Bare names only: Keep current behavior (`--repos generacy,humancy`). Simple, no ambiguity about org/owner resolution
- B) Multi-format: Accept bare names, `owner/repo`, or `github.com/owner/repo` — auto-detect format and extract repo name. More flexible but adds parsing complexity
**Answer**: **B) Multi-format.** Accept bare names, `owner/repo`, or `github.com/owner/repo` — auto-detect and extract repo name. The `parseRepoUrl()` helper already needs to exist for the config loader, so reusing it in CLI arg parsing is essentially free. Avoids the friction of mentally stripping prefixes when copying from config.

### Q9: Behavior When Config Exists but Has Incomplete Repos
**Context**: If config.yaml exists but only lists 3 repos while `MONITORED_REPOS` previously had 8, consumers that switch to config will silently monitor fewer repos. The spec doesn't define whether this is expected behavior or whether there should be a minimum repo count validation or explicit acknowledgment.
**Question**: Should there be any validation or warning when the config file repo list is significantly smaller than what env vars previously provided?
**Options**:
- A) No validation: Config file is authoritative; if it lists fewer repos, that's intentional. The user chose what to put in config
- B) Log informational message: On startup, log the resolved repo count and source (e.g., "Monitoring 3 repos from config file"). No validation, just visibility
- C) Warn on empty: Only warn/error if the resolved repo list is completely empty (no repos to monitor). Otherwise trust the config
**Answer**: **B) Log informational message.** On startup, log the resolved repo count and source (e.g., `"Monitoring 3 repos from config file"`). With no hardcoded fallback list, the config file is fully authoritative — if it lists 3 repos, that's intentional. The informational log provides visibility without adding validation logic.

### Q10: Config File Creation Ownership
**Context**: The spec lists "Creating the actual `.generacy/config.yaml` file in tetrad-development" as out of scope (companion issue). However, the implementation depends on this file existing with the correct `repos` section populated. If the companion issue produces a config file with different field names or structure, the implementation won't work.
**Question**: Should this implementation include a sample/reference `.generacy/config.yaml` file (e.g., in `packages/generacy/examples/`) that documents the expected repos structure for the companion issue to follow?
**Options**:
- A) Yes, add reference config: Create `examples/config-workspace.yaml` showing the full repos + workspace schema. Serves as a contract between this issue and the companion issue
- B) No, existing examples suffice: The existing `examples/config-full.yaml` already shows the repos schema. The companion issue can reference it and add the new `workspace` section
**Answer**: **B) Existing examples suffice.** The codebase already has `examples/config-full.yaml`, `examples/config-multi-repo.yaml`, etc. documenting the `repos` schema. The new `workspace` section will be added to the schema (with Zod) and to these existing examples as part of this implementation. Additionally, the actual `.generacy/config.yaml` has now been committed to `tetrad-development/develop`, so the companion issue has a concrete file to reference.

### Q11: Post-Clone Config Re-read for Workspace Setup
**Context**: The bootstrap problem (FR-009) is addressed by falling back to `BOOTSTRAP_REPOS`. But if `BOOTSTRAP_REPOS` is reduced to just `tetrad-development` (Q6 option A), workspace setup would need to clone tetrad-development first, then re-read the config file from the cloned repo, then clone remaining repos. This two-phase approach adds complexity. The spec doesn't specify whether workspace setup should re-read config mid-execution.
**Question**: Should `generacy setup workspace` perform a two-phase clone (clone tetrad-development, read config, clone remaining repos), or clone all bootstrap repos in one pass?
**Options**:
- A) Two-phase clone: Clone tetrad-development first, load config from it, then clone remaining repos from config. True single source of truth, but more complex
- B) Single-pass with full bootstrap: Keep all repos in `BOOTSTRAP_REPOS`, clone them all in one pass. Simpler, but `BOOTSTRAP_REPOS` must mirror config
- C) Single-pass with config overlay: Clone `BOOTSTRAP_REPOS` first, then check config for any additional repos not in bootstrap list and clone those too. Belt-and-suspenders approach
**Answer**: **A) Two-phase clone.** 1) Clone/locate the primary repo (specified via CLI arg, env var, or already on disk). 2) Read `.generacy/config.yaml` from it. 3) Clone remaining repos from config. If the primary repo is already present (e.g., running inside a devcontainer where `tetrad-development` is at `/workspaces/tetrad-development`), step 1 is a no-op and config is read directly. No hardcoded fallback list needed — this follows naturally from Q6.
