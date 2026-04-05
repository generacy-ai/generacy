# Feature Specification: Add Per-User Lease Protocol to Orchestrator

Update the orchestrator (`packages/orchestrator`) to support per-user execution lease requests and cluster connection gating as part of the new per-seat pricing model.

**Branch**: `418-summary-update-orchestrator` | **Date**: 2026-04-05 | **Status**: Draft | **Issue**: [#418](https://github.com/generacy-ai/generacy/issues/418)

## Summary

Update the orchestrator (`packages/orchestrator`) to support per-user execution lease requests and cluster connection gating as part of the new per-seat pricing model.

## Changes Required

### Lease Request (before dispatch)
Before dispatching work to a worker, the orchestrator must:
1. Send `lease_request` with `{ userId, queueItemId, jobId }` via relay
2. Wait for `lease_granted` or `lease_denied`
3. On `lease_granted`: dispatch to worker, start heartbeat loop
4. On `lease_denied` (at_capacity): leave item in queue, retry on `slot_available`

The `userId` is the cluster owner — all workflows dispatched from a cluster count against that user's per-seat limits.

### Lease Release (on workflow end)
On workflow pause/complete/fail, send `lease_release` with `{ leaseId }` via relay.

### Heartbeat Loop
For each active lease, send `lease_heartbeat` with `{ leaseId }` every 30 seconds. If heartbeat fails, treat lease as expired and re-enqueue the work item.

### Slot Available Listener
Listen for `slot_available` messages from cloud. On receipt, attempt to dequeue next item and request a lease.

### Queue Priority
Set priority scores on enqueue:
- `0` for resume (finish in-progress work first)
- `1` for retry (re-attempt failed work)
- `Date.now()` for new work (FIFO within this tier)

### Worker Cap
Cap effective worker count at `min(configuredWorkers, userTierLimit)` where `userTierLimit` comes from the per-seat concurrent workflow limit for the cluster owner's tier.

### Cluster Rejection Handling
Handle `cluster_rejected` on relay connection — surface error to user: "Active cluster limit reached for your plan."

## Context
- Limits are per-seat (individual) — each user/cluster-owner has their own limits
- See `docs/billing-concurrent-workflow-enforcement.md` in tetrad-development
- Depends on generacy-ai/generacy-cloud#391 (cloud-side lease service)

## Per-Seat Limits
| Tier | Active Clusters | Concurrent Workflows |
|------|----------------|----------------------|
| Free | 1 | 1 |
| Basic | 2 | 2 |
| Standard | 3 | 5 |
| Professional | 4 | 10 |
| Enterprise | Unlimited | Unlimited |

## Acceptance Criteria
- [ ] Lease request sent before worker dispatch with userId
- [ ] Lease release sent on workflow pause/complete/fail
- [ ] 30-second heartbeat loop for active leases
- [ ] slot_available listener triggers dequeue + lease request
- [ ] Queue priority: resume(0) > retry(1) > new(Date.now())
- [ ] Worker count capped at user's tier limit
- [ ] cluster_rejected handling with user-facing error
- [ ] Unit tests for lease lifecycle
- [ ] Integration tests with mock relay

## User Stories

### US1: Workflow Dispatch with Lease Enforcement

**As a** cluster owner on a paid plan,
**I want** the orchestrator to request a lease from the cloud before dispatching work,
**So that** my concurrent workflow usage is enforced according to my tier limits.

**Acceptance Criteria**:
- [ ] Orchestrator sends `lease_request` with `{ userId, queueItemId, jobId }` before dispatching to a worker
- [ ] On `lease_granted`, work is dispatched and heartbeat loop starts
- [ ] On `lease_denied` (at_capacity), item stays in queue and retries on `slot_available`

### US2: Graceful Lease Lifecycle Management

**As a** platform operator,
**I want** leases to be released when workflows end and heartbeated while active,
**So that** the cloud accurately tracks concurrent usage and reclaims abandoned slots.

**Acceptance Criteria**:
- [ ] `lease_release` sent on workflow pause, complete, or fail
- [ ] `lease_heartbeat` sent every 30 seconds for active leases
- [ ] Failed heartbeat causes lease to be treated as expired and work re-enqueued

### US3: Cluster Connection Gating

**As a** user who has exceeded their active cluster limit,
**I want** a clear error message when my cluster is rejected,
**So that** I understand the limitation and can upgrade my plan.

**Acceptance Criteria**:
- [ ] `cluster_rejected` message on relay connection is handled
- [ ] User-facing error: "Active cluster limit reached for your plan."

### US4: Fair Queue Ordering

**As a** user with multiple queued workflows,
**I want** in-progress resumes prioritized over retries, and retries over new work,
**So that** existing work completes before new work starts.

**Acceptance Criteria**:
- [ ] Resume items get priority `0`
- [ ] Retry items get priority `1`
- [ ] New work items get priority `Date.now()` (FIFO within tier)

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Send `lease_request` via relay before dispatching work to a worker | P0 | Must include `userId` (cluster owner), `queueItemId`, `jobId` |
| FR-002 | Handle `lease_granted` response: dispatch work, start heartbeat | P0 | |
| FR-003 | Handle `lease_denied` response: leave item in queue | P0 | Retry triggered by `slot_available` |
| FR-004 | Send `lease_release` via relay on workflow pause/complete/fail | P0 | Includes `leaseId` |
| FR-005 | Send `lease_heartbeat` every 30 seconds for each active lease | P0 | |
| FR-006 | On heartbeat failure, expire lease and re-enqueue work item | P1 | |
| FR-007 | Listen for `slot_available` from cloud, dequeue and request lease | P0 | |
| FR-008 | Set queue priority scores: resume=0, retry=1, new=Date.now() | P1 | |
| FR-009 | Cap worker count at `min(configuredWorkers, userTierLimit)` | P1 | `userTierLimit` from per-seat concurrent workflow limit |
| FR-010 | Handle `cluster_rejected` on relay connection with user-facing error | P1 | "Active cluster limit reached for your plan." |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Lease request before every dispatch | 100% | No workflow dispatched without a granted lease |
| SC-002 | Lease release on workflow end | 100% | No orphaned leases after workflow pause/complete/fail |
| SC-003 | Heartbeat interval accuracy | 30s ± 5s | Timer precision under normal load |
| SC-004 | Queue priority ordering | Correct | Resume before retry before new, verified by unit tests |
| SC-005 | Worker cap enforcement | Correct | Never exceed `min(configured, tierLimit)` active workers |
| SC-006 | Unit test coverage for lease lifecycle | ≥90% | Jest coverage report |
| SC-007 | Integration tests with mock relay | Pass | All lease protocol flows exercised end-to-end |

## Assumptions

- Cloud-side lease service (generacy-ai/generacy-cloud#391) is available and implements the lease protocol
- Relay connection already exists between orchestrator and cloud (no new transport needed)
- `userId` is the cluster owner — all workflows from a cluster count against that single user's limits
- Tier limits are communicated to the orchestrator via the lease protocol responses (not stored locally)

## Out of Scope

- Cloud-side lease service implementation (handled in generacy-cloud#391)
- Billing/payment processing
- Plan upgrade UI or prompts beyond the error message
- Multi-user clusters (each cluster has a single owner)
- Rate limiting beyond concurrent workflow caps

---

*Generated by speckit*
