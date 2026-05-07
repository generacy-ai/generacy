# Tasks: Concurrent Local Clusters — Port & Volume Conflicts

**Input**: Design documents from `/specs/539-problem-v1-5-onboarding/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Scaffolder Change

- [ ] T001 [US1] Update `scaffoldDockerCompose` port logic in `packages/generacy/src/cli/commands/cluster/scaffolder.ts`
  - Change line 93: `ports: ['3100:3100', '3101:3101', '3102:3102']` → `ports: input.deploymentMode === 'cloud' ? ['3100:3100'] : ['3100']`
  - Remove 3101 and 3102 host-port mappings entirely for both modes
  - Local mode (default): ephemeral `'3100'`; cloud mode: fixed `'3100:3100'`

- [ ] T002 [P] [US1] Update scaffolder tests in `packages/generacy/src/cli/commands/cluster/__tests__/scaffolder.test.ts`
  - Update existing `scaffoldDockerCompose` test to assert ephemeral port format (`['3100']`) instead of hardcoded `['3100:3100', ...]`
  - Add test: local mode (default) emits `['3100']`
  - Add test: cloud mode (`deploymentMode: 'cloud'`) emits `['3100:3100']`
  - Add test: neither mode includes 3101 or 3102

## Phase 2: Status Port Display

- [ ] T003 [US2] Add `PortMapping` schema and `hostPort` to `ClusterStatus` in `packages/generacy/src/cli/commands/status/formatter.ts`
  - Add `PortMappingSchema` (`containerPort`, `hostPort`, `protocol`)
  - Add `ports: z.array(PortMappingSchema).default([])` to `ServiceStatusSchema`
  - Add `hostPort: z.number().nullable()` to `ClusterStatusSchema`
  - Add "Port" column to `formatTable` header and rows (display `hostPort ?? 'N/A'`)
  - Include `hostPort` in JSON output (already handled by schema addition)

- [ ] T004 [US2] Parse `Publishers` from Docker ps output in `packages/generacy/src/cli/commands/status/index.ts`
  - In `getClusterServices()`: extract `Publishers` array from parsed JSON
  - Map each publisher to `{ containerPort: TargetPort, hostPort: PublishedPort, protocol: Protocol }`
  - Include `ports` field in returned `ServiceStatus` objects
  - In `statusCommand` action: derive `hostPort` from first service's `ports` where `containerPort === 3100`
  - Pass `hostPort` into `ClusterStatus` objects

- [ ] T005 [P] [US2] Add formatter tests in `packages/generacy/src/cli/commands/status/__tests__/formatter.test.ts`
  - Test `deriveState` (existing behavior, confirm unchanged)
  - Test `formatTable` includes "Port" column with host port value
  - Test `formatTable` shows "N/A" when `hostPort` is null
  - Test `formatJson` includes `hostPort` field

## Phase 3: Legacy Port Warning

- [ ] T006 [US1] Add legacy port detection and warning to `packages/generacy/src/cli/commands/up/index.ts`
  - Read compose file from `ctx.composePath` using `readFileSync` + `yaml.parse()`
  - Check if `services.cluster.ports` contains any string with `:` (HOST:CONTAINER pattern)
  - If legacy ports detected, emit warning via `logger.warn()`:
    ```
    This cluster uses hardcoded port bindings (e.g., 3100:3100).
    This prevents running multiple clusters simultaneously.
    To fix: delete .generacy/docker-compose.yml and re-run 'generacy launch'.
    ```
  - Do NOT block startup — warning only, then proceed to `runCompose`

- [ ] T007 [P] [US1] Add legacy port warning tests in `packages/generacy/src/cli/commands/up/__tests__/legacy-port-warning.test.ts`
  - Test: compose file with `'3100:3100'` triggers warning
  - Test: compose file with `'3100'` (ephemeral) does NOT trigger warning
  - Test: compose file with no ports does NOT trigger warning
  - Extract detection logic into a testable pure function (e.g., `hasLegacyPorts(ports: unknown[]): boolean`)

## Dependencies & Execution Order

**Sequential constraints**:
- T001 must complete before T002 (tests depend on the new behavior)
- T003 must complete before T004 (status/index.ts depends on new schema types)
- T006 should complete before T007 (tests depend on the detection function)

**Parallel opportunities**:
- T002 and T003 can run in parallel (different files, no shared dependencies)
- T005 and T006 can run in parallel (different feature areas)
- T007 can run in parallel with T005

**Recommended execution**:
1. T001 → T002 (scaffolder core + tests)
2. T003 → T004 (formatter schema + status parsing) — can overlap with step 1
3. T005 + T006 in parallel (formatter tests + legacy warning)
4. T007 (legacy warning tests)
