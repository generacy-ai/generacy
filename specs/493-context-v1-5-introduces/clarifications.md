# Clarifications — #493 @generacy-ai/cli package skeleton

## Batch 1 — 2026-04-29

### Q1: Publish workflow strategy
**Context**: The spec requires a workflow triggered by `cli-v*` tags (FR-008), but also says "match prevailing convention." The prevailing convention in this repo is changeset-based preview publishing (`.github/workflows/publish-preview.yml` uses `pnpm changeset version --snapshot`). These are different approaches — a dedicated tag-triggered workflow vs. integrating into the existing changeset pipeline.
**Question**: Should the CLI publish via a new tag-triggered workflow (`cli-v*` → npm publish), or should it integrate into the existing changeset-based pipeline and drop the separate tag trigger?
**Options**:
- A: New tag-triggered workflow (as spec states literally)
- B: Integrate into existing changeset pipeline (match prevailing convention)
- C: Both — changeset for preview, tag-triggered for stable releases

**Answer**: *Pending*

### Q2: Placeholder subcommand behavior
**Context**: FR-002 says Commander.js dispatches 11 "placeholder" subcommands, but doesn't specify what happens at runtime when a user invokes one (e.g., `generacy launch`). This affects UX and whether tests should assert specific output.
**Question**: When a user runs a placeholder subcommand, what should happen?
**Options**:
- A: Print "Not yet implemented — coming soon in a future release" and exit 0
- B: Print "Not yet implemented" and exit 1 (non-zero signals failure)
- C: Print nothing, exit 0 (truly empty)

**Answer**: *Pending*

### Q3: findClusterByCwd() matching strategy
**Context**: The spec requires `findClusterByCwd()` to "resolve the correct cluster for a given path" but doesn't specify the matching algorithm. When a cluster is registered with `path: "/home/user/project"`, should running a command from `/home/user/project/src/` also match? What if multiple cluster paths are prefixes of the cwd?
**Question**: Should `findClusterByCwd()` match the cwd as an exact match against cluster paths, or use longest-prefix-match (cwd is at or below a cluster's path)?
**Options**:
- A: Longest-prefix-match (standard convention, like git finding .git)
- B: Exact match only
- C: Longest-prefix-match with a warning if multiple clusters share a prefix

**Answer**: *Pending*
