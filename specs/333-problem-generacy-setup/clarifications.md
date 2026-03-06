# Clarifications for #333: Remove hardcoded tetrad-development bootstrap fallback

## Batch 1 — 2026-03-06

### Q1: Config discovery strategy
**Context**: The existing `findWorkspaceConfigPath()` in `loader.ts` walks **up** from a given start directory. However, the workspace setup needs to find `.generacy/config.yaml` in mounted project repos that are **sibling** directories under `/workspaces/` (e.g., `/workspaces/my-project/.generacy/config.yaml`). Walking up from `/workspaces` won't find configs in child project directories.
**Question**: What discovery strategy should replace the hardcoded `tetrad-development` path lookup? Should we: scan all immediate subdirectories of `workdir` (e.g., `/workspaces/*/.generacy/config.yaml`), or use `findWorkspaceConfigPath()` starting from `cwd`, or require an explicit project name?
**Options**:
- A: Scan all immediate subdirectories of `workdir` for `.generacy/config.yaml` (broadest — finds any mounted project's config)
- B: Use `findWorkspaceConfigPath(cwd)` to walk up from current working directory (relies on cwd being inside a project with config)
- C: Add a new `--config` CLI flag / `CONFIG_PATH` env var so the caller specifies the config path explicitly
- D: Combination — try `--config`/env first, then scan `workdir` subdirectories as fallback

**Answer**: *Pending*

### Q2: Multiple configs found
**Context**: If the discovery strategy scans `/workspaces/*/`, multiple mounted projects could each contain a `.generacy/config.yaml`. The spec doesn't address what happens when more than one config is discovered.
**Question**: If multiple `.generacy/config.yaml` files are found under `workdir`, should the command: use the first one found, merge them, or fail with an error listing the candidates?
**Options**:
- A: Use the first one found (alphabetical order) with a warning listing others
- B: Fail with an error listing all found configs, requiring the user to specify which one via `--config`
- C: Merge all configs (union of repos from all configs)

**Answer**: *Pending*

### Q3: Scope of tetrad-development removal
**Context**: The spec's FR-001 mentions removing the bootstrap fallback at lines ~62-72 in `workspace.ts`. However, there is additional `tetrad-development`-specific code: (1) Phase 2 logic (lines 301-340) that re-reads config after bootstrapping and clones additional repos, (2) repo ordering logic (lines 285-289) that prioritizes `tetrad-development` first, and (3) the `repoSource` type includes `'bootstrap (config not found)'`.
**Question**: Should all `tetrad-development`-specific code be removed (Phase 2 bootstrap logic, repo ordering priority, bootstrap repoSource), or only the initial fallback at lines 62-72?
**Options**:
- A: Remove all tetrad-development-specific code (Phase 2, ordering, bootstrap repoSource) — clean break
- B: Only remove the initial fallback; keep Phase 2 as a general "config-not-found-then-found" pattern

**Answer**: *Pending*
