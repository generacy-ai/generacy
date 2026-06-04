# Implementation Plan: Local Cluster Identity Split Detection

**Feature**: Detect and surface mismatches between `process.env.GENERACY_CLUSTER_ID` and persisted `cluster.json.cluster_id` at orchestrator startup, without mutating local state. Verify the launch scaffolder is still the single client-side source for `GENERACY_CLUSTER_ID`.
**Branch**: `750-summary-local-cluster-s`
**Status**: Complete

## Summary

The local cluster launch path can produce an "identity split": the cluster's runtime `GENERACY_CLUSTER_ID` (from `.env`) is one UUID, but the cluster doc + API key it authenticates as on the cloud is a different UUID. Root cause is cloud-side (the device-code activation endpoint mints a fresh `randomUUID()` instead of reusing the claim's `clusterId`), and the fix for *fresh* clusters lands in a parallel `generacy-ai/generacy-cloud` companion issue.

This issue ships the **client-side half**:
1. **Detection** — at orchestrator startup, compare env id vs persisted `/var/lib/generacy/cluster.json.cluster_id`. On mismatch, emit a single `cluster.identity-split` relay event with both ids and continue running. No state mutation.
2. **Verification gate** — confirm `packages/generacy/src/cli/commands/launch/scaffolder.ts` writes `LaunchConfig.clusterId` end-to-end (no client-side overrides).

The event consumer (cloud UI banner offering "destroy and re-launch") is out of scope for this issue and tracked under the cloud companion.

## Technical Context

- **Language**: TypeScript (Node >= 22), ESM modules.
- **Packages touched**:
  - `packages/orchestrator/` — adds detector service, wires it into `server.ts` startup paths.
  - `packages/generacy/src/cli/commands/launch/` — verification only (no code change expected; FR-001 already satisfied at `scaffolder.ts:71-114`).
- **Dependencies**: No new deps. Uses existing `node:fs/promises`, `zod`, pino logger, and the established relay-event emission pattern.
- **Relay channel**: New event channel `cluster.identity-split` joins the existing allowlist in `packages/orchestrator/src/routes/internal-relay-events.ts` (currently: `cluster.vscode-tunnel`, `cluster.audit`, `cluster.credentials`, `cluster.bootstrap`). Note: emission happens *in-process* in the orchestrator (it owns the relay client), so the IPC route may not need extension — but the channel name should still be a documented allowed value for cross-process emitters that follow.
- **Persistence file**: `/var/lib/generacy/cluster.json` — already validated via `ClusterJsonSchema` (`packages/orchestrator/src/activation/types.ts:17`).
- **Env source**: `process.env.GENERACY_CLUSTER_ID` set from `.generacy/.env` mounted into the orchestrator container.

## Project Structure

```
packages/orchestrator/src/
├── services/
│   └── identity-split-detector.ts          # NEW: detector + once-per-process guard
├── activation/
│   ├── persistence.ts                       # EXISTING: readClusterJson() (reused)
│   └── types.ts                             # EXISTING: ClusterJsonSchema
├── routes/
│   └── internal-relay-events.ts             # MODIFIED: add 'cluster.identity-split' to ALLOWED_CHANNELS allowlist
└── server.ts                                # MODIFIED: invoke detector after relay bridge starts (both startup paths)

packages/orchestrator/src/__tests__/
└── identity-split-detector.test.ts          # NEW: unit tests for detector

packages/generacy/src/cli/commands/launch/__tests__/
└── scaffolder.test.ts                       # EXISTING: add (or confirm) assertion that scaffoldEnvFile writes config.clusterId verbatim

specs/750-summary-local-cluster-s/
├── plan.md                                  # this file
├── research.md
├── data-model.md
├── contracts/
│   └── cluster-identity-split-event.md
└── quickstart.md
```

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                        Orchestrator startup                    │
│                                                                │
│   createServer()                                               │
│      │                                                         │
│      ├─ register /internal/relay-events route (deferred)       │
│      ├─ [activation path A: existing key]                      │
│      │     initializeRelayBridge() ──► relayClientRef set      │
│      │     detectIdentitySplit({clusterJsonPath, env, send})   │
│      │                                                         │
│      └─ [activation path B: wizard mode]                       │
│            activateInBackground()                              │
│              └─ on success ──► initializeRelayBridge()         │
│                              detectIdentitySplit(...)          │
│                                                                │
│   detectIdentitySplit:                                         │
│      1. read process.env.GENERACY_CLUSTER_ID                   │
│      2. await readClusterJson(clusterJsonPath)                 │
│      3. if both present AND ids differ:                        │
│           if not alreadyEmitted (module-level guard):          │
│             sendRelayEvent('cluster.identity-split', {         │
│               env_cluster_id,                                  │
│               cluster_json_cluster_id,                         │
│               detected_at: ISO                                 │
│             })                                                 │
│             mark alreadyEmitted = true                         │
│      4. NEVER mutate env, cluster.json, or .env                │
└────────────────────────────────────────────────────────────────┘
```

Key invariants:
- **Detection is read-only**. The function reads two values, compares, optionally sends one relay event. No writes anywhere.
- **One emission per process lifetime**. A module-level `hasEmitted` flag prevents flapping across reconnects, retries, or re-invocations within the same Node process. Container restart resets it (acceptable — that's a fresh process).
- **Best-effort emission**. If the relay client is disconnected at detection time, the event is dropped (no buffering). Acceptable because the mismatch is persistent — the next orchestrator boot will detect again. Avoid building a queue.
- **Missing files are non-events**. If `cluster.json` is absent (pre-activation) OR env id is unset, skip detection silently. Mismatch requires both sides to be present.

## Constitution Check

No `.specify/memory/constitution.md` exists in this repo — skipped.

Adherence to project conventions:
- ✅ Reuses existing relay-event pattern (`sendRelayEvent(channel, payload)` callback) — same shape as `PostActivationRetryService`.
- ✅ Reuses existing `readClusterJson()` from `activation/persistence.ts` — no duplicated parsing.
- ✅ Reuses existing relay channel naming convention `cluster.<noun>` (e.g. `cluster.bootstrap`, `cluster.credentials`).
- ✅ No new packages, no new dependencies.
- ✅ Fails closed on every side: missing inputs → no event; relay down → no event (next boot retries).
- ✅ Defense against runaway emission via module-level once-flag (FR-005).

## Implementation Steps (high level — `/tasks` will expand)

1. Add `cluster.identity-split` to the `ALLOWED_CHANNELS` tuple in `packages/orchestrator/src/routes/internal-relay-events.ts` (documents the channel even though the orchestrator emits it directly).
2. Create `packages/orchestrator/src/services/identity-split-detector.ts` exporting:
   - `detectIdentitySplit(options): Promise<DetectionOutcome>` — the pure detector.
   - `resetIdentitySplitDetectionState()` — test helper to clear the once-flag.
3. Wire `detectIdentitySplit` into both startup paths in `packages/orchestrator/src/server.ts`:
   - Existing-key path (~line 357, after `initializeRelayBridge` completes).
   - Background-activation path (~line 720, after `relayBridge.start()` in `activateInBackground`).
4. Unit tests in `packages/orchestrator/src/__tests__/identity-split-detector.test.ts` cover: match → no event; mismatch → one event; mismatch + repeat call → still one event; missing env → no event; missing cluster.json → no event; sendRelayEvent throw → swallowed and logged.
5. Verification test in `packages/generacy/src/cli/commands/launch/__tests__/scaffolder.test.ts` asserting `scaffoldEnvFile` writes `config.clusterId` to `GENERACY_CLUSTER_ID` byte-for-byte (FR-001 gate).
6. File the cloud companion issue (FR-006) — track as related issue, do not block this issue's merge on it.

## Key Technical Decisions (full rationale in `research.md`)

- **Detection only — no reconciliation** (FR-003, FR-004). Mid-process env mutation cannot reach already-spawned worker subprocesses, and the host `.env` is unreachable from inside the container. Reconciliation is unsafe; remediation is destroy + re-launch.
- **Emit once per process** (FR-005). Module-level boolean flag. Container restart is a fresh module load → resets flag. Acceptable: identity split is persistent and one event per container boot is sufficient signal for the cloud UI.
- **Best-effort emission**. No buffering, no retry. The mismatch persists across boots, so the next startup re-detects and re-emits. Buffering adds complexity for no real benefit.
- **Reuse `readClusterJson`** (no new parsing). Already validated via `ClusterJsonSchema` in `activation/types.ts`.
- **No host-side detection in CLI**. The CLI scaffolder already uses `config.clusterId` (`launch/scaffolder.ts:71-114`); FR-001 is a verification gate (unit-test assertion), not new behavior.
- **Emit *after* relay bridge starts**, not before. The detector needs a working relay client; calling it pre-activation would silently drop the event. Calling post-bridge-start gives the best chance of in-flight delivery.

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Detector runs before relay client has connected → event dropped | Acceptable: next orchestrator restart re-emits. Document as known behavior in event contract. |
| `readClusterJson` throws on corrupt JSON | Existing implementation already returns `null` on parse failure (`activation/persistence.ts:47`). Detector treats `null` as "no detection possible" and returns. |
| Race between `cluster.json` write (activation flow) and detector read | Detector runs *after* `initializeRelayBridge` which itself runs *after* `activate()` — so `cluster.json` is guaranteed to exist (or was already absent → no detection). |
| Detection sends event on every relay reconnect | Module-level `hasEmitted` guard. Test covers this. |
| Cloud UI not yet ready to consume the event | Out of scope; cloud companion tracks UI work. Event is forward-compatible (additive). |

## Out of Scope (cross-referenced from spec)

- Cloud-side cluster-doc id minting fix (separate `generacy-ai/generacy-cloud` issue per FR-006).
- In-place migration / reconciliation of mismatched clusters (FR-003, FR-004).
- Activation-time `.env` rewrite or mid-process env mutation (FR-003).
- Cloud UI banner rendering (cloud companion).
- Telemetry/metrics for split-cluster frequency.
- `deploy` (SSH) path — already adopts `pollResult.cluster_id`; not affected.
