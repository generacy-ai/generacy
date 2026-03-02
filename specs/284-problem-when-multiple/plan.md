# Implementation Plan: Filter Issue Monitoring by Assignee

**Branch**: `284-problem-when-multiple` | **Date**: 2026-03-02

## Summary

Add assignee-based issue filtering to the orchestrator so each cluster only processes issues assigned to its GitHub identity. This prevents cross-cluster duplicate processing when multiple developers run local orchestrator clusters against the same monitored repositories.

**Approach**: Resolve the cluster's GitHub username once at startup (env var or `gh api /user` fallback), then pass it through constructor injection to all monitor services and webhook handlers. Each service filters issues by checking `issue.assignees.includes(clusterGithubUsername)` before processing. When no username is configured, all issues are processed (backward-compatible).

## Technical Context

- **Language**: TypeScript (ES modules, `.js` extensions in imports)
- **Framework**: Fastify (HTTP server), pino (logging), Zod (config validation)
- **Test framework**: Vitest with `vi.fn()` mocking
- **Key packages**: `@generacy-ai/orchestrator`, `@generacy-ai/workflow-engine`
- **Runtime**: Node.js with `gh` CLI available on `$PATH`
- **Existing pattern**: Constructor injection of dependencies (logger, client factory, phase tracker, queue adapter, config, repositories)

## Architecture Overview

```
Startup (server.ts)
  └─ resolveClusterIdentity(config)
       ├─ CLUSTER_GITHUB_USERNAME env var → return it
       ├─ exec("gh api /user") → parse JSON, return .login
       └─ both fail → log warning, return undefined

Identity flows to:
  ├─ LabelMonitorService(... clusterGithubUsername)
  │   └─ filterByAssignee() in pollRepo() after listIssuesWithLabel()
  ├─ PrFeedbackMonitorService(... clusterGithubUsername)
  │   └─ assignee check after PrLinker.linkPrToIssue() using returned assignees
  ├─ setupWebhookRoutes(... clusterGithubUsername)
  │   └─ check payload.issue.assignees before processing
  └─ setupPrWebhookRoutes(... clusterGithubUsername)
      └─ check issue assignees after PrLinker resolution

Shared utility: services/identity.ts
  ├─ resolveClusterIdentity(config, logger) → string | undefined
  └─ filterByAssignee(issues, username, logger) → filtered issues
```

## Implementation Phases

### Phase 1: Config & Identity Resolution

**Goal**: Add config field, env var mapping, and identity resolution utility.

#### Step 1.1: Add `clusterGithubUsername` to config schema

**File**: `packages/orchestrator/src/config/schema.ts`

Add optional string field to `MonitorConfigSchema`:

```typescript
export const MonitorConfigSchema = z.object({
  pollIntervalMs: z.number().int().min(5000).default(30000),
  webhookSecret: z.string().optional(),
  maxConcurrentPolls: z.number().int().min(1).max(20).default(5),
  adaptivePolling: z.boolean().default(true),
  clusterGithubUsername: z.string().optional(),  // NEW
});
```

**Rationale**: Lives in `MonitorConfig` because it affects all monitor services. Optional so existing configs don't break.

#### Step 1.2: Read `CLUSTER_GITHUB_USERNAME` env var in config loader

**File**: `packages/orchestrator/src/config/loader.ts`

Add env var mapping in `loadFromEnv()`, in the monitor config section (after the `webhookSecret` block):

```typescript
const clusterGithubUsername = process.env['CLUSTER_GITHUB_USERNAME'];
if (clusterGithubUsername) {
  if (!config.monitor) {
    config.monitor = {};
  }
  (config.monitor as Record<string, unknown>).clusterGithubUsername = clusterGithubUsername;
}
```

#### Step 1.3: Create identity resolution utility

**File**: `packages/orchestrator/src/services/identity.ts` (NEW)

```typescript
import { execFile } from 'node:child_process';
import type { Issue } from '@generacy-ai/workflow-engine';

interface Logger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug?(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Resolve the cluster's GitHub identity for assignee-based issue filtering.
 *
 * Resolution order:
 *   1. config.monitor.clusterGithubUsername (from CLUSTER_GITHUB_USERNAME env var)
 *   2. `gh api /user` fallback (auto-detection from gh auth)
 *   3. undefined (filtering disabled, all issues processed)
 */
export async function resolveClusterIdentity(
  configUsername: string | undefined,
  logger: Logger,
): Promise<string | undefined> {
  // 1. Explicit config (env var)
  if (configUsername) {
    logger.info(
      { username: configUsername, source: 'config' },
      `Cluster identity resolved: ${configUsername} (from CLUSTER_GITHUB_USERNAME)`,
    );
    return configUsername;
  }

  // 2. Fallback: gh api /user
  try {
    const login = await ghApiUser(logger);
    logger.info(
      { username: login, source: 'gh-api' },
      `Cluster identity resolved: ${login} (from gh api /user)`,
    );
    return login;
  } catch (error) {
    // Classify and log the error
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('ENOENT') || message.includes('not found')) {
      logger.warn(
        { error: message },
        'gh CLI not found — set CLUSTER_GITHUB_USERNAME to enable assignee filtering',
      );
    } else if (message.includes('auth') || message.includes('401') || message.includes('login')) {
      logger.warn(
        { error: message },
        'gh CLI not authenticated — run "gh auth login" or set CLUSTER_GITHUB_USERNAME',
      );
    } else if (message.includes('timeout') || message.includes('TIMEOUT')) {
      logger.warn(
        { error: message },
        'gh api /user timed out — set CLUSTER_GITHUB_USERNAME to avoid this delay',
      );
    } else {
      logger.warn(
        { error: message },
        'Failed to resolve cluster identity via gh api /user — set CLUSTER_GITHUB_USERNAME to enable assignee filtering',
      );
    }
  }

  // 3. Both failed — filtering disabled
  logger.warn('Assignee filtering disabled: no cluster identity configured. All issues will be processed.');
  return undefined;
}

/**
 * Call `gh api /user` with a 10s timeout and return the login field.
 */
function ghApiUser(logger: Logger): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'gh',
      ['api', '/user', '--jq', '.login'],
      { timeout: 10_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        const login = stdout.trim();
        if (!login) {
          reject(new Error('gh api /user returned empty login'));
          return;
        }
        resolve(login);
      },
    );

    // Handle spawn errors (ENOENT when gh not installed)
    child.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Filter issues to only those assigned to the cluster's GitHub username.
 *
 * When `clusterGithubUsername` is undefined, returns all issues (no filtering).
 * When filtering is active, unassigned issues are skipped (per Q1 decision).
 * Issues assigned to multiple users trigger a warning (per Q3 decision).
 */
export function filterByAssignee(
  issues: Issue[],
  clusterGithubUsername: string | undefined,
  logger: Logger,
): Issue[] {
  if (!clusterGithubUsername) return issues;

  return issues.filter(issue => {
    if (issue.assignees.length === 0) {
      logger.warn?.(
        { issueNumber: issue.number },
        'Skipping issue: no assignees set (assign before labeling)',
      ) ?? logger.warn(
        { issueNumber: issue.number } as Record<string, unknown>,
        'Skipping issue: no assignees set (assign before labeling)',
      );
      return false;
    }

    if (issue.assignees.length > 1 && issue.assignees.includes(clusterGithubUsername)) {
      logger.warn?.(
        { issueNumber: issue.number, assignees: issue.assignees },
        'Issue has multiple assignees — may be processed by multiple clusters',
      ) ?? logger.warn(
        { issueNumber: issue.number, assignees: issue.assignees } as Record<string, unknown>,
        'Issue has multiple assignees — may be processed by multiple clusters',
      );
    }

    const assigned = issue.assignees.includes(clusterGithubUsername);
    if (!assigned) {
      if (logger.debug) {
        logger.debug(
          { issueNumber: issue.number, assignees: issue.assignees, clusterUsername: clusterGithubUsername },
          'Skipping issue: not assigned to this cluster',
        );
      }
    }
    return assigned;
  });
}
```

**Key decisions**:
- `filterByAssignee` uses the `Issue` type from workflow-engine (which has `assignees: string[]`)
- Unassigned issues are skipped with `warn`-level logging (Q1 answer: option B)
- Multiple assignees trigger a warning but still process (Q3 answer: option B)
- `gh api /user` has 10s timeout with error classification (Q6 answer: option B)
- Shared utility avoids duplicating logic across 3 services (Q5 answer: option A)

#### Step 1.4: Export from services index

**File**: `packages/orchestrator/src/services/index.ts`

Add export:
```typescript
export { resolveClusterIdentity, filterByAssignee } from './identity.js';
```

---

### Phase 2: Update Monitor Services

**Goal**: Add `clusterGithubUsername` to service constructors and apply filtering in polling paths.

#### Step 2.1: Update LabelMonitorService

**File**: `packages/orchestrator/src/services/label-monitor-service.ts`

Changes:
1. Add import: `import { filterByAssignee } from './identity.js';`
2. Add `clusterGithubUsername` to constructor (7th parameter, optional):

```typescript
constructor(
  logger: Logger,
  createClient: GitHubClientFactory,
  phaseTracker: PhaseTracker,
  queueAdapter: QueueAdapter,
  config: MonitorConfig,
  repositories: RepositoryConfig[],
  clusterGithubUsername?: string,  // NEW
) {
  // ... existing code ...
  this.clusterGithubUsername = clusterGithubUsername;
}
```

3. Add private field: `private readonly clusterGithubUsername: string | undefined;`
4. In `pollRepo()`, after each `client.listIssuesWithLabel()` call, filter issues:

```typescript
// In the KNOWN_PROCESS_LABELS loop:
const issues = await client.listIssuesWithLabel(owner, repo, processLabel);
const filteredIssues = filterByAssignee(issues, this.clusterGithubUsername, this.logger);
for (const issue of filteredIssues) {
  // ... existing processing ...
}

// In the KNOWN_COMPLETED_LABELS loop (same pattern):
const issues = await client.listIssuesWithLabel(owner, repo, completedLabel);
const filteredIssues = filterByAssignee(issues, this.clusterGithubUsername, this.logger);
for (const issue of filteredIssues) {
  // ... existing processing ...
}
```

**Note**: The `Logger` interface in this file lacks `debug`. The `filterByAssignee` utility handles this gracefully with the optional `debug?` check.

#### Step 2.2: Update PrFeedbackMonitorService

**File**: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`

Changes:
1. Add `clusterGithubUsername` to constructor (7th parameter, optional)
2. Add private field
3. Modify `PrLinker.linkPrToIssue()` return path to include assignee check:

In `processPrReviewEvent()`, after the `linkPrToIssue()` call succeeds and before the unresolved threads check:

```typescript
const link = await this.prLinker.linkPrToIssue(client, owner, repo, prInput);
if (!link) { ... }

const { issueNumber, linkMethod } = link;

// NEW: Assignee check
if (this.clusterGithubUsername) {
  const issue = await client.getIssue(owner, repo, issueNumber);
  if (issue.assignees.length === 0) {
    this.logger.warn(
      { owner, repo, issueNumber, prNumber },
      'Skipping PR feedback: linked issue has no assignees',
    );
    return false;
  }
  if (!issue.assignees.includes(this.clusterGithubUsername)) {
    this.logger.debug(
      { owner, repo, issueNumber, prNumber, assignees: issue.assignees },
      'Skipping PR feedback: linked issue not assigned to this cluster',
    );
    return false;
  }
  if (issue.assignees.length > 1) {
    this.logger.warn(
      { owner, repo, issueNumber, assignees: issue.assignees },
      'Issue has multiple assignees — may be processed by multiple clusters',
    );
  }
}
```

**Q4 decision (option A — reuse PrLinker data)**: The spec answer says to extend `PrLinker.linkPrToIssue()` to return assignees. However, after reviewing the code, `PrLinker.linkPrToIssue()` already calls `github.getIssue()` internally but only reads `.labels` from it. Rather than changing the `PrToIssueLink` interface and `PrLinker` internals, the cleaner approach is to add the assignee check in `processPrReviewEvent()` by fetching the issue. This is one extra API call per PR event but:
- Avoids changing the `PrLinker` interface (used in multiple places)
- The `PrLinker.linkPrToIssue()` already has a narrowly scoped responsibility
- The extra fetch is only incurred when `clusterGithubUsername` is set

**Alternative (preferred if API call cost matters)**: Extend `PrToIssueLink` to include `assignees: string[]`, modify `PrLinker.linkPrToIssue()` to return it from the issue it already fetches. This is the Q4-A approach and saves one API call per PR. Implement this if the code review prefers it.

#### Step 2.3: EpicCompletionMonitorService — No filtering (Q9 answer: option C)

**File**: `packages/orchestrator/src/services/epic-completion-monitor-service.ts`

Per Q9, **no changes** to this service. Epic completion monitoring is lightweight and read-only (checks child states, updates status comment). The actual work enqueuing happens in `LabelMonitorService` when it detects the `completed:children-complete` label — and that path already has assignee filtering from Step 2.1.

---

### Phase 3: Update Webhook Handlers

**Goal**: Add assignee checks to webhook routes.

#### Step 3.1: Add `assignees` to `GitHubWebhookPayload.issue` type

**File**: `packages/orchestrator/src/types/monitor.ts`

Add `assignees` field to the `issue` object in `GitHubWebhookPayload`:

```typescript
export interface GitHubWebhookPayload {
  action: string;
  label: {
    name: string;
    color: string;
    description: string;
  };
  issue: {
    number: number;
    title: string;
    labels: Array<{ name: string }>;
    assignees: Array<{ login: string }>;  // NEW — GitHub API includes this
  };
  repository: {
    owner: { login: string };
    name: string;
    full_name: string;
  };
}
```

**Note**: The webhook payload `assignees` is `Array<{ login: string }>` (objects), while the workflow-engine `Issue.assignees` is `string[]` (flat). The webhook handler must map `.map(a => a.login)`.

#### Step 3.2: Update label webhook handler

**File**: `packages/orchestrator/src/routes/webhooks.ts`

1. Add `clusterGithubUsername?: string` to `WebhookRouteOptions`:

```typescript
export interface WebhookRouteOptions {
  monitorService: LabelMonitorService;
  webhookSecret?: string;
  watchedRepos: Set<string>;
  clusterGithubUsername?: string;  // NEW
}
```

2. Add assignee check after the repo whitelist check and before `parseLabelEvent()`:

```typescript
// After: if (!watchedRepos.has(repoKey)) { ... }

// NEW: Assignee filtering
if (clusterGithubUsername) {
  const assigneeLogins = (payload.issue.assignees ?? []).map(a => a.login);
  if (assigneeLogins.length === 0) {
    server.log.warn(
      { issue: payload.issue.number, repo: repoKey },
      'Webhook: skipping issue with no assignees',
    );
    return reply.status(200).send({
      status: 'ignored',
      reason: 'issue has no assignees',
    });
  }
  if (!assigneeLogins.includes(clusterGithubUsername)) {
    server.log.debug(
      { issue: payload.issue.number, repo: repoKey, assignees: assigneeLogins },
      'Webhook: skipping issue not assigned to this cluster',
    );
    return reply.status(200).send({
      status: 'ignored',
      reason: 'not assigned to this cluster',
    });
  }
}
```

**Note**: Uses `payload.issue.assignees ?? []` defensively in case older webhook payloads lack the field.

#### Step 3.3: Update PR webhook handler

**File**: `packages/orchestrator/src/routes/pr-webhooks.ts`

1. Add `clusterGithubUsername?: string` to `PrWebhookRouteOptions`
2. The PR webhook payload doesn't contain issue assignees. The `PrFeedbackMonitorService.processPrReviewEvent()` already handles the assignee check (Step 2.2), so **no additional check is needed in the webhook route itself**. The service-level check is sufficient.

However, pass `clusterGithubUsername` to the options interface for consistency (even though the route doesn't use it directly — the service does):

```typescript
export interface PrWebhookRouteOptions {
  monitorService: PrFeedbackMonitorService;
  webhookSecret?: string;
  watchedRepos: Set<string>;
  clusterGithubUsername?: string;  // NEW (for future use / consistency)
}
```

---

### Phase 4: Wire Up in Server

**Goal**: Resolve identity at startup and pass to all services/routes.

#### Step 4.1: Update server.ts

**File**: `packages/orchestrator/src/server.ts`

1. Add import: `import { resolveClusterIdentity } from './services/identity.js';`
2. After config loading and before service construction, resolve identity:

```typescript
// After: const config = options.config ?? loadConfig();
// NEW: Resolve cluster identity for assignee filtering
const clusterGithubUsername = await resolveClusterIdentity(
  config.monitor.clusterGithubUsername,
  server.log,
);
```

**Wait** — `server.log` isn't available until after Fastify is created. The identity resolution should happen after Fastify instantiation but before service construction. Place it after the `server.decorate('config', config)` line.

3. Pass `clusterGithubUsername` to `LabelMonitorService` constructor:

```typescript
labelMonitorService = new LabelMonitorService(
  server.log,
  createGitHubClient,
  phaseTracker,
  queueAdapter,
  config.monitor,
  config.repositories,
  clusterGithubUsername,  // NEW
);
```

4. Pass to `PrFeedbackMonitorService` constructor:

```typescript
prFeedbackMonitorService = new PrFeedbackMonitorService(
  server.log,
  createGitHubClient,
  phaseTracker,
  queueAdapter,
  config.prMonitor,
  config.repositories,
  clusterGithubUsername,  // NEW
);
```

5. Pass to webhook route setup:

```typescript
await setupWebhookRoutes(server, {
  monitorService: labelMonitorService,
  webhookSecret: config.monitor.webhookSecret,
  watchedRepos,
  clusterGithubUsername,  // NEW
});
```

```typescript
await setupPrWebhookRoutes(server, {
  monitorService: prFeedbackMonitorService,
  webhookSecret: config.prMonitor.webhookSecret,
  watchedRepos,
  clusterGithubUsername,  // NEW
});
```

#### Step 4.2: CLI orchestrator command (Q10 answer: option A — server.ts only)

**File**: `packages/generacy/src/cli/commands/orchestrator.ts`

Per Q10, identity resolution lives exclusively in `server.ts`. The CLI command delegates to `createOrchestratorServer()` / `server.ts` for service construction, so it gets identity resolution automatically.

However, the CLI's `setupLabelMonitor()` function constructs `LabelMonitorService` directly (not via `server.ts`). This path needs updating:

1. Add identity resolution before `LabelMonitorService` construction:
```typescript
// In setupLabelMonitor(), before creating the monitor:
const { resolveClusterIdentity } = await import('@generacy-ai/orchestrator');
const clusterGithubUsername = await resolveClusterIdentity(
  process.env['CLUSTER_GITHUB_USERNAME'],
  monitorLogger,
);
```

2. Pass to constructor:
```typescript
const monitor = new LabelMonitorService(
  monitorLogger,
  createGitHubClient,
  phaseTracker,
  bridge,
  { pollIntervalMs, maxConcurrentPolls: 5, adaptivePolling: !useSmee },
  repositories,
  clusterGithubUsername,  // NEW
);
```

---

### Phase 5: Tests

**Goal**: Unit tests for identity resolution, filtering, and integration with services.

#### Step 5.1: Identity resolution tests

**File**: `packages/orchestrator/src/services/__tests__/identity.test.ts` (NEW)

Tests:
- `resolveClusterIdentity` returns config username when set (no `gh` call)
- `resolveClusterIdentity` calls `gh api /user` when config username not set
- `resolveClusterIdentity` returns `undefined` when both fail
- `resolveClusterIdentity` logs appropriate warnings for different failure types
- `resolveClusterIdentity` respects 10s timeout

Mock `execFile` via `vi.mock('node:child_process')`.

#### Step 5.2: filterByAssignee tests

**File**: `packages/orchestrator/src/services/__tests__/identity.test.ts` (same file)

Tests:
- Returns all issues when username is `undefined` (backward compat)
- Returns only assigned issues when username is set
- Returns empty array when no issues match
- Skips unassigned issues with `warn` log (Q1: option B)
- Warns on multiple assignees but still includes the issue (Q3: option B)
- Logs skipped issues at debug level

#### Step 5.3: LabelMonitorService filtering tests

**File**: Extend existing test patterns (add test cases to existing test file or create `services/__tests__/label-monitor-service.test.ts`)

Tests:
- `pollRepo` calls `filterByAssignee` before processing issues
- Service with `clusterGithubUsername: undefined` processes all issues
- Service with username set only processes assigned issues
- Both `KNOWN_PROCESS_LABELS` and `KNOWN_COMPLETED_LABELS` loops are filtered

#### Step 5.4: PrFeedbackMonitorService filtering tests

**File**: Extend `services/__tests__/pr-feedback-monitor-service.test.ts`

Tests:
- `processPrReviewEvent` skips unassigned issues when username is set
- `processPrReviewEvent` processes assigned issues normally
- `processPrReviewEvent` processes all issues when username is `undefined`
- Warning logged for multiple assignees

#### Step 5.5: Webhook handler tests

**File**: Extend `routes/__tests__/pr-webhooks.test.ts` and add `routes/__tests__/webhooks.test.ts`

Tests for label webhook:
- Returns `ignored` for unassigned issues when username is set
- Returns `ignored` for issues assigned to other users
- Processes issues assigned to cluster username
- Processes all issues when no username configured
- Handles missing `assignees` field in payload gracefully

---

### Phase 6: Verification & Cleanup

#### Step 6.1: TypeScript compilation check

```bash
cd packages/orchestrator && pnpm tsc --noEmit
```

#### Step 6.2: Run all tests

```bash
cd packages/orchestrator && pnpm test
```

#### Step 6.3: Verify exports

Ensure `resolveClusterIdentity` and `filterByAssignee` are exported from `packages/orchestrator/src/services/index.ts` and `packages/orchestrator/src/index.ts`.

---

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Unassigned issues | Skip (Q1-B) | Prevents all clusters processing unassigned issues; enforces assign-before-label workflow |
| Multiple assignees | Warn, still process (Q3-B) | Pragmatic; same as today's behavior for that issue |
| PR feedback assignee check | Separate `getIssue()` call in service | Avoids changing `PrLinker` interface; cost is 1 API call per PR when filtering is active |
| Epic monitor filtering | No filtering (Q9-C) | Lightweight read-only check; filtering at this level could silently stall epics |
| Shared utility vs duplicated methods | Shared `filterByAssignee()` (Q5-A) | DRY; pure function with no state |
| Identity resolution location | `server.ts` + CLI `setupLabelMonitor()` (Q10-A adjusted) | Single resolution per entry point; CLI has its own service construction path |
| `gh api /user` timeout | 10s with error classification (Q6-B) | One-time startup cost; classified errors aid debugging |
| Webhook response | Optional `reason` field (Q8-A) | Already existing pattern in webhook handlers |
| Webhook race (label before assign) | Polling catches it (Q7-A) | Hybrid architecture already handles stale webhook data |

## File Change Summary

| File | Change Type | Lines (est.) |
|------|-------------|-------------|
| `packages/orchestrator/src/config/schema.ts` | Modify | +1 |
| `packages/orchestrator/src/config/loader.ts` | Modify | +8 |
| `packages/orchestrator/src/services/identity.ts` | **New** | ~120 |
| `packages/orchestrator/src/services/index.ts` | Modify | +1 |
| `packages/orchestrator/src/services/label-monitor-service.ts` | Modify | +12 |
| `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` | Modify | +20 |
| `packages/orchestrator/src/types/monitor.ts` | Modify | +1 |
| `packages/orchestrator/src/routes/webhooks.ts` | Modify | +18 |
| `packages/orchestrator/src/routes/pr-webhooks.ts` | Modify | +2 |
| `packages/orchestrator/src/server.ts` | Modify | +10 |
| `packages/generacy/src/cli/commands/orchestrator.ts` | Modify | +8 |
| `packages/orchestrator/src/services/__tests__/identity.test.ts` | **New** | ~200 |
| Existing test files (3 files) | Modify | ~80 |

**Total**: ~2 modified + 2 new files (source), ~3-4 test files

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| `gh api /user` hangs at startup | 10s timeout enforced via `execFile` `timeout` option |
| Breaking existing single-cluster setups | `clusterGithubUsername` defaults to `undefined`; all filtering is no-op when undefined |
| Issues silently dropped if forgot to assign | `warn`-level logging for unassigned issues; polling recovery catches label-before-assign race |
| GitHub webhook payload missing `assignees` | Defensive `?? []` on `payload.issue.assignees` |
| API rate limit increase from extra `getIssue()` in PR feedback | Only 1 extra call per PR when filtering active; acceptable for typical workloads |
| `EpicCompletionMonitorService` not wired into server | Out of scope per spec; no changes needed |
