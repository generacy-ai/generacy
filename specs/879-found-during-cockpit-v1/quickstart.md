# Quickstart: Verifying the #879 PR-feedback dedupe migration

This isn't a new feature to install — it's an internal caller-site change. This quickstart is for **reviewers, operators, and anyone debugging PR-feedback behavior post-merge**.

## What changed (one-paragraph version)

`PrFeedbackMonitorService` no longer writes `phase-tracker:*:address-pr-feedback` keys with 24h TTL. It now shares the same in-flight queue-state dedupe that the resume path uses (`QueueManager.enqueueIfAbsent`). The `waiting-for:address-pr-feedback` label is added **before** the enqueue call, so it survives an in-flight collision. Simultaneous webhook + poll triggers collapse to one queue item. Handler-side `phaseTracker.clear(...)` calls are removed (they were partners of a key nothing writes).

## For reviewers

**Files to focus review attention on** (this is the whole diff surface):

- `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` — the migration site.
- `packages/orchestrator/src/worker/pr-feedback-handler.ts` — dead `phaseTracker.clear()` cleanup.
- `packages/orchestrator/src/services/redis-queue-adapter.ts` + `in-memory-queue-adapter.ts` — log-shape upgrade on `false` return.
- `packages/orchestrator/src/server.ts` (`PrFeedbackMonitorService` ctor call) + `packages/orchestrator/src/worker/claude-cli-worker.ts` (`PrFeedbackHandler` ctor call) — signature updates.
- `packages/orchestrator/src/__tests__/phase-tracker-audit.test.ts` — new audit test (SC-004).
- Test files under `packages/orchestrator/src/services/__tests__/` and `packages/orchestrator/src/worker/__tests__/` — signature updates + new SC tests.

**Contract to keep in mind while reviewing** — see `contracts/enqueue-dedupe.md`. The most important invariant is **I2**: zero-trusted PRs must never enqueue. Without this guard, self-clearing dedupe busy-loops.

## For operators (post-deploy)

### Verifying the fix landed correctly

**1. Grep for the smoking-gun regression** (stale-key silence):

```bash
# Should return 0 lines. Any remaining write is a bug.
rg -n "tryMarkProcessed.*address-pr-feedback|phaseTracker.*'address-pr-feedback'" packages/orchestrator/src
```

**2. Check for the new observable log line** on any in-flight collision (webhook + poll race, or `continue`/`process` in flight when feedback arrives):

```bash
# In your orchestrator logs, look for the new drop line:
kubectl logs deploy/orchestrator | grep -E '"reason":"in-flight".*address-pr-feedback|Dropping.*in flight'
```

Expected shape:

```json
{
  "level": "info",
  "itemKey": "owner/repo#42",
  "reason": "in-flight",
  "msg": "Dropping enqueue (item already in flight)"
}
```

A **repeating** in-flight drop line at poll cadence (default ~10-30s) is your **stuck-worker signal** — the same issue is being re-detected on every poll but blocked by a persistently-in-flight item. Combined with the `waiting-for:address-pr-feedback` label being present on the issue (FR-010), this is the diagnosable state that pre-migration silently strands.

**3. Check the label state is truthful:**

Any PR with trusted unresolved feedback should have `waiting-for:address-pr-feedback` on its linked issue, whether or not the enqueue attempt collided. Cockpit `watch`/`status` should reflect it.

### Migration cleanup (Redis)

**No action needed.** Old `phase-tracker:*:address-pr-feedback` keys still in Redis expire on their own ~24h TTL and no longer influence any code path. If you want to clean up eagerly:

```bash
redis-cli --scan --pattern 'phase-tracker:*:address-pr-feedback' | xargs -r redis-cli del
```

But this is optional — the migration explicitly does not depend on migrating existing keys (Assumption 3 in spec).

## Available commands / behaviors (unchanged surface)

No CLI commands or config surfaces are added or removed. The behavior of these operator-visible endpoints is unchanged:

- Webhook: `POST /webhooks/pull_request_review` → `PrFeedbackMonitorService.processPrReviewEvent(event)` still runs, just with different dedupe internals.
- Poll: default 60s interval (config `prMonitor.pollIntervalMs`), unchanged.
- Cockpit `watch <issue>` / `status <issue>` render labels — `waiting-for:address-pr-feedback` now reflects reality more truthfully (FR-010).

## Troubleshooting

### "My PR has unresolved feedback but nothing is happening"

Pre-#879: could mean a stale phase-tracker key was silently blocking enqueue for hours.

Post-#879: check in order:

1. **Trust classification**: is any comment author trusted? Look for `Zero-trusted unresolved threads` warn logs or the `⚠️ Feedback requires a trusted author` PR notice. If yes, an OWNER/MEMBER/COLLABORATOR needs to reply to a thread (or `CLUSTER_GITHUB_USERNAME` needs to be set to match a comment author). This is the #869 contract at work.
2. **Assignee**: is the linked issue assigned to `CLUSTER_GITHUB_USERNAME`? See `Skipping PR feedback: linked issue not assigned to this cluster` debug logs.
3. **In-flight collision**: is a `continue` or `process` item already running for the same issue? Look for the `reason: "in-flight"` info log at poll cadence. The feedback will enqueue on the next poll after the in-flight item completes. This is intentional (Q2→A single-writer-per-issue).
4. **Auth**: is the GitHub client failing? Look for `githubAuth.status` in the `/health` endpoint (from #762).

### "The audit test failed on my PR"

`packages/orchestrator/src/__tests__/phase-tracker-audit.test.ts` asserts:

- `pr-feedback-monitor-service.ts` does not reference `PhaseTracker`
- `pr-feedback-handler.ts` does not reference `PhaseTracker`
- No `DEDUP_PHASE` declaration remains under `packages/orchestrator/src/**`

If your PR reintroduces any of these, that's the intended failure. Removing `PhaseTracker` entirely from these two files is a load-bearing part of #879 (FR-007, SC-004). If you have a legitimate reason to keep them, the audit test needs an explicit update with reviewer sign-off.

### "Handler tests are failing after `git pull`"

Test stubs constructed `PrFeedbackHandler` and `PrFeedbackMonitorService` with a `phaseTracker` positional arg. Post-migration, the arg is gone (both classes). Update your local mocks — see `pr-feedback-handler.test.ts` and `pr-feedback-monitor-service.test.ts` for the new construction shape.
