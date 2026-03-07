# Clarifications: Fix `generacy setup build` Phase 4

## Batch 1 — 2026-03-07

### Q1: Cross-repo scope of FR-001
**Context**: FR-001 requires adding `.md` command files to the `@generacy-ai/agency` npm package, but that package lives in the `generacy-ai/agency` repo. The current `@generacy-ai/agency` package only includes `"dist"` in its `files` field, and the `.md` files are in a separate monorepo package at `packages/claude-plugin-agency-spec-kit/commands/`. This issue is in the `generacy` repo.
**Question**: Is the agency repo change (adding `.md` files to the `@generacy-ai/agency` npm distribution) a prerequisite that will be handled separately, or should this issue cover changes to both repos?

**Answer**: *Pending*

### Q2: Expected path of `.md` files within installed npm package
**Context**: The npm fallback in `build.ts` needs to know the exact path to the `.md` files within the globally installed `@generacy-ai/agency` package. Currently, the `.md` files live at `packages/claude-plugin-agency-spec-kit/commands/` in the monorepo, but the npm package is built from `packages/agency/` which only includes `dist/`. The fallback path could be `$(npm root -g)/@generacy-ai/agency/commands/` (flat) or `$(npm root -g)/@generacy-ai/agency/packages/claude-plugin-agency-spec-kit/commands/` (mirrored), depending on how the agency package is updated.
**Question**: What path structure should the `.md` files use within the published `@generacy-ai/agency` npm package?
**Options**:
- A: Flat `commands/` directory at package root (add `"commands"` to `files` field and copy during build)
- B: Mirror monorepo structure `packages/claude-plugin-agency-spec-kit/commands/` (add to `files` field directly)
- C: Include in `dist/commands/` alongside existing dist output

**Answer**: *Pending*
