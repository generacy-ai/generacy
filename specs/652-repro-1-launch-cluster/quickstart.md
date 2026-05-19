# Quickstart: Post-Activation Retry

## What This Changes

After this fix, restarting a cluster where first-boot setup failed will automatically retry post-activation. Previously, the cluster would silently remain in a half-setup state forever.

## Testing the Fix

### Reproduce the Bug (Before Fix)

1. Launch a cluster pointing to a repo with a non-`main` default branch
2. Wizard completes, post-activation fails during `git clone`
3. Fix the branch config, restart: `npx generacy stop && npx generacy up`
4. **Before fix**: Cluster reports healthy but `/workspaces/<project>/` is empty

### Verify the Fix (After Fix)

1. Same setup — launch with bad branch, let post-activation fail
2. Fix the branch config, restart the cluster
3. **After fix**: Orchestrator detects "activated but incomplete" → replays `bootstrap-complete` → post-activation re-runs → repo clones successfully

### Verify No Regression

1. Launch a cluster normally (post-activation succeeds on first boot)
2. Restart the cluster: `npx generacy stop && npx generacy up`
3. Post-activation should NOT re-run (completion flag exists on data volume)

## Key Log Lines

### Successful Retry
```
[orchestrator] Post-activation incomplete — replaying bootstrap-complete lifecycle action
[orchestrator] POST /lifecycle/bootstrap-complete → 200
[post-activation-watcher] Detected trigger, running post-activation...
[post-activation] Clone successful, writing completion flag
```

### Normal Restart (No Retry Needed)
```
[orchestrator] Existing cluster API key found, skipping activation
[orchestrator] Post-activation already complete, skipping retry
```

### Retry Failure
```
[orchestrator] Post-activation incomplete — replaying bootstrap-complete lifecycle action
[post-activation] git clone failed: fatal: remote branch 'nonexistent' not found
[orchestrator] Post-activation retry failed, pushing degraded status
```

## Workaround (Still Works)

The manual workaround documented in the issue still works as a fallback:
```bash
docker exec <project>-orchestrator-1 touch /tmp/generacy-bootstrap-complete
```

## Files Changed

| File | Change |
|------|--------|
| `packages/orchestrator/src/services/post-activation-retry.ts` | New service: state detection + retry trigger |
| `packages/orchestrator/src/server.ts` | Call retry service after activation |

## Companion Changes (cluster-base repo)

| File | Change |
|------|--------|
| `entrypoint-post-activation.sh` | Write `/var/lib/generacy/post-activation-complete` on success |
| `entrypoint-post-activation.sh` | Defensive cleanup for partial state before retry |
