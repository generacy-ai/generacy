# Clarifications

## Batch 1 — 2026-03-06

### Q1: Populated repos.dev/clone format
**Context**: FR-005 says these should be "optional arrays of `org/repo` strings or null", but the template example only shows commented-out placeholders. The actual populated format determines schema design.
**Question**: When `repos.dev` and `repos.clone` are populated in a cluster-template config, what is the exact YAML structure? Is it a flat list of strings like `["org/repo1", "org/repo2"]`, or objects with additional metadata?

**Answer**: *Pending*

### Q2: Primary repo monitor flag
**Context**: The `WorkspaceConfig` schema has a `monitor` boolean (default `true`) on each repo entry. The `repos.primary` represents the "already mounted" repo. Setting `monitor: true` on the primary repo would trigger monitoring behavior on the repo the workspace is already in.
**Question**: Should the primary repo converted from `repos.primary` have `monitor` set to `true` or `false` in the resulting `WorkspaceConfig`?

**Answer**: *Pending*

### Q3: Template validation error behavior
**Context**: Currently `tryLoadWorkspaceConfig()` returns `null` when no `workspace` key is found, but throws on schema validation errors. With the new fallback path, we need a consistent error strategy.
**Question**: When a config file has `project`+`repos` keys (template format detected) but fails validation (e.g., missing `project.org_name`, malformed `repos.primary`), should the loader throw an error or return `null`?
**Options**:
- A: Throw an error (consistent with current workspace format behavior — if format is detected, validation errors are real errors)
- B: Return null (treat it as "not a recognized config" and let caller handle)

**Answer**: *Pending*

### Q4: Project metadata preservation
**Context**: The template format includes `project.id`, `project.org_id`, `project.name` fields that have no equivalent in `WorkspaceConfig`. These identifiers may be needed by other parts of the system (e.g., linking to the Generacy platform).
**Question**: Should `convertTemplateConfig()` only return a `WorkspaceConfig`, or should it also expose/preserve the project metadata (`id`, `org_id`, `name`) in a separate or extended return type?
**Options**:
- A: Only return WorkspaceConfig (keep it simple, project metadata not needed by workspace setup)
- B: Return an extended type that includes project metadata alongside WorkspaceConfig

**Answer**: *Pending*
