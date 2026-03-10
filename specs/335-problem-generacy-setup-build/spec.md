# Feature Specification: Build phase should skip source builds for external projects

**Branch**: `335-problem-generacy-setup-build` | **Date**: 2026-03-06 | **Status**: Draft

## Summary

`generacy setup build` assumes dependency repos (`agency`, `latency`) are cloned locally at `/workspaces/agency` and `/workspaces/latency` and tries to build them from source. For external projects that consume these as published npm packages, the build fails because the source repos don't exist. The build phase should detect the environment and skip source builds when packages are already available.

## Problem

`generacy setup build` assumes that dependency repos (`agency`, `latency`) are cloned as source at `/workspaces/agency` and `/workspaces/latency`, and attempts to build them from source. For external projects that use published npm packages, these repos don't exist and the build fails.

### Observed behavior (external project)

After the workspace setup fails to clone repos (see #333), the build phase attempts:

```
INFO: Phase 2: Building Agency packages
INFO: Building latency dependency
INFO: Latency built successfully
INFO: Installing agency dependencies
INFO: Building agency
INFO: Phase 3: Building Generacy packages
ERROR: Command failed
    cmd: "pnpm install --filter \"!@generacy-ai/generacy-plugin-claude-code\""
```

The speckit recovery fallback also fails:

```
[setup-speckit] Building agency...
[setup-speckit] ERROR: npm install failed in agency
```

### Expected behavior

For external projects, the tooling packages (`@generacy-ai/agency`, `@generacy-ai/latency`, etc.) should be consumed as published npm packages, not built from source. The build phase should detect whether it's running in a multi-repo development environment (source repos present) vs. an external project environment (packages installed from registry) and behave accordingly.

### Context

- The orchestrator and worker containers ship with the generacy CLI pre-installed (from the Docker image)
- External projects don't need to build agency/latency/generacy from source — they use the versions baked into the image or installed from npm
- The `setup-speckit.sh` recovery script also hardcodes `AGENCY_REPO_URL=https://github.com/generacy-ai/agency` as a fallback

## User Stories

### US1: External project developer runs setup build

**As an** external project developer using generacy tooling,
**I want** `generacy setup build` to succeed without local source repos,
**So that** I can use the pre-installed or npm-published packages without build failures.

**Acceptance Criteria**:
- [ ] `generacy setup build` completes successfully when `/workspaces/agency` and `/workspaces/latency` do not exist
- [ ] Build phase skips Phase 2 (building agency/latency from source) when source repos are absent
- [ ] Build phase skips Phase 3 source-build steps when running in external project context
- [ ] Informational log message indicates source build was skipped (e.g., "Skipping source build — using installed packages")

### US2: Multi-repo developer retains existing behavior

**As a** generacy platform developer with source repos cloned,
**I want** `generacy setup build` to continue building from source as it does today,
**So that** I can develop and test against local changes.

**Acceptance Criteria**:
- [ ] When `/workspaces/agency` and `/workspaces/latency` exist, build proceeds as before
- [ ] No behavioral change for the multi-repo development workflow

### US3: Speckit recovery script handles missing repos

**As an** external project developer,
**I want** the `setup-speckit.sh` fallback to not fail when agency source repo is unavailable,
**So that** speckit setup completes without errors.

**Acceptance Criteria**:
- [ ] `setup-speckit.sh` skips building agency from source when the repo is not cloned
- [ ] Speckit functions correctly using pre-installed packages

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Build phase checks for existence of source repos before attempting source builds | P1 | Check `/workspaces/agency`, `/workspaces/latency` |
| FR-002 | Skip Phase 2 (dependency source builds) when source repos are absent | P1 | Log skip reason |
| FR-003 | Skip Phase 3 source-dependent steps when in external project context | P1 | |
| FR-004 | `setup-speckit.sh` skips agency source build when repo not present | P1 | Remove or guard the hardcoded clone fallback |
| FR-005 | Add clear log messages when build phases are skipped | P2 | Helps debugging |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | External project build success | 100% pass rate | `generacy setup build` exits 0 without source repos present |
| SC-002 | Multi-repo build unchanged | No regressions | Existing build flow works identically when source repos exist |
| SC-003 | Speckit setup success | No errors from `setup-speckit.sh` | Script completes without npm install failures |

## Assumptions

- Published npm packages for `@generacy-ai/agency`, `@generacy-ai/latency`, etc. are available in the Docker image or npm registry
- The presence/absence of `/workspaces/agency` is a reliable signal for environment detection
- No source-level modifications to agency/latency are needed in external project contexts

## Out of Scope

- Publishing new versions of npm packages
- Changing Docker image build process
- Supporting partial source repo presence (e.g., agency cloned but not latency)

---

*Generated by speckit*
