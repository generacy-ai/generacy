# Data Model: Distinguish PR-feedback fixer timeout from stuck-loop

**Branch**: `1070-problem-when-pr-feedback` | **Issue**: [generacy#1070](https://github.com/generacy-ai/generacy/issues/1070)

Entities, interfaces, and state transitions this PR introduces or modifies. Type definitions match the target TypeScript source shape; import paths use the workspace-style names (`@generacy-ai/*`) or the co-located `.js` extensions ESM requires.

## 1. `SpawnClaudeResult` — private return type of `spawnClaudeForFeedback` (FR-011)

**File**: `packages/orchestrator/src/worker/pr-feedback-handler.ts` (co-located; not re-exported).

```typescript
/**
 * Return shape of `spawnClaudeForFeedback` (widened from `boolean` per FR-011).
 *
 * `success` is true iff the CLI exited with code 0.
 * `timedOut` is true iff the internal SIGTERM timer fired (regardless of exit code).
 * `exitCode` is the process exit code (null when the process died via signal
 * before an exit code was captured — matches Node's ChildProcess.exitCode
 * semantics).
 *
 * Semantic invariant: `timedOut === true` implies `success === false`.
 * A timeout that races with a natural exit-0 finish is treated as timeout
 * (the SIGTERM fires and this cycle's work is bounded, per FR-013).
 */
export interface SpawnClaudeResult {
  success: boolean;
  exitCode: number | null;
  timedOut: boolean;
}
```

**Validation rules**:
- Type is private to the handler module (not exported from `@generacy-ai/orchestrator`).
- No Zod schema — this is a private return type, not a wire format.

**Callers to update** (single site):
- `pr-feedback-handler.ts:412` — `const success = await this.spawnClaudeForFeedback(...)` → `const { success, exitCode, timedOut } = await this.spawnClaudeForFeedback(...)`.

**Test doubles to update**: `packages/orchestrator/src/worker/__tests__/pr-feedback-handler.test.ts` — every `spawnClaudeForFeedback` mock (~5 sites) migrates from resolving `true`/`false` to resolving `{ success, exitCode, timedOut }` triples. The most common triples:
- Success: `{ success: true, exitCode: 0, timedOut: false }`
- Timeout with partial push: `{ success: false, exitCode: 143, timedOut: true }`
- Clean non-zero exit: `{ success: false, exitCode: 1, timedOut: false }`

## 2. `PrFeedbackMetadata` — additive field `retryAttempt` (D-1)

**File**: `packages/orchestrator/src/types/monitor.ts:38-43` (existing type, extended).

```typescript
/**
 * Metadata for the address-pr-feedback command.
 */
export interface PrFeedbackMetadata {
  /** PR number on the repository */
  prNumber: number;
  /** IDs of unresolved review threads at detection time */
  reviewThreadIds: number[];
  /**
   * #1070 D-1: Number of auto-retries dispatched so far for this trigger,
   * INCLUDING this dispatch. Original cycle = 0. First auto-retry = 1.
   * Second auto-retry = 2 (last permitted per Q5=C max=2).
   *
   * Written by PrFeedbackMonitorService at every enqueue (both the normal
   * path and the retry-eligible branch). Read by PrFeedbackHandler on the
   * timeout+hasChanges disposition to decide between
   * `blocked:fixer-timeout` (< 2) and `blocked:fixer-timeout-repeat` (>= 2).
   *
   * Optional for backwards compatibility with in-flight QueueItems queued
   * before this PR lands. Handler reads `?? 0`.
   */
  retryAttempt?: number;
}
```

**Validation rules**:
- Non-negative integer. In practice `0`, `1`, or `2`.
- Optional to allow rolling deployment: an orchestrator running this code can dequeue a QueueItem enqueued by a prior version without a `retryAttempt` field. The handler's `?? 0` default treats that as "original cycle" — which is the correct semantic for any pre-#1070 QueueItem (there was no retry model before).

**Wire format**: This type is serialized into Redis by the queue adapter (`packages/orchestrator/src/services/redis-queue-adapter.ts`). No adapter change is needed — the adapter serializes the QueueItem via `JSON.stringify(metadata)` and deserializes symmetrically.

## 3. `fixerTimeoutRetryCount` — instance-scoped `Map` on `PrFeedbackMonitorService` (Q1=A, D-2, D-5)

**File**: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts:79` (new field alongside `lastUnresolvedThreadCount`).

```typescript
/**
 * #1070 Q1=A / FR-006 / Assumption 4: per-stateKey retry counter for the
 * blocked:fixer-timeout retry-eligible branch. Mirrors the sibling
 * lastUnresolvedThreadCount map at line 79. Instance-scoped so state doesn't
 * leak across services.
 *
 * Key: `${owner}/${repo}#${prNumber}` (same as lastUnresolvedThreadCount).
 * Value: number of auto-retries dispatched so far, capped at 2 per Q5=C.
 *
 * Write sites:
 *   - Increment in the retry-eligible branch at pr-feedback-monitor-service.ts
 *     (inserted between :372 and :373 per D-4).
 *   - Delete in Case C at :296-317 per D-5 (progress-only reset).
 *
 * Read sites:
 *   - Retry-eligible branch decides `counter < 2` for dispatch permission.
 *   - Same branch bakes the current value into `PrFeedbackMetadata.retryAttempt`
 *     for handler consumption.
 *
 * Restart-loss failure mode is bounded and benign (spec §Assumption 7).
 */
private fixerTimeoutRetryCount: Map<string, number> = new Map();
```

## 4. Disposition branches — enumerated (FR-001)

The collapsed `if (!success || !hasChanges)` at `pr-feedback-handler.ts:469-481` becomes a **four-way explicit switch**, using the widened result from §1:

| # | Precondition | Disposition | Label applied | `waiting-for:*` state |
|---|---|---|---|---|
| B1 | `success && !hasChanges` | **no-diff** | `blocked:stuck-feedback-loop` (FR-004 — unchanged) | kept |
| B2 | `!success && !timedOut && hasChanges` | **push-failed** (clean non-zero + committed) | `blocked:stuck-feedback-loop` (folds into today's behavior; not a new failure mode) | kept |
| B3 | `!success && !timedOut && !hasChanges` | **push-failed no diff** | `blocked:stuck-feedback-loop` (same as B1) | kept |
| B4 | `timedOut && !hasChanges` | **timeout-no-progress** | `blocked:fixer-timeout-no-progress` (FR-002a, terminal) | kept |
| B5 | `timedOut && hasChanges && retryAttempt < 2` | **timeout retry-eligible** | `blocked:fixer-timeout` (FR-002) | kept (FR-012) |
| B6 | `timedOut && hasChanges && retryAttempt >= 2` | **timeout repeat** | `blocked:fixer-timeout-repeat` (FR-003, terminal) | kept |

**Note on B2/B3 grouping**: The four sub-branches named in FR-001 are `timeout-with-changes`, `timeout-no-progress`, `no-diff`, and `push-failed`. The table above expands `no-diff` into B1 (clean CLI exit, no changes) and `push-failed` into B2 (dirty CLI exit, changes) + B3 (dirty CLI exit, no changes). B1+B3 collapse in the source into the existing `!success || !hasChanges` sub-branch that keeps `blocked:stuck-feedback-loop`; only B4/B5/B6 are net-new code paths.

Every branch flows through the shared `finally` at `pr-feedback-handler.ts:628-637` (FR-010) — no branch may skip the `agent:in-progress` clear.

**Disposition log line contract** (US1 acceptance): every branch above emits ONE `warn` (B-family) or `info` (happy path) whose payload includes:
- `disposition: 'no-diff' | 'push-failed' | 'timeout-no-progress' | 'fixer-timeout' | 'fixer-timeout-repeat'`
- `prNumber`, `issueNumber`, `owner`, `repo`
- On any `timedOut` branch: `exitCode: number | null`, `cliCompleted: false` (never `success: false` — see FR-005 / D-6)

## 5. Counter state machine (Q5=C, D-5)

```
                       ┌──────────────────────────────────────────┐
                       │                                          │
                       ▼                                          │
              ┌──────────────┐         B5 dispatch (monitor)      │
              │ counter = 0  │ ───────────────────────────────┐   │
              │ (fresh)      │                                │   │
              └──────┬───────┘                                ▼   │
                     │                                ┌──────────────┐
     Case C fires    │                                │ counter = 1  │
     (all threads    │                                │              │
     resolved)       │  Case C fires ──────► reset ◄──└──────┬───────┘
                     │                                       │
                     │                                       │ B5 dispatch
                     ▼                                       ▼
              ┌──────────────┐                        ┌──────────────┐
              │ counter = 0  │◄─── Case C fires ─────┤ counter = 2  │
              └──────────────┘                        │  (capped)    │
                                                     └──────┬───────┘
                                                            │
                                                            │ handler sees
                                                            │ retryAttempt=2,
                                                            │ applies
                                                            │ B6 label →
                                                            │ terminal
                                                            ▼
                                                    ┌──────────────┐
                                                    │ paused via   │
                                                    │ blocked:*    │
                                                    │ short-circuit│
                                                    └──────────────┘
```

**Transition rules**:
- Increment: monitor's retry-eligible branch (D-4). Never elsewhere.
- Reset: Case C at `pr-feedback-monitor-service.ts:296-317` (D-5). Never elsewhere.
- Read: monitor's retry-eligible branch (decides dispatch permission); indirectly, the handler via `retryAttempt` (decides label).

## 6. Label definitions (FR-002, FR-002a, FR-003)

**File**: `packages/workflow-engine/src/actions/github/label-definitions.ts` (three new entries next to the existing `blocked:stuck-feedback-loop` at line 111).

```typescript
{
  name: 'blocked:fixer-timeout',
  color: 'D73A4A',
  description: 'PR-feedback CLI timed out (exit 143) after pushing a partial commit — up to two automatic retries will follow.',
},
{
  name: 'blocked:fixer-timeout-no-progress',
  color: 'D73A4A',
  description: 'PR-feedback CLI timed out (exit 143) without pushing any commit — human intervention required (retries would not make progress).',
},
{
  name: 'blocked:fixer-timeout-repeat',
  color: 'D73A4A',
  description: 'PR-feedback CLI timed out and the auto-retry budget (2) was exhausted without fully resolving review threads — human intervention required.',
},
```

**Validation**: Descriptions must fit GitHub's 100-char label description limit — verified visually against each string above (each fits well under 200 chars, well within GitHub's constraint. See `label-sync-service.classify.test.ts:54-73` for the "description is too long" failure shape.)

## 7. Cockpit `WAITING_PIPELINE_ORDER` extension (D-3)

**File**: `packages/cockpit/src/state/precedence.ts:26-40` (existing array, three additions).

```typescript
export const WAITING_PIPELINE_ORDER: string[] = [
  'blocked:stuck-feedback-loop',
  'blocked:fixer-timeout-no-progress',   // +1070 — terminal, outranks waiting-for
  'blocked:fixer-timeout-repeat',        // +1070 — terminal, outranks waiting-for
  'waiting-for:address-pr-feedback',
  'blocked:fixer-timeout',               // +1070 — retry-eligible, sorts BELOW waiting-for
  'waiting-for:spec-review',
  'waiting-for:clarification',
  'waiting-for:plan-review',
  'waiting-for:tasks-review',
  'waiting-for:implementation-review',
  'waiting-for:manual-validation',
];
```

**Relationship note**: `blocked:fixer-timeout` (retry-eligible) is positioned **below** `waiting-for:address-pr-feedback`. Per Q4=A, an operator watching the issue during the retry window should see `waiting-for:address-pr-feedback` as the primary state (the retry is coming; the cluster IS still "waiting" to address the feedback). The two terminal labels sort **above** `waiting-for:address-pr-feedback` for symmetry with `blocked:stuck-feedback-loop` — the terminal state IS the more-specific and more-urgent thing to surface.

## Entity Relationships

```
PrFeedbackMonitorService (singleton, orchestrator process)
  │
  ├── holds ──► fixerTimeoutRetryCount: Map<stateKey, number>
  │                     │
  │                     └── increment (retry-eligible branch)
  │                     └── delete (Case C)
  │                     └── read → bake into retryAttempt at enqueue
  │
  └── enqueues ─► QueueItem { metadata: PrFeedbackMetadata { retryAttempt, ... } }
                         │
                         ▼ (over Redis, cross-process)
                     ┌──────────────────────────────────┐
                     │ PrFeedbackHandler (per-job, worker process) │
                     │   │                                          │
                     │   ├── reads item.metadata.retryAttempt ?? 0  │
                     │   ├── awaits spawnClaudeForFeedback          │
                     │   │      └── returns SpawnClaudeResult       │
                     │   └── decides B1..B6 disposition,            │
                     │       applies one of six labels              │
                     └──────────────────────────────────────────────┘
```

## Out of Scope for the Data Model

- No changes to `QueueItem` shape (only `metadata` payload grows).
- No changes to `MonitorState` (`packages/orchestrator/src/types/monitor.ts:187-198`).
- No new Redis key patterns (SC-006).
- No new Zod schemas — `PrFeedbackMetadata` has no schema today (it is a typed metadata payload, deserialized as `Record<string, unknown>` at the `QueueItem.metadata` boundary and cast to `PrFeedbackMetadata` at read sites).
