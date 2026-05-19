# Bug Fix: Cluster restart doesn't retry failed post-activation

**Branch**: `652-repro-1-launch-cluster` | **Date**: 2026-05-19 | **Status**: Draft | **Issue**: [#652](https://github.com/generacy-ai/generacy/issues/652)

## Summary

When post-activation fails on first boot (e.g., `git clone` fatals due to wrong branch, missing creds, or network error), restarting the cluster does not retry the post-activation script. The `/tmp/generacy-bootstrap-complete` trigger file is lost on container restart (tmpfs), and no wizard runs on subsequent boots (activation already complete), leaving the cluster permanently half-set-up with no recovery path except destroying the data volume.

The fix: track post-activation completion on the data volume (`/var/lib/generacy/post-activation-complete`), and on startup, if activated but post-activation never succeeded, re-run it immediately.

## User Stories

### US1: Cluster recovery via restart

**As a** cluster operator,
**I want** a failed post-activation to automatically retry when I restart the cluster,
**So that** fixing the underlying issue (bad branch, missing creds, network) and restarting is a real recovery path.

**Acceptance Criteria**:
- [ ] Restarting a cluster where post-activation failed re-runs post-activation against current config
- [ ] If config is now correct, cluster finishes setup cleanly
- [ ] Visible log output indicates post-activation is retrying

### US2: Successful clusters are unaffected

**As a** cluster operator,
**I want** a cluster that completed post-activation successfully to not re-run it on restart,
**So that** repos aren't re-cloned and credentials aren't re-configured on every container restart.

**Acceptance Criteria**:
- [ ] Cluster with successful post-activation skips it on restart (no regression)
- [ ] State file persists on the data volume across container restarts

### US3: Visible failure state

**As a** cluster operator or maintainer,
**I want** post-activation failures to be clearly visible in `docker compose logs`,
**So that** I can diagnose what went wrong without exec-ing into the container.

**Acceptance Criteria**:
- [ ] Failed post-activation produces structured, visible log output
- [ ] Cluster status reflects incomplete setup (not falsely "healthy")

## Root Cause

The post-activation flow has a state management bug across three interacting mechanisms:

1. **Persisted API key** on data volume — cluster skips wizard/activation on restart (correct).
2. **Wizard skipped** — no process creates `/tmp/generacy-bootstrap-complete` on restart (correct behavior, wrong consequence).
3. **Trigger file in `/tmp`** — wiped on container restart. Watcher arms but trigger never appears. Post-activation permanently blocked.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Persist post-activation completion flag at `/var/lib/generacy/post-activation-complete` on the data volume | P1 | Written only after post-activation succeeds |
| FR-002 | On startup: if API key exists AND completion flag absent, run post-activation immediately (no wizard trigger needed) | P1 | Core fix |
| FR-003 | On startup: if API key exists AND completion flag present, skip post-activation (current behavior) | P1 | No regression |
| FR-004 | On startup: if no API key, arm watcher for wizard trigger (current first-boot behavior) | P1 | No regression |
| FR-005 | Defensive cleanup: remove empty `/workspaces/<project>/` (no `.git`) before retry | P2 | Partial clone left by failed first attempt |
| FR-006 | Defensive cleanup: if `.git` exists with different remote/branch, log warning and skip clone | P2 | Don't clobber user work |
| FR-007 | Surface structured error to cluster status if post-activation fails on retry | P2 | Propagate via relay to cloud dashboard |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | First-boot success path | Works identically to today | Manual E2E test |
| SC-002 | Failed first-boot + restart | Post-activation retries and succeeds | Automated test |
| SC-003 | Successful boot + restart | Post-activation skipped, no re-clone | Automated test |
| SC-004 | Partial-state cleanup | Empty workspace dir removed before retry | Automated test |
| SC-005 | Zero regression in existing activation flow | Wizard-triggered first boot still works | Manual E2E test |

## Assumptions

- The data volume at `/var/lib/generacy/` persists across `docker compose down && up -d` (it's a named Docker volume, not a bind mount to `/tmp`).
- The post-activation script (`entrypoint-post-activation.sh`) is idempotent or safe to re-run after cleanup.
- Changes span both `generacy` (orchestrator) and `cluster-base` (shell scripts) repos.

## Out of Scope

- Fixing the underlying branch mismatch bug (#651) — that's a separate issue.
- Cloud-side UI for configuring primary branch — future work.
- Automatic retry without restart (e.g., backoff loop inside the container) — simplest fix is restart-triggered retry.
- Changing the `/tmp/generacy-bootstrap-complete` trigger mechanism for first boot — it stays as-is for the wizard flow.

---

*Generated by speckit*
