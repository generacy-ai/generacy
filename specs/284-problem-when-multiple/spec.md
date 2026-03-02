# Feature Specification: Filter Issue Monitoring by Assignee

**Branch**: `284-problem-when-multiple` | **Date**: 2026-03-02 | **Status**: Draft

## Summary

When multiple developers run orchestrator clusters locally against the same monitored repositories, every cluster independently detects and queues the same labeled issues for processing. The existing `PhaseTrackerService` deduplication uses a local Redis instance per cluster, so it only prevents duplicates **within** a single cluster — not **across** clusters. This leads to conflicting branches, duplicate PRs, and wasted compute.

The solution adds assignee-based issue filtering: each orchestrator cluster resolves its GitHub identity at startup and only processes issues assigned to that identity. This naturally partitions work across clusters without requiring shared state.

## User Stories

### US1: Developer Runs Local Cluster Without Cross-Cluster Conflicts

**As a** developer running a local orchestrator cluster,
**I want** my cluster to only process issues assigned to my GitHub account,
**So that** my cluster doesn't conflict with other developers' clusters processing the same issues.

**Acceptance Criteria**:
- [ ] Cluster resolves its GitHub identity at startup via `CLUSTER_GITHUB_USERNAME` env var or `gh api /user` fallback
- [ ] `LabelMonitorService` only processes issues where `issue.assignees` includes the cluster's username
- [ ] `PrFeedbackMonitorService` only processes PR feedback for issues assigned to the cluster's username
- [ ] `EpicCompletionMonitorService` only processes epics assigned to the cluster's username
- [ ] Label webhook handler ignores issues not assigned to the cluster's username
- [ ] PR review webhook handler ignores issues not assigned to the cluster's username
- [ ] Skipped issues are logged at `debug` level with the reason

### US2: Explicit Cluster Identity Configuration

**As a** DevOps engineer deploying production orchestrators,
**I want** to explicitly set the cluster's GitHub username via an environment variable,
**So that** I have deterministic control over which issues each cluster processes.

**Acceptance Criteria**:
- [ ] `CLUSTER_GITHUB_USERNAME` env var is read by the config loader
- [ ] When set, the env var value is used as the cluster identity (no `gh api /user` call)
- [ ] The resolved username is logged at startup at `info` level
- [ ] The username is passed to all monitor services and webhook handlers

### US3: Automatic Identity Detection

**As a** developer who has authenticated with `gh auth`,
**I want** the cluster to automatically detect my GitHub username,
**So that** I don't need extra configuration to get assignee filtering.

**Acceptance Criteria**:
- [ ] When `CLUSTER_GITHUB_USERNAME` is not set, the cluster calls `gh api /user` once at startup
- [ ] The `login` field from the response is used as the cluster identity
- [ ] The `gh api /user` result is cached (never called again during the cluster's lifetime)
- [ ] If `gh api /user` fails, a warning is logged and filtering is disabled (backward-compatible)

### US4: Backward-Compatible Fallback

**As a** developer who hasn't configured a username or `gh auth`,
**I want** the orchestrator to continue working as before (processing all issues),
**So that** existing workflows are not broken.

**Acceptance Criteria**:
- [ ] When neither `CLUSTER_GITHUB_USERNAME` nor `gh api /user` succeeds, all issues are processed
- [ ] A warning is logged explaining that assignee filtering is disabled
- [ ] No errors are thrown during startup due to missing identity

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add `clusterGithubUsername` field (optional `string`) to `MonitorConfigSchema` in `config/schema.ts` | P1 | Used by all services for filtering |
| FR-002 | Read `CLUSTER_GITHUB_USERNAME` env var in config loader (`config/loader.ts`) and map to `monitor.clusterGithubUsername` | P1 | |
| FR-003 | Implement `resolveClusterIdentity()` utility that: (1) checks `config.monitor.clusterGithubUsername`, (2) falls back to `gh api /user`, (3) returns `undefined` if both fail | P1 | Call once at startup, cache result |
| FR-004 | Resolve cluster identity in `server.ts` before constructing services; log resolved username at `info` level | P1 | |
| FR-005 | Add `clusterGithubUsername?: string` parameter to `LabelMonitorService` constructor | P1 | Pass `undefined` to skip filtering |
| FR-006 | Add `filterByAssignee()` method to `LabelMonitorService` that filters issues where `issue.assignees` includes the cluster username | P1 | When username is `undefined`, return all issues (no filtering) |
| FR-007 | Call `filterByAssignee()` in `LabelMonitorService.pollRepo()` after `client.listIssuesWithLabel()` and before processing | P1 | Apply to both `KNOWN_PROCESS_LABELS` and `KNOWN_COMPLETED_LABELS` loops |
| FR-008 | Add `clusterGithubUsername?: string` parameter to `PrFeedbackMonitorService` constructor | P1 | |
| FR-009 | In `PrFeedbackMonitorService`, after `PrLinker` resolves the linked issue number, fetch the issue via `client.getIssue()` and check assignees before processing | P1 | `getIssue()` already returns `Issue` with `assignees: string[]` |
| FR-010 | Add `clusterGithubUsername?: string` parameter to `EpicCompletionMonitorService` constructor | P1 | |
| FR-011 | Add assignee filtering in `EpicCompletionMonitorService.pollRepo()` after `client.listIssuesWithLabel()` | P1 | Same pattern as `LabelMonitorService` |
| FR-012 | Add `assignees: Array<{ login: string }>` to `GitHubWebhookPayload.issue` type in `types/monitor.ts` | P1 | Currently missing from the type; real GitHub payloads include this field |
| FR-013 | Add assignee check in webhook handler (`routes/webhooks.ts`) before `parseLabelEvent()` | P1 | Return `{ status: 'ignored', reason: 'not assigned to this cluster' }` when filtered |
| FR-014 | Add assignee check in PR webhook handler (`routes/pr-webhooks.ts`) after resolving linked issue | P2 | Requires issue fetch since `GitHubPrReviewWebhookPayload` lacks issue assignees |
| FR-015 | Pass resolved `clusterGithubUsername` to webhook route setup functions (`setupWebhookRoutes`, `setupPrWebhookRoutes`) | P1 | |
| FR-016 | Update CLI orchestrator command (`packages/generacy/src/cli/commands/orchestrator.ts`) to resolve identity and pass to `LabelMonitorService` | P1 | Same resolution logic as `server.ts` |
| FR-017 | Log skipped issues at `debug` level with issue number, repo, and reason | P2 | Aids troubleshooting |
| FR-018 | Log unassigned issues distinctly from "assigned to someone else" at `debug` level | P2 | Helps distinguish "no assignee" from "wrong assignee" |

## Technical Design

### Identity Resolution

```
resolveClusterIdentity(config) → string | undefined
├── config.monitor.clusterGithubUsername is set? → return it
├── exec("gh api /user") succeeds? → parse JSON, return .login
└── both fail → log warning, return undefined
```

- Called once at startup in `server.ts` and `orchestrator.ts` CLI command
- Result stored as a simple `string | undefined` and passed via constructor injection
- No runtime re-resolution; if identity changes, restart the cluster

### Assignee Filtering Logic

Shared pattern for all monitor services (implemented as a private method on each):

```typescript
private filterByAssignee(issues: Issue[]): Issue[] {
  if (!this.clusterGithubUsername) return issues;
  return issues.filter(issue => {
    const assigned = issue.assignees.includes(this.clusterGithubUsername!);
    if (!assigned) {
      this.logger.debug(
        { issueNumber: issue.number, assignees: issue.assignees },
        'Skipping issue: not assigned to this cluster'
      );
    }
    return assigned;
  });
}
```

### Webhook Assignee Check

For label webhooks (`routes/webhooks.ts`), the check uses the payload's issue data directly:

```typescript
if (clusterGithubUsername) {
  const assigneeLogins = payload.issue.assignees.map(a => a.login);
  if (!assigneeLogins.includes(clusterGithubUsername)) {
    return { status: 'ignored', reason: 'not assigned to this cluster' };
  }
}
```

For PR review webhooks (`routes/pr-webhooks.ts`), the payload only contains PR data. The linked issue must be resolved via `PrLinker` first, then the issue fetched to check assignees. This adds one API call per filtered PR webhook.

### Corrections to Issue Description

The issue states that `payload.issue.assignees` is "already in the `GitHubWebhookPayload` type" — this is **incorrect**. The current `GitHubWebhookPayload.issue` type in `types/monitor.ts` only has `number`, `title`, and `labels`. The `assignees` field must be added (FR-012).

### File Changes

All changes are in `packages/orchestrator` and `packages/generacy`:

| File | Change |
|------|--------|
| `packages/orchestrator/src/config/schema.ts` | Add `clusterGithubUsername: z.string().optional()` to `MonitorConfigSchema` |
| `packages/orchestrator/src/config/loader.ts` | Read `CLUSTER_GITHUB_USERNAME` env var into `monitor.clusterGithubUsername` |
| `packages/orchestrator/src/services/identity.ts` | **New file**: `resolveClusterIdentity()` function (env var check + `gh api /user` fallback) |
| `packages/orchestrator/src/server.ts` | Call `resolveClusterIdentity()` at startup; pass result to service constructors and webhook route setup |
| `packages/orchestrator/src/services/label-monitor-service.ts` | Add `clusterGithubUsername` constructor param; add `filterByAssignee()`; call in `pollRepo()` |
| `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` | Add `clusterGithubUsername` constructor param; add assignee check after issue linking in `processPrReviewEvent()` |
| `packages/orchestrator/src/services/epic-completion-monitor-service.ts` | Add `clusterGithubUsername` constructor param; add `filterByAssignee()`; call in `pollRepo()` |
| `packages/orchestrator/src/types/monitor.ts` | Add `assignees: Array<{ login: string }>` to `GitHubWebhookPayload.issue` |
| `packages/orchestrator/src/routes/webhooks.ts` | Accept `clusterGithubUsername` param; add assignee check before processing |
| `packages/orchestrator/src/routes/pr-webhooks.ts` | Accept `clusterGithubUsername` param; add assignee check after issue resolution |
| `packages/generacy/src/cli/commands/orchestrator.ts` | Resolve identity; pass to `LabelMonitorService` constructor |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Cross-cluster duplicate processing | Zero duplicates when two clusters monitor the same repos with different identities | Manual test: run two clusters, assign issue to one identity, verify only that cluster processes it |
| SC-002 | Identity resolution at startup | Resolves in < 5s (env var) or < 10s (gh api fallback) | Log timestamp at startup |
| SC-003 | Backward compatibility | Existing single-cluster setups work without any configuration changes | Automated tests: services with `clusterGithubUsername: undefined` process all issues |
| SC-004 | Filtered issue logging | All skipped issues produce debug-level log entries | Review logs after test run with assignee filtering enabled |
| SC-005 | Test coverage | All filtering logic covered by unit tests | Tests for each service with and without `clusterGithubUsername` set |

## Testing Strategy

### Unit Tests

| Test | Service | Scenario |
|------|---------|----------|
| `filterByAssignee` returns all issues when username is `undefined` | LabelMonitorService | Backward compatibility |
| `filterByAssignee` returns only assigned issues | LabelMonitorService | Normal filtering |
| `filterByAssignee` returns empty array when no issues match | LabelMonitorService | No work for this cluster |
| `pollRepo` calls `filterByAssignee` before processing | LabelMonitorService | Integration |
| Same filtering tests | EpicCompletionMonitorService | Same patterns |
| `processPrReviewEvent` skips unassigned issues | PrFeedbackMonitorService | After issue fetch |
| `processPrReviewEvent` processes assigned issues | PrFeedbackMonitorService | Normal flow |
| Webhook returns `ignored` for unassigned issues | webhooks.ts | Assignee check |
| Webhook processes assigned issues normally | webhooks.ts | Normal flow |
| Webhook processes all issues when no username configured | webhooks.ts | Backward compatibility |
| `resolveClusterIdentity` returns env var when set | identity.ts | Priority 1 source |
| `resolveClusterIdentity` falls back to `gh api /user` | identity.ts | Priority 2 source |
| `resolveClusterIdentity` returns `undefined` when both fail | identity.ts | Graceful fallback |

### Integration Tests

- Two simulated clusters with different usernames monitoring the same repo: verify each only processes its assigned issues
- Cluster with no username configured: verify it processes all issues (backward compat)

## Assumptions

- The `gh` CLI is installed and available on `$PATH` in environments that rely on auto-detection (not required when `CLUSTER_GITHUB_USERNAME` is explicitly set)
- Issue assignees are set **before** applying `process:*` labels (otherwise the issue may be picked up and filtered out before the assignee is set)
- GitHub webhook payloads include `issue.assignees` as an array of objects with `login` fields (confirmed by GitHub API documentation)
- A single GitHub username is sufficient for cluster identity (no need for multiple assignees per cluster)
- The `EpicCompletionMonitorService` is currently not wired into `server.ts` — this feature adds filtering to it but does **not** wire it into the server (that's a separate concern)

## Out of Scope

- **Shared Redis deduplication across clusters**: The assignee approach replaces the need for cross-cluster Redis; no shared Redis work is planned
- **Wiring `EpicCompletionMonitorService` into `server.ts`**: The service exists but isn't started by the server; adding filtering logic is in scope, but instantiating/starting it is not
- **Multiple assignees per cluster**: Each cluster has exactly one identity; supporting multiple identities adds complexity without clear benefit
- **Runtime identity changes**: If the cluster's identity needs to change, the cluster must be restarted
- **GitHub App authentication**: This feature uses personal access tokens / `gh auth` tokens; GitHub App installation tokens have different identity semantics
- **Assignee auto-assignment**: This feature does not automatically assign issues; developers must manually assign issues to the appropriate account before labeling
- **UI changes**: No frontend changes are needed; this is entirely an orchestrator-side change

---

*Generated by speckit*
