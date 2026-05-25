# Implementation Plan: Worker Scale Lifecycle Action

**Feature**: Implement `worker-scale` lifecycle action so cloud UI can scale worker replicas
**Branch**: `696-problem-generacy-cloud-ships`
**Status**: Complete

## Summary

Add `worker-scale` to the control-plane's `LifecycleActionSchema` and implement a handler that validates the requested count, persists it to `.env` and `cluster.yaml`, executes `docker compose up -d --scale worker=<n>`, and triggers an immediate metadata push so the cloud UI reflects the change within ~10s. Drive-by: fix the relay-bridge to read `workers` (flat) instead of `workerCount` (camelCase) from `cluster.yaml`.

## Technical Context

**Language/Version**: TypeScript (ESM), Node >=22
**Primary Dependencies**: `zod` (validation), `yaml` (file parsing/writing), `node:child_process` (docker compose exec), `node:fs` (file I/O), `node:http` (internal API calls)
**Storage**: File-based (`.env`, `cluster.yaml`)
**Testing**: Vitest (unit + integration with stubbed docker exec)
**Target Platform**: Linux container (cluster-base image)
**Project Type**: Monorepo (pnpm workspaces)
**Constraints**: Docker CLI + Compose V2 must be available in container (companion cluster-base PR)

## Project Structure

### Documentation (this feature)

```text
specs/696-problem-generacy-cloud-ships/
├── spec.md              # Feature specification
├── clarifications.md    # Clarified questions
├── plan.md              # This file
├── research.md          # Technology decisions
├── data-model.md        # Types and interfaces
└── quickstart.md        # Testing/usage guide
```

### Source Code (files to modify/create)

```text
packages/control-plane/
├── src/
│   ├── schemas.ts                          # ADD 'worker-scale' to LifecycleActionSchema
│   ├── routes/
│   │   └── lifecycle.ts                    # ADD worker-scale handler branch
│   └── services/
│       └── worker-scaler.ts                # NEW: orchestrates scale operation

packages/orchestrator/
├── src/
│   ├── server.ts                           # ADD POST /internal/refresh-metadata route
│   ├── routes/
│   │   └── internal-refresh-metadata.ts    # NEW: triggers immediate metadata push
│   ├── services/
│   │   └── relay-bridge.ts                 # FIX readClusterYaml: workerCount → workers
│   └── types/
│       └── relay.ts                        # FIX ClusterMetadataPayload: workerCount → workers

packages/cluster-relay/
└── src/
    └── metadata.ts                         # FIX workerCount → workers in metadata collection
```

## Implementation Phases

### Phase 1: Schema & Type Updates (no runtime behavior change)

1. Add `'worker-scale'` to `LifecycleActionSchema` in `packages/control-plane/src/schemas.ts`
2. Add `WorkerScaleBodySchema` (Zod: `{ count: z.number().int().min(1) }`)
3. Add `WorkerScaleResponseSchema` extending `LifecycleResponseSchema` with `previousCount` and `requestedCount`

### Phase 2: Drive-by metadata field rename

4. Rename `workerCount` → `workers` in `packages/orchestrator/src/types/relay.ts` (`ClusterMetadataPayload`)
5. Fix `readClusterYaml()` in `relay-bridge.ts:608-623` to read `parsed?.workers` instead of `parsed?.workerCount`
6. Update `collectMetadata()` in `relay-bridge.ts:545-549` to set `metadata.workers` instead of `metadata.workerCount`
7. Update `packages/cluster-relay/src/metadata.ts` if it references `workerCount`

### Phase 3: Worker-scale handler implementation

8. Create `packages/control-plane/src/services/worker-scaler.ts`:
   - `resolveProjectDir()` via existing `resolveGeneracyDir()`
   - `readCurrentWorkerCount(generacyDir)` — parse `.env` for `WORKER_COUNT`
   - `updateEnvFile(generacyDir, count)` — replace `WORKER_COUNT=<old>` with `WORKER_COUNT=<new>`
   - `updateClusterYaml(generacyDir, count)` — update `workers:` field
   - `execDockerScale(composeFilePath, count)` — spawn `docker compose up -d --scale worker=<n>`
   - `triggerMetadataRefresh()` — POST to orchestrator `/internal/refresh-metadata`
9. Wire handler in `lifecycle.ts` for `worker-scale` action

### Phase 4: Orchestrator refresh-metadata endpoint

10. Create `packages/orchestrator/src/routes/internal-refresh-metadata.ts`
    - Pattern: same as `internal-relay-events.ts` (getter for relay bridge, API key gated)
    - Calls `relayBridge.sendMetadata()` to push metadata immediately
11. Register route in `server.ts` (before `server.listen()`, same deferred-binding pattern as relay-events)

### Phase 5: Tests

12. Unit tests for `worker-scaler.ts` (file parsing, env updates, yaml updates)
13. Integration test for lifecycle handler with stubbed `child_process.spawn`
14. Unit test for `/internal/refresh-metadata` endpoint
15. Verify existing lifecycle tests still pass

## Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| Use `docker compose --scale` not Docker Engine API | Simpler, matches how CLI starts clusters; compose file `name:` field resolves project name |
| Trigger metadata refresh via HTTP IPC | Reuses existing `ORCHESTRATOR_INTERNAL_API_KEY` pattern from #594; no new relay channel needed |
| Flat `workers: <number>` in cluster.yaml | Matches scaffolder output; simplest representation |
| No upper-bound validation in cluster | Cloud already enforces tier limits before request reaches cluster |
| Atomic file updates for .env and cluster.yaml | Prevents partial writes on crash (temp+rename pattern) |

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Docker CLI not available in cluster-base | Companion PR blocker tracked separately; handler returns clear error if `docker` not found |
| Compose project name mismatch | Compose file has top-level `name:` field (scaffolder.ts:175); no `-p` needed |
| Race between scale and container readiness | Return `accepted: true` immediately; cloud polls via metadata for actual state |
| `.env` file format corruption | Use regex-based line replacement, not full rewrite; atomic write |

## Dependencies

- **Blocker**: `generacy-ai/cluster-base` companion PR adding `docker-ce-cli` + `docker-compose-plugin`
- **Internal**: `resolveGeneracyDir()` from `packages/control-plane/src/services/project-dir-resolver.ts`
- **Internal**: `ORCHESTRATOR_INTERNAL_API_KEY` IPC pattern from #594
