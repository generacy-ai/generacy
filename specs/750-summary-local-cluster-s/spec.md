# Feature Specification: ## Summary

A **local cluster's runtime identity (`GENERACY_CLUSTER_ID`) does not match its cloud cluster-doc id

**Branch**: `750-summary-local-cluster-s` | **Date**: 2026-06-04 | **Status**: Draft

## Summary

## Summary

A **local cluster's runtime identity (`GENERACY_CLUSTER_ID`) does not match its cloud cluster-doc id.** The cluster relays/authenticates as the cloud doc id (via that doc's API key) but self-identifies as a *different* UUID for tunnel-name derivation, orchestrator identity, and worker enumeration — an identity split.

## Evidence (observed on staging)

Project `Xr7fxq61PF57U2lOtoKe`, local cluster `todo-list-example1-local-1`:
- Orchestrator process env: **`GENERACY_CLUSTER_ID=6c23c4c4-97d6-44ad-ac7a-b2302e9d7e9a`**
- Cloud cluster-doc id (and relay identity): **`a356d8f5-cca3-4f4a-9070-4fd8084b0468`**
  - Firestore doc `organizations/vnVZ…/clusters/a356d8f5-…` exists (`name: todo-list-example1-local-1`, `mode: local`), with one `api_keys/*`.
  - Relay log: `[relay] coexist: cluster=a356d8f5-… joining project=Xr7fxq61PF57U2lOtoKe`
- No doc exists under `clusters/6c23c4c4-…` (404), and it has no `api_keys` — so this is an **identity split, not a duplicate doc**.

## Why `deploy` is fine but this isn't

`generacy deploy` already adopts the **cloud-returned** id:
- `cli/commands/deploy/activation.ts:85` → `clusterId: pollResult.cluster_id`
- `cli/commands/deploy/scaffolder.ts:33` → `cluster_id: activation.clusterId`

So the remote/SSH path scaffolds with the cloud-minted `cluster_id`. The **local launch path** (web "Add cluster → local" → the launch command) appears to scaffold with a locally-minted / pre-existing id (`6c23c4c4`) and never reconcile it with the cloud-minted doc id (`a356d8f5`).

(Couldn't fully root-cause the exact mint site — the local containers were torn down before I could read `.generacy/cluster.json` / the compose env source. Candidate sites: the launch command's clusterId generation, and/or the web "Add cluster → local" pre-creating a doc whose id isn't fed back into the scaffold.)

## Impact

- `deriveTunnelName` keys on `GENERACY_CLUSTER_ID` → the local cluster registers tunnel `g-6c23c4c4…`, persisted (via #743) onto the `a356d8f5` doc. Still unique, so **no tunnel-name collision** — but the doc id ≠ the tunnel-source id.
- Anything correlating the cluster's self-reported identity (`6c23c4c4`) with its cloud doc id (`a356d8f5`) will mismatch — e.g. orchestrator identity / assignee filtering (#742), worker enumeration, future per-cluster reporting.
- Confusing to debug (two ids for one cluster).

## Root cause (clarified)

The mismatch originates **cloud-side** — the two cloud endpoints disagree:

- `buildLaunchConfig` returns `claim.clusterId` (`services/api/src/services/launch-config.ts:121`) → the scaffolder writes this to `GENERACY_CLUSTER_ID` (observed `6c23c4c4-…`).
- Device-code activation mints a **fresh `randomUUID()`** (`services/api/src/services/cluster-activation.ts:385-386`, "#792: generate fresh UUID (was hardcoded `clusterId = projectId`)") → this becomes the actual cluster doc + API key (observed `a356d8f5-…`, the only doc that exists; `clusters/6c23c4c4-…` is a 404 with no api_keys).

The client launch scaffolder is correct (it uses `config.clusterId` from `LaunchConfig`). The fix must align the two cloud endpoints.

## Proposed fix

**Two-track fix, ships in parallel:**

1. **Cloud companion** (separate `generacy-ai/generacy-cloud` issue): Device-code activation must **reuse** the claim/`LaunchConfig.clusterId` instead of minting a fresh UUID. The claim's `clusterId` becomes canonical — that same id is used to create the cluster doc + API key during activation. Result: `LaunchConfig.clusterId == pollResult.cluster_id == cluster-doc id`.

2. **This issue (client-side)**:
   - Verify the launch path uses `config.clusterId` end-to-end (no client-side overrides).
   - Ship divergence **detection** at orchestrator startup: when `process.env.GENERACY_CLUSTER_ID` ≠ persisted `/var/lib/generacy/cluster.json.cluster_id`, emit a relay event (`cluster.identity-split`) and continue. The cloud UI surfaces a remediation banner ("destroy and re-launch this cluster") for already-split clusters.
   - **No in-container `.env` rewrite or activation-time reconciliation** — the host `.env` and already-spawned workers can't reliably be updated, and once the cloud companion lands, divergence won't arise on fresh launches.

This aligns with #744 Q3 (cloud-minted clusterId).

## Acceptance criteria

- [ ] A freshly-launched local cluster's `GENERACY_CLUSTER_ID` equals its cloud cluster-doc id (post cloud companion landing).
- [ ] `deriveTunnelName`, orchestrator identity, and worker enumeration all use the same id the cloud doc is keyed by.
- [ ] No orphan id (no self-minted id that never becomes a doc).
- [ ] Orchestrator startup emits `cluster.identity-split` relay event when `process.env.GENERACY_CLUSTER_ID` ≠ persisted `cluster.json.cluster_id`, then continues running.
- [ ] No automatic rewrite of host `.env`, `cluster.json`, or in-process env at activation/startup.

## Notes

- Distinct from generacy-ai/generacy-cloud#801 (sibling stuck `connecting` due to projectId-keyed doc resolution) — that one is why this local cluster was stuck; this issue is the separate identity mismatch.
- Lower urgency than #801, but worth closing before relying on per-cluster identity in production.

Relates: #744 (cluster-id minting), generacy-ai/generacy-cloud#792 / #796 / #801, #742 (cluster identity).


## User Stories

### US1: Local cluster has a single identity

**As a** Generacy operator/developer running a local cluster,
**I want** my local cluster's `GENERACY_CLUSTER_ID` to equal the cloud cluster-doc id it relays as,
**So that** tunnel-name derivation, orchestrator identity, worker enumeration, and per-cluster reporting all correlate to the same id without surprises when debugging.

**Acceptance Criteria**:
- [ ] Freshly-launched local cluster shows the same UUID in `GENERACY_CLUSTER_ID`, `cluster.json.cluster_id`, the cloud cluster-doc path, and the relay handshake identity (post cloud companion).
- [ ] No 404 cluster-doc lookups for the orchestrator's self-reported id.

### US2: Existing mismatched clusters surface a clear remediation path

**As a** Generacy operator with a pre-existing local cluster that was launched before the fix,
**I want** the orchestrator to detect the identity split and surface it,
**So that** I receive a UI prompt to destroy and re-launch the cluster rather than discovering the mismatch through obscure correlation failures.

**Acceptance Criteria**:
- [ ] Orchestrator startup emits `cluster.identity-split` relay event when env id ≠ persisted cluster.json id.
- [ ] Orchestrator continues running (does not exit) after emitting the event.
- [ ] No automatic mutation of host `.env`, `cluster.json`, or process env.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The launch CLI scaffolder MUST write `LaunchConfig.clusterId` (cloud-returned claim id) to `.env`'s `GENERACY_CLUSTER_ID` and `.generacy/cluster.json.cluster_id`. No client-side UUID minting or override. | P1 | Already implemented at `packages/generacy/src/cli/commands/launch/scaffolder.ts:71-114`; this FR is a verification gate. |
| FR-002 | The orchestrator at startup MUST compare `process.env.GENERACY_CLUSTER_ID` against the persisted `/var/lib/generacy/cluster.json.cluster_id`. On mismatch, emit a relay event on channel `cluster.identity-split` with both ids and continue running. | P1 | Detection only — no remediation. Event consumed by cloud UI. |
| FR-003 | The orchestrator MUST NOT rewrite host `.env`, the host-side `cluster.json`, or in-process `GENERACY_CLUSTER_ID` to reconcile an identity split. | P1 | Host `.env` is unreachable from inside the container; mid-process env mutation does not propagate to already-spawned workers. Reconciliation is unsafe. |
| FR-004 | The fix MUST NOT silently overwrite mismatched ids on existing local clusters. Remediation is destroy + re-launch (user-driven via cloud UI banner). | P1 | FR-005 from original spec retained. |
| FR-005 | The orchestrator's `cluster.identity-split` event MUST be emitted at most once per orchestrator process lifetime (not on every restart loop iteration / not flapping). | P2 | Prevent log/event spam; one event per boot. |
| FR-006 | A companion `generacy-ai/generacy-cloud` issue MUST be filed to make device-code activation reuse the claim's `clusterId` (canonical source) instead of minting a fresh `randomUUID()`. | P1 | This issue ships detection independently; the cloud companion delivers prevention. Tracked as a related/dependent issue, not a blocker. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Identity consistency on fresh launch | 100% | Launch a new local cluster post-fix (with cloud companion landed); verify `GENERACY_CLUSTER_ID` matches the cloud cluster-doc id and relay handshake identity. |
| SC-002 | Mismatch detection on existing split cluster | Event emitted within 5s of orchestrator start | Boot an orchestrator with a deliberately-mismatched env id; observe one `cluster.identity-split` event on the relay; confirm orchestrator stays up. |
| SC-003 | No silent state mutation | Zero writes | After mismatch detection, `.env`, `cluster.json`, and `process.env.GENERACY_CLUSTER_ID` byte-equal their pre-detection values. |
| SC-004 | No event spam | ≤1 event per orchestrator process | Run orchestrator for ≥5 minutes with persistent mismatch; only one `cluster.identity-split` event observed. |

## Assumptions

- Cloud-side `buildLaunchConfig` already returns `claim.clusterId` correctly (verified at `services/api/src/services/launch-config.ts:121`). This issue does not introduce that behavior; it relies on it.
- The orchestrator's relay client is available at startup (post-activation) to emit the `cluster.identity-split` event. If activation has not yet completed, detection may run after activation.
- Cloud UI consumes `cluster.identity-split` and renders a remediation banner (tracked via the cloud companion issue).
- "Destroy and re-launch" is an acceptable user-facing remediation for already-split clusters (no in-place migration is offered).

## Out of Scope

- Cloud-side cluster-doc id minting strategy beyond requiring that activation reuse the claim's `clusterId` (the cloud companion issue covers implementation).
- In-place migration / reconciliation of existing mismatched clusters (FR-004).
- Activation-time `.env` rewrite or mid-process env mutation (FR-003).
- UI rendering of the identity-split banner (cloud-side).
- Telemetry/metrics for split-cluster frequency (could be a follow-up).
- Lifecycle of the `deploy` (SSH) path — it already adopts `pollResult.cluster_id` and is not affected.

---

*Generated by speckit*
