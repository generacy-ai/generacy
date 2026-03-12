# Implementation Plan: Update Getting-Started Docs for Cluster Base Repo Approach

**Feature**: Update external-facing developer docs to document the cluster base repo merge approach
**Branch**: `355-summary-update-external-facing`
**Status**: Complete

## Summary

This feature adds net-new documentation to the getting-started guides explaining how developers set up and update their cluster configuration using the base repo merge approach (`cluster-base` → `cluster-microservices` fork chain). Since no `cluster-templates` references exist in the current docs, this is purely additive content — no replacements needed.

The work spans three existing doc pages plus a potential new page, adding content about the fork chain relationship, the `git remote add` + `git merge` workflow, the `cluster-base.json` tracking file, and the onboarding PR process.

## Technical Context

- **Framework**: Docusaurus documentation site
- **Language**: Markdown with Docusaurus extensions (admonitions, Mermaid diagrams, frontmatter)
- **Location**: `docs/docs/getting-started/`
- **Build**: Docusaurus static site generator (see `docs/` directory)
- **Patterns**: Existing pages use `:::tip`, `:::caution`, `:::danger` admonitions, Mermaid `graph` blocks, tables, and step-by-step numbered sections

## Key Design Decisions

### D1: New page vs. section within existing page

**Decision**: Create a new `cluster-setup.md` page in getting-started, rather than cramming content into `dev-environment.md`.

**Rationale**: The current `dev-environment.md` covers dev containers (VS Code, Docker Compose, features). Cluster base repo setup is a separate concept — it's about merging upstream configuration repos, not about container setup. Mixing these would confuse developers. A dedicated page keeps both topics focused.

### D2: Scope is additive, not replacement

**Decision**: All work is net-new content. No find-and-replace of `cluster-templates` needed.

**Rationale**: Clarification Q1 confirmed zero `cluster-templates` references exist in `docs/`. The spec's FR-001 and FR-007 (replace references, update links) are effectively no-ops. Focus shifts to FR-002 through FR-006.

### D3: Migration plan as authoritative source

**Decision**: Reference the [migration plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cluster-base-migration-plan.md) for accurate technical details (git commands, `cluster-base.json` schema, exact workflows).

**Rationale**: The spec provides high-level requirements but the migration plan has the implementation details needed for accurate documentation. The spec's assumption A2 confirms this.

### D4: Introduce "cluster" concept with a definition

**Decision**: Open the new page with a brief definition of what a "cluster" means in developer-facing terms before diving into setup instructions.

**Rationale**: Clarification Q3 noted that "cluster" isn't used anywhere in the current docs. New developers need context before following the setup steps.

## Project Structure

```
docs/docs/getting-started/
├── dev-environment.md          # MODIFY — add cross-reference to cluster-setup
├── project-setup.md            # MODIFY — add onboarding PR section, mention cluster-base.json
├── multi-repo.md               # REVIEW — no changes expected (no cluster-templates refs)
├── cluster-setup.md            # CREATE — new page for cluster base repo setup
└── index.md                    # MODIFY — add cluster-setup to the page listing if needed
```

## Implementation Steps

### Phase 1: Create the cluster-setup page

**Files**: `docs/docs/getting-started/cluster-setup.md` (new)

1. Add Docusaurus frontmatter with appropriate `sidebar_position` (after dev-environment, likely position 7)
2. Write introductory section defining "cluster" in developer terms
3. Document the fork chain with Mermaid diagram:
   ```
   cluster-base (root: standard setup)
     └── cluster-microservices (fork: adds Docker-in-Docker)
   ```
4. Add "Which variant do I need?" guidance table
5. Document new project setup workflow:
   - `git remote add cluster-base <url>`
   - `git merge cluster-base/main --allow-unrelated-histories`
6. Document update workflow:
   - `git fetch cluster-base`
   - `git merge cluster-base/main`
7. Document `cluster-base.json` tracking file — what it is, what it contains
8. Add troubleshooting section for common merge conflicts

### Phase 2: Update project-setup.md

**Files**: `docs/docs/getting-started/project-setup.md` (modify)

1. Add a new section (after "Step 3: Review the Output" or in "Understand What Was Created") describing the onboarding PR:
   - What it does: merges cluster base repo into the project (merge commit, not file copy)
   - How it's triggered (by `generacy init` or the GitHub App)
   - What developers see in the PR
2. Mention `cluster-base.json` as one of the files created/tracked
3. Cross-reference the new `cluster-setup.md` page for full details

### Phase 3: Update dev-environment.md

**Files**: `docs/docs/getting-started/dev-environment.md` (modify)

1. Add a brief note/callout in the "What the Dev Container Provides" section or "Next Steps" pointing to `cluster-setup.md` for cluster configuration
2. No substantive content changes — cluster setup is separate from dev container setup

### Phase 4: Verification

1. Run `grep -r "cluster-templates" docs/docs/getting-started/` — expect 0 results (SC-001)
2. Verify all links to base repos (`cluster-base`, `cluster-microservices`) are present and correct (SC-004)
3. Verify fork chain diagram is present (SC-002)
4. Verify update workflow is documented step-by-step (SC-003)
5. Review against all acceptance criteria from spec

## Dependencies

- **Migration plan document**: Needed as source of truth for exact git commands, `cluster-base.json` schema, and workflow details. Must be read before writing the cluster-setup page.
- **No code dependencies**: This is a documentation-only change with no runtime impact.

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Migration plan is incomplete or out of date | Inaccurate documentation | Flag gaps and document what's known; add TODOs for details pending finalization |
| "Cluster" terminology confuses developers | Poor developer experience | Lead with a clear, jargon-free definition; use consistent terminology throughout |
| Onboarding PR workflow details are unclear | Incomplete project-setup.md updates | Document what's known from spec; mark specifics (trigger mechanism, PR contents) as needing confirmation |

## Constitution Check

No `constitution.md` found — no governance constraints to verify against.

---

*Generated by speckit*
