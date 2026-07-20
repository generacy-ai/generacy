# Research: Post-activation-settled readiness gating

## Prior art in this repo (directly reused pattern)

### `codeServerReady` (#586, #596)

The exact shape we mirror. Trace:

- `packages/orchestrator/src/services/code-server-probe.ts` — pure async probe returning `Promise<boolean>` via `net.connect()` with 500ms timeout.
- `packages/orchestrator/src/routes/health.ts:139-142` — `Promise.all([probeCodeServerSocket(), probeControlPlaneSocket()])` writes the bit into `HealthResponse`.
- `packages/orchestrator/src/services/relay-bridge.ts:706-720` — `collectMetadata()` does the same two probes and writes both onto `ClusterMetadataPayload`.
- `packages/cluster-relay/src/metadata.ts` — parallel `HealthData` + `ClusterMetadata` extraction on the client that synthesises metadata from `/health` when the orchestrator itself isn't the sender.
- #596 fixed a bug where a stale singleton returned `false` even after code-server was up; the resolution was to use a live `net.connect()` probe against the socket rather than an in-process singleton. Analogous risk here: we must NOT cache the settled-bit result across the process lifetime — the marker can appear at any time. Using `fs.existsSync` synchronously per call is the direct analog.

**Decision**: Mirror `codeServerReady` exactly. `postActivationReady` is a synchronous `fs.existsSync` check per `/health` and per `collectMetadata()`. No caching.

**Alternative considered**: A single readiness struct on the orchestrator that all three bits derive from. **Rejected** — adds a new abstraction on top of a working parallel pattern for one more field. Uniformity across the three bits is more valuable than DRY.

### Push-latency via `sendMetadata()` (from #586 / #596)

For `codeServerReady`, immediate propagation on false→true was needed to avoid users waiting up to 60s (the metadata heartbeat) after code-server came up before the "Open IDE" button enabled. The implementation used `CodeServerManager.onStatusChange` to trigger `RelayBridge.sendMetadata()`.

For `postActivationReady`, the analogous trigger is "the marker file appearing." There's no in-process manager whose events we can listen to — the file is written by an external process (`entrypoint-post-activation.sh` in the cluster image). The only in-process signal is the filesystem itself.

**Decision**: One-shot `fs.watch` on `dirname('/var/lib/generacy')` at orchestrator boot, filtered by basename `post-activation-restart-done`. Callback invokes `relayBridge.sendMetadata()` and stops watching. Skipped entirely if the marker already exists at boot.

**Alternatives considered**:
- `fs.watch(markerPath)` directly. **Rejected** — watching a non-existent file is unreliable across platforms; watching the directory is the standard pattern.
- Polling `existsSync` every 1s. **Rejected** — spins CPU during the entire pre-settled window (~30-60s) for a one-shot transition; `fs.watch` is event-driven and cheaper.
- Waiting for the 60s heartbeat (Q2/B). **Explicitly rejected in clarifications** — leaves the tunnel button dead for up to a minute after settle, which is precisely the first-connect flow this bug is about.

## Prior art for gated lifecycle actions (defer / skip semantics)

### The `hasGitHubToken` gate in `bootstrap-complete` (existing code)

`packages/control-plane/src/routes/lifecycle.ts:189-214` already contains a precedent for skipping a subset of `bootstrap-complete` sub-actions based on a runtime condition: when `!hasGitHubToken`, the handler emits a `cluster.bootstrap` relay event with `{ status: 'awaiting-credentials', reason: 'github-token-not-sealed' }` and skips the sentinel write + code-server start + tunnel start. Response body still 200 OK with `sentinel: null` to signal "we handled the request but did not fire the downstream trigger."

**Decision**: Match this shape for the settled gate. Skipping step (d) inside `bootstrap-complete` returns 200 with the same envelope as today (no schema change); the log line and relay event fully cover observability. The user-initiated `POST /lifecycle/vscode-tunnel-start` skip returns a structured `{ accepted: false, reason, message }` body since it has no other side channel (unlike `bootstrap-complete`, it's a direct user action from the UI).

**Alternative considered**: Return 409 CONFLICT for `vscode-tunnel-start` skip. **Rejected in Q4/A rationale** — the `ControlPlaneError` enum has no CONFLICT variant; introducing one is more invasive than the response-body approach and would require both cloud + client changes to interpret. A 200 with `accepted: false` is idiomatic for control-plane and consistent with `hasGitHubToken`-branch behavior.

## Filesystem marker vs. IPC signal

The marker file is written by a bash script (`entrypoint-post-activation.sh`) in a separate container from the orchestrator, so IPC is not an option — the marker must be observable via the shared `generacy-data` volume mount. This is the same volume that already carries `cluster-api-key`, `post-activation-complete`, `wizard-credentials.env`, and `master.key`, all of which are read by orchestrator/control-plane code today via `existsSync` / `readFileSync`. The pattern is native.

## Fallback predicate correctness

Batch 1 / Q1 initially proposed `restart-done present OR post-activation-complete absent` as the settled predicate. Batch 2 correction identified this as wrong: on a fresh wizard cluster at `bootstrap-complete` time, `post-activation-complete` is ALSO absent (the post-activation hook writes it later, just before restart). So the predicate would evaluate to `settled = true` exactly when the gate is most needed.

The corrected discriminator is `activated`, computed as `existsSync('/var/lib/generacy/cluster-api-key')`, matching `PostActivationRetryService.checkPostActivationState()`. Truth table:

| Scenario | `activated` | `marker` | `postActivationReady` |
|---|---|---|---|
| Local `generacy launch` cluster | false | false | **true** (no restart ever coming) |
| Wizard cluster, pre-restart | true | false | **false** (gate active) |
| Wizard cluster, post-restart | true | true | **true** (safe to start tunnel) |
| Local cluster somehow with marker | false | true | true (harmless) |

**Sources**:
- `PostActivationRetryService.checkPostActivationState()` — `packages/orchestrator/src/services/post-activation-retry.ts:69-91`.
- `runPostActivationBranch` decision matrix — `packages/orchestrator/src/services/post-activation-dispatch.ts:31-59`.

## Non-persistence of pre-restart tunnel-start requests

Q7 pinned the recovery model: rely on the fresh orchestrator's existing `BootResumeService` + `setRetainedTunnelEvent` machinery.

`BootResumeService.triggerBootResume()` (`packages/orchestrator/src/services/boot-resume-service.ts:30-52`) already dispatches both `vscode-tunnel-start` and `code-server-start` unconditionally once `activated && postActivationComplete` hold — both true post-restart. Snappoll orchestrator logs confirm this fires ~4s after the self-restart (spec Q6 answer).

`setRetainedTunnelEvent` (`packages/orchestrator/src/routes/retained-tunnel-event.ts:52-67`) retains one tunnel event with special handling: an `authorization_pending` event is retained until superseded by another `authorization_pending` (device code refresh) or a terminal event (`connected`/`disconnected`/`error`). This is exactly what a modal reopen needs — the current device code is replayed to the user on tunnel-modal open.

**Decision**: No new persistence. Reuse `BootResumeService` + `setRetainedTunnelEvent`.

**Rejected alternatives**:
- Q7/B — cross-restart persistence via a `pending-vscode-tunnel-start` marker. Adds a persistence surface with lifecycle questions (clear on start success? on user cancel? staleness bound?) for zero benefit over `BootResumeService`'s existing unconditional post-restart dispatch.
- Q7/D — grace-window fire (wait N seconds after marker appears before firing). Timing hack that reintroduces a race between the grace timer and the SIGTERM.
- Q7/C — explicit `cluster.vscode-tunnel: { status: 'lost', reason: 'orchestrator-restarted' }` observability event. Reasonable optional follow-up but not required to close this bug; noted in spec §Out of Scope.

## References

- Spec: `specs/1009-summary-freshly-activated/spec.md`
- Clarifications: `specs/1009-summary-freshly-activated/clarifications.md` (Batch 1 + Batch 2)
- Prior art PRs: #586, #588, #596 (`codeServerReady` propagation); #624 (`controlPlaneReady` + init-result); #824, #834 (`BootResumeService` + wizard-branch wiring); #937 (post-activation retry `GH_TOKEN` sealing).
- Files:
  - `packages/orchestrator/src/services/code-server-probe.ts`
  - `packages/orchestrator/src/services/control-plane-probe.ts`
  - `packages/orchestrator/src/services/post-activation-retry.ts`
  - `packages/orchestrator/src/services/boot-resume-service.ts`
  - `packages/orchestrator/src/services/post-activation-dispatch.ts`
  - `packages/orchestrator/src/routes/retained-tunnel-event.ts`
  - `packages/orchestrator/src/routes/health.ts`
  - `packages/orchestrator/src/services/relay-bridge.ts`
  - `packages/orchestrator/src/types/api.ts`, `types/relay.ts`
  - `packages/control-plane/src/routes/lifecycle.ts`
  - `packages/cluster-relay/src/metadata.ts`, `messages.ts`
  - `packages/generacy/src/cli/commands/cluster/scaffolder.ts` (compose volume mount)
