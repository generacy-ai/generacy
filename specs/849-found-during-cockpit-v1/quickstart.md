# Quickstart: Verify the paired resume-dedupe clear

**Feature**: `849-found-during-cockpit-v1`
**Related**: [spec.md](./spec.md), [plan.md](./plan.md)

This guide covers (1) reproducing the pre-fix stranding behavior on a test cluster, (2) verifying the fix on a post-implementation build, and (3) log-grep patterns for post-deploy monitoring.

## Prerequisites

- A running orchestrator cluster (any deployment mode: local docker-compose, cloud-deployed via `generacy launch`, or SSH-deployed via `generacy deploy`).
- Redis reachable from the orchestrator (default: `redis://redis:6379`). Reachable to you as well if you want to inspect keys directly.
- A test GitHub repository the cluster monitors, with at least one issue that can be walked through the `implement` phase.
- `redis-cli` on the cluster host (already present in the `cluster-base` container: `docker exec <orchestrator-container> redis-cli`).
- Optional: `gh` CLI locally for approving/requesting-changes on PRs.

## 1. Reproduce the stranding (pre-fix)

This confirms the failure mode the fix addresses. Skip if you already believe the bug.

**Setup**: an issue processed through to `implement`. The workflow should produce a PR and pause at `waiting-for:implementation-review`.

```bash
# Confirm dedupe key exists after the first resume
docker exec <orchestrator-container> redis-cli GET \
  phase-tracker:<owner>:<repo>:<issue>:resume:implementation-review
# → "1"

docker exec <orchestrator-container> redis-cli TTL \
  phase-tracker:<owner>:<repo>:<issue>:resume:implementation-review
# → some value < 86400
```

**Trigger the stranding**:

1. Request changes on the PR (`gh pr review --request-changes ...`). The agent pauses at `waiting-for:address-pr-feedback`, resumes, addresses the feedback, pushes.
2. The agent re-pauses at `waiting-for:implementation-review` (second pause on this gate — this is the point the pre-fix bug misses).
3. Approve the PR (`gh pr review --approve`).

**Observe the drop** in the orchestrator logs:
```
"Duplicate event detected" ... "phase":"resume:implementation-review"
```

The resume event is silently discarded. The issue is stranded until the 24h TTL expires or an operator manually clears the key.

**Manual repair** (documented in spec §Summary):
```bash
docker exec <orchestrator-container> redis-cli DEL \
  phase-tracker:<owner>:<repo>:<issue>:resume:implementation-review
# → (integer) 1
```
After DEL, the next label-monitor poll picks up the pending `agent:approved` label and enqueues the resume. This is the workaround this fix eliminates.

## 2. Verify the fix (post-implementation)

Same scenario as above, running against a build that includes the paired-clear.

**Expected new log lines** at every pause:

On successful paired-clear (happy path):
```
INFO ... "Cleared paired resume dedupe on pause"
    phase: "implement"
    gateLabel: "waiting-for:implementation-review"
    owner: "<owner>"
    repo: "<repo>"
    issueNumber: <n>
```

On swallowed DEL failure (Redis blip):
```
WARN ... "Failed to clear paired resume dedupe on pause (non-fatal, TTL backstop will absorb)"
    phase: "implement"
    gateLabel: "waiting-for:implementation-review"
    owner: "<owner>"
    repo: "<repo>"
    issueNumber: <n>
    error: "<stringified error>"
```

**Redis state after the paired-clear**:
```bash
docker exec <orchestrator-container> redis-cli GET \
  phase-tracker:<owner>:<repo>:<issue>:resume:implementation-review
# → (nil)   ← the key is gone (cleared by the pause)
```

**Walk the two-cycle scenario**:

1. Fresh issue → `implement` → PR → pause at `waiting-for:implementation-review`.
   - Log: `Cleared paired resume dedupe on pause` (clears nothing on the first pass; this is normal).
   - Redis: key absent.
2. Request changes → resume → pause at `waiting-for:address-pr-feedback`.
   - Log: `Cleared paired resume dedupe on pause` for `waiting-for:address-pr-feedback`.
   - Redis: `phase-tracker:<owner>:<repo>:<issue>:resume:implementation-review` exists (from step 1's resume enqueue).
3. Address feedback → resume → pause at `waiting-for:implementation-review` (SECOND time).
   - Log: `Cleared paired resume dedupe on pause` for `waiting-for:implementation-review`.
   - Redis: `phase-tracker:<owner>:<repo>:<issue>:resume:implementation-review` is now DELETED by the paired-clear.
4. Approve the PR → resume enqueues.
   - Log: `Issue enqueued` (from `label-monitor-service.ts:333`) — NOT `Duplicate event detected`.
   - Workflow proceeds through the remaining phases.

**Redis key `TTL` check between step 3 and step 4** proves the fix ran:
```bash
docker exec <orchestrator-container> redis-cli TTL \
  phase-tracker:<owner>:<repo>:<issue>:resume:implementation-review
# → (integer) -2    ← key does not exist
```
`-2` is Redis's return code for "key does not exist" (as opposed to `-1` for "exists with no TTL"). This is the ground-truth signal that the paired-clear ran.

## 3. Post-deploy monitoring

**SC-002 measurement** — search operator runbooks and support logs for the manual repair command being invoked against stranded issues:
```bash
# Post-fix: expect zero matches over any 30-day window
grep -r 'redis-cli DEL phase-tracker:' /path/to/runbooks/
grep -r 'redis-cli DEL phase-tracker:' <support-log-source>
```

**Log-grep for paired-clear activity** — confirms the mechanism is running (not just the symptom):
```bash
# In orchestrator container logs (pino JSON output):
docker logs <orchestrator-container> 2>&1 | \
  jq -c 'select(.msg == "Cleared paired resume dedupe on pause")'

# Or grep the flat text form:
docker logs <orchestrator-container> 2>&1 | \
  grep 'Cleared paired resume dedupe on pause'
```

**Alert on repeated warn lines**:
```bash
docker logs <orchestrator-container> 2>&1 | \
  jq -c 'select(.msg | startswith("Failed to clear paired resume dedupe on pause"))'
```
A spike in these warns means Redis has degraded and the TTL is doing more of the work — degraded but not broken. Cross-check with orchestrator's Redis liveness signal.

## 4. Troubleshooting

**Symptom**: `Cleared paired resume dedupe on pause` never appears in the logs.

Possible causes and checks:
- Worker was constructed without a `phaseTracker`. Confirm `server.ts` worker-mode branch instantiated one (redis available). Check `redisClient` state at boot in the orchestrator startup logs.
- New pause path added that bypasses `LabelManager.onGateHit`. Verify all `github.addLabels(..., ['waiting-for:...'])` calls in the codebase flow through `LabelManager.onGateHit` (spec Assumption 2). If a new path exists, it must also invoke the paired-clear callback.
- `LabelManager` constructed at a site that does not pass the `clearResumeDedupe` arg (e.g., a test harness). Check the specific worker code path being exercised.

**Symptom**: `Failed to clear paired resume dedupe on pause` appears repeatedly for the same key.

Possible causes and checks:
- Redis is unreachable or in a failure state. Check the orchestrator's Redis connection metric / logs.
- Redis is up but the key has an ACL or eviction policy blocking DEL. Check `redis-cli ACL WHOAMI` and `redis-cli CONFIG GET maxmemory-policy`.
- The paired-clear still ran best-effort; the TTL backstop will unblock the issue within ≤24h. If urgent, use the pre-fix manual repair command (spec §Summary) — it still works.

**Symptom**: A same-gate re-review still strands even after the fix is deployed.

Possible causes and checks:
- Confirm the fix is actually in the running container: `docker exec <orchestrator-container> grep -c 'Cleared paired resume dedupe' /path/to/label-manager.js`. Zero matches → old build.
- Confirm `PhaseTracker` reached the `LabelManager` constructor: add a temporary trace log at `claude-cli-worker.ts:406` verifying the callback arg is non-`undefined`.
- Check the dedupe key against the exact `(owner, repo, issue, gate)` tuple. Typos in the `<gate>` suffix (e.g., `implementation_review` vs `implementation-review`) manifest as this symptom.
- Confirm you're not looking at a different `phase-tracker:` key layout — e.g., a `resume:process` or a legacy shape from a prior TTL cycle.

**Symptom**: Test fails locally — `label-manager.test.ts` `clearResumeDedupe not called after retry exhaustion`.

Possible causes and checks:
- Verify `github.addLabels` mock throws on all 3 retry attempts (delays are 1000/2000/4000 ms — fake timers or `vi.useFakeTimers()` may be needed to keep tests fast).
- Verify the paired-clear invocation sits OUTSIDE the `retryWithBackoff(...)` block — inside the block, the retry loop would re-run the callback per retry.

## 5. Rollback

If the fix causes an unexpected regression:

1. Revert the three source-file changes:
   - `packages/orchestrator/src/worker/label-manager.ts` (remove callback arg + paired-clear block)
   - `packages/orchestrator/src/worker/claude-cli-worker.ts` (remove `phaseTracker` from `ClaudeCliWorkerDeps` + wiring closure)
   - `packages/orchestrator/src/server.ts` (remove worker-mode `PhaseTrackerService` instantiation)
2. Revert the test extensions.
3. Redeploy the orchestrator.

Post-rollback:
- Existing dedupe keys age out on their TTL (≤24h).
- Operators fall back to the `redis-cli DEL phase-tracker:<owner>:<repo>:<issue>:resume:<gate>` runbook for stranded issues.
- No data migration, no schema change, no relay-payload change to reverse.
