# Research: Identity-Split Detection

## Goal

Decide *how* and *where* the orchestrator should detect the identity-split condition without violating FR-003 (no state mutation) and FR-005 (no event spam).

## Decisions

### D1: Detection runs in-process inside the orchestrator (not control-plane)

**Decision**: Implement the detector as an orchestrator service. Wire it into both startup paths in `server.ts`.

**Rationale**:
- The orchestrator owns the `ClusterRelay` WebSocket client — it can directly call `client.send({...})` with no IPC hop. The control-plane would need to use the existing `/internal/relay-events` IPC channel (added in #594/#598/#600), adding a code path that can fail (HTTP error, 503 if relay not yet initialized) for no benefit.
- The data the detector needs (`process.env.GENERACY_CLUSTER_ID`, `/var/lib/generacy/cluster.json`) is equally available in either process. No control-plane-only state is involved.
- Startup ordering is simpler: the orchestrator already has a clear "post-relay-bridge" hook point in both startup paths.

**Alternatives considered**:
- *Detection in control-plane, emit via IPC*: rejected — adds a network hop and a failure mode (orchestrator relay endpoint must be ready). The detector has no control-plane data dependency.
- *Detection inside `activate()`*: rejected — `activate()` runs before the relay client is connected, so the event would always be dropped. Also conflates activation concerns with diagnostic detection.

### D2: Emit one event per process lifetime via a module-level flag

**Decision**: Use a `let hasEmitted = false;` module-level variable in `identity-split-detector.ts`. Export `resetIdentitySplitDetectionState()` for tests.

**Rationale**:
- FR-005 forbids spam. A module-level flag is the simplest enforcement and survives across all in-process callers (relay reconnects, retries).
- Container restart = fresh Node process = fresh module load = flag resets. This is acceptable: a restarted container has the user observing a new boot cycle anyway, so one event per restart is the right granularity for the cloud UI.

**Alternatives considered**:
- *Persist the flag in a file (e.g. `/var/lib/generacy/identity-split-emitted`)*: rejected — the event is cheap to re-emit per boot; persistence adds I/O and a cleanup-on-resolution problem (when does the cluster get re-launched and the flag cleared? Manual remediation).
- *Time-window debounce (e.g. emit at most once per hour)*: rejected — same persistence problem, also harder to test.

### D3: Best-effort emission (no buffering, no retry)

**Decision**: If the relay client is disconnected at detection time, log a warning and return. Do not buffer the event.

**Rationale**:
- Identity-split is persistent — the mismatch survives across reboots. The next orchestrator boot will detect and re-emit. Buffering optimizes for a non-existent scenario (one-shot mismatch that resolves before retry).
- The relay client's send call already handles "disconnected" state by no-op'ing — the existing `internal-relay-events.ts:42` checks `client.isConnected` first. Mirror this pattern.

**Alternatives considered**:
- *Queue events until connected*: rejected — adds complexity for a self-healing scenario.

### D4: Reuse `readClusterJson` from `activation/persistence.ts`

**Decision**: Import `readClusterJson` directly. Do not reimplement parsing.

**Rationale**:
- `readClusterJson` already validates against `ClusterJsonSchema`, returns `null` on missing/corrupt — exactly the contract the detector wants ("no detection possible" → return).
- Single source of truth for the cluster.json shape.

### D5: Skip detection when either side is missing

**Decision**: If `process.env.GENERACY_CLUSTER_ID` is unset OR `cluster.json` is missing/invalid, return without emitting.

**Rationale**:
- Pre-activation, `cluster.json` doesn't exist yet — that's not a split, just an unactivated cluster.
- If env is unset, the cluster is misconfigured in a different way (no `.env` mounted) — out of scope for identity-split detection; would surface via different errors.
- Mismatch requires *two present values that disagree* — anything else is noise.

### D6: Call site is *after* `initializeRelayBridge` in both startup paths

**Decision**: In `server.ts`:
- Existing-key path (`if (config.relay.apiKey) { ... }`): call detector after `initializeRelayBridge` returns and the relayClientRef is set.
- Background-activation path (`activateInBackground`): call detector after `await relayBridge.start()` succeeds.

**Rationale**:
- The relay client needs to be live (`isConnected: true`) for the event to actually be sent. Pre-bridge-start emission silently no-ops.
- Both paths converge on "relay bridge has started → run detector once" — the same call site in both, just placed correctly relative to the bridge startup.

### D7: Channel name `cluster.identity-split` joins ALLOWED_CHANNELS

**Decision**: Add `'cluster.identity-split'` to the `ALLOWED_CHANNELS` tuple in `routes/internal-relay-events.ts`.

**Rationale**:
- Even though the orchestrator emits in-process (no IPC), the allowlist is the documented set of relay event channels. Adding the channel here keeps the allowlist authoritative and prepares for future emitters (e.g. if the control-plane ever needs to emit this).
- Cheap, low risk — just a string addition to an enum.

## Implementation Patterns Referenced

- **Relay-event emission pattern**: `packages/orchestrator/src/services/post-activation-retry.ts:61` — `this.sendRelayEvent?.('cluster.bootstrap', { ... })` with optional callback DI. Mirror this signature.
- **Background activation hook**: `packages/orchestrator/src/server.ts:666` — `activateInBackground()` is the post-activation hook in wizard mode.
- **`readClusterJson` contract**: `packages/orchestrator/src/activation/persistence.ts:41` — returns `null` on missing/invalid, validated via Zod.
- **Once-per-process pattern**: New for this issue, but module-level scoped state is consistent with the `module-level state store pattern` already used in control-plane (`POST /internal/status`, `setRelayPushEvent`).

## Sources

- Spec: `specs/750-summary-local-cluster-s/spec.md`
- Clarifications: `specs/750-summary-local-cluster-s/clarifications.md`
- Existing relay channel emission: `packages/orchestrator/src/services/post-activation-retry.ts`
- Existing channel allowlist: `packages/orchestrator/src/routes/internal-relay-events.ts`
- Cluster JSON schema: `packages/orchestrator/src/activation/types.ts`
- Launch scaffolder verification target: `packages/generacy/src/cli/commands/launch/scaffolder.ts:71-114`
- Related: #744 (cluster-id minting), generacy-cloud#792 / #796 / #801, #742 (cluster identity)
