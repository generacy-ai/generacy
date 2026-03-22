# Feature Specification: Queue Priority for Resume/Retry vs New Workflows

**Branch**: `404-context-part-billing` | **Date**: 2026-03-22 | **Status**: Draft | **Issue**: [#404](https://github.com/generacy-ai/generacy/issues/404)

## Summary

Implement tiered queue priority so that resume and retry items are dispatched before new work. Currently all queue items use `priority: Date.now()` (pure FIFO). This change ensures in-progress work is finished before starting new workflows, improving throughput and reducing wasted compute.

## Context

Part of the [Billing & Concurrent Workflow Enforcement](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/billing-concurrent-workflow-enforcement.md) plan — queue priority scheme.

This was originally tracked as agency#328 but that issue only produced spec artifacts — no code was implemented. The queue code lives in this repo (`packages/orchestrator/`), so the implementation belongs here.

## Problem

All queue items currently use `priority: Date.now()` (pure FIFO). Resumes and retries should be dispatched before new work to prioritize finishing in-progress work.

Affected enqueue sites:
- `packages/orchestrator/src/services/label-monitor-service.ts:303` — `priority: Date.now()`
- `packages/orchestrator/src/services/pr-feedback-monitor-service.ts:202` — `priority: Date.now()`

## Priority Scheme

The orchestrator's Redis sorted set queue uses `ZADD`/`ZPOPMIN` (lower score = higher priority).

| Priority Score | Type | Rationale |
|---------------|------|-----------|
| `0.{timestamp}` | **Resume** | Finish in-progress work first |
| `1.{timestamp}` | **Retry** | Re-attempt failed work before starting new |
| `Date.now()` | **New** | Fresh issue trigger, FIFO within this tier |

Using `0.{timestamp}` and `1.{timestamp}` (e.g., `0.1711036800000`, `1.1711036800000`) ensures:
- Resumes always dequeue before retries (0.x < 1.x)
- Retries always dequeue before new items (1.x < 1711036800000)
- FIFO ordering is preserved within each tier (timestamp sub-priority)
- Backwards-compatible with existing items using `Date.now()`

## User Stories

### US1: Resume Priority

**As a** workflow orchestrator,
**I want** resumed workflows to be dispatched before new or retried work,
**So that** in-progress work completes faster and resources aren't wasted starting new workflows when existing ones are waiting.

**Acceptance Criteria**:
- [ ] Resume items enqueued with priority `0.{timestamp}` (lower = higher priority)
- [ ] Resumes dequeue before retries and new items

### US2: Retry Priority

**As a** workflow orchestrator,
**I want** retried workflows to be dispatched before new work but after resumes,
**So that** failed work is re-attempted promptly without starving resumed workflows.

**Acceptance Criteria**:
- [ ] Retry items enqueued with priority `1.{timestamp}`
- [ ] Retries dequeue before new items but after resumes

### US3: Backwards Compatibility

**As a** system operator,
**I want** existing queue items (without a `queueReason`) to continue working at the same priority,
**So that** the upgrade is seamless and requires no migration.

**Acceptance Criteria**:
- [ ] Items without `queueReason` default to `Date.now()` priority
- [ ] No behavior change for existing enqueued items

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add `queueReason: 'new' \| 'resume' \| 'retry'` field to `QueueItem` type | P1 | In `types/monitor.ts` |
| FR-002 | Create `getPriorityScore(reason)` helper function | P1 | Returns `0.{ts}`, `1.{ts}`, or `Date.now()` |
| FR-003 | Update `label-monitor-service.ts` enqueue calls with `queueReason: 'new'` | P1 | Line ~303 |
| FR-004 | Update `pr-feedback-monitor-service.ts` enqueue calls with `queueReason: 'new'` | P1 | Line ~202 |
| FR-005 | Update `command: 'continue'` enqueue paths with `queueReason: 'resume'` | P1 | All resume/continue paths |
| FR-006 | Update retry/re-enqueue paths with `queueReason: 'retry'` | P1 | All retry paths |
| FR-007 | Update `redis-queue-adapter.ts` to use priority from `queueReason` | P1 | Fallback to `Date.now()` |
| FR-008 | Update `in-memory-queue-adapter.ts` to use priority from `queueReason` | P1 | Fallback to `Date.now()` |
| FR-009 | Add unit tests verifying priority ordering | P1 | Resume < Retry < New |

## Changes Required

1. Add a `queueReason: 'new' | 'resume' | 'retry'` field to the `QueueItem` type in `types/monitor.ts`
2. Create a priority score helper function:
   ```typescript
   function getPriorityScore(reason: QueueReason): number {
     const timestamp = Date.now();
     switch (reason) {
       case 'resume': return parseFloat(`0.${timestamp}`);
       case 'retry': return parseFloat(`1.${timestamp}`);
       case 'new': return timestamp;
     }
   }
   ```
3. Update enqueue call sites to pass `queueReason` and use the priority helper:
   - `label-monitor-service.ts` — new workflows: `queueReason: 'new'`
   - `pr-feedback-monitor-service.ts` — new workflows: `queueReason: 'new'`
   - Any `command: 'continue'` enqueues — resume: `queueReason: 'resume'`
   - Any retry/re-enqueue paths — retry: `queueReason: 'retry'`
4. Update `redis-queue-adapter.ts` and `in-memory-queue-adapter.ts` to use the priority from `queueReason` if present, falling back to `Date.now()` for backwards compatibility
5. Add unit tests verifying priority ordering: resumes before retries before new items

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Resume items dequeue before retries | 100% | Unit test: enqueue resume + retry, verify dequeue order |
| SC-002 | Retry items dequeue before new items | 100% | Unit test: enqueue retry + new, verify dequeue order |
| SC-003 | FIFO within each tier | 100% | Unit test: enqueue 2 items same tier, verify FIFO |
| SC-004 | Backwards compatibility | No breakage | Existing items without `queueReason` work unchanged |

## Assumptions

- The Redis sorted set (`ZADD`/`ZPOPMIN`) correctly orders floating-point scores (e.g., `0.1711036800000 < 1.1711036800000 < 1711036800000`)
- `parseFloat("0.{timestamp}")` and `parseFloat("1.{timestamp}")` produce correct numeric values for Redis scoring
- Existing enqueued items will naturally drain before the upgrade, or coexist safely with the new priority scheme

## Out of Scope

- Dynamic priority adjustment (e.g., aging/boosting stale items)
- Priority inversion detection or starvation prevention
- Queue migration of existing items to the new priority scheme
- UI/dashboard visibility of queue priority tiers

## References

- Original spec (agency#328): [spec artifacts](https://github.com/generacy-ai/agency/tree/develop/specs/328-context-part-billing)
- Billing enforcement doc: [billing-concurrent-workflow-enforcement.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/billing-concurrent-workflow-enforcement.md#queue-priority)
- Redis queue adapter: `packages/orchestrator/src/services/redis-queue-adapter.ts`
- In-memory queue adapter: `packages/orchestrator/src/services/in-memory-queue-adapter.ts`
- Queue item type: `packages/orchestrator/src/types/monitor.ts`

---

*Generated by speckit*
