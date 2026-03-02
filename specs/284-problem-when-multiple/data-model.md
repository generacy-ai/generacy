# Data Model: Assignee Filtering

## Config Schema Changes

### MonitorConfigSchema (Zod)

```typescript
// packages/orchestrator/src/config/schema.ts
export const MonitorConfigSchema = z.object({
  pollIntervalMs: z.number().int().min(5000).default(30000),
  webhookSecret: z.string().optional(),
  maxConcurrentPolls: z.number().int().min(1).max(20).default(5),
  adaptivePolling: z.boolean().default(true),
  clusterGithubUsername: z.string().optional(),  // NEW
});
```

**Field**: `clusterGithubUsername`
- **Type**: `string | undefined`
- **Source**: `CLUSTER_GITHUB_USERNAME` env var → `config.monitor.clusterGithubUsername`
- **Default**: `undefined` (no filtering)
- **Used by**: All monitor services and webhook handlers via constructor injection

## Type Changes

### GitHubWebhookPayload (types/monitor.ts)

```diff
 export interface GitHubWebhookPayload {
   action: string;
   label: { name: string; color: string; description: string };
   issue: {
     number: number;
     title: string;
     labels: Array<{ name: string }>;
+    assignees: Array<{ login: string }>;
   };
   repository: { owner: { login: string }; name: string; full_name: string };
 }
```

**Note**: The webhook payload provides assignees as `Array<{ login: string }>` (objects with `login`), while the workflow-engine `Issue.assignees` is `string[]` (flat). Webhook handlers must map: `payload.issue.assignees.map(a => a.login)`.

## Existing Types (No Changes Needed)

### Issue (workflow-engine)

```typescript
// packages/workflow-engine/src/types/github.ts — ALREADY EXISTS
export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  assignees: string[];  // Already present, already returned by listIssuesWithLabel()
  milestone?: Milestone;
  created_at: string;
  updated_at: string;
}
```

### PrToIssueLink (orchestrator)

```typescript
// packages/orchestrator/src/types/monitor.ts — NO CHANGES
export interface PrToIssueLink {
  prNumber: number;
  issueNumber: number;
  linkMethod: 'pr-body' | 'branch-name';
}
```

## New Interfaces

### WebhookRouteOptions (updated)

```typescript
// packages/orchestrator/src/routes/webhooks.ts
export interface WebhookRouteOptions {
  monitorService: LabelMonitorService;
  webhookSecret?: string;
  watchedRepos: Set<string>;
  clusterGithubUsername?: string;  // NEW
}
```

### PrWebhookRouteOptions (updated)

```typescript
// packages/orchestrator/src/routes/pr-webhooks.ts
export interface PrWebhookRouteOptions {
  monitorService: PrFeedbackMonitorService;
  webhookSecret?: string;
  watchedRepos: Set<string>;
  clusterGithubUsername?: string;  // NEW
}
```

## Environment Variables

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `CLUSTER_GITHUB_USERNAME` | string | (none) | Explicit GitHub username for this cluster. When set, skips `gh api /user` auto-detection. |

## Data Flow

```
Environment
  CLUSTER_GITHUB_USERNAME="octocat"
    ↓
Config Loader (loader.ts)
  config.monitor.clusterGithubUsername = "octocat"
    ↓
Identity Resolution (identity.ts)
  resolveClusterIdentity(config.monitor.clusterGithubUsername, logger)
    → "octocat"
    ↓
Constructor Injection
  ├─ LabelMonitorService(... clusterGithubUsername="octocat")
  ├─ PrFeedbackMonitorService(... clusterGithubUsername="octocat")
  ├─ setupWebhookRoutes(... clusterGithubUsername="octocat")
  └─ setupPrWebhookRoutes(... clusterGithubUsername="octocat")
    ↓
Runtime Filtering
  issue.assignees.includes("octocat") → process or skip
```
