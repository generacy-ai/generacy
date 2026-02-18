# Implementation Plan: Label Sync Utility for Watched Repositories

**Feature**: Label sync utility that provisions workflow labels across all configured repositories
**Branch**: `feature/200-label-sync-utility`
**Status**: Complete

## Summary

Add a `LabelSyncService` to the orchestrator package that reads a list of watched repositories from configuration, and on startup (or when a new repo is added), ensures all label protocol labels exist with correct colors and descriptions. The service reuses the existing `GitHubClient` from `@generacy-ai/workflow-engine` for GitHub API calls and the existing `WORKFLOW_LABELS` definition as the source of truth.

## Technical Context

- **Language**: TypeScript (ES modules)
- **Runtime**: Node.js >= 20
- **Framework**: Fastify 5 (orchestrator server)
- **Testing**: Vitest
- **GitHub API**: Via `gh` CLI (through `GhCliGitHubClient`)
- **Config**: Zod schemas
- **Logging**: Pino (via Fastify)

## Key Technical Decisions

1. **Reuse existing GitHubClient** from workflow-engine rather than creating a new Octokit-based client. The `gh` CLI approach is already battle-tested and the interface supports all needed label operations.

2. **Extract label definitions** to a shared export from workflow-engine. The existing `WORKFLOW_LABELS` array in `sync-labels.ts` is the canonical source; we'll export it and add missing `process:*` and `epic-child` labels.

3. **Service pattern** follows existing orchestrator services (`WorkflowService`, `QueueService`, `AgentRegistry`) — a class injected into the server startup lifecycle.

4. **Sync before listen** — label sync runs in `createServer()` after config loading but before `server.listen()`, ensuring labels are provisioned before webhook processing begins.

## Project Structure

```
packages/orchestrator/
├── src/
│   ├── config/
│   │   └── schema.ts                    # MODIFY — add RepositoriesConfig
│   ├── services/
│   │   ├── label-sync-service.ts        # NEW — LabelSyncService
│   │   └── index.ts                     # MODIFY — export new service
│   ├── server.ts                        # MODIFY — integrate label sync on startup
│   └── index.ts                         # MODIFY — export new service
├── tests/
│   └── services/
│       └── label-sync-service.test.ts   # NEW — unit tests

packages/workflow-engine/
├── src/
│   ├── actions/github/
│   │   ├── sync-labels.ts               # MODIFY — export WORKFLOW_LABELS
│   │   └── label-definitions.ts         # NEW — shared label definitions module
│   └── index.ts                         # MODIFY — export label definitions
```

## Implementation Steps

### Step 1: Extract label definitions to shared module

Create `packages/workflow-engine/src/actions/github/label-definitions.ts`:
- Move `WORKFLOW_LABELS` from `sync-labels.ts` to this new module
- Add missing labels: `process:speckit-feature`, `process:speckit-bugfix`, `epic-child`
- Export `WORKFLOW_LABELS` and the `LabelConfig` interface
- Update `sync-labels.ts` to import from the new module
- Export from workflow-engine's `index.ts`

### Step 2: Add repository configuration to orchestrator

Extend `packages/orchestrator/src/config/schema.ts`:
- Add `RepositoryConfigSchema` with `owner` and `repo` fields
- Add `repositories` array to `OrchestratorConfigSchema` (default empty)
- Support `ORCHESTRATOR_REPOSITORIES` env var as comma-separated `owner/repo` list

### Step 3: Implement LabelSyncService

Create `packages/orchestrator/src/services/label-sync-service.ts`:
- Constructor takes a logger and the GitHubClient factory
- `syncAll(repos)` — iterates repos, calls `syncRepo` for each, collects results
- `syncRepo(owner, repo)` — lists existing labels, diffs against `WORKFLOW_LABELS`, creates/updates as needed
- Returns structured results per repo (created/updated/unchanged counts)
- Handles per-repo errors without failing the batch
- Tracks synced repos to avoid redundant re-syncs

### Step 4: Integrate into server startup

Modify `packages/orchestrator/src/server.ts`:
- After config loading and before route registration, instantiate `LabelSyncService`
- If `config.repositories` is non-empty, call `syncAll()`
- Log results summary
- Sync failures log warnings but do not prevent server startup

### Step 5: Add unit tests

Create `packages/orchestrator/tests/services/label-sync-service.test.ts`:
- Mock `GitHubClient` interface
- Test: creates missing labels
- Test: updates labels with wrong color/description
- Test: skips labels that match
- Test: continues on per-repo failure
- Test: tracks synced repos to avoid re-sync
- Test: handles empty repository list

## Dependencies

| Dependency | Source | Usage |
|-----------|--------|-------|
| `GitHubClient` | `@generacy-ai/workflow-engine` | Label CRUD operations |
| `createGitHubClient` | `@generacy-ai/workflow-engine` | Client factory |
| `WORKFLOW_LABELS` | `@generacy-ai/workflow-engine` | Label definitions |
| `zod` | npm | Config schema |
| `pino` | via Fastify | Logging |

## Rate Limiting Strategy

The `gh` CLI handles authentication and basic rate limiting. For multi-repo sync:
- List labels first (1 API call per repo) to minimize mutations
- Only create/update labels that differ (minimize writes)
- Process repos sequentially (not in parallel) to stay within rate limits
- Log rate limit headers if available after sync

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| GitHub API rate limit hit during sync | Medium — sync incomplete | Sequential processing, diff-first approach, log warnings |
| `gh` CLI not authenticated in production | High — sync fails silently | Validate auth on startup, clear error message |
| Label definitions drift between workflow-engine and orchestrator | Medium — inconsistent state | Single source of truth in shared module |
