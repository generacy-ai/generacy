# Research: Label Sync Utility

## Technology Decisions

### GitHub API Access: `gh` CLI vs Octokit

**Decision**: Use `gh` CLI via existing `GhCliGitHubClient`

**Rationale**:
- Already implemented and tested in `@generacy-ai/workflow-engine`
- `GitHubClient` interface has all needed methods: `listLabels`, `createLabel`, `updateLabel`
- Handles authentication via `gh auth` / `GH_TOKEN` env var
- Consistent with all other GitHub operations in the codebase

**Alternative considered**: Direct Octokit usage (as in `generacy-plugin-copilot`). Rejected because it would introduce a parallel GitHub client stack and the label sync doesn't need features beyond what `gh` CLI provides.

### Label Definition Sharing: Shared module vs Duplication

**Decision**: Extract to `label-definitions.ts` in workflow-engine, import from orchestrator

**Rationale**:
- Single source of truth prevents drift
- workflow-engine already owns the `SyncLabelsAction` and label types
- orchestrator already depends on workflow-engine (or can add the dep)

**Alternative considered**: Copy-paste label array into orchestrator. Rejected due to maintenance burden.

### Sync Timing: Before listen vs Background

**Decision**: Sync before `server.listen()` (blocking startup)

**Rationale**:
- Issue spec requires "Runs automatically on startup"
- Labels must exist before webhooks can trigger workflow processing
- Sync is fast when labels already exist (1 API call per repo to list, 0 mutations)

**Alternative considered**: Background async sync after startup. Rejected because there's a race condition — a webhook could arrive before labels are provisioned.

## Implementation Patterns

### Service Pattern
Follow existing services in `packages/orchestrator/src/services/`:
- Class-based service with dependency injection (logger, client factory)
- Sync/async methods returning typed results
- No framework coupling (pure TypeScript, testable in isolation)

### Error Handling
- Per-repo try/catch — one repo failing doesn't block others
- Structured error logging with repo context
- Sync failures are warnings, not fatal errors

## Key References

- Existing `SyncLabelsAction`: `packages/workflow-engine/src/actions/github/sync-labels.ts`
- Existing `LabelOperations`: `packages/github-issues/src/operations/labels.ts`
- `GitHubClient` interface: `packages/workflow-engine/src/actions/github/client/interface.ts`
- Orchestrator config: `packages/orchestrator/src/config/schema.ts`
- GitHub label API docs: https://docs.github.com/en/rest/issues/labels
