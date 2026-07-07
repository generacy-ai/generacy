# Feature Specification: ## Summary

After a cluster is stopped and started (`generacy stop` → `generacy start`, or any
container restart), the VS Code Desktop tunnel (`code tunnel` → vscode

**Branch**: `824-summary-after-cluster-stopped` | **Date**: 2026-07-07 | **Status**: Draft

## Summary

## Summary

After a cluster is stopped and started (`generacy stop` → `generacy start`, or any
container restart), the VS Code Desktop tunnel (`code tunnel` → vscode.dev) never
comes back. `generacy stop` explicitly stops the tunnel, but **nothing restarts it on
the next boot**, so the project page shows the tunnel disconnected and
`https://vscode.dev/tunnel/<name>` stops resolving.

Reproduced on a live local cluster (`sniplink`): after a restart there was no
`code tunnel` process running, and nothing in the boot path started one.

## Root cause

The VS Code tunnel is auto-started in exactly **one** place — the control-plane
`bootstrap-complete` lifecycle handler:

- `packages/control-plane/src/routes/lifecycle.ts` — the `bootstrap-complete` branch
  calls `getVsCodeTunnelManager().start()` (and `code-server` start).

On the orchestrator, `bootstrap-complete` is only *replayed* at startup when
post-activation is considered incomplete:

- `packages/orchestrator/src/services/post-activation-retry.ts` — `checkPostActivationState()`:

  ```ts
  needsRetry = activated && !postActivationComplete
  ```

- `packages/orchestrator/src/server.ts` (~L481) only calls
  `triggerPostActivationRetry()` (which POSTs `bootstrap-complete`) when
  `needsRetry` is true.

`postActivationComplete` is the existence of
`/var/lib/generacy/post-activation-complete`, which lives on the **persistent**
`generacy-data` volume and is written once on the first successful activation. So on
every subsequent restart:

- `cluster-api-key` present → `activated = true`
- `post-activation-complete` present → `postActivationComplete = true`
- ⇒ `needsRetry = false` → `bootstrap-complete` is never replayed → the tunnel (and
  code-server) are never started.

Meanwhile `generacy stop` explicitly stops the tunnel:

- `packages/generacy/src/cli/commands/stop/index.ts` → `lifecycleAction(ctx, 'vscode-tunnel-stop')`.

And `entrypoint-post-activation.sh` — which *does* re-run on restart (its sentinel
survives on the container writable layer) — does not start the tunnel.

Net: **stop kills the tunnel, start never revives it.**

## Evidence (cluster `sniplink`, cluster id `12ba9254-…`)

- After restart (orchestrator container `StartedAt` 16:11): **no `code tunnel` process**.
- `/var/lib/generacy/cluster-api-key` present; `/var/lib/generacy/post-activation-complete`
  present ⇒ `needsRetry = false` ⇒ orchestrator skipped the bootstrap-complete replay.
- Manually invoking `POST /lifecycle/vscode-tunnel-start` on the control-plane socket
  started the tunnel and it **connected immediately** using the persisted token in
  `/home/node/.vscode/cli` (a dedicated persistent volume). So the machinery is
  healthy — nothing calls it on restart.

## Steps to reproduce

1. Bootstrap a cluster through the wizard; confirm the VS Code tunnel connects.
2. `generacy stop <cluster>` then `generacy start <cluster>` (or restart the
   orchestrator container).
3. Observe: no `code tunnel` process in the orchestrator; tunnel shows disconnected in
   the cloud project page and never reconnects on its own.

## Proposed fix

At orchestrator startup, when the cluster is already activated, **ensure services are
running independent of the one-shot post-activation retry**.

**Design (per clarifications):** orchestrator-side boot resume as a sibling of
`PostActivationRetryService`, in the `needsRetry === false && activated &&
postActivationComplete` branch of `server.ts`, wired *after* `initializeRelayBridge()`
so relay event ordering matches first-boot.

- Fire two independent, best-effort lifecycle POSTs to the control-plane socket:
  `POST /lifecycle/vscode-tunnel-start` and `POST /lifecycle/code-server-start`.
  Failure in one does not prevent the other; both run to completion.
- Single-shot envelope, mirroring `PostActivationRetryService`: 15 s
  `probeControlPlaneSocket` wait + 1 POST attempt with 10 s request timeout. No
  retry loop; UI Restart is the manual backstop.
- On POST failure (socket unreachable / 5xx), emit `cluster.bootstrap { status:
  'failed', reason: 'resume-failed', service: 'vscode-tunnel' | 'code-server',
  error }` — reuses the same channel as the sibling retry so operators watch one
  place. Per-service events (`cluster.vscode-tunnel`, `codeServerReady` in
  metadata) remain as-is for post-POST child-process failures.
- Control-plane is untouched: it stays a pure executor of lifecycle actions. Both
  managers (`VsCodeTunnelProcessManager.start()`, code-server) are already
  idempotent, so this is safe even if a future path also triggers a start.

## Related

- Companion bug: device-code timeout orphans the tunnel child so the UI **Restart**
  button can silently no-op (filed separately).
- Prior art: **#652** (restart didn't retry *failed* post-activation) fixed the
  `needsRetry = true` path; this issue is the opposite gap — when post-activation
  *succeeded*, services are not resumed. **#604** (device-code race).

## Scope

`generacy` repo only — `packages/orchestrator` (boot-time service resume) and possibly
`packages/control-plane` (self-start on boot). No cross-repo changes required.


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
