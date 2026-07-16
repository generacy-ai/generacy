# Feature Specification: ## Summary

On a freshly deployed cluster (preview channel), clicking **"Connect with VS Code Desktop"** in the cloud dashboard hangs forever on "Starting tunnel…"

**Branch**: `966-summary-freshly-deployed` | **Date**: 2026-07-16 | **Status**: Draft

## Summary

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

## Acceptance criteria

- On a fresh cluster, clicking "Connect with VS Code Desktop" surfaces the GitHub device-code prompt (code + `github.com/login/device` URL) in the UI, and completing it connects the tunnel.
- A tunnel status event emitted while the orchestrator relay is momentarily disconnected is delivered to the cloud once the relay reconnects (buffered/replayed, not dropped).
- A user-triggered `vscode-tunnel-start` always yields a deliverable status event even when a child process already exists.
- A tunnel that stays in `authorization_pending` past the device-code timeout emits a terminal `error` event (and is torn down), rather than hanging indefinitely.

## Environment

- Release channel: **preview** (`ghcr.io/generacy-ai/cluster-base:preview`, orchestrator `0.0.0-preview-20260716184512-4c1ff4d`, code-server 4.96.4)
- Local cluster deployed from staging (`app-staging.generacy.ai`), project `snappoll`.


## User Stories

### US1: See the device code after clicking "Connect with VS Code Desktop"

**As a** developer using a freshly deployed cluster,
**I want** the GitHub device code and `github.com/login/device` URL to appear in the cloud dashboard after I click "Connect with VS Code Desktop",
**So that** I can complete the GitHub authorization and use the VS Code Desktop tunnel.

**Acceptance Criteria**:
- [ ] On a fresh cluster, the click surfaces the GitHub device-code prompt (code + URL) in the UI.
- [ ] Completing the device-code flow transitions the UI to a connected tunnel state.
- [ ] The flow works even when tunnel auto-start at `bootstrap-complete` races the orchestrator relay's initial `connected` transition.

### US2: Never miss a tunnel state transition across a relay reconnect

**As a** cloud UI consumer of `cluster.vscode-tunnel` events,
**I want** the latest actionable status per tunnel to be delivered once the orchestrator relay reconnects,
**So that** a momentary relay disconnect does not leave me stuck on a stale `starting` spinner or showing a stale device code for an already-authorized tunnel.

**Acceptance Criteria**:
- [ ] Only the latest actionable status per tunnel matters — a stale intermediate state is not required for correctness.
- [ ] A terminal state (`connected` / `disconnected` / `error`) that fires during a `!isConnected` window overwrites any earlier retained `authorization_pending` and is what the UI sees on reconnect.
- [ ] Among retained terminals, the latest wins.

## Functional Requirements

| ID     | Requirement | Priority | Notes |
|--------|-------------|----------|-------|
| FR-001 | The orchestrator MUST retain the latest actionable `cluster.vscode-tunnel` event per tunnel when the relay is not `connected`, and MUST replay the retained event to the cloud on relay (re)connect instead of dropping it silently at the `/internal/relay-events` handler. Retained statuses: `authorization_pending`, `connected`, `disconnected`, `error`. | P0 | Fixes the primary bug: fire-and-forget drop at `packages/orchestrator/src/routes/internal-relay-events.ts:43` when `!client.isConnected`. |
| FR-002 | The retained-event replay MUST ride the existing relay reconnect code path (`RelayBridge.handleConnected` at `packages/orchestrator/src/services/relay-bridge.ts:197`, which already re-sends metadata). No new inter-process reconnect signal (e.g., a `POST /lifecycle/relay-reconnect` back into control-plane) is introduced. | P0 | Q1 → A: retained event lives as a module-level singleton in the orchestrator (`retained-events.ts` / `internal-relay-events.ts`) with `get`/`set` accessors imported by both writer and reader, mirroring the existing `getRelayPushEvent`/`setRelayPushEvent` idiom. |
| FR-003 | A user-triggered `POST /lifecycle/vscode-tunnel-start` MUST always produce a fresh, deliverable status event. Specifically, when the child process is alive and `status === "starting"` with no device code parsed yet, `start()` MUST emit a fresh `starting` event and return (keep the child), instead of early-returning silently. | P0 | Q5 → A: emit fresh `starting`, do not kill+respawn. The `starting`-with-live-child branch is today's click-into-silence gap in `packages/control-plane/src/services/vscode-tunnel-manager.ts:143-163`. |
| FR-004 | A tunnel that stays in `authorization_pending` past a bounded timeout MUST emit a terminal `error` event and tear down the child, rather than hanging indefinitely. The system MUST enforce this as a separate `DEFAULT_DEVICE_CODE_AUTH_TIMEOUT_MS` (~300 s / 5 min) armed on transition to `authorization_pending`. The existing 30 s starting-phase timer is retained for the "spawned but never printed a code" broken-CLI case. | P0 | Q4 → C: two distinct constants. Rationale — 30 s is too short for a human to open a browser and type an 8-char device code; 5 min is well under GitHub's ~15 min device-code validity. Live hang was 10+ min in `authorization_pending` after the starting-phase timer had already been cleared at `vscode-tunnel-manager.ts:392`. |
| FR-005 | The retained-event buffer MUST hold at most one event per tunnel (single slot) with terminal preference: a `connected` / `disconnected` / `error` event MUST overwrite an earlier `authorization_pending`, and among terminal states the latest wins. A late/re-emitted `authorization_pending` MUST NOT clobber a retained terminal. | P0 | Q3 → C: single-slot with explicit terminal-beats-pending precedence. Rules out multi-slot audit-trail semantics (option B) so the UI never sees a device code for an already-authorized tunnel. |
| FR-006 | Retention MUST distinguish child-lifecycle `error` events from administrative `error` events. Only child-lifecycle `error` events (spawn failure, exit-before-connected, device-code timeout) are retained; `error` emitted from `unregister()` cleanup (`vscode-tunnel-manager.ts:326-378`) and the `actualTunnelName !== opts.tunnelName` name-collision observational emit at `vscode-tunnel-manager.ts:434` MUST NOT be retained. | P1 | Q2 → B. Rationale — replaying an `unregister()` cleanup error or a name-collision observational error after reconnect could spuriously error a tunnel that is actually `connected`. |

## Success Criteria

| ID     | Metric | Target | Measurement |
|--------|--------|--------|-------------|
| SC-001 | Fresh-cluster success rate for "Connect with VS Code Desktop" reaching the device-code prompt in the UI | 100 % across 10 consecutive fresh-cluster boots (preview channel) | Manual repro on 10 freshly deployed preview clusters after fix ships. |
| SC-002 | `cluster.vscode-tunnel` retained-event delivery across relay reconnect | 100 % of retained actionable statuses delivered to the cloud within one reconnect cycle | Integration test: emit `authorization_pending` while relay is `!isConnected`, force reconnect, assert cloud receives it exactly once. |
| SC-003 | Bounded `authorization_pending` phase duration | An `authorization_pending` state MUST terminate (either transition to `connected` / `disconnected` or emit `error` and tear down) within `DEFAULT_DEVICE_CODE_AUTH_TIMEOUT_MS` (300 s) | Integration test: spawn a stub `code tunnel` that stays in `authorization_pending` beyond the timeout; assert `error` event and child SIGTERM within the window. |
| SC-004 | Fresh-emit on user re-trigger with live `starting` child | 100 % of `POST /lifecycle/vscode-tunnel-start` calls emit at least one deliverable status event | Unit test on `VsCodeTunnelProcessManager.start()`: with `status === 'starting'` and `deviceCode == null`, calling `start()` fires exactly one `starting` event and does not spawn a new child. |
| SC-005 | No spurious `error` from `unregister()` after reconnect | 0 replayed `error` events sourced from `unregister()` or name-collision observational emit paths | Unit test on the retention layer: emit an `unregister()` `error`, then reconnect; assert no replay. |

## Assumptions

- The orchestrator and control-plane remain in separate processes; the retained-event buffer lives in the orchestrator, which is where the drop (writer) and reconnect (reader) code paths both run.
- `RelayBridge.handleConnected` remains the sole code path invoked on relay reconnect, i.e., the metadata re-send already happens there and the retained tunnel event can ride the same trigger.
- The `code tunnel` CLI prints the device code on stdout in the format matched today by the parser at `packages/control-plane/src/services/vscode-tunnel-manager.ts` (regex `/[A-Z0-9]{4}-[A-Z0-9]{4}/`). No CLI-format regression is in scope.
- Only one `code tunnel` child process is expected per cluster at any moment. Multi-tenant retention (per-clusterId keying) is not required.
- Cloud-side consumers (`use-vscode-tunnel.ts`) will accept a replayed `cluster.vscode-tunnel` event without additional cluster-side signaling — no new SSE frame type or discriminator field is added.
- GitHub device codes remain valid ~15 min, well above the ~5 min `DEFAULT_DEVICE_CODE_AUTH_TIMEOUT_MS`.

## Out of Scope

- Cloud-side (`generacy-cloud`) UI/timeout work in `use-vscode-tunnel.ts` — the client-side timeout / Firestore `vscodeTunnelStatus` fallback is tracked as a separate issue per one-issue-per-repo convention.
- A general-purpose retained/replay layer for other `cluster.*` event channels beyond `cluster.vscode-tunnel`.
- Persisting the retained event across orchestrator process restarts (in-memory only; a restart resets the buffer, which is acceptable because the child process is also gone after restart).
- Multi-tenant per-clusterId keying of the retained-event buffer (single-tunnel assumption above).
- Changes to the `code tunnel` device-code CLI parser or CLI flags.
- Making `bootstrap-complete` gate the tunnel auto-start on relay-connected (option 2 in the issue body) — the reliable-delivery approach (FR-001/FR-002) subsumes it.

---

*Generated by speckit*
