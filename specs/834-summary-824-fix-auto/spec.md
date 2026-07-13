# Feature Specification: ## Summary

The #824 fix (auto-resume the VS Code tunnel + code-server after a cluster stop/start,
via `BootResumeService`) does **not** run on wizard-provisioned clusters — which is
every dev cluster created through the bootstrap wizard

**Branch**: `834-summary-824-fix-auto` | **Date**: 2026-07-07 | **Status**: Draft

## Summary

## Summary

The #824 fix (auto-resume the VS Code tunnel + code-server after a cluster stop/start,
via `BootResumeService`) does **not** run on wizard-provisioned clusters — which is
every dev cluster created through the bootstrap wizard. The service was wired into a
startup branch these clusters never execute, so the tunnel is still down after every
stop/start. Verified live on cluster `sniplink` running the published fix
(`@generacy-ai/orchestrator` / control-plane `0.0.0-preview-20260707175952-4bb30e1`):
after stop/start there was no `code tunnel` process and no `BootResumeService` log line.

This is a follow-up to #824 (PR #832, commit `b3bad08`) — the feature is correct in
isolation but unreachable on the code path that matters.

## Root cause

`createServer()` picks its startup branch on `config.relay.apiKey`
(`packages/orchestrator/src/server.ts`):

- `packages/orchestrator/src/server.ts:433` — `if (!isWorkerMode && !config.relay.apiKey)`
  → `activateInBackground()` (`server.ts:799`). **Wizard clusters take this branch.**
- `packages/orchestrator/src/server.ts:447` — `else if (!isWorkerMode && config.relay.apiKey)`
  → synchronous existing-key path. **`BootResumeService` was added only here**
  (`server.ts:489`, `resumeService.triggerBootResume()` at `server.ts:500`).

Wizard-provisioned clusters boot with `config.relay.apiKey` **empty** — the relay key is
not in the process env; it is persisted to `/var/lib/generacy/cluster-api-key` and
reloaded during activation. So they always take the `activateInBackground` branch, which
checks post-activation state at `server.ts:890` but only handles the *retry* case
(`PostActivationRetryService`) — it never constructs or calls `BootResumeService`.

Net: on wizard clusters the boot-resume never fires, and the tunnel stays down after a
stop/start (matching the original #824 symptom this fix was meant to resolve).

## Evidence (cluster `sniplink`)

- Orchestrator booted 18:10 on the published fix; the log shows the `activateInBackground`
  markers ("Existing cluster API key found, skipping activation" from
  `activation/index.js:31`, "Cluster activation complete" from the `activateInBackground`
  body) — i.e. the **first** branch ran.
- `BootResumeService.triggerBootResume()` logs `"Boot resume: waiting for control-plane
  socket"` the instant it fires. That line is **absent** from the startup logs → the
  resume was never invoked.
- No `code tunnel` process was running after the restart.
- Manually POSTing `/lifecycle/vscode-tunnel-start` to the control-plane socket (identical
  to what the boot-resume / UI Restart does) spawned `code tunnel` and it connected using
  the still-valid persisted token — confirming the resume machinery itself is healthy and
  only the wiring is wrong.

## Steps to reproduce

1. Bootstrap a cluster through the wizard (so the relay key lands in
   `/var/lib/generacy/cluster-api-key`, not the process env). Confirm the tunnel connects.
2. `generacy stop <cluster>` then `generacy start <cluster>`.
3. Observe: orchestrator takes the `activateInBackground` branch; no
   `"Boot resume: …"` log; no `code tunnel` process; tunnel never reconnects.

## Proposed fix

Invoke the boot-resume from the `activateInBackground` path as well, after the relay
bridge starts and `checkPostActivationState()` returns — mirroring
`packages/orchestrator/src/server.ts:488-502`.

Preferred: **hoist the shared "check post-activation state → retry (needsRetry) or
resume (activated && postActivationComplete)" logic into one helper** that both the
synchronous existing-key branch and `activateInBackground` call, so the two paths cannot
drift again. Today only the retry half is duplicated into both; the resume half exists in
just one.

## Test-coverage gap (please close in this fix)

#824's validation exercised the `config.relay.apiKey`-present (synchronous) path, not the
`activateInBackground` path that all wizard clusters use — which is why the mis-wiring
shipped. Add a regression test that drives the `activateInBackground` startup path with
`activated && postActivationComplete` state and asserts `BootResumeService.triggerBootResume()`
(or the two `/lifecycle/*-start` POSTs) fires. A test that only covers the env-key branch
will pass while the real path stays broken.

## Scope

`generacy` repo only — `packages/orchestrator/src/server.ts` (+ a shared helper) and the
new regression test. No control-plane or cross-repo changes; `BootResumeService` itself is
correct and unchanged.

## Related

- #824 (original fix — incomplete), PR #832, commit `b3bad08`.
- #825 (companion device-code-timeout / restart hardening).


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
