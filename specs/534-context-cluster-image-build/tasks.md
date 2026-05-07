# Tasks: Cluster Image Build Workflows

**Input**: Design documents from `/specs/534-context-cluster-image-build/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Implementation

- [X] T001 [US1][US2] Create `.github/workflows/publish-cluster-base-image.yml` — `workflow_dispatch` trigger with `ref` choice input (`develop`/`main`), cross-repo checkout of `generacy-ai/cluster-base` via `actions/checkout@v4`, tag mapping step (`develop`->`preview`, `main`->`stable` + `sha-<short>`), GHCR login via `docker/login-action@v3`, build+push via `docker/build-push-action@v6`. Permissions: `contents: read`, `packages: write`.
- [X] T002 [P] [US1][US2] Create `.github/workflows/publish-cluster-microservices-image.yml` — identical structure to T001 but targeting `generacy-ai/cluster-microservices` repo and `ghcr.io/generacy-ai/cluster-microservices` image.

## Phase 2: Validation

- [X] T003 Verify workflow YAML syntax — run `actionlint` or equivalent linting on both workflow files to catch syntax errors before merge.
- [X] T004 Update CLAUDE.md — add entries for the two new workflow files in the project documentation (already partially present from plan phase; verify accuracy).

## Dependencies & Execution Order

- **T001 and T002** are independent and can run in parallel (separate files, identical structure).
- **T003** depends on T001 + T002 (validates the created files).
- **T004** depends on T001 + T002 (documents the created files).

**Parallel opportunities**: T001 ‖ T002, then T003 ‖ T004.

**Total**: 4 tasks across 2 phases.
