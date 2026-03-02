# Technical Research: Assignee Filtering Implementation

## Codebase Findings

### 1. Issue.assignees Already Available

**Verified**: Both `listIssuesWithLabel()` and `getIssue()` in `gh-cli.ts` already request and return `assignees`.

- `listIssuesWithLabel()` (line 114): `--json 'number,title,body,state,labels,assignees,milestone,createdAt,updatedAt'`
- `getIssue()` (line 75): same fields
- Both map assignees: `((item['assignees'] as Array<{ login: string }>) ?? []).map(a => a.login)`
- `Issue` type: `assignees: string[]` (flat login strings)

**Conclusion**: No workflow-engine changes needed (Q2 answer confirmed: option A).

### 2. GitHubWebhookPayload Missing Assignees

**Confirmed**: The current `GitHubWebhookPayload.issue` type in `types/monitor.ts` only has:
```typescript
issue: { number: number; title: string; labels: Array<{ name: string }> }
```

GitHub's actual webhook payload includes `assignees: Array<{ login: string }>`. This must be added.

### 3. Webhook Content-Type Parser Registration

Both `webhooks.ts` and `pr-webhooks.ts` register `addContentTypeParser('application/json', { parseAs: 'string' })`. In Fastify, this replaces the default JSON parser instance-wide. When both are registered on the same Fastify instance, the second registration overwrites the first.

**Current behavior**: This works because both parsers do the same thing (parse JSON, keep raw body). No conflict in practice, but it's fragile.

**This feature doesn't change this behavior** — it's pre-existing and unrelated to assignee filtering.

### 4. EpicCompletionMonitorService Not Wired

**Confirmed**: `server.ts` does not import, instantiate, or start `EpicCompletionMonitorService`. The config schema exists (`EpicMonitorConfigSchema`) and the service file exists, but the service is never started.

**Impact**: Per Q9 (option C), no assignee filtering is added to this service. This is safe because:
1. The service is never instantiated by the server
2. Epic monitoring is read-only (updates comments, transitions labels)
3. The `completed:children-complete` label it applies is picked up by `LabelMonitorService`, which has assignee filtering

### 5. CLI vs Server Service Construction

**Finding**: The CLI `orchestrator.ts` command has its own `setupLabelMonitor()` function that constructs `LabelMonitorService` directly (not via `server.ts`). This is a separate code path that also needs identity resolution.

The CLI path:
```
orchestrator.ts → setupLabelMonitor() → new LabelMonitorService(...)
```

The server path:
```
server.ts → createServer() → new LabelMonitorService(...)
```

**Both paths need updating** (contradicts Q10-A "server.ts only" — the CLI has its own construction path).

### 6. PrLinker.linkPrToIssue() Return Type

`PrLinker.linkPrToIssue()` returns `PrToIssueLink | null`:
```typescript
interface PrToIssueLink {
  prNumber: number;
  issueNumber: number;
  linkMethod: 'pr-body' | 'branch-name';
}
```

It fetches the issue internally (line 113: `const issue = await github.getIssue(...)`) but only checks `issue.labels` for orchestration status. The `issue` object (including `assignees`) is not returned.

**Options for assignee check in PR feedback**:
1. **Extend PrToIssueLink** to include `assignees: string[]` and return from `linkPrToIssue()` — saves 1 API call
2. **Separate fetch** in `processPrReviewEvent()` after linking — simpler, 1 extra API call

Plan uses option 2 (separate fetch) for simplicity. Option 1 is a good optimization if API calls become a concern.

### 7. Logger Interface Inconsistency

Different services use different logger interfaces:

- `LabelMonitorService`: local `Logger` interface (info, warn, error — **no debug**)
- `PrFeedbackMonitorService`: imports `Logger` from `../worker/types.js` (has info, warn, error, debug, child)
- `EpicCompletionMonitorService`: local `Logger` interface (info, warn, error — **no debug**)
- `server.ts`: Fastify's pino logger (has all levels)

The shared `filterByAssignee()` utility needs to handle loggers with and without `debug`. Implementation uses optional chaining: `logger.debug?.()`.

### 8. Existing Webhook Response Pattern

Current webhook responses already include `reason` strings:
```typescript
// webhooks.ts
{ status: 'ignored', reason: 'not a labeled event' }
{ status: 'ignored', reason: 'not a watched repository' }
{ status: 'ignored', reason: 'not a trigger label' }
{ status: 'ignored', reason: 'resume detected after label re-fetch' }
{ status: 'ignored', reason: 'no matching waiting-for:* after re-fetch' }

// pr-webhooks.ts
{ status: 'ignored', reason: 'not a PR review event (got: ...)' }
{ status: 'ignored', reason: 'not a submitted review (got action: ...)' }
{ status: 'ignored', reason: 'not a watched repository' }
```

Adding `{ status: 'ignored', reason: 'not assigned to this cluster' }` follows the existing pattern exactly.

### 9. Test Patterns

Existing tests use:
- `vitest` (`describe`, `it`, `expect`, `vi.fn()`, `vi.mock()`)
- Mock factories: `createMockLogger()`, `createMockPhaseTracker()`, `createMockQueueAdapter()`, `createMockGitHubClient()`
- Direct service instantiation with mock dependencies
- Fastify `inject()` for route testing
- HMAC signature computation for webhook tests

New tests should follow these patterns exactly.
