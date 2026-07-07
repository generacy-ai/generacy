# Feature Specification: Boot-resume fires on wizard-provisioned clusters (#824 follow-up)

**Branch**: `834-summary-824-fix-auto` | **Date**: 2026-07-07 | **Status**: Draft

## Summary

The #824 fix (auto-resume the VS Code tunnel + code-server after a cluster stop/start,
via `BootResumeService`) does **not** run on wizard-provisioned clusters — which is
every dev cluster created through the bootstrap wizard. The service was wired into a
startup branch these clusters never execute (`config.relay.apiKey`-present synchronous
path), so the tunnel is still down after every stop/start. Verified live on cluster
`sniplink` running the published fix (`@generacy-ai/orchestrator` / control-plane
`0.0.0-preview-20260707175952-4bb30e1`): after stop/start there was no `code tunnel`
process and no `BootResumeService` log line.

This is a follow-up to #824 (PR #832, commit `b3bad08`) — the feature is correct in
isolation but unreachable on the code path that matters.

## Root cause

`createServer()` in `packages/orchestrator/src/server.ts` selects its startup branch on
whether `config.relay.apiKey` is set at boot time:

- `server.ts:433` — `if (!isWorkerMode && !config.relay.apiKey)` → `activateInBackground()`
  (`server.ts:799`). **Wizard clusters take this branch** because the wizard persists the
  relay key to `/var/lib/generacy/cluster-api-key` (loaded during activation), never
  seeding it into the process env.
- `server.ts:447` — `else if (!isWorkerMode && config.relay.apiKey)` → synchronous
  existing-key path. **`BootResumeService` was added only here** (`server.ts:489`,
  `resumeService.triggerBootResume()` at `server.ts:500`).

The `activateInBackground` path calls `checkPostActivationState()` at `server.ts:890` but
only handles the retry case (`PostActivationRetryService`); it never constructs or calls
`BootResumeService`. Net effect on wizard clusters: boot-resume never fires and the
tunnel stays down after a stop/start — the exact symptom #824 was meant to fix.

## User Stories

### US1: Wizard cluster developer resumes VS Code tunnel across restarts

**As a** developer running a Generacy dev cluster provisioned through the bootstrap wizard,
**I want** the VS Code tunnel and code-server to auto-resume after `generacy stop` / `generacy start`,
**So that** I can reconnect to my cluster without manually POSTing to the control-plane socket or clicking "Restart" in the UI.

**Acceptance Criteria**:
- [ ] After `generacy stop <cluster>` followed by `generacy start <cluster>`, a wizard-provisioned cluster's `code tunnel` process is running and the tunnel is connected without manual intervention.
- [ ] The orchestrator log contains the `"Boot resume: waiting for control-plane socket"` line during startup on wizard clusters (proof `BootResumeService.triggerBootResume()` was invoked).
- [ ] The behavior is unchanged for env-key clusters (the `config.relay.apiKey`-present synchronous branch continues to invoke boot-resume exactly once).

### US2: Maintainer prevents future drift between the two startup branches

**As a** Generacy maintainer,
**I want** the "post-activation state → retry vs. resume" decision to live in a single shared helper called from both startup branches,
**So that** we cannot ship a fix into one path while leaving the other silently broken (as happened with #824).

**Acceptance Criteria**:
- [ ] The post-activation branch logic (retry when `needsRetry === true`; boot-resume when `activated && postActivationComplete`) is implemented in one place and called from both the synchronous existing-key branch and `activateInBackground`.
- [ ] A regression test drives the `activateInBackground` startup path with `activated && postActivationComplete` state and asserts `BootResumeService.triggerBootResume()` (or the two `/lifecycle/*-start` POSTs) fires.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `activateInBackground()` must invoke `BootResumeService.triggerBootResume()` after `initializeRelayBridge()` and `checkPostActivationState()` return, when the post-activation state is `activated && postActivationComplete` (i.e. `needsRetry === false`). | P1 | Mirror the existing wiring at `server.ts:488-502`. |
| FR-002 | The two startup branches (synchronous existing-key and `activateInBackground`) must share a single implementation of the post-activation branch decision (retry vs. resume). | P1 | Preferred approach per issue: hoist into one helper both branches call. Prevents recurrence of the same drift. |
| FR-003 | Retry (`PostActivationRetryService`) and boot-resume (`BootResumeService`) must remain mutually exclusive per boot: retry runs iff `needsRetry === true`; boot-resume runs iff `activated && postActivationComplete`; never both. | P1 | Preserve existing semantics; no double-fire. |
| FR-004 | The existing behavior of the synchronous existing-key branch (env-key clusters) must not change: one boot-resume call per boot, same log line, same error surface. | P1 | Regression guard for env-key path. |
| FR-005 | A regression test must exercise the `activateInBackground` startup path with post-activation state `activated && postActivationComplete` and assert that `BootResumeService.triggerBootResume()` (or its two downstream `/lifecycle/vscode-tunnel-start` + `/lifecycle/code-server-start` POSTs) fires. | P1 | Closes the #824 test-coverage gap; a test that only covers the env-key branch will pass while the real path stays broken. |
| FR-006 | No changes to `BootResumeService` itself, to the control-plane, or to any other repo. Scope is confined to `packages/orchestrator/src/server.ts` (+ a new shared helper) and the new test. | P2 | Explicit scope guard from the issue. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Wizard-provisioned cluster tunnel auto-resume after stop/start | 100% (up from 0%) | Reproduce the issue's steps on a fresh wizard cluster after the fix; observe `code tunnel` running and the boot-resume log line. |
| SC-002 | Boot-resume wiring parity between startup branches | Both branches invoke boot-resume via the same code path | Static inspection: one helper referenced from both branches; no branch-specific boot-resume call sites. |
| SC-003 | Regression test coverage for the `activateInBackground` path | ≥1 test that fails when the boot-resume call is removed from the `activateInBackground` branch | Delete/comment the boot-resume invocation on the `activateInBackground` side; test must fail. |
| SC-004 | No regression on env-key clusters | 0 behavior changes on the synchronous existing-key path | Existing #824 tests continue to pass; observed log/lifecycle POST count unchanged for env-key boots. |

## Assumptions

- `BootResumeService` itself is correct and unchanged — issue explicitly states "the resume machinery itself is healthy and only the wiring is wrong" (validated on cluster `sniplink` by manually POSTing to `/lifecycle/vscode-tunnel-start`).
- `VsCodeTunnelProcessManager.start()` and `CodeServerProcessManager.start()` remain idempotent, so an accidental double-fire (should FR-003 be violated) would not corrupt state — but FR-003 is still required to keep semantics clean.
- Wizard clusters' post-activation state after a stop/start on an already-activated cluster is `activated && postActivationComplete` (i.e. `needsRetry === false`). The retry service is the only current consumer of the true branch.
- The control-plane socket is reachable within the existing 15s wait (`probeControlPlaneSocket`); no changes to the wait envelope are required.

## Out of Scope

- Modifying `BootResumeService`, `PostActivationRetryService`, `VsCodeTunnelProcessManager`, or `CodeServerProcessManager`.
- Any control-plane, cluster-base, cluster-microservices, or cloud repo changes.
- Fixing the device-code-timeout / restart hardening tracked in the companion issue #825.
- Pushing `cluster.state = degraded` on boot-resume failure — the #824 decision to keep failure per-service (`cluster.bootstrap` warning) is preserved.
- Refactoring `checkPostActivationState()` semantics or its return shape.

## Related

- #824 (original fix — incomplete), PR #832, commit `b3bad08`.
- #825 (companion device-code-timeout / restart hardening).

---

*Generated by speckit*
