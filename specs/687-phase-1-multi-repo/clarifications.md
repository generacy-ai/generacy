# Clarifications: Sibling-Repo Discovery and ActionContext Widening

## Batch 1 — 2026-05-22

### Q1: Primary Repo Identification
**Context**: The spec says "exclude the primary repo from the sibling map" and "the primary repo can be identified by matching `workdir` against the repo list." However, `WorkspaceConfig.repos` is a flat array of `{ name, monitor }` objects with no explicit "primary" field. The template format has `repos.primary` but after `convertTemplateConfig()` it becomes just the first entry in the flat array. Since the schema only stores repo `name` (not full paths), identification requires deriving paths via `getRepoWorkdir(name, basePath)` and comparing against the resolved `workdir`.
**Question**: How should the primary repo be identified from the `workspace.repos` list? Should we derive each repo's expected path using `getRepoWorkdir(name)` and compare against the normalized `workdir` from `ExecutionOptions.cwd`? And what should happen if `workdir` doesn't match any repo in the list — should all repos be treated as siblings, or should `siblingWorkdirs` be empty?
**Options**:
- A: Path-match — derive paths with `getRepoWorkdir(name, dirname(workdir))`, compare against `workdir`; if no match, treat all repos as siblings
- B: Path-match — same derivation, but if no match, return empty `siblingWorkdirs: {}`
- C: Basename-match — extract `basename(workdir)` and match against `repos[].name`; simpler but less robust

**Answer**: B (path-match, empty fallback). Derive each repo's expected path with `getRepoWorkdir(name, dirname(workdir))` and compare against the resolved, realpath-normalized `workdir`. If no match, return `siblingWorkdirs: {}` and log a warning. Don't fall back to "treat all as siblings" — that would silently include the primary in fan-out and corrupt downstream behavior. Fail closed when the primary can't be identified.

### Q2: Config Injection vs Self-Discovery
**Context**: The `workflow-engine` package currently has no dependency on `@generacy-ai/config`. The spec says to "read `workspace.repos` from `.generacy/config.yaml`" but doesn't specify the mechanism. Two approaches: (A) add `@generacy-ai/config` as a dependency and use `tryLoadWorkspaceConfig()` + `findWorkspaceConfigPath()` inside the executor, or (B) extend `ExecutionOptions` to accept the config (or pre-resolved sibling map) from the caller (orchestrator already loads workspace config). Option B keeps workflow-engine decoupled from config loading.
**Question**: Should `workflow-engine` discover and load the config itself (adding a dependency on `@generacy-ai/config`), or should the sibling map be passed in via `ExecutionOptions` by the caller?
**Options**:
- A: Self-discovery — add `@generacy-ai/config` dependency, executor calls `findWorkspaceConfigPath()` + `tryLoadWorkspaceConfig()` internally
- B: Caller-injection — add `siblingWorkdirs?: Record<string, string>` to `ExecutionOptions`, let orchestrator resolve and pass it in
- C: Hybrid — accept optional `siblingWorkdirs` on `ExecutionOptions`, fall back to self-discovery if not provided

**Answer**: B (caller-injection). Extend `ExecutionOptions` with `siblingWorkdirs?: Record<string, string>` and let the orchestrator resolve and pass it in. The orchestrator already depends on `@generacy-ai/config` (see `packages/orchestrator/src/config/loader.ts`); keeping that dependency out of `workflow-engine` preserves its layering. Hybrid (C) isn't worth the complexity — `workflow-engine` has no use case for running independently of an orchestrator that already loads config.

### Q3: Sibling Base Path Derivation
**Context**: `getRepoWorkdir(repoName, basePath)` constructs `${basePath}/${repoName}` with a default `basePath` of `/workspaces`. The spec assumes siblings are "cloned as peers under `/workspaces/`". However, the executor derives `workdir` from `options.cwd ?? process.cwd()`, which could be any path. If the primary repo is at `/home/user/projects/my-repo`, the base path should be `/home/user/projects/`, not `/workspaces/`.
**Question**: Should the base path for sibling discovery be derived dynamically from `dirname(workdir)` (i.e., the parent of the primary repo's working directory), or should it use the hardcoded `/workspaces` default from `getRepoWorkdir()`?
**Options**:
- A: Dynamic — use `path.dirname(workdir)` as base path (works in any directory layout)
- B: Hardcoded — always use `/workspaces` (matches current cluster deployment assumptions)
- C: Configurable — read from config or env var, defaulting to `/workspaces`

**Answer**: A (dynamic via `path.dirname(workdir)`). Hardcoding `/workspaces` breaks any non-cluster deployment (local dev outside devcontainers, CI runners, future hosting layouts). The `/workspaces` default in `getRepoWorkdir()` should be overridden with the parent of the primary's resolved workdir.

### Q4: Config Loading Frequency
**Context**: The executor's `createActionContext()` is called once per step. If config loading happens there, it means disk I/O on every step. Alternatively, config could be loaded once at the start of `execute()` and cached for the entire workflow run. The latter is more efficient but means the sibling map is stale if config changes mid-execution (unlikely but possible).
**Question**: Should the workspace config be loaded once per `execute()` call (cached for the workflow run) or per `createActionContext()` call (per step)?
**Options**:
- A: Once per `execute()` — load and cache at workflow start, pass to `createActionContext()`
- B: Per step — load fresh in each `createActionContext()` call
- C: Lazy singleton — load on first access, cache for remainder of execution

**Answer**: A (once per `execute()`). Load and cache at workflow start, pass the resolved map into `createActionContext()`. Per-step disk I/O is wasteful for data that doesn't meaningfully change mid-execution. Lazy singleton (C) is marginally lazier but adds state for no real benefit here.
