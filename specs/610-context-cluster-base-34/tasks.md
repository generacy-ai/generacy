# Tasks: Fix vscode-cli volume mount path in launch CLI scaffolder

**Input**: Design documents from `/specs/610-context-cluster-base-34/`
**Prerequisites**: plan.md (required), spec.md (required), research.md (available)
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Fix

- [ ] T001 [US1] Update orchestrator service volume mount from `vscode-cli:/home/node/.vscode-cli` to `vscode-cli-state:/home/node/.vscode/cli` in `scaffoldDockerCompose()` (`packages/generacy/src/cli/commands/cluster/scaffolder.ts`, line ~159)
- [ ] T002 [US1] Update top-level `volumes:` declaration from `vscode-cli: null` to `vscode-cli-state: null` in the same function (`packages/generacy/src/cli/commands/cluster/scaffolder.ts`, line ~252)

## Phase 2: Verification

- [ ] T003 [US1] Verify scaffolded `docker-compose.yml` output contains `vscode-cli-state:/home/node/.vscode/cli` and `vscode-cli-state: null` (run existing tests or inspect output manually)

## Dependencies & Execution Order

T001 and T002 are in the same file and logically coupled — apply together as a single edit. T003 follows after both are complete.

No parallel opportunities (single-file, 3 trivial tasks).
