# Feature Specification: VS Code Desktop tunnel hangs on "Starting tunnel…" — device-code auth event dropped/never surfaced

**Branch**: `966-summary-freshly-deployed` | **Date**: 2026-07-16 | **Status**: Draft

## Summary

On a freshly deployed cluster (preview channel), clicking **"Connect with VS Code Desktop"** in the cloud dashboard hangs forever on "Starting tunnel…". The `code tunnel` process starts and enters GitHub device-code authentication, but the device code is never surfaced to the user, so the tunnel can never be authorized and never registers with the VS Code tunnel relay.

## Impact

VS Code Desktop connect is unusable on any cluster where the device-code authorization event does not reach the UI — the user is left with an indefinite spinner and no device code to act on. There is no timeout, so it never resolves to an error either.

## Root cause

The tunnel manager (`packages/control-plane/src/services/vscode-tunnel-manager.ts::start()`) spawns:

```
code tunnel --accept-server-license-terms --name g-<clusterid>
```

with **no non-interactive access token**. `code tunnel` therefore requires interactive GitHub device-code auth. Verified live — the CLI prints exactly:

```
info Using GitHub for authentication, run `code tunnel user login --provider <provider>` option to change this.
To grant access to the server, please log into https://github.com/login/device and use code 5675-C13F
```

The manager parses this and is expected to emit an `authorization_pending` event (carrying `{ userCode, verificationUri }`) so the cloud UI can show the user the code to enter. That event is **not reaching the UI**, so the flow stalls.

Runtime evidence from the live cluster:
- The `code tunnel` process is alive and holds an established TCP connection to a **GitHub IP** (`140.82.114.3:443`, the device-auth endpoint) but **no** connection to the VS Code tunnel relay (`global.rel.tunnels.api.visualstudio.com`). Classic "stuck in device-code auth, never registered" signature.
- No access token exists on disk (`~/.vscode/cli` contains only the tunnel lock file); auth depends entirely on surfacing the device code.
- The process has been auth-pending for 10+ minutes, so the manager's device-code timeout (which should emit an `error` and kill the child) is **not firing** in this run either.

Why the event doesn't surface — the status-relay path is fire-and-forget and gated on the orchestrator relay being `connected`:

```ts
// packages/orchestrator/src/routes/internal-relay-events.ts:43-50
if (client.isConnected) {
  client.send({ type: 'event', event, data, timestamp });
}
return reply.status(204).send();   // dropped silently when !isConnected — no buffer, no replay
```

The tunnel auto-starts at `bootstrap-complete` (`packages/control-plane/src/routes/lifecycle.ts`), which on this cluster happened **before** the orchestrator relay reached `connected` (logs show `[relay] Cannot send message: not connected` during the first boot cycle, relay only became `connected` afterward). The `authorization_pending` event emitted during that window is dropped on the floor. When the user then clicks "Connect with VS Code Desktop", `start()` (reworked in #831, commit `aef8f58a`) takes the early-return branch for an already-running child and only **re-emits the cached** event — and the manager never emits a fresh `starting`, so recovery depends on a status event that may already have been lost.

Cloud side is a correct-but-unforgiving consumer: `use-vscode-tunnel.ts` sets local state to `'starting'` and then waits indefinitely for a `cluster:vscode-tunnel` SSE event with **no timeout**, so a single dropped event = permanent spinner.

## Proposed fix (generacy / cluster side)

The reliable-delivery gap is the core bug. Options, roughly in order of preference:
1. **Don't drop tunnel status events on a disconnected relay** — buffer the latest tunnel status (at minimum `authorization_pending` and terminal states) in the orchestrator and replay it to the cloud on relay (re)connect, instead of the `if (client.isConnected)` silent drop at `internal-relay-events.ts:43`. The relay bridge already re-sends metadata on reconnect; tunnel status should ride the same reconnect path.
2. **Don't auto-start the tunnel before the relay is `connected`** — gate the `bootstrap-complete` tunnel auto-start on relay-connected, or (re)emit a fresh `authorization_pending`/`starting` when a user explicitly triggers `vscode-tunnel-start`, so the user click always produces a deliverable event.
3. **Make the device-code timeout actually fire** — the child has been auth-pending far past `DEFAULT_DEVICE_CODE_TIMEOUT_MS` without emitting `error` or being killed; the #831 timeout/kill path is not triggering and should be fixed so a stuck tunnel surfaces an error rather than hanging.

## Follow-up (generacy-cloud, out of scope for this issue)

Add a client-side timeout / Firestore `vscodeTunnelStatus` fallback in `use-vscode-tunnel.ts` so a lost SSE event degrades to an actionable error instead of an infinite "Starting tunnel…" spinner. Track separately per one-issue-per-repo convention.

## Environment

- Release channel: **preview** (`ghcr.io/generacy-ai/cluster-base:preview`, orchestrator `0.0.0-preview-20260716184512-4c1ff4d`, code-server 4.96.4)
- Local cluster deployed from staging (`app-staging.generacy.ai`), project `snappoll`.

---

## User Stories

### US1: Device-code prompt reliably reaches the UI (P1)

**As a** developer on a freshly deployed cluster,
**I want** clicking "Connect with VS Code Desktop" to show me the GitHub device code and verification URL,
**So that** I can authorize the tunnel and finish connecting VS Code Desktop instead of watching an indefinite spinner.

**Acceptance Criteria**:
- [ ] On a fresh cluster where the orchestrator relay was disconnected at `bootstrap-complete` (the current preview default), clicking "Connect with VS Code Desktop" surfaces the device code + `github.com/login/device` URL in the cloud UI within one relay reconnect cycle.
- [ ] Completing the device-code flow transitions the tunnel to `connected` and registers with the VS Code tunnel relay (an outbound TCP connection to `global.rel.tunnels.api.visualstudio.com` becomes visible).
- [ ] The flow works without the user restarting the cluster or manually re-triggering `vscode-tunnel-start`.

### US2: Tunnel status survives a relay disconnect (P1)

**As a** cluster operator,
**I want** tunnel status events emitted while the orchestrator relay is momentarily disconnected to reach the cloud after reconnect,
**So that** a single dropped event does not permanently strand the tunnel in `starting`.

**Acceptance Criteria**:
- [ ] The latest tunnel-status event of a "user-actionable" class (at minimum `authorization_pending`, and terminal `connected` / `disconnected` / `error`) is retained in the orchestrator when the relay is not `connected` and replayed on reconnect.
- [ ] `starting` transitions (transient) do not need to be replayed; only the latest actionable status per tunnel matters.
- [ ] The reconnect replay rides the same code path that already re-sends metadata on reconnect (no separate reconnect handler).

### US3: User-triggered start always yields a deliverable event (P1)

**As a** developer clicking "Connect with VS Code Desktop",
**I want** the click to always produce a fresh, deliverable status event,
**So that** a lost prior event during boot can never cause the UI to hang on a click that "did nothing".

**Acceptance Criteria**:
- [ ] `POST /lifecycle/vscode-tunnel-start` invoked while a child process is already running re-emits the current tunnel status (or a fresh `starting`) as a new event, rather than returning silently.
- [ ] The re-emitted event reaches the cloud UI (via replay per US2 if the relay is momentarily disconnected).

### US4: Stuck device-code auth surfaces a terminal error (P2)

**As a** developer,
**I want** a tunnel that stays in `authorization_pending` past the device-code timeout to fail with a visible error,
**So that** I see an actionable failure instead of an infinite spinner and can retry.

**Acceptance Criteria**:
- [ ] A tunnel that remains in `authorization_pending` past `DEFAULT_DEVICE_CODE_TIMEOUT_MS` emits a terminal `error` status event and tears down the child process.
- [ ] The error event is delivered to the cloud UI (subject to US2 replay if relay is disconnected).
- [ ] Subsequent user clicks on "Connect with VS Code Desktop" spawn a fresh `code tunnel` child and restart the flow cleanly.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The orchestrator MUST retain the latest actionable tunnel-status event (at minimum `authorization_pending`, `connected`, `disconnected`, `error`) per tunnel when the relay is not `connected`, and replay it once the relay transitions to `connected`. | P1 | Fixes the silent drop at `internal-relay-events.ts:43`. Transient `starting` need not be replayed. |
| FR-002 | The reconnect replay MUST ride the same reconnect code path that already re-sends metadata (relay bridge), not a bespoke reconnect handler. | P1 | Consistency and single source of truth for reconnect behaviour. |
| FR-003 | `POST /lifecycle/vscode-tunnel-start` invoked while a `code tunnel` child process already exists MUST re-emit a fresh, deliverable status event (either the currently-cached actionable status or a fresh `starting` prompting the manager to re-emit its cached device-code state), rather than early-returning without emitting. | P1 | The #831 early-return branch is currently unforgiving of any prior dropped event. |
| FR-004 | `VsCodeTunnelProcessManager` MUST enforce `DEFAULT_DEVICE_CODE_TIMEOUT_MS` — if the child stays in `authorization_pending` past the timeout, emit a terminal `error` status event AND kill the child (SIGTERM → SIGKILL fallback). | P2 | The #831 timeout path currently does not fire in practice. |
| FR-005 | Buffer scope MUST be limited to at most one retained event per tunnel per event-class (latest wins). No unbounded queue, no replay of stale transient status. | P1 | Avoids accidental buffer growth on long disconnects. |
| FR-006 | The retained-event mechanism MUST NOT apply to `cluster.audit` or `cluster.credentials` channels — those channels have their own delivery semantics (batching, receipt) and MUST retain the current fire-and-forget behaviour when the relay is disconnected. | P1 | Scope containment: this issue is about `cluster.vscode-tunnel` reliability, not a general reliable-delivery layer. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Time from user click on "Connect with VS Code Desktop" to device-code prompt visible in UI on a fresh cluster (relay disconnected at `bootstrap-complete`) | < 30 seconds median across 10 fresh-cluster runs | Manual repro on preview channel; instrument the relay reconnect + replay path. |
| SC-002 | Fraction of `authorization_pending` events surfaced to the UI when emitted during a `!isConnected` window | 100% (currently 0%) | Integration test: force relay `disconnected`, emit `authorization_pending`, transition relay to `connected`, assert event received. |
| SC-003 | Fraction of user-triggered `vscode-tunnel-start` requests that yield a deliverable event when a child process is already running | 100% (currently 0% for lost prior events) | Integration test: spawn tunnel, drop the first `authorization_pending`, POST `/lifecycle/vscode-tunnel-start`, assert a deliverable event is emitted. |
| SC-004 | Fraction of tunnels stuck in `authorization_pending` past `DEFAULT_DEVICE_CODE_TIMEOUT_MS` that emit a terminal `error` and tear down the child | 100% (currently 0% observed) | Integration test with mocked device-code auth that never completes; assert `error` event within timeout + kill-grace window. |
| SC-005 | Regression: no additional relay-message traffic on healthy clusters (relay stays `connected` throughout boot) | Retained-event mechanism sends 0 extra messages on the happy path | Compare relay message count on a healthy-boot cluster before/after the change. |

## Assumptions

- The relay bridge's existing metadata re-send-on-reconnect path is a suitable hook for tunnel-status replay (per Proposed fix #1). If it is not, FR-002 permits a sibling handler on the same reconnect trigger, but no new reconnect signal is introduced.
- The manager already caches device-code state internally (per #831 rework at commit `aef8f58a`); FR-003 relies on that cache being present. If it is not, FR-003 additionally requires introducing that cache.
- `DEFAULT_DEVICE_CODE_TIMEOUT_MS` is defined in `vscode-tunnel-manager.ts` today (per #831). If it is not, FR-004 additionally requires introducing it.
- The cloud-side infinite-spinner behaviour (`use-vscode-tunnel.ts` no timeout) is tracked as a separate generacy-cloud issue per the "one-issue-per-repo" convention. This spec is cluster-side only.
- No changes to the `code tunnel` invocation itself (still no non-interactive access token; still device-code auth) — introducing a non-interactive token is a separate design decision, out of scope.

## Out of Scope

- Cloud-side (`use-vscode-tunnel.ts`) client-side timeout / Firestore `vscodeTunnelStatus` fallback. Tracked separately in generacy-cloud.
- Introducing a non-interactive access token for `code tunnel` (would eliminate device-code auth entirely, but is a different design).
- Extending the retained-event / replay mechanism to any channel other than `cluster.vscode-tunnel` (audit and credentials keep their existing semantics; see FR-006).
- Rewriting the tunnel manager's `start()` beyond what FR-003 requires; the #831 architecture stays.
- Any UX changes to the "Connect with VS Code Desktop" button or the "Starting tunnel…" copy.

---

*Generated by speckit*
