# Data Model: PR review feedback must continue processing after a workflow completes

## Entities touched

This fix does not introduce new persistent entities. Two in-memory types change shape.

### `PrReviewEvent` (modified)

**File**: `packages/orchestrator/src/types/monitor.ts:76-89`

**Purpose**: In-memory event object handed to `PrFeedbackMonitorService.processPrReviewEvent`. Shared by webhook and poll paths.

**Change**: Add `prMerged: boolean` field.

```ts
export interface PrReviewEvent {
  /** Repository owner */
  owner: string;
  /** Repository name */
  repo: string;
  /** PR number */
  prNumber: number;
  /** PR body text */
  prBody: string;
  /** Head branch name */
  branchName: string;
  /** How this event was detected */
  source: 'webhook' | 'poll';
  /**
   * NEW (#1049): whether the PR is currently merged. Read from
   * `payload.pull_request.merged` on the webhook path; always `false`
   * on the poll path (poll lists open PRs only). Used by the merged-PR
   * gate (FR-008) to reject reviews on merged PRs before any checkout
   * / fetch / push code path runs — see spec US4.
   */
  prMerged: boolean;
}
```

**Validation**:
- Must be present (non-optional). Populated at both construction sites: `pr-webhooks.ts` and `pr-feedback-monitor-service.pollRepo`.
- Missing / `undefined` at consumption time is a bug in a construction site — no runtime coercion; TypeScript enforces.

**Test doubles**: Existing test helpers (`createWebhookPayload` in `pr-webhooks.test.ts`, various in `pr-feedback-monitor-service.test.ts`) must be updated to set `prMerged: false` by default and expose an override.

### `GitHubPrReviewWebhookPayload.pull_request` (modified)

**File**: `packages/orchestrator/src/types/monitor.ts:124-131`

**Purpose**: Type shape for the incoming GitHub webhook body.

**Change**: Add `merged?: boolean` and `merged_at?: string | null`.

```ts
pull_request: {
  number: number;
  title: string;
  body: string | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  state: string;
  merged?: boolean;             // NEW (#1049)
  merged_at?: string | null;    // NEW (#1049) — carried for observability; not consumed
};
```

**Validation**:
- Both optional to preserve backward-compat with existing test doubles.
- At runtime, GitHub always sends these on the review events we filter to.
- `merged_at` is not consumed but recorded on the type for future observability work.

### `PrLinkResult` (new, replaces `PrToIssueLink | null` return)

**File**: `packages/orchestrator/src/worker/pr-linker.ts`

**Purpose**: Discriminated result of `PrLinker.linkPrToIssue`, so the monitor can name the specific gate that dropped an event (FR-005).

```ts
/**
 * Result of attempting to link a PR to an orchestrated issue.
 *
 * Discriminated so the caller can distinguish the three failure modes
 * for FR-005 gate-naming in log lines.
 */
export type PrLinkResult =
  | { kind: 'ok'; link: PrToIssueLink }
  | { kind: 'no-link' }
  | { kind: 'no-issue'; issueNumber: number }
  | { kind: 'not-orchestrated'; issueNumber: number };
```

**Existing `PrToIssueLink` (unchanged)**:
```ts
export interface PrToIssueLink {
  prNumber: number;
  issueNumber: number;
  linkMethod: 'pr-body' | 'branch-name';
  assignees: string[];
}
```

**Transition mapping** (old return → new return):

| Old return | New return |
|---|---|
| `null` at `pr-linker.ts:108` (no body/branch match) | `{ kind: 'no-link' }` |
| `null` at `pr-linker.ts:130` (getIssue threw) | `{ kind: 'no-issue', issueNumber }` |
| `null` at `pr-linker.ts:122` (isOrchestrated=false) | `{ kind: 'not-orchestrated', issueNumber }` |
| `PrToIssueLink { ... }` at `:138-143` | `{ kind: 'ok', link: { ... } }` |

**Caller migration**: single call site (`pr-feedback-monitor-service.ts:148`):
```ts
const result = await this.prLinker.linkPrToIssue(client, owner, repo, prInput);
if (result.kind !== 'ok') {
  await this.dropWithGateLog(client, event, result);   // §2 of plan.md
  return false;
}
const { link } = result;
const { issueNumber, linkMethod, assignees } = link;
// ...unchanged from here
```

## Orchestration-evidence prefix set (constant, new)

**File**: `packages/orchestrator/src/worker/pr-linker.ts`

```ts
/**
 * Orchestration evidence: any of these label prefixes on the linked issue
 * marks the issue as speckit-orchestrated for the purpose of the PR-feedback
 * guard. `phase:*` is intentionally excluded — it's the least durable prefix
 * (removed at phase start/complete/cleanup) and load-bearing for
 * LabelMonitorService bookkeeping. See clarifications.md Q4=B.
 */
const ORCHESTRATION_PREFIXES = ['agent:', 'workflow:', 'completed:'] as const;
```

**Durability proof** (from research.md D1):
- `workflow:*` — never removed anywhere in either repo.
- `completed:*` — only cleared by requeue, which re-adds `workflow:*` in the same call (`label-monitor-service.ts:397-403`).
- `agent:*` — added and removed throughout the workflow's active phases; retained for currently-active workflows to preserve existing behaviour.
- `phase:*` (EXCLUDED) — removed at phase start (`label-manager.ts:171-177`), phase complete (`label-manager.ts:205`), and cleanup (`label-manager.ts:395-403`).

## Log-line contract (informal, new)

Not a type, but a shape asserted by tests. See `contracts/drop-gate-logging.md`.

## Relationships

```
PrReviewEvent (webhook path)                PrReviewEvent (poll path)
  ├─ built from GitHubPrReviewWebhookPayload  ├─ built inside pollRepo
  ├─ prMerged = payload.pull_request.merged ?? false   └─ prMerged = false (invariant)
  └─ prMerged may be true or false
        │
        └── PrFeedbackMonitorService.processPrReviewEvent
              │
              ├── merged-PR gate (FR-008)          ← rejects if prMerged
              │     drops → info log { gate: 'merged-pr' }
              │
              ├── PrLinker.linkPrToIssue → PrLinkResult
              │     └── discriminates: no-link | no-issue | not-orchestrated | ok
              │
              ├── assignees-empty gate                ← rejects if empty assignees
              │     drops → info log { gate: 'assignees-empty' }
              │
              ├── wrong-cluster gate                  ← stays at debug (Q3=B)
              │
              └── (rest of pipeline: threads, trust, blocked:*, enqueue)
```

## Non-changes (explicit)

The following types are **not** touched:
- `MonitorState` — no new bookkeeping fields required.
- `QueueItem` / `PrFeedbackMetadata` — no new fields; the merged-PR gate short-circuits before enqueue.
- `PrToIssueLink` — the underlying success payload is unchanged; only the return shape widens.
- `GitHubClient` / `GitHubClientFactory` — no new methods required. The optional log-time probe reuses existing `getPRReviewThreads`.

## Migration / storage

None. All types are in-memory only. No database, no config schema, no cache format changes.
