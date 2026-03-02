# Clarification Questions

## Status: Pending

## Questions

### Q1: Unassigned Issues Behavior
**Context**: The filtering logic uses `issue.assignees.includes(clusterGithubUsername)`, which returns `false` for issues with an empty assignees list. When assignee filtering is active, this means **no cluster** would process unassigned issues — they'd be silently dropped by every cluster. This is a significant behavioral change from the current system where all issues are processed.
**Question**: When assignee filtering is enabled, should issues with **no assignees** be processed by all clusters (treated like the backward-compatible case), or should they be skipped by all clusters (requiring explicit assignment before processing)?
**Options**:
- A) Process unassigned issues on all clusters: Unassigned issues bypass the filter entirely, behaving as if filtering is disabled for that issue. This is safer for adoption but reduces the partitioning benefit for issues that haven't been assigned yet.
- B) Skip unassigned issues on all clusters: Only explicitly assigned issues are processed. This enforces a strict "assign before label" workflow but risks silently dropping issues if developers forget to assign.
- C) Configurable behavior via env var: Add a `CLUSTER_PROCESS_UNASSIGNED` boolean (default: true) to control whether unassigned issues are processed. More flexible but adds configuration complexity.
**Answer**:

---

### Q2: Issue Assignees Availability from `listIssuesWithLabel()`
**Context**: The spec assumes `issue.assignees` is available from `client.listIssuesWithLabel()`. However, this method currently returns lightweight issue objects (`{ number, labels: [{ name }] }`). If `assignees` is not included in the response, each polling cycle would need additional `getIssue()` API calls per issue to check assignees, which could significantly increase GitHub API usage — especially for `KNOWN_COMPLETED_LABELS` which checks 13 labels.
**Question**: Does `client.listIssuesWithLabel()` (from `@generacy-ai/workflow-engine`) already return `assignees` in its `Issue` type, or does the workflow-engine client need to be updated to include this field?
**Options**:
- A) Already included: The `Issue` type from workflow-engine includes `assignees` and the GitHub API list endpoint returns it. No additional API calls needed.
- B) Needs workflow-engine update: The `Issue` type needs `assignees` added. The GitHub Issues API already returns assignees in list responses, so this is just a type/mapping change in workflow-engine.
- C) Requires per-issue fetch: The list endpoint doesn't return assignees and a separate `getIssue()` call is needed per issue. Consider batching or caching strategies.
**Answer**:

---

### Q3: Multiple Clusters Assigned to Same Issue
**Context**: An issue can have multiple GitHub assignees. If two developers both assign themselves to the same issue, the `includes()` check passes for both clusters, meaning both would process it — defeating the purpose of the feature. The spec states "a single GitHub username is sufficient for cluster identity" but doesn't address the case where the issue itself has multiple assignees that map to different clusters.
**Question**: Should the system detect and warn when an issue is assigned to multiple known cluster identities, or is this considered a user workflow error that doesn't need handling?
**Options**:
- A) No special handling: This is a user workflow error. Document that each issue should be assigned to exactly one cluster identity. Multiple assignments result in duplicate processing (same as current behavior).
- B) Log a warning: When an issue has multiple assignees, log a warning-level message indicating potential duplicate processing, but still process the issue.
- C) First-assignee wins: Only process if the cluster's username matches the first assignee in the list. This is fragile and depends on GitHub's ordering.
**Answer**:

---

### Q4: Assignee Filtering Order in PR Feedback Monitor
**Context**: The `PrFeedbackMonitorService` already calls `PrLinker.linkPrToIssue()` which fetches the issue to verify it's orchestrated (has `agent:*` label). FR-009 adds a separate `client.getIssue()` call after linking to check assignees. This means the issue is fetched twice — once in `PrLinker` and once for the assignee check. Additionally, for polling, the new `deduplicatePrsByIssue()` pre-filters PRs before the full event flow. The spec doesn't clarify where in this pipeline the assignee check should go.
**Question**: Should the assignee check in `PrFeedbackMonitorService` reuse the issue data already fetched by `PrLinker.linkPrToIssue()`, or should it remain a separate fetch as specified?
**Options**:
- A) Reuse PrLinker's issue data: Modify `PrLinker.linkPrToIssue()` to return the issue's assignees in its result, avoiding the duplicate fetch. This changes the PrLinker interface.
- B) Separate fetch as specified: Keep the additional `getIssue()` call. Simpler implementation, but adds one extra API call per PR event.
- C) Cache at client level: Implement a short-lived cache in the GitHub client so the second `getIssue()` call hits the cache. No interface changes needed.
**Answer**:

---

### Q5: Shared Filtering Utility vs. Duplicated Private Methods
**Context**: The spec places identical `filterByAssignee()` private methods on three separate services (`LabelMonitorService`, `EpicCompletionMonitorService`, and a similar pattern in `PrFeedbackMonitorService`). The new `services/identity.ts` file is already being created as a shared utility for identity resolution. Duplicating the filtering logic across three services violates DRY and increases maintenance burden.
**Question**: Should `filterByAssignee()` be a shared utility function (e.g., in `services/identity.ts` alongside `resolveClusterIdentity()`), or should it remain as duplicated private methods on each service?
**Options**:
- A) Shared utility function: Export a `filterByAssignee(issues, username, logger)` function from `services/identity.ts`. Services call the shared function. Single point of maintenance.
- B) Duplicated private methods as specified: Each service has its own copy. Simpler per-service, but three copies to maintain.
- C) Base class or mixin: Create a shared base class or mixin that provides the filtering. More structural change but follows OOP patterns.
**Answer**:

---

### Q6: `gh api /user` Failure Modes and Timeout
**Context**: The spec says `resolveClusterIdentity()` calls `gh api /user` via `exec()` as a fallback. Several failure modes are unspecified: network timeouts (the `gh` CLI may hang if GitHub is unreachable), `gh` not installed, `gh` not authenticated, invalid JSON response, or the command being killed. SC-002 mentions a 10s target for the fallback path but doesn't specify an enforcement mechanism.
**Question**: What timeout should be enforced on the `gh api /user` subprocess, and should specific error types (auth failure vs. network vs. not installed) produce different log messages?
**Options**:
- A) Simple 10s timeout, generic error: Kill the subprocess after 10s. Log a single warning message regardless of failure type. Keep it simple.
- B) 10s timeout with error classification: Kill after 10s. Parse stderr to distinguish "gh not found", "not authenticated", and "network error". Log specific warnings for each to aid debugging.
- C) 5s timeout, strict: Use a shorter timeout since this blocks startup. Log specific errors. If the timeout is hit, suggest setting `CLUSTER_GITHUB_USERNAME` explicitly.
**Answer**:

---

### Q7: Assignee Check Timing for Webhook Label Events
**Context**: For webhook label events, the assignee check happens when the webhook fires (immediately after a label is applied). The spec's assumption states "assignees are set before applying `process:*` labels," but in practice a developer might apply the label first and assign second — especially if using GitHub's bulk actions or automation. If the label webhook fires before the assignee is set, the issue will be filtered out and never retried (webhooks are fire-once, and subsequent assignee changes don't trigger label webhooks).
**Question**: Should there be a recovery mechanism for issues that were filtered out at webhook time but later assigned, or is the "assign before label" workflow strictly enforced?
**Options**:
- A) Polling catches it: The polling loop will pick up the issue on its next cycle (since the label is still present and the assignee will be set by then). No extra mechanism needed — the hybrid webhook+polling design already handles this.
- B) Strict enforcement: Document that "assign before label" is required. If missed, the developer must remove and re-add the label. Simple and explicit.
- C) Delayed webhook processing: When a webhook fires for an unassigned issue, schedule a delayed retry (e.g., 30s) to re-check assignees. More complex but handles the race condition.
**Answer**:

---

### Q8: Webhook Response Contract Change
**Context**: FR-013 specifies returning `{ status: 'ignored', reason: 'not assigned to this cluster' }` from the webhook handler. The current webhook response type is `{ status: 'processed' | 'duplicate' | 'ignored' }` without a `reason` field. Adding `reason` changes the response contract. If any external systems (monitoring, alerting, or the Smee receiver) inspect webhook responses, this could have unexpected effects.
**Question**: Is the `reason` field in the webhook response a new addition to the response type, and are there any external consumers of webhook responses that need to be updated?
**Options**:
- A) Add optional `reason` field: Add `reason?: string` to the response type. Existing consumers ignore unknown fields, so this is backward-compatible.
- B) Use existing `status: 'ignored'` only: Don't add `reason` to the response. Log the reason server-side at debug level instead. No response contract change.
- C) New status value: Add `status: 'filtered'` as a distinct status from `'ignored'` to differentiate assignee filtering from other ignore reasons.
**Answer**:

---

### Q9: EpicCompletionMonitorService — Filter Parent or Children?
**Context**: The spec says to add assignee filtering in `EpicCompletionMonitorService.pollRepo()` after `client.listIssuesWithLabel()`. This filters the **parent epic issues** by assignee. However, epic issues may be assigned to a project lead while child issues are assigned to individual developers (different clusters). If the epic is assigned to Developer A's cluster, only that cluster monitors completion — even if Developer B's cluster is processing child issues. Conversely, if the epic is unassigned, no cluster monitors it (per Q1).
**Question**: For epic completion monitoring, should the assignee filter apply to the parent epic issue, or should it be based on whether any child issues are assigned to the cluster?
**Options**:
- A) Filter on parent epic assignee: Only the cluster whose identity matches the epic's assignee monitors its completion. Simple and consistent with the other services.
- B) Filter on child issue assignees: A cluster monitors an epic if any of its child issues are assigned to it. More semantically correct but requires fetching child issues before filtering.
- C) No filtering on epics: Epic completion monitoring is a lightweight read-only check (no processing/enqueuing). Skip assignee filtering entirely for this service to avoid gaps.
**Answer**:

---

### Q10: CLI Orchestrator Command Scope
**Context**: FR-016 says to update the CLI orchestrator command to resolve identity and pass to `LabelMonitorService`. However, the CLI command in `packages/generacy/src/cli/commands/orchestrator.ts` also constructs other components (server, Smee receiver, etc.). The spec's file change table only mentions passing to `LabelMonitorService` in the CLI, but the CLI ultimately calls `createOrchestratorServer()` from `server.ts` which constructs all services. If `server.ts` already handles identity resolution and passes it to all services (FR-004), the CLI shouldn't need separate identity resolution.
**Question**: Should identity resolution happen exclusively in `server.ts` (covering both direct server startup and CLI invocation), or does the CLI need its own separate resolution before calling `createOrchestratorServer()`?
**Options**:
- A) Server.ts only: Identity resolution lives in `createOrchestratorServer()`. The CLI just passes config; the server resolves identity internally. Single code path.
- B) CLI resolves and passes to server: The CLI resolves identity and passes it as a parameter to `createOrchestratorServer()`. This allows the CLI to log the identity before server construction.
- C) Both paths: The CLI resolves for its own `LabelMonitorService` construction (if it constructs one directly), and `server.ts` resolves for its services. Each entry point handles its own resolution.
**Answer**:
