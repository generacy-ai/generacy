# Implementation Plan: Gate VS Code tunnel on post-activation restart settling

**Feature**: On freshly activated wizard clusters, gate `vscode-tunnel-start` (both user-initiated and `bootstrap-complete` auto-start) on the post-activation self-restart having completed, so a tunnel started pre-restart is not SIGTERM'd mid-device-auth and its token is not silently lost.
**Branch**: `1009-summary-freshly-activated`
**Status**: Complete

## Summary

Add a `postActivationReady: boolean` bit on `/health` and `ClusterMetadataPayload`, computed as
`(NOT activated) OR (post-activation-restart-done marker present)`. Push it to the cloud immediately on `false → true` transition via `sendMetadata()` (mirrors `codeServerReady` / `controlPlaneReady`). Skip the tunnel start on both the `bootstrap-complete` handler and the `POST /lifecycle/vscode-tunnel-start` handler when the bit is `false`. Rely on the existing `BootResumeService` + `setRetainedTunnelEvent` machinery for post-settle auto-recovery. No cluster-image changes; no cross-restart persistence; no in-process `fs.watch` deferral (explicitly rejected in Q7).

Behavioral change surface is small and additive:

| Path | Pre-fix | Post-fix |
|---|---|---|
| `POST /lifecycle/bootstrap-complete` on wizard cluster | Fires steps (a)(b)(c)(d) — (d) start tunnel racing self-restart | Fires (a)(b)(c), skips (d) with log line; `BootResumeService` starts tunnel post-restart |
| `POST /lifecycle/vscode-tunnel-start` on wizard cluster pre-restart | Starts tunnel, initiates device-code, dies to SIGTERM | Skips start with clear response body; no watcher, no device-code auth |
| `GET /health` | No `postActivationReady` field | Adds `postActivationReady?: boolean` |
| `ClusterMetadataPayload` on relay | No `postActivationReady` field | Adds `postActivationReady?: boolean` |
| `RelayBridge.sendMetadata()` triggers | Periodic 60s + tunnel/code-server transitions | +1 trigger: marker-appearance one-shot watcher (only armed at boot when marker is absent) |

Non-changes: `PostActivationRetryService`, `BootResumeService`, `setRetainedTunnelEvent`, `runPostActivationBranch`, and the two `wizard-env-writer` call sites in `bootstrap-complete` / `prepare-workspace` are all UNTOUCHED. The `writeFile(sentinel, …)` and `codeServerManager.start()` sequencing in `bootstrap-complete` is preserved (per Q6 spec assumption §7 — those must fire pre-settled, they are what causes the marker to eventually exist).

## Technical Context

- **Language**: TypeScript, `strict` mode, ESM. Node >=22 (matches monorepo baseline).
- **Packages touched**:
  - `packages/orchestrator` — new `PostActivationSettledMonitor`, `probePostActivationSettled` helper, `/health` field, `collectMetadata()` field, marker-watch → `sendMetadata()` wiring.
  - `packages/control-plane` — `bootstrap-complete` handler skips step (d) when not settled; `vscode-tunnel-start` handler skips + responds when not settled. Introduces a settled-predicate helper (mirror of the orchestrator's, but only the `existsSync` half — the control-plane process doesn't need the `activated` fallback because in local/dev containers it too sees `activated=false` via the same key-file check).
  - `packages/cluster-relay` — `ClusterMetadata` and `HealthData` gain `postActivationReady?: boolean`; propagated in `collectMetadata()`.
- **Predicate**: `postActivationReady = (NOT activated) OR (post-activation-restart-done present)`, where `activated = existsSync('/var/lib/generacy/cluster-api-key')` (matches `PostActivationRetryService.checkPostActivationState()`) and marker path = `/var/lib/generacy/post-activation-restart-done` (Q1 answer — written by `entrypoint-post-activation.sh` immediately before `docker restart "$self_container"`).
- **Volume**: The marker lives on the `generacy-data` volume, already mounted at `/var/lib/generacy` in both orchestrator and control-plane containers (see `packages/generacy/src/cli/commands/cluster/scaffolder.ts:159`). No compose change required.
- **Push-latency mirror**: Uses the exact `codeServerReady` post-#586/#596 pattern — `fs.existsSync` on the marker in `/health` and `collectMetadata()`, plus a one-shot `fs.watch` armed at orchestrator boot when the marker is absent, whose callback invokes `RelayBridge.sendMetadata()` (Q2/A).
- **Response contract for skipped tunnel start**: 200 OK with `{ accepted: false, action: 'vscode-tunnel-start', deferred: false, reason: 'post-activation-not-settled', message: 'Cluster is still starting up; retry once postActivationReady is true' }`. No new error code, no new HTTP status; consistent with `ControlPlaneError` enum having no CONFLICT (see clarifications Q4 rationale).
- **No new persistence**: Explicit non-goal per Q7/B. No `/var/lib/generacy/pending-vscode-tunnel-start` marker.
- **No in-process `fs.watch` on the control-plane side for deferral**: Explicit non-goal per Q7 (would either die with the restart or trip inside the sub-second pre-restart window and reproduce #1009 from a new entry point). The `fs.watch` in the orchestrator is only for pushing the readiness bit to the cloud — it never starts the tunnel.

## Constitution Check

No `.specify/memory/constitution.md` present in this repo. N/A.

## Project Structure

New / modified files (all under `packages/`):

```
packages/orchestrator/src/
  services/
    post-activation-settled-probe.ts        [NEW]  Pure sync + async settled predicate, no side effects.
    post-activation-settled-monitor.ts      [NEW]  One-shot fs.watch → sendMetadata() bridge.
  routes/
    health.ts                                [MOD]  Adds postActivationReady to /health response + schema.
  services/
    relay-bridge.ts                          [MOD]  collectMetadata() reads settled bit; server.ts wires monitor into sendMetadata().
  types/
    api.ts                                   [MOD]  HealthResponseSchema gains postActivationReady?: boolean.
    relay.ts                                 [MOD]  ClusterMetadataPayload gains postActivationReady?: boolean.
  server.ts                                  [MOD]  Constructs PostActivationSettledMonitor; wires .onSettled → relayBridge.sendMetadata().

packages/control-plane/src/
  services/
    post-activation-settled.ts              [NEW]  Sync existsSync-based predicate used by both lifecycle handlers.
  routes/
    lifecycle.ts                             [MOD]  bootstrap-complete skips step (d) when !settled; vscode-tunnel-start returns skip response when !settled.

packages/cluster-relay/src/
  metadata.ts                                [MOD]  HealthData + ClusterMetadata gain postActivationReady?: boolean and propagate it.
  messages.ts                                [MOD]  ClusterMetadata schema gains postActivationReady?: boolean.

specs/1009-summary-freshly-activated/
  plan.md                                   [NEW]  This file.
  research.md                                [NEW]
  data-model.md                              [NEW]
  quickstart.md                              [NEW]
  contracts/
    health-response.md                        [NEW]  /health response schema delta.
    cluster-metadata.md                      [NEW]  ClusterMetadataPayload / ClusterMetadata schema delta.
    lifecycle-skip-response.md               [NEW]  Response body shape for the skipped tunnel-start / skipped bootstrap-complete step (d).
```

### File-by-file responsibility

- **`post-activation-settled-probe.ts`** (orchestrator, NEW).
  Exports `isPostActivationSettledSync(paths?)` returning boolean. Default paths from env or hardcoded defaults matching `PostActivationRetryService`. Semantics: `!existsSync(keyFilePath) || existsSync(markerPath)`. Sync-only — matches how `PostActivationRetryService.checkPostActivationState()` uses `existsSync`, and matches how `/health` synchronously composes `codeServerReady` today.

- **`post-activation-settled-monitor.ts`** (orchestrator, NEW).
  Class `PostActivationSettledMonitor` with `start()` / `stop()`. On `start()`:
    1. Compute current predicate. If settled → no-op (no watch needed; readiness is already `true` and won't change).
    2. Else install `fs.watch` on `dirname(markerPath)` (watching the file directly is unreliable across create — the file doesn't exist yet). Filename filter matches basename.
    3. On event whose target basename matches and file now exists, call `onSettled()` callback (once), stop watching.
    4. Idempotent `.start()` and `.stop()`. Safe on non-existent directory (log + no-op).

- **`health.ts`** (orchestrator, MOD).
  Adds `postActivationReady: { type: 'boolean' }` to both the 200 and 503 response schemas. Adds `postActivationReady: isPostActivationSettledSync()` to the response object. No breaking change — existing consumers ignoring the field are unaffected (optional in the Zod schema per parity with `codeServerReady`).

- **`relay-bridge.ts`** (orchestrator, MOD).
  `collectMetadata()` sets `metadata.postActivationReady = isPostActivationSettledSync()` alongside the existing socket probes. No change to trigger cadence beyond wiring an extra `sendMetadata()` call from the settled-monitor's callback.

- **`server.ts`** (orchestrator, MOD).
  After `relayBridge` construction (in both the "existing API key" and wizard/background-activation branches), instantiate `PostActivationSettledMonitor` with `onSettled: () => relayBridge.sendMetadata()`. Register `.stop()` in graceful shutdown. Monitor is a no-op when settled at boot (local clusters, or wizard clusters that reboot after the restart) — no `fs.watch` installed.

- **`api.ts` / `relay.ts`** (orchestrator types, MOD).
  Add `postActivationReady: z.boolean().optional()` to `HealthResponseSchema`; add `postActivationReady?: boolean` to `ClusterMetadataPayload`. Both parallel-construct the existing `codeServerReady` / `controlPlaneReady` shape (Q3/C).

- **`post-activation-settled.ts`** (control-plane, NEW).
  Standalone module `isPostActivationSettledSync()` for control-plane use. Same semantics as the orchestrator version but with control-plane-appropriate defaults. Kept independent (rather than shared package) to avoid a new cross-package dependency for two boolean checks; sync `existsSync` mirrors how `bootstrap-complete` already reads the sentinel path env.

- **`lifecycle.ts`** (control-plane, MOD).
  - `bootstrap-complete` branch (~L168): after (a)(b) run and (c) `codeServerManager.start()` is fired, wrap step (d) in `if (isPostActivationSettledSync()) { … } else { log skip }`. The response body remains `{ accepted: true, action: 'bootstrap-complete', sentinel }` — the caller of `bootstrap-complete` (cloud) does not care whether (d) fired here or via `BootResumeService`.
  - `vscode-tunnel-start` branch (~L77): before calling `tunnelManager.start()`, `if (!isPostActivationSettledSync()) { return 200 with { accepted: false, action, deferred: false, reason: 'post-activation-not-settled', message } }`. No watcher installed; no `tunnelManager.start()` call; no device-code side effect.

- **`cluster-relay/src/metadata.ts` + `messages.ts`** (MOD).
  `HealthData` interface gains `postActivationReady: boolean`. `fetchHealth` reads `data['postActivationReady'] === true`. `collectMetadata()` copies it onto `ClusterMetadata`. `messages.ts` `ClusterMetadata` gains `postActivationReady?: boolean`. This is the wire-shape path used when the cluster-relay client synthesises metadata from `/health` (as opposed to the orchestrator RelayBridge path, which is the primary source for wizard clusters).

## Data model

See `data-model.md` — one core entity (`PostActivationReadyBit`), two schema deltas (`HealthResponse.postActivationReady`, `ClusterMetadataPayload.postActivationReady`), and one response contract (`LifecycleSkipResponse`).

## Test strategy

Unit tests (Vitest, matching existing `packages/orchestrator/src/__tests__/*.test.ts` layout):

- `post-activation-settled-probe.test.ts` — truth table:
  - `!keyFile && !marker` → true (local cluster, non-activated).
  - `!keyFile && marker` → true.
  - `keyFile && !marker` → false (wizard pre-restart — gate active).
  - `keyFile && marker` → true (wizard post-restart).
  Uses `mkdtempSync`, custom paths, existing test pattern in `post-activation-retry.test.ts`.

- `post-activation-settled-monitor.test.ts` —
  - Monitor doesn't install watch when marker exists at `start()`.
  - Monitor installs watch, fires `onSettled` when marker file appears, stops watching, does not fire again on subsequent writes.
  - `start()` then `stop()` before marker appears → no callback, watcher cleaned up.

- Lifecycle handler tests (extend existing lifecycle test file if present, else new):
  - `vscode-tunnel-start` when settled → forwards to `tunnelManager.start()` as today.
  - `vscode-tunnel-start` when not settled → returns 200 with `{ accepted: false, reason: 'post-activation-not-settled' }`, does NOT invoke `tunnelManager.start()`.
  - `bootstrap-complete` when settled + `hasGitHubToken` → step (d) fires as today.
  - `bootstrap-complete` when not settled + `hasGitHubToken` → steps (a)(b)(c) fire, (d) is skipped with log line, response unchanged.

- Regression (SC-004): synthetic local cluster (no key file present) → `postActivationReady === true`; `bootstrap-complete` step (d) fires. Prevents accidentally gating local clusters.

Manual verification (see `quickstart.md`):
1. Repro pre-fix behavior on a fresh wizard cluster (`snappoll`-style): tunnel button appears during pre-restart window, device-code auth succeeds, `token.json` never persists.
2. On the fixed build: tunnel button is gated by `postActivationReady === false` (companion cloud PR); the `POST /lifecycle/vscode-tunnel-start` handler returns the skip response if invoked directly; post-restart `BootResumeService` dispatches `vscode-tunnel-start`, the retained `authorization_pending` event replays the device code to the modal, single authorization persists to `token.json`.

## Risks & mitigations

1. **Monitor fires from a `fs.watch` event on a rename/mv rather than a create.** Mitigation: the callback rechecks `existsSync(markerPath)` before invoking `onSettled` (guards against transient rename→delete sequences from atomic-write patterns; the cluster-image script uses plain `echo > file` so this is unlikely, but the guard is cheap).

2. **Marker-file readability edge case (uid/gid mismatch on the volume).** Mitigation: `/var/lib/generacy/cluster-api-key` and `/var/lib/generacy/wizard-credentials.env` are already read by the same orchestrator process under the same uid (see `PostActivationRetryService.readGhToken()`, `checkPostActivationState()`). The marker is written by the same host-mounted volume as those files; readability is already covered by existing conventions.

3. **Post-restart `BootResumeService` burns a device code when no user is watching the modal.** Explicitly out-of-scope per spec §Out of Scope — tracked as a future issue. The retained `authorization_pending` event covers modal-open-within-5-minutes; past that the user must click once more.

4. **Local clusters permanently gated.** Prevented by the `NOT activated` predicate branch (SC-004). Unit test enforces this.

5. **Wire-schema drift between orchestrator's `ClusterMetadataPayload` and cluster-relay's `ClusterMetadata`.** Both must add the field; the two are decoupled today (each package owns its own type). The Q3 clarification pins the field name as `postActivationReady` on both sides. Contract file `cluster-metadata.md` documents both.

6. **Companion cloud/UI change (FR-006) not landed.** Cross-repo dependency (generacy-cloud). Without it, the tunnel button will still be offered pre-restart, but the server-side skip in `vscode-tunnel-start` (FR-005) will refuse the request cleanly — the UI will see the skip response and the user won't complete auth. The fix still helps (no auth is destroyed by SIGTERM) even before the UI change lands. Cloud-side gate is called out as a companion issue.

## Changeset

Per repo policy (CLAUDE.md changeset gate): this diff touches non-test files under `packages/orchestrator/src/`, `packages/control-plane/src/`, and `packages/cluster-relay/src/`. Implementation phase must add `.changeset/1009-<slug>.md` with `minor` bump for each of `@generacy-ai/orchestrator`, `@generacy-ai/control-plane`, and `@generacy-ai/cluster-relay` (new capability — a new boolean field on wire + new gate behavior). Do NOT amend an existing changeset; a newly-added file is required by the CI gate.
