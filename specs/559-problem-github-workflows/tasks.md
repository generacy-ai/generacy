# Tasks: Auto-publish cluster images on push

**Input**: Design documents from `/specs/559-problem-github-workflows/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Implementation

- [X] T001 [US1] Create `.github/workflows/poll-cluster-images.yml` with cron schedule (`*/5 * * * *`), `workflow_dispatch` (manual trigger), permissions (`contents: read`, `packages: read`, `actions: write`), and strategy matrix with 4 include entries: (cluster-base, develop), (cluster-base, main), (cluster-microservices, develop), (cluster-microservices, main). Each entry specifies `repo`, `branch`, `image`, and `workflow` fields.

- [X] T002 [US1] Implement the poll job steps: (1) query HEAD SHA via `gh api /repos/generacy-ai/${{ matrix.repo }}/commits/${{ matrix.branch }} --jq '.sha'` and truncate to 7 chars, (2) query GHCR tags via `gh api /orgs/generacy-ai/packages/container/${{ matrix.image }}/versions --jq` and check for `sha-<HEAD_SHA>` existence, (3) conditionally dispatch via `gh workflow run ${{ matrix.workflow }} -f ref=${{ matrix.branch }}` only when tag is missing.

- [X] T003 [US1] Add per-matrix-entry concurrency keys: `group: poll-cluster-${{ matrix.repo }}-${{ matrix.branch }}`, `cancel-in-progress: false`.

## Phase 2: Verification

- [X] T004 [US1] Verify existing publish workflows (`publish-cluster-base-image.yml`, `publish-cluster-microservices-image.yml`) are unchanged — manual `workflow_dispatch` path preserved.

- [X] T005 [US1] Dry-run validation: review the workflow YAML for correct `gh api` jq filters, 7-char SHA truncation matching existing `git rev-parse --short=7` convention, and proper `gh workflow run` invocation syntax.

## Dependencies & Execution Order

**Sequential**: T001 → T002 → T003 (single file, incremental additions)
**Then**: T004 and T005 can run in parallel (read-only verification)

All tasks modify or verify a single file: `.github/workflows/poll-cluster-images.yml`. The existing publish workflows are read-only references — no modifications needed.
