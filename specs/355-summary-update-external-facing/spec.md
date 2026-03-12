# Feature Specification: Update Getting-Started Docs for Cluster Base Repo Approach

Update external-facing developer documentation to reflect the new cluster base repo approach, replacing references to `cluster-templates` with the new fork chain of base repos (`cluster-base` → `cluster-microservices`).

**Branch**: `355-summary-update-external-facing` | **Date**: 2026-03-12 | **Status**: Draft

## Summary

The onboarding flow is moving from copying template files out of `generacy-ai/cluster-templates` to merging standalone base repos into developer projects. All external-facing docs need to be updated to reflect this change so developers have accurate setup and update instructions.

## Background

The base repos form a fork chain:

```
cluster-base                          ← Root: standard setup (no DinD)
  └── cluster-microservices           ← Fork: adds Docker-in-Docker
```

This creates a Git upstream relationship that allows developers to pull cluster setup updates via `git merge`. See the [migration plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cluster-base-migration-plan.md) for full details.

## Files to Update

### `docs/docs/getting-started/dev-environment.md`
- Replace any `cluster-templates` references with base repo approach
- Add "Updating your cluster setup" section explaining `git fetch cluster-base && git merge cluster-base/main`
- Update the manual setup instructions to use `git remote add` + `git merge --allow-unrelated-histories`

### `docs/docs/getting-started/project-setup.md`
- Update description of what the onboarding PR does (merge commit vs file copy)
- Mention `cluster-base.json` file that tracks the upstream relationship

### `docs/docs/getting-started/multi-repo.md`
- Update any references to `cluster-templates` if present

### Other files
- Search for any remaining references to `cluster-templates` across the docs and update

## User Stories

### US1: New Developer Onboarding

**As a** new developer setting up their environment,
**I want** accurate documentation on how to set up my cluster using the base repo approach,
**So that** I can successfully configure my dev environment without following outdated instructions.

**Acceptance Criteria**:
- [ ] Getting-started docs describe the base repo merge approach (not template copying)
- [ ] Both `cluster-base` and `cluster-microservices` variants are explained with guidance on which to choose

### US2: Existing Developer Updating Cluster Setup

**As an** existing developer with a previously configured cluster,
**I want** clear instructions on how to pull updates from the upstream base repo,
**So that** I can keep my cluster configuration up to date without manual diffing.

**Acceptance Criteria**:
- [ ] `git fetch` + `git merge` workflow is documented step-by-step
- [ ] Manual setup for existing repos uses `git remote add` + `--allow-unrelated-histories`

### US3: Developer Understanding the New Model

**As a** developer reading the docs,
**I want** to understand the fork chain relationship between base repos,
**So that** I know how updates propagate and which upstream to track.

**Acceptance Criteria**:
- [ ] Fork chain diagram is included in docs
- [ ] `cluster-base.json` tracking file is mentioned and explained

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Replace all `cluster-templates` references in getting-started docs | P1 | Search across all docs |
| FR-002 | Document the base repo fork chain with both variants | P1 | Include diagram |
| FR-003 | Add "Updating your cluster setup" section with `git fetch`/`git merge` workflow | P1 | In dev-environment.md |
| FR-004 | Update manual setup instructions to use `git remote add` + `--allow-unrelated-histories` | P1 | In dev-environment.md |
| FR-005 | Update onboarding PR description (merge commit vs file copy) | P2 | In project-setup.md |
| FR-006 | Document `cluster-base.json` tracking file | P2 | In project-setup.md |
| FR-007 | Update links to point to new base repos instead of `cluster-templates` | P1 | All docs |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `cluster-templates` references in getting-started docs | 0 | `grep -r "cluster-templates" docs/docs/getting-started/` |
| SC-002 | Base repo fork chain documented | Both variants listed | Manual review |
| SC-003 | Update workflow documented | Complete step-by-step | Manual review |
| SC-004 | Links to base repos correct | All links updated | Manual review |

## Acceptance Criteria

- [ ] No references to `cluster-templates` remain in getting-started docs
- [ ] Base repo fork chain is clearly documented with both variants listed
- [ ] Update workflow (`git fetch` + `git merge`) is documented
- [ ] Manual setup for existing repos uses `git remote add` + `--allow-unrelated-histories`
- [ ] Links point to new base repos (`cluster-base`, `cluster-microservices`) instead of `cluster-templates`

## Assumptions

- The `cluster-base` and `cluster-microservices` repos already exist and are accessible
- The migration plan document is the source of truth for the technical approach
- The onboarding automation has already been updated to use the base repo merge approach

## Out of Scope

- Updating the onboarding automation code itself (separate issue)
- Creating the base repos or migration tooling
- Updating internal/non-docs references to `cluster-templates`

## References

- [Migration plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cluster-base-migration-plan.md)
- [GitHub Issue #355](https://github.com/generacy-ai/generacy/issues/355)

---

*Generated by speckit*
