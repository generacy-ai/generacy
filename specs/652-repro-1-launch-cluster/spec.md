# Feature Specification: ## Repro

1

**Branch**: `652-repro-1-launch-cluster` | **Date**: 2026-05-19 | **Status**: Draft

## Summary

## Repro

1. Launch a cluster with a configuration that causes post-activation to fail mid-setup (easiest reproducer today: a project repo whose default branch isn't `main` — see [generacy-ai/generacy#651](https://github.com/generacy-ai/generacy/issues/651) for the underlying cause). The wizard completes, "Cluster activated successfully" is logged, but the post-activation script's `git clone` fatals.
2. Stop the cluster and restart it (e.g., fix whatever caused the failure, then `docker compose down && up -d` or `npx generacy stop && npx generacy up`).
3. **Expected:** post-activation re-runs against the now-fixed config, completes successfully, repo gets cloned, cluster is fully set up.
4. **Actual:** post-activation never re-runs. The cluster reports healthy and "activated," but `/workspaces/<project>/` stays empty and `gh CLI` stays unauthenticated. From the outside, the cluster looks fine; nothing surfaces the half-completed-setup state.

## Root cause

The orchestrator's post-activation flow is gated on the existence of `/tmp/generacy-bootstrap-complete`. On first launch, the wizard creates that file when the user clicks through the activation steps; the `post-activation-watcher` (armed at orchestrator startup) detects the file appearing and runs the `post-activation` script (which does `git clone`, configures gh CLI, etc.).

The container's orchestrator log on a restart with persisted cluster API key:

```
[orchestrator] Wizard mode — deferring repo clone until activation completes
[orchestrator] Arming post-activation watcher (trigger: /tmp/generacy-bootstrap-complete)
[post-activation-watcher] Watching /tmp/generacy-bootstrap-complete (poll every 2s)...
... Existing cluster API key found, skipping activation
... Cluster activation complete
```

Three things are happening simultaneously:

1. **The cluster has a persisted API key** (stored on the data volume, survives restart). It uses this to skip activation — the cloud already knows about this cluster.
2. **The wizard is skipped** because activation is already complete from the cloud's perspective.
3. **`/tmp/generacy-bootstrap-complete` is in `/tmp`**, which is wiped on container restart. The watcher is armed, waiting for a trigger that will never appear (no wizard to create it).

The result: post-activation is permanently blocked from running. Any partial state left from the failed first attempt (e.g., an empty `/workspaces/<project>/` directory created by the `Cloning into ...` line before `fatal:`) persists, and there's no recovery path short of destroying the cluster's data volume and starting over.

## Fix

Track post-activation completion **on the data volume**, not in `/tmp`. The orchestrator startup decides what to do based on the persisted state:

| State | Action on startup |
|---|---|
| First boot, no prior activation | Arm watcher; wait for wizard trigger (today's behavior) |
| Prior activation succeeded AND prior post-activation succeeded | Skip post-activation (today's behavior — don't re-clone on every restart) |
| Prior activation succeeded BUT prior post-activation failed or never completed | **Re-run post-activation immediately** (new behavior — currently this case is silently broken) |

Concretely:

- Persist a flag like `/var/lib/generacy/post-activation-complete` (or a small JSON state file) on the data volume when post-activation succeeds.
- On orchestrator startup, if cluster is already activated (existing API key) AND `post-activation-complete` is absent → directly run the post-activation script, no need for the wizard trigger file at all.
- Keep the `/tmp/generacy-bootstrap-complete` trigger as the first-boot signal from the wizard, but treat it as additive — its absence shouldn't mean "skip post-activation forever," it should mean "wait for wizard OR proceed if state file says re-run."

### Defensive cleanup

If post-activation succeeded but left files in a weird state (e.g., the clone partially wrote to `/workspaces/<project>/` before failing), the retry should clean up before retrying:

- If `/workspaces/<project>/` exists and is empty (no `.git`), `rm -rf` it before attempting the clone.
- If `/workspaces/<project>/.git` exists but doesn't match the configured `REPO_URL`/`REPO_BRANCH`, leave it alone but log a clear warning ("workspace already initialized with different repo — skipping clone").
- If the configured branch doesn't exist upstream (e.g., #651 bug), surface a structured error that propagates to the cluster status (not just a log line).

## Acceptance criteria

- A cluster where first-boot post-activation fails (any cause — bad branch, missing creds, network blip) can recover by simply restarting. The retry runs post-activation against the current config; if config is now correct, the cluster finishes setup cleanly.
- A cluster where first-boot post-activation **succeeded** doesn't re-run post-activation on subsequent restarts — same as today's behavior, no regression. (Don't re-clone the repo on every cluster start.)
- The state file is on the data volume so it survives container restarts.
- A post-activation failure logs visibly enough that a user or maintainer can tell from `docker compose logs` that the setup didn't complete.
- Tests cover: first-boot success, first-boot failure + restart success, multi-restart no-op, mid-failure partial-state cleanup.

## Workaround until fixed

Inside the running orchestrator container, manually create the trigger file to force the post-activation watcher to fire:

```bash
docker exec <project>-orchestrator-1 touch /tmp/generacy-bootstrap-complete
```

The watcher polls every 2s, will see the file, and run post-activation. Verified to work in the user's case — repo cloned successfully after the manual trigger.

## Why this matters beyond #651

The bug is independent. It bites any cluster where:
- Network drops during the initial clone.
- The user's GitHub App needs additional permissions but they're granted mid-wizard.
- Any other transient failure makes the first post-activation exit non-zero.

In all those cases, the user's natural recovery instinct is "restart the cluster" — which today silently makes the situation worse (cluster looks "activated" externally, but is permanently half-set-up). Fixing this makes restarts a real recovery tool.

## Discovered during

End-to-end testing of v1.6 custom-image flow. After fixing the `REPO_BRANCH=main` issue (#651) by hand-editing `.env` to `develop`, the user restarted the cluster expecting it to re-run setup. The cluster came back up clean ("Existing cluster API key found, skipping activation") but `/workspaces/ai-lawfirm/` stayed empty. Diagnostic investigation in the running container showed the post-activation watcher armed but never triggered — manually touching `/tmp/generacy-bootstrap-complete` immediately ran post-activation, which then succeeded against the fixed branch.

## Related

- generacy-ai/generacy#651 (the bug that surfaced this — but this issue is independently real).
- generacy-ai/generacy-cloud — primaryBranch issue (longer-term: branch config in the UI; cleaner-failure modes if user picks the wrong branch).

## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
