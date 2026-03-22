# Clarifications: #404 Queue Priority for Resume/Retry vs New Workflows

## Batch 1 — 2026-03-22

### Q1: Priority Computation Responsibility
**Context**: The spec describes both a `getPriorityScore(reason)` helper (Changes #2, FR-002) for callers to use at enqueue sites, AND says to update both queue adapters to "use priority from `queueReason`" (FR-007, FR-008). If adapters compute priority from `queueReason`, the caller-side helper is redundant. If callers compute priority, the adapter updates are redundant.
**Question**: Should priority be computed by the **callers** (enqueue sites use the helper to set `priority`), or by the **adapters** (adapters read `queueReason` and override `priority` internally)?
**Options**:
- A: Callers compute priority using the helper; adapters use the `priority` field as-is (current behavior)
- B: Adapters compute priority from `queueReason`; callers just set `queueReason` and the adapter ignores/overrides `priority`
- C: Both — callers set priority via the helper AND adapters have fallback logic for items without `queueReason`

**Answer**: B — Adapters compute priority from `queueReason`. Callers just set `queueReason` on the item and the adapter determines the score. This is cleaner — priority computation is centralized in one place (the adapter), not scattered across enqueue call sites. The `priority` field on `QueueItem` becomes adapter-managed. Callers don't need to import or call a helper function. The adapter logic is: `if queueReason === 'resume' → 0.{timestamp}`, `if queueReason === 'retry' → 1.{timestamp}`, `else → Date.now()`. For backwards compatibility, items without `queueReason` default to `Date.now()`.

### Q2: Retry Path via release()
**Context**: FR-006 says "Update retry/re-enqueue paths with `queueReason: 'retry'`", but in the actual code, retries happen inside `release()` in `redis-queue-adapter.ts` (line ~185) and `in-memory-queue-adapter.ts` (line ~109), NOT via `enqueue()`. The `release()` method re-inserts failed items with their **original priority**. There is no separate retry enqueue call site to tag with `queueReason: 'retry'`.
**Question**: Should `release()` be updated to recompute the priority at the retry tier (`1.{timestamp}`) when re-inserting a failed item? This would change the item's position in the queue.
**Options**:
- A: Yes — `release()` should update priority to retry tier (`1.{timestamp}`), boosting failed items above new work
- B: No — `release()` keeps original priority; only items explicitly enqueued as retries (if any future path exists) get retry priority
- C: Conditional — if the original item was `new`, demote to retry tier; if already `resume`, keep resume priority

**Answer**: A — Yes, `release()` should update priority to retry tier (`1.{timestamp}`) when re-inserting a failed item. This is the whole point of the feature — retries should be dispatched before new work. The item's original priority (which was `Date.now()` from when it was first enqueued) is no longer relevant. It failed, it's being retried, it should get retry priority. Set `queueReason: 'retry'` on the re-inserted item so the adapter computes the correct score.

### Q3: PR Feedback Priority Tier
**Context**: FR-004 tags `address-pr-feedback` items as `queueReason: 'new'`. However, PR feedback responds to reviews on an already-in-progress workflow's PR — it's continuing existing work, not starting fresh. The stated goal of this feature is "in-progress work is finished before starting new workflows." Treating PR feedback as `new` means it competes with fresh issue triggers rather than being prioritized as in-progress work.
**Question**: Should `address-pr-feedback` items use `new` priority (as spec states) or `resume` priority (since they continue in-progress work)?
**Options**:
- A: `new` — PR feedback is a distinct event, treat as new work (as spec states)
- B: `resume` — PR feedback continues an existing workflow, prioritize like resumes

**Answer**: B — `resume` priority. PR feedback is continuing work on an existing PR from an existing workflow. It's not a fresh issue being processed for the first time. The intent of "finish in-progress work first" directly applies here — the PR is in-progress, the review feedback needs to be addressed to complete it. Use `queueReason: 'resume'`.
